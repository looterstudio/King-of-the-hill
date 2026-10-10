// Rooms (up to 100 players, solo / duos / squads) and the matchmaker that fills them. Waiting
// rooms and countdowns live here on the main thread; once a match goes live it runs on a
// MatchHost (in-process or on a worker thread) and whatever it wants sent comes back to be
// routed to the right sockets.
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { COUNTDOWN_MS, FILL_WAIT_MS, MODES, OPEN_ROOMS, matchPoints, playerNumber, RESULT_MS, ROOM_MAX, ROOM_MIN, TICK_HZ, type Mode } from '../../shared/src/constants.ts';
import { BOT_NAMES } from '../../shared/src/bots.ts';
import type { LobbyRoom, RoomPhase, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import type { MatchHost } from './host.ts';
import type { Outbound, SpecRequest } from './match.ts';
import type { Flag } from './anticheat.ts';
import { makeTeams } from '../../shared/src/teams.ts';

const SOFT_BUFFER = 256 * 1024;      // skip snapshots to a client this far behind
const BOT_FILL_WAIT_MS = 20_000;     // with bots to fill the room, how long it waits for more people
let nextBot = 900_000;               // bot ids, apart from the clients' (which count up from 1)
const HARD_BUFFER = 2 * 1024 * 1024; // drop a client this far behind

export class Client {
  room: Room | null = null;
  queued = false;
  name = '';
  wallet: string | null = null;
  authed = false;
  tokens: number;
  lastRefill = Date.now();
  mode: Mode = 'solo';
  party = '';          // friends who type the same code land on the same team
  wantRoom = '';       // a room picked from the lobby list
  team = 0;
  skin = 0;            // character picked in the lobby (looks only)
  authing = false;     // a sign-in is waiting on the balance read
  private lastLobbyAction = 0;
  private lobbyTokens = 5;
  constructor(public id: number, public ws: WebSocket, public num: string, public nonce: string, private rate: number) { this.tokens = rate; }

  send(msg: ServerMsg) { this.sendRaw(JSON.stringify(msg)); }
  sendRaw(s: string, droppable = false) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > HARD_BUFFER) { this.ws.terminate(); return; }
    if (droppable && this.ws.bufferedAmount > SOFT_BUFFER) return;
    this.ws.send(s);
  }
  // a few quick ones are fine (leave, then drop in again); a socket toggling all day gets one a second
  lobbyAction(): boolean {
    const now = Date.now();
    this.lobbyTokens = Math.min(5, this.lobbyTokens + (now - this.lastLobbyAction) / 1000);
    this.lastLobbyAction = now;
    if (this.lobbyTokens < 1) { this.send({ t: 'error', msg: 'slow down a moment and try again' }); return false; }
    this.lobbyTokens -= 1;
    return true;
  }
  // token bucket: refuse floods without punishing a burst after a lag spike
  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.rate * 2, this.tokens + ((now - this.lastRefill) / 1000) * this.rate);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface RoomHooks {
  onScore(room: Room, c: Client, points: number): { awarded: boolean; epoch: number };
  onResult?(room: Room, c: Client, place: number, kills: number): void; // every wallet's match, for its profile
  fillWithBots?: boolean; // every match starts with 100: bots take the seats nobody did (they never score)
  onFlag?(room: Room, c: Client | null, f: Flag): void;
  minVerifiedForTicket: number;
}

export { makeTeams };

export class Room {
  readonly id = randomBytes(4).toString('hex');
  readonly seed = randomBytes(4).readUInt32LE();
  phase: RoomPhase = 'waiting';
  seats: Client[] = [];
  private fillDeadline: number | null = null;
  startsAt: number | null = null;
  private overAt = 0;
  verifiedAtStart = 0;
  teamsAtStart = 0;
  closed = false;
  private dirty = false; // the seat list changed: sent once per lobby tick, not once per join/leave
  flagged = new Map<number, string>();
  private botSeats: RoomSeat[] = [];
  private get minPlayers() { return this.hooks.fillWithBots ? 1 : ROOM_MIN; }

  constructor(private hooks: RoomHooks, private host: MatchHost, readonly mode: Mode = 'solo') {}

  get open() { return this.phase === 'waiting' && this.seats.length < ROOM_MAX && !this.closed; }

  broadcast(msg: ServerMsg, droppable = false) {
    const s = JSON.stringify(msg);
    for (const c of this.seats) if (c.room === this) c.sendRaw(s, droppable);
  }

