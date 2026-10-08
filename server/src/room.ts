// Rooms (max 10 players) and the matchmaker that fills them. One process-wide tick drives every
// room, so a node with 300 live rooms still runs one timer, not 300.
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  COUNTDOWN_MS, FILL_WAIT_MS, RESULT_MS, ROOM_MAX, ROOM_MIN, ROUND_MAX_MS, SNAP_EVERY, TICK_HZ,
} from '../../shared/src/constants.ts';
import type { RoomPhase, RoomSeat, ServerMsg } from '../../shared/src/protocol.ts';
import { Sim, type Input } from '../../shared/src/sim.ts';

const SOFT_BUFFER = 256 * 1024;      // skip snapshots to a client this far behind
const HARD_BUFFER = 2 * 1024 * 1024; // drop a client this far behind

export class Client {
  room: Room | null = null;
  queued = false;
  input: Input = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
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
  sim: Sim | null = null;
  private fillDeadline: number | null = null;
  startsAt: number | null = null;
  private overAt = 0;
  private tick = 0;
  private liveSince = 0;
  verifiedAtStart = 0;
  closed = false;

  constructor(private hooks: RoomHooks) {}

  get open() { return this.phase === 'waiting' && this.seats.length < ROOM_MAX && !this.closed; }

  broadcast(msg: ServerMsg, droppable = false) {
    const s = JSON.stringify(msg);
    for (const c of this.seats) c.sendRaw(s, droppable);
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
    if (this.phase === 'live' && this.sim) {
      const ev: Parameters<Sim['eliminate']>[3] = [];
      this.sim.eliminate(c.id, null, 'left', ev);
      this.emitElims(ev);
      // keep the seat in the list during a live round so the winner check stays honest
      return;
    }
    this.seats = this.seats.filter((s) => s !== c);
    if (this.phase === 'countdown' && this.seats.length < ROOM_MIN) { this.phase = 'waiting'; this.startsAt = null; this.fillDeadline = null; }
    if (this.seats.length === 0) this.closed = true;
    else this.announce();
  }

  private emitElims(ev: ReturnType<Sim['step']>) {
    if (!this.sim) return;
    for (const e of ev) if (e.kind === 'elim') this.broadcast({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: this.sim.alive });
  }

  update(now: number) {
    if (this.closed) return;
    switch (this.phase) {
      case 'waiting': {
        if (this.seats.length >= ROOM_MIN && this.fillDeadline === null) { this.fillDeadline = now + FILL_WAIT_MS; this.announce(); }
        if (this.seats.length < ROOM_MIN) this.fillDeadline = null;
        if (this.seats.length >= ROOM_MAX || (this.fillDeadline !== null && now >= this.fillDeadline)) {
          this.phase = 'countdown'; this.startsAt = now + COUNTDOWN_MS; this.announce();
        }
        break;
      }
      case 'countdown': {
        if (this.startsAt !== null && now >= this.startsAt) {
          this.phase = 'live'; this.liveSince = now;
          this.sim = new Sim(this.seed);
          this.sim.spawn(this.seats.map((c) => c.id));
          this.verifiedAtStart = this.seats.filter((c) => c.wallet).length;
          this.announce();
        }
        break;
      }
      case 'live': {
        const sim = this.sim!;
        const inputs = new Map<number, Input>();
        for (const c of this.seats) if (c.room === this) inputs.set(c.id, c.input);
        this.emitElims(sim.step(1 / TICK_HZ, inputs));
        if (++this.tick % SNAP_EVERY === 0) this.snapshot();
        if (sim.alive <= 1 || now - this.liveSince > ROUND_MAX_MS) this.finish(now);
        break;
      }
      case 'over': {
        if (now >= this.overAt) {
          for (const c of this.seats) if (c.room === this) c.room = null;
          this.closed = true;
        }
        break;
      }
    }
  }

  private snapshot() {
    const sim = this.sim!;
    const r = (v: number) => Math.round(v * 10) / 10;
    this.broadcast({
      t: 'snap', tick: this.tick, time: r(sim.t), ringR: r(sim.ringR),
      players: [...sim.players.values()].map((p) => ({ id: p.id, x: r(p.x), y: r(p.y), aim: Math.round(p.aim * 100) / 100, hp: Math.max(0, Math.ceil(p.hp)), alive: p.alive, dash: p.dashT > 0 })),
      bullets: sim.bullets.map((b) => ({ id: b.id, x: r(b.x), y: r(b.y), vx: r(b.vx), vy: r(b.vy) })),
    }, true);
  }

  private finish(now: number) {
    const sim = this.sim!;
    const alive = [...sim.players.values()].filter((p) => p.alive);
    // time cap with several alive: most hp wins, a tie means nobody does
    alive.sort((a, b) => b.hp - a.hp);
    const top = alive.length === 1 || (alive.length > 1 && alive[0].hp > alive[1].hp) ? alive[0] : null;
    const winner = top ? this.seats.find((c) => c.id === top.id && c.room === this) ?? null : null;
    let res = { awarded: false, epoch: -1 };
    // a ticket needs enough distinct verified wallets at the start, so a 2-wallet room cannot farm wins
    if (winner && winner.wallet && this.verifiedAtStart >= this.hooks.minVerifiedForTicket) res = this.hooks.onWin(this, winner);
    this.phase = 'over'; this.overAt = now + RESULT_MS;
    this.snapshot();
    this.broadcast({ t: 'result', winner: top ? top.id : null, ticketAwarded: res.awarded, epoch: res.epoch });
  }
}

export class Matchmaker {
  rooms = new Map<string, Room>();
  private queue: Client[] = [];
  private timer: NodeJS.Timeout | null = null;
  private next = 0;
  lastTickMs = 0;

  constructor(private hooks: RoomHooks, private maxRooms: number) {}

  enqueue(c: Client) {
    if (c.room || c.queued) return;
    c.queued = true; this.queue.push(c);
    c.send({ t: 'queued', position: this.queue.length });
  }
  dequeue(c: Client) { if (c.queued) { c.queued = false; this.queue = this.queue.filter((q) => q !== c); } }
  leave(c: Client) { this.dequeue(c); c.room?.remove(c); }

  private assign() {
    if (this.queue.length === 0) return;
    // fill the fullest open room first: rooms start sooner and fewer half-empty rooms linger
    const open = [...this.rooms.values()].filter((r) => r.open).sort((a, b) => b.seats.length - a.seats.length);
    while (this.queue.length) {
      let room = open.find((r) => r.open);
      if (!room) {
        if (this.rooms.size >= this.maxRooms) break; // queue waits for capacity
        room = new Room(this.hooks); this.rooms.set(room.id, room); open.push(room);
      }
      const c = this.queue.shift()!;
      c.queued = false;
      if (c.ws.readyState !== c.ws.OPEN) continue;
      room.add(c);
    }
  }

  start() {
    const step = 1000 / TICK_HZ;
    this.next = performance.now();
    const loop = () => {
      const t0 = performance.now();
      this.assign();
      const now = Date.now();
      for (const [id, r] of this.rooms) { r.update(now); if (r.closed) this.rooms.delete(id); }
      this.lastTickMs = performance.now() - t0;
      // drift-corrected: schedule against the ideal timeline, not "33 ms after we finished"
      this.next += step;
      const wait = this.next - performance.now();
      if (wait < -step * 5) this.next = performance.now(); // fell far behind: resync instead of spiralling
      this.timer = setTimeout(loop, Math.max(0, wait));
    };
    this.timer = setTimeout(loop, step);
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  get queued() { return this.queue.length; }
}
