// Offline demo transport: plays the server's role inside the browser with bots and a simulated
// fee stream. Same Sim, same snapshots, same input queue semantics, so the UI under test is real.
import {
  COUNTDOWN_MS, matchPoints, MAP_HALF, MODES, MODE_IDS, RESULT_MS, ROOM_MAX, SNAP_EVERY, TICK_HZ, epochEnd, epochOf, playerNumber, type Mode,
} from '../../shared/src/constants.ts';
import type { ClientMsg, LobbyRoom, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import { Sim, emptyInput, sanitizeInput, type TickInputs } from '../../shared/src/sim.ts';
import { InputQueue } from '../../shared/src/inputq.ts';
import { frame, snapFor, type Viewer } from '../../shared/src/snap.ts';
import { makeTeams } from '../../shared/src/teams.ts';
import { botInput, newBot, teamDrops, type Bot } from './bots.ts';

type Handler = (m: ServerMsg) => void;
const NAMES = ['degen.sol', 'wagmi', 'ser_pump', 'rugless', 'bonkbro', 'paperhand', 'diamond', 'jeet', 'moonboi', 'gmgm', 'solchad', 'wifhat', 'ape420', 'fomo', 'ngmi', 'rekt', 'gigabrain', 'anon', 'whale', 'hodl'];
const fakeWallet = () => Array.from({ length: 44 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('');
export const DEMO_PLAYERS = 40;

export class LocalNet {
  private handlers: Handler[] = [];
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private lamports = 7_400_000_000n;
  private tickets = new Map<string, { name: string; wins: number }>(); // points this epoch
  private teamPlace = new Map<number, number>();
  private me: RoomSeat | null = null;
  private myWallet = fakeWallet();
  private mine = new InputQueue(emptyInput(), TICK_HZ);
  room: { id: string; seed: number; mode: Mode; seats: RoomSeat[]; bots: Bot[]; sim: Sim | null; timers: number[] } | null = null;
  private free: { x: number; z: number } | null = null;
  // the other rooms on the 'server', for the lobby list (simulated: this demo only runs yours)
  private fake: LobbyRoom[] = [];
  private loop = 0;
  private killer: number | null = null;
  private viewer: Viewer = { lootVer: -1, lootAt: -9 };

  constructor() {
    for (let i = 0; i < 6; i++) this.tickets.set(`bot-${NAMES[i]}`, { name: NAMES[i], wins: (6 - i + Math.floor(Math.random() * 3)) * 45 + Math.floor(Math.random() * 30) });
    for (let i = 0; i < 5; i++) this.fake.push(this.fakeRoom(i < 3));
  }
  private fakeRoom(live: boolean): LobbyRoom {
    const mode = MODE_IDS[Math.floor(Math.random() * 3)];
    return live ? { id: Math.random().toString(16).slice(2, 10), mode, n: 70 + Math.floor(Math.random() * 31), state: 'live', startsIn: null }
      : { id: Math.random().toString(16).slice(2, 10), mode, n: 3 + Math.floor(Math.random() * 50), state: 'waiting', startsIn: 20 + Math.floor(Math.random() * 25) };
  }
  private emitLobby() {
    // filling rooms gain players, start, and eventually finish and make way for new ones
    this.fake = this.fake.map((r) => {
      if (r.state === 'live') return Math.random() < 0.02 ? this.fakeRoom(false) : r;
      const n = Math.min(ROOM_MAX, r.n + Math.floor(Math.random() * 4));
      const startsIn = Math.max(0, (r.startsIn ?? 30) - 1);
      return startsIn === 0 || n >= ROOM_MAX ? { ...r, n, state: 'live', startsIn: null } : { ...r, n, startsIn };
    });
    const mine = this.room ? [{ id: this.room.id, mode: this.room.mode, n: this.room.seats.length, state: this.room.sim ? 'live' : 'waiting', startsIn: null } as LobbyRoom] : [];
    const order = { waiting: 0, countdown: 1, live: 2, over: 3 } as const;
    this.emit({ t: 'lobby', rooms: [...mine, ...this.fake].sort((a, b) => order[a.state] - order[b.state] || b.n - a.n) });
  }

  on(h: Handler) { this.handlers.push(h); }
  private emit(m: ServerMsg) { for (const h of this.handlers) h(m); }

  connect() {
    setTimeout(() => { this.onOpen?.(); this.emit({ t: 'hello', nonce: 'demo', requireWallet: false, allowGuests: true, holdMinUsd: 50 }); this.emitPot(); }, 50);
    setInterval(() => this.emitPot(), 2000);
    setTimeout(() => this.emitLobby(), 60);
    setInterval(() => this.emitLobby(), 1000);
    const fee = () => {
      const whale = Math.random() < 0.08, sol = whale ? 0.4 + Math.random() * 2.2 : 0.004 + Math.random() * 0.07, add = BigInt(Math.round(sol * 1e9));
      this.lamports += add;
      this.emit({ t: 'inflow', inflow: { lamports: add.toString(), at: Date.now(), source: whale ? 'whale buy' : 'trading fees' } });
      setTimeout(fee, 1200 + Math.random() * 3000);
    };
    setTimeout(fee, 900);
  }

  private emitPot() {
    const epoch = epochOf(Date.now());
    const top = [...this.tickets.entries()].map(([wallet, t]) => ({ wallet, name: t.name, wins: t.wins })).sort((a, b) => b.wins - a.wins).slice(0, 8);
    this.emit({ t: 'pot', pot: { epoch, epochEndMs: epochEnd(epoch), lamports: this.lamports.toString(), rolloverLamports: '0', commit: '', online: 1287 + Math.floor(Math.random() * 40), rooms: 31 + Math.floor(Math.random() * 4), tickets: top, closeFrom: epochEnd(epoch) - 30 * 60_000, holdTokens: 50_000, symbol: 'KING', solUsd: 150 } });
  }

  send(m: ClientMsg) {
    switch (m.t) {
      case 'guest': {
        const name = (m.name || 'guest').slice(0, 14);
        this.me = { id: 1, num: playerNumber(Math.floor(Math.random() * 456)), name, verified: true, team: 0 };
        this.emit({ t: 'authed', name, wallet: this.myWallet, num: this.me.num });
        break;
      }
      case 'queue': {
        if (!this.me || this.room) break;
        this.me.skin = Math.max(0, Math.min(4, Math.floor(Number(m.skin)) || 0));
        const picked = this.fake.find((r) => r.id === m.room && r.state === 'waiting');
        this.openRoom(picked ? picked.mode : MODE_IDS.includes(m.mode as Mode) ? m.mode! : 'solo', picked?.id);
        if (picked) this.fake = this.fake.filter((r) => r !== picked);
        break;
      }
      case 'spec': this.spectate(m); break;
      case 'leave': this.closeRoom(); break;
      case 'in': this.mine.push(sanitizeInput(m)); break;
    }
  }

  private announce(state: 'waiting' | 'countdown' | 'live' | 'over', startsAt: number | null) {
    const r = this.room!;
    this.emit({ t: 'room', roomId: r.id, you: 1, seats: r.seats, state, startsAt, seed: r.seed, mode: r.mode });
  }

  private openRoom(mode: Mode, id?: string) {
    this.me!.team = 0;
    const room = { id: id ?? Math.random().toString(16).slice(2, 10), seed: Math.floor(Math.random() * 2 ** 31), mode, seats: [this.me!], bots: [] as Bot[], sim: null as Sim | null, timers: [] as number[] };
    this.room = room;
    this.emit({ t: 'queued', position: 1 });
    this.announce('waiting', null);
    let delay = 200;
    const total = Math.min(ROOM_MAX, DEMO_PLAYERS);
    for (let i = 0; i < total - 1; i++) {
      delay += 40 + Math.random() * 90;
      room.timers.push(window.setTimeout(() => {
        const id = i + 2;
        room.seats.push({ id, num: playerNumber(Math.floor(Math.random() * 456)), name: NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), verified: true, team: 0, skin: Math.floor(Math.random() * 5) });
        room.bots.push(newBot(id, Math.random));
        if (room.seats.length < total) this.announce('waiting', null);
        else { this.announce('countdown', Date.now() + COUNTDOWN_MS); room.timers.push(window.setTimeout(() => this.startRound(), COUNTDOWN_MS)); }
      }, delay));
    }
  }

  private startRound() {
    const r = this.room!;
    r.sim = new Sim(r.seed);
    const teams = makeTeams(r.seats.map((s) => ({ id: s.id, party: '' })), MODES[r.mode].size);
    r.seats = r.seats.map((s) => ({ ...s, team: teams.get(s.id)! }));
    r.sim.spawn(r.seats.map((s) => s.id), teams);
    teamDrops(r.bots, teams, Math.random);
    this.mine = new InputQueue(emptyInput(), TICK_HZ); this.killer = null; this.teamPlace = new Map(); this.free = null; this.viewer = { lootVer: -1, lootAt: -9 };
    this.announce('live', null);
    this.loop = window.setInterval(() => this.step(), 1000 / TICK_HZ);
  }

  private step() {
    const r = this.room;
    if (!r || !r.sim) return;
    const sim = r.sim;
    const inputs: TickInputs = new Map();
    inputs.set(1, this.mine.next()); // the same rules as the server (shared/src/inputq.ts)
    for (const b of r.bots) if (sim.players.get(b.id)?.alive) inputs.set(b.id, botInput(b, sim));
    for (const e of sim.step(1 / TICK_HZ, inputs)) {
      if (e.kind === 'elim') {
        if (e.victim === 1) this.killer = e.by;
        const team = sim.players.get(e.victim)?.team, alive = sim.teamsAlive;
        if (team !== undefined && !alive.has(team) && !this.teamPlace.has(team)) this.teamPlace.set(team, alive.size + 1);
        this.emit({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: sim.alive, head: e.head });
      } else if (e.kind === 'hit') { if (e.victim === 1 || e.by === 1) this.emit({ t: 'event', ...e }); }
      else if (e.kind === 'vhit') { if (e.by === 1) this.emit({ t: 'event', ...e }); }
      else this.emit({ t: 'event', ...e } as ServerMsg);
    }
    if (sim.tick % SNAP_EVERY === 0) {
      let watch = 1;
      const me = sim.players.get(1)!;
      if (!me.alive) {
        if (this.killer === null || !sim.players.get(this.killer)?.alive) this.killer = this.mate(sim) ?? [...sim.players.values()].find((p) => p.alive)?.id ?? 1;
        watch = this.killer;
        if (this.free && this.mate(sim) !== undefined) this.free = null;
      }
      const keep = new Set([...sim.players.values()].filter((p) => p.alive && p.team === me.team && p.id !== 1).map((p) => p.id));
      this.emit(snapFor(frame(sim), 1, watch, this.viewer, { at: this.free, keep }));
    }
    if (sim.teamsAlive.size <= 1) this.finish();
  }

  private mate(sim: Sim) { const me = sim.players.get(1)!; return [...sim.players.values()].find((p) => p.alive && p.team === me.team && p.id !== 1)?.id; }

  // same rules as the server: teammates first, free camera only once your team is out
  private spectate(m: Extract<ClientMsg, { t: 'spec' }>) {
    const sim = this.room?.sim, me = sim?.players.get(1);
    if (!sim || !me || me.alive) return;
    const mate = this.mate(sim);
    if (m.at !== undefined) {
      if (m.at === null || mate !== undefined) { this.free = null; return; }
      this.free = { x: Math.max(-MAP_HALF, Math.min(MAP_HALF, m.at[0])), z: Math.max(-MAP_HALF, Math.min(MAP_HALF, m.at[1])) };
      return;
    }
    this.free = null;
    const pool = [...sim.players.values()].filter((p) => p.alive && (mate === undefined || p.team === me.team)).map((p) => p.id).sort((a, b) => a - b);
    if (!pool.length) return;
    if (m.target !== undefined && pool.includes(m.target)) { this.killer = m.target; return; }
    const cur = pool.indexOf(this.killer ?? -1);
    this.killer = pool[cur < 0 ? 0 : (cur + (m.dir === -1 ? -1 : 1) + pool.length) % pool.length];
  }

  private finish() {
    const r = this.room!, sim = r.sim!;
    clearInterval(this.loop);
    const team = [...sim.teamsAlive][0];
    const winners = team === undefined ? [] : [...sim.players.values()].filter((p) => p.team === team).map((p) => p.id);
    if (team !== undefined) this.teamPlace.set(team, 1);
    const points: Record<number, number> = {};
    const field = new Set([...sim.players.values()].map((p) => p.team)).size;
    for (const p of sim.players.values()) {
      const pts = matchPoints(r.mode, this.teamPlace.get(p.team) ?? 0, p.kills, winners.includes(p.id), field);
      points[p.id] = pts;
      if (!pts) continue;
      const seat = r.seats.find((s) => s.id === p.id)!;
      const key = p.id === 1 ? this.myWallet : `bot-${seat.name}`;
      const t = this.tickets.get(key) ?? { name: seat.name, wins: 0 };
      t.wins += pts; this.tickets.set(key, t);
    }
    this.emit({ t: 'result', winner: winners[0] ?? null, winners, points, awarded: true, epoch: epochOf(Date.now()) });
    this.emitPot();
    r.timers.push(window.setTimeout(() => this.closeRoom(), RESULT_MS - 300)); // free the seat before the client shows the lobby
  }

  private closeRoom() {
    if (!this.room) return;
    for (const t of this.room.timers) clearTimeout(t);
    clearInterval(this.loop);
    this.room = null;
  }
}