  private seatList(): RoomSeat[] { return [...this.seats.map((c) => ({ id: c.id, num: c.num, name: c.name, verified: !!c.wallet, team: c.team, skin: c.skin })), ...this.botSeats]; }
  // queue/leave spam used to send the whole seat list to every seat on every toggle (one attacker
  // turned 1.7 KB/s into 11.6 MB/s for a full room): now at most once per lobby tick, serialized once
  private announce() { this.dirty = true; }
  private flushAnnounce() {
    if (!this.dirty) return;
    this.dirty = false;
    const head = `{"t":"room","roomId":${JSON.stringify(this.id)},"you":`;
    const tail = `,"seats":${JSON.stringify(this.seatList())},"state":"${this.phase}","startsAt":${JSON.stringify(this.startsAt)},"seed":${this.seed},"mode":"${this.mode}"}`;
    for (const c of this.seats) if (c.room === this) c.sendRaw(head + c.id + tail);
  }
  // how many teams the current seats would make: a match needs two, or the only team "wins" on the first tick
  private teamCount() { return new Set(makeTeams(this.seats.map((c) => ({ id: c.id, party: c.party })), MODES[this.mode].size).values()).size; }
  view(now: number): LobbyRoom {
    const at = this.startsAt ?? (this.fillDeadline !== null ? this.fillDeadline + COUNTDOWN_MS : null);
    return { id: this.id, mode: this.mode, n: this.seats.length, state: this.phase, startsIn: at === null ? null : Math.max(0, Math.ceil((at - now) / 1000)) };
  }
  hasParty(p: string) { return !!p && this.seats.some((c) => c.party === p); }

  add(c: Client) { this.seats.push(c); c.room = this; c.team = 0; this.announce(); }

  remove(c: Client) {
    if (c.room !== this) return;
    c.room = null;
    if (this.phase === 'live') { this.host.leave(this.id, c.id); return; } // the seat stays so the winner check stays honest
    this.seats = this.seats.filter((s) => s !== c);
    if (this.phase === 'countdown' && this.seats.length < this.minPlayers) { this.phase = 'waiting'; this.startsAt = null; this.fillDeadline = null; }
    if (this.seats.length === 0) this.closed = true;
    else if (this.phase !== 'over') this.announce();
  }

  input(c: Client, i: Parameters<MatchHost['input']>[2]) { if (this.phase === 'live') this.host.input(this.id, c.id, i); }
  spectate(c: Client, r: SpecRequest) { if (this.phase === 'live') this.host.spectate(this.id, c.id, r); }

  // what the match wants sent, routed to sockets
  deliver(o: Outbound, now: number) {
    for (const s of o.sends) {
      if (s.to === 'all') { for (const c of this.seats) if (c.room === this) c.sendRaw(s.json, s.drop); }
      else for (const id of s.to) { const c = this.seats.find((x) => x.id === id); if (c && c.room === this) c.sendRaw(s.json, s.drop); }
    }
    if (o.flags) for (const f of o.flags) { this.flagged.set(f.id, f.reason); this.hooks.onFlag?.(this, this.seats.find((c) => c.id === f.id) ?? null, f); }
    if (o.ended) this.finish(o.ended.winners, o.ended.places, now);
  }

  update(now: number) {
    if (this.closed) return;
    if (this.phase === 'waiting') {
      if (this.seats.length >= this.minPlayers && this.fillDeadline === null) { this.fillDeadline = now + (this.hooks.fillWithBots ? BOT_FILL_WAIT_MS : FILL_WAIT_MS); this.announce(); }
      if (this.seats.length < this.minPlayers) this.fillDeadline = null;
      if ((this.seats.length >= ROOM_MAX || (this.fillDeadline !== null && now >= this.fillDeadline)) && (this.hooks.fillWithBots || this.teamCount() >= 2)) {
        this.phase = 'countdown'; this.startsAt = now + COUNTDOWN_MS; this.announce();
      }
    } else if (this.phase === 'countdown') {
      if (this.startsAt !== null && now >= this.startsAt) {
        // the empty seats go to bots: a full 100 every match
        const bots = this.hooks.fillWithBots ? Array.from({ length: Math.max(0, ROOM_MAX - this.seats.length) }, () => nextBot++) : [];
        const teams = makeTeams([...this.seats.map((c) => ({ id: c.id, party: c.party })), ...bots.map((id) => ({ id, party: '' }))], MODES[this.mode].size);
        this.teamsAtStart = new Set(teams.values()).size;
        if (this.teamsAtStart < 2) { this.phase = 'waiting'; this.startsAt = null; this.fillDeadline = null; this.announce(); } // someone left: wait for more
        else {
          this.phase = 'live';
          this.verifiedAtStart = this.seats.filter((c) => c.wallet).length;
          for (const c of this.seats) c.team = teams.get(c.id) ?? c.id;
          this.botSeats = bots.map((id, i) => ({ id, num: playerNumber(id * 7 + this.seed), name: BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? String(Math.floor(i / BOT_NAMES.length)) : ''), verified: false, team: teams.get(id) ?? id, skin: id % 5, bot: true }));
          this.host.start(this.id, this.seed, this.seats.map((c) => c.id), Object.fromEntries([...this.seats.map((c) => [c.id, c.team]), ...this.botSeats.map((b) => [b.id, b.team])]), bots);
          this.announce();
        }
      }
    } else if (this.phase === 'over' && now >= this.overAt) {
      for (const c of this.seats) if (c.room === this) c.room = null;
      this.closed = true;
    }
    this.flushAnnounce();
  }

  private finish(winnerIds: number[], places: Record<number, [number, number]>, now: number) {
    let res = { awarded: false, epoch: -1 };
    const points: Record<number, number> = {};
    // points need enough distinct verified wallets at the start, so a few wallets cannot farm
    // each other; anyone the cheat checks flagged during the match gets nothing
    const counts = this.verifiedAtStart >= this.hooks.minVerifiedForTicket;
    for (const c of this.seats) {
      const [place, kills] = places[c.id] ?? [0, 0];
      const pts = matchPoints(this.mode, place, kills, winnerIds.includes(c.id), this.teamsAtStart);
      points[c.id] = pts;
      if (c.wallet && !this.flagged.has(c.id)) this.hooks.onResult?.(this, c, place, kills);
      if (!counts || !pts || !c.wallet || this.flagged.has(c.id)) continue;
      const r = this.hooks.onScore(this, c, pts);
      if (r.awarded) res = r;
    }
    this.phase = 'over'; this.overAt = now + RESULT_MS;
    this.broadcast({ t: 'result', winner: winnerIds[0] ?? null, winners: winnerIds, points, awarded: counts, epoch: res.epoch });
  }
}

