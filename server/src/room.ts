// Rooms (up to 100 players) and the matchmaker that fills them. Waiting rooms and countdowns live
// here on the main thread; once a match goes live it runs on a MatchHost (in-process or on a
// worker thread) and whatever it wants sent comes back to be routed to the right sockets.
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { COUNTDOWN_MS, FILL_WAIT_MS, RESULT_MS, ROOM_MAX, ROOM_MIN, TICK_HZ } from '../../shared/src/constants.ts';
import type { RoomPhase, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import type { MatchHost } from './host.ts';
import type { Outbound } from './match.ts';

const SOFT_BUFFER = 256 * 1024;      // skip snapshots to a client this far behind
const HARD_BUFFER = 2 * 1024 * 1024; // drop a client this far behind

export class Client {
  room: Room | null = null;
  queued = false;
  name = '';
  wallet: string | null = null;
  authed = false;
  tokens: number;
  lastRefill = Date.now();
  constructor(public id: number, public ws: WebSocket, public num: string, public nonce: string, private rate: number) { this.tokens = rate; }

  send(msg: ServerMsg) { this.sendRaw(JSON.stringify(msg)); }
  sendRaw(s: string, droppable = false) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > HARD_BUFFER) { this.ws.terminate(); return; }
    if (droppable && this.ws.bufferedAmount > SOFT_BUFFER) return;
    this.ws.send(s);
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
  onWin(room: Room, winner: Client): { awarded: boolean; epoch: number };
  minVerifiedForTicket: number;
}

export class Room {
  readonly id = randomBytes(4).toString('hex');
  readonly seed = randomBytes(4).readUInt32LE();
  phase: RoomPhase = 'waiting';
  seats: Client[] = [];
  private fillDeadline: number | null = null;
  startsAt: number | null = null;
  private overAt = 0;
  verifiedAtStart = 0;
  closed = false;

  constructor(private hooks: RoomHooks, private host: MatchHost) {}

  get open() { return this.phase === 'waiting' && this.seats.length < ROOM_MAX && !this.closed; }

  broadcast(msg: ServerMsg, droppable = false) {
    const s = JSON.stringify(msg);
    for (const c of this.seats) if (c.room === this) c.sendRaw(s, droppable);
  }

  private seatList(): RoomSeat[] { return this.seats.map((c) => ({ id: c.id, num: c.num, name: c.name, verified: !!c.wallet })); }
  private announce() {
    const seats = this.seatList();
    for (const c of this.seats) c.send({ t: 'room', roomId: this.id, you: c.id, seats, state: this.phase, startsAt: this.startsAt, seed: this.seed });
  }

  add(c: Client) { this.seats.push(c); c.room = this; this.announce(); }

  remove(c: Client) {
    if (c.room !== this) return;
    c.room = null;
    if (this.phase === 'live') { this.host.leave(this.id, c.id); return; } // the seat stays so the winner check stays honest
    this.seats = this.seats.filter((s) => s !== c);
    if (this.phase === 'countdown' && this.seats.length < ROOM_MIN) { this.phase = 'waiting'; this.startsAt = null; this.fillDeadline = null; }
    if (this.seats.length === 0) this.closed = true;
    else if (this.phase !== 'over') this.announce();
  }

  input(c: Client, i: Parameters<MatchHost['input']>[2]) { if (this.phase === 'live') this.host.input(this.id, c.id, i); }

  // what the match wants sent, routed to sockets
  deliver(o: Outbound, now: number) {
    for (const s of o.sends) {
      if (s.to === 'all') { for (const c of this.seats) if (c.room === this) c.sendRaw(s.json, s.drop); }
      else for (const id of s.to) { const c = this.seats.find((x) => x.id === id); if (c && c.room === this) c.sendRaw(s.json, s.drop); }
    }
    if (o.ended) this.finish(o.ended.winner, now);
  }

  update(now: number) {
    if (this.closed) return;
    if (this.phase === 'waiting') {
      if (this.seats.length >= ROOM_MIN && this.fillDeadline === null) { this.fillDeadline = now + FILL_WAIT_MS; this.announce(); }
      if (this.seats.length < ROOM_MIN) this.fillDeadline = null;
      if (this.seats.length >= ROOM_MAX || (this.fillDeadline !== null && now >= this.fillDeadline)) {
        this.phase = 'countdown'; this.startsAt = now + COUNTDOWN_MS; this.announce();
      }
    } else if (this.phase === 'countdown') {
      if (this.startsAt !== null && now >= this.startsAt) {
        this.phase = 'live';
        this.verifiedAtStart = this.seats.filter((c) => c.wallet).length;
        this.host.start(this.id, this.seed, this.seats.map((c) => c.id));
        this.announce();
      }
    } else if (this.phase === 'over' && now >= this.overAt) {
      for (const c of this.seats) if (c.room === this) c.room = null;
      this.closed = true;
    }
  }

  private finish(winnerId: number | null, now: number) {
    const winner = winnerId !== null ? this.seats.find((c) => c.id === winnerId && c.room === this) ?? null : null;
    let res = { awarded: false, epoch: -1 };
    // a ticket needs enough distinct verified wallets at the start, so a few wallets cannot farm wins
    if (winner && winner.wallet && this.verifiedAtStart >= this.hooks.minVerifiedForTicket) res = this.hooks.onWin(this, winner);
    this.phase = 'over'; this.overAt = now + RESULT_MS;
    this.broadcast({ t: 'result', winner: winnerId, ticketAwarded: res.awarded, epoch: res.epoch });
  }
}

export class Matchmaker {
  rooms = new Map<string, Room>();
  private queue: Client[] = [];
  private timer: NodeJS.Timeout | null = null;
  private next = 0;
  lastTickMs = 0;
  host!: MatchHost;

  constructor(private hooks: RoomHooks, private maxRooms: number) {}

  // batches coming back from wherever matches run
  deliver = (batch: Outbound[]) => { const now = Date.now(); for (const o of batch) this.rooms.get(o.roomId)?.deliver(o, now); };

  enqueue(c: Client) {
    if (c.room || c.queued) return;
    c.queued = true; this.queue.push(c);
    c.send({ t: 'queued', position: this.queue.length });
  }
  dequeue(c: Client) { if (c.queued) { c.queued = false; this.queue = this.queue.filter((q) => q !== c); } }
  leave(c: Client) { this.dequeue(c); c.room?.remove(c); }

  private assign() {
    if (this.queue.length === 0) return;
    // fill the fullest open room first: matches start sooner and fewer half-empty rooms linger
    const open = [...this.rooms.values()].filter((r) => r.open).sort((a, b) => b.seats.length - a.seats.length);
    while (this.queue.length) {
      let room = open.find((r) => r.open);
      if (!room) {
        if (this.rooms.size >= this.maxRooms) break; // queue waits for capacity
        room = new Room(this.hooks, this.host); this.rooms.set(room.id, room); open.push(room);
      }
      const c = this.queue.shift()!;
      c.queued = false;
      if (c.ws.readyState !== c.ws.OPEN) continue;
      room.add(c);
    }
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