const cleanParty = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const MODE_SET = new Set(Object.keys(MODES));

export class Matchmaker {
  rooms = new Map<string, Room>();
  private queue: Client[] = [];
  private timer: NodeJS.Timeout | null = null;
  private next = 0;
  lastTickMs = 0;
  host!: MatchHost;

  // maxRooms: rooms alive at once on this server; openRooms: how many may be filling at once
  constructor(private hooks: RoomHooks, private maxRooms: number, private openRooms = OPEN_ROOMS) {}

  // batches coming back from wherever matches run
  deliver = (batch: Outbound[]) => { const now = Date.now(); for (const o of batch) this.rooms.get(o.roomId)?.deliver(o, now); };

  enqueue(c: Client, want: { mode?: unknown; party?: unknown; room?: unknown } = {}) {
    if (c.room || c.queued) return;
    c.mode = MODE_SET.has(String(want.mode)) ? (want.mode as Mode) : 'solo';
    c.wantRoom = typeof want.room === 'string' ? want.room.slice(0, 16) : '';
    const picked = this.rooms.get(c.wantRoom);
    if (picked) c.mode = picked.mode;
    c.party = c.mode === 'solo' ? '' : cleanParty(want.party);
    c.queued = true; this.queue.push(c);
    c.send({ t: 'queued', position: this.queue.length });
  }
  dequeue(c: Client) { if (c.queued) { c.queued = false; this.queue = this.queue.filter((q) => q !== c); } }
  leave(c: Client) { this.dequeue(c); c.room?.remove(c); }

  private assign() {
    if (this.queue.length === 0) return;
    const filling = () => [...this.rooms.values()].filter((r) => r.phase === 'waiting' && !r.closed);
    const left: Client[] = [];
    for (const c of this.queue) {
      if (c.ws.readyState !== c.ws.OPEN) { c.queued = false; continue; }
      const open = filling().filter((r) => r.open && r.mode === c.mode);
      // the room you picked, then the one your party is in, then the fullest one filling
      let room = open.find((r) => r.id === c.wantRoom) ?? open.find((r) => r.hasParty(c.party))
        ?? open.sort((a, b) => b.seats.length - a.seats.length)[0];
      if (!room) {
        if (this.rooms.size >= this.maxRooms || filling().length >= this.openRooms) { left.push(c); continue; } // waits for capacity
        room = new Room(this.hooks, this.host, c.mode); this.rooms.set(room.id, room);
      }
      c.queued = false;
      room.add(c);
    }
    this.queue = left;
  }

  // the lobby's room list: filling rooms first, then live ones
  lobby(now: number): LobbyRoom[] {
    const order = { waiting: 0, countdown: 1, live: 2, over: 3 } as const;
    return [...this.rooms.values()].filter((r) => !r.closed).map((r) => r.view(now))
      .sort((a, b) => order[a.state] - order[b.state] || b.n - a.n).slice(0, 12);
  }

  // lobby work only (filling rooms, countdowns); the 30 Hz simulation runs on the host
  start() {
    const step = 1000 / TICK_HZ;
    this.next = performance.now();
    const loop = () => {
      const t0 = performance.now();
      this.assign();
      const now = Date.now();
      for (const [id, r] of this.rooms) { r.update(now); if (r.closed) this.rooms.delete(id); }
      this.lastTickMs = performance.now() - t0;
      this.next += step;
      const wait = this.next - performance.now();
      if (wait < -step * 5) this.next = performance.now();
      this.timer = setTimeout(loop, Math.max(0, wait));
    };
    this.timer = setTimeout(loop, step);
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  get queued() { return this.queue.length; }
}
