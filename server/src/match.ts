// A live match: the simulation, per-player input queues, snapshots and events. It knows nothing
// about sockets; everything it wants sent comes out as (targets, json) pairs. That is what lets
// matches run on worker threads (one per core) while the main thread owns the connections.
import { ROUND_MAX_MS, SNAP_EVERY, TICK_HZ } from '../../shared/src/constants.ts';
import { Sim, emptyInput, type Input, type SimEvent } from '../../shared/src/sim.ts';
import { frame, frameJson, snapJsonFor, type Viewer } from '../../shared/src/snap.ts';

// targets: 'all' = everyone still in the match; otherwise player ids. drop = may be skipped for a slow client
export interface Send { to: 'all' | number[]; json: string; drop?: boolean }
export interface Outbound { roomId: string; sends: Send[]; ended?: { winner: number | null } }

class Seat {
  queue: Input[] = [];
  last: Input = emptyInput();
  present = true;
  viewer: Viewer = { lootVer: -1, lootAt: -9 };
  // one input per tick, in order: the client predicts with the same inputs, so none may be skipped
  // or doubled. A client sending faster than 30 Hz only fills the queue; it never moves faster.
  push(i: Input) { this.queue.push(i); if (this.queue.length > 10) this.queue.shift(); }
  next(): Input {
    const i = this.queue.shift();
    if (i) { this.last = i; return i; }
    return { ...this.last, jump: false, slide: false, slot: 0, reload: false, interact: false, item: 0, perk: false }; // late packet: keep walking, don't repeat one-shots
  }
}

export class Match {
  sim: Sim;
  seats = new Map<number, Seat>();
  private watching = new Map<number, number>(); // dead players keep watching whoever got them
  private startedAt: number;
  ended = false;

  constructor(public roomId: string, seed: number, ids: number[], now: number) {
    this.sim = new Sim(seed);
    this.sim.spawn(ids);
    for (const id of ids) this.seats.set(id, new Seat());
    this.startedAt = now;
  }

  input(id: number, i: Input) { this.seats.get(id)?.push(i); }

  leave(id: number, out: Send[]) {
    const s = this.seats.get(id);
    if (!s || !s.present) return;
    s.present = false;
    const ev: SimEvent[] = [];
    this.sim.eliminate(id, null, 'left', ev);
    this.emit(ev, out);
  }

  private emit(ev: SimEvent[], out: Send[]) {
    for (const e of ev) {
      if (e.kind === 'elim') {
        if (e.by !== null) for (const [k, v] of this.watching) if (v === e.victim) this.watching.set(k, e.by);
        this.watching.set(e.victim, e.by ?? e.victim);
        out.push({ to: 'all', json: JSON.stringify({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: this.sim.alive, head: e.head }) });
      } else if (e.kind === 'hit') out.push({ to: [e.victim, e.by], json: JSON.stringify({ t: 'event', ...e }) }); // only the two involved care
      else out.push({ to: 'all', json: JSON.stringify({ t: 'event', ...e }) }); // booms, forts, nukes, opened cases
    }
  }

  private snapshot(out: Send[]) {
    const f = frame(this.sim), j = frameJson(f);
    for (const [id, seat] of this.seats) {
      if (!seat.present) continue;
      let watch = id;
      const me = this.sim.players.get(id);
      if (me && !me.alive) {
        let w = this.watching.get(id);
        if (w === undefined || !this.sim.players.get(w)?.alive) { w = [...this.sim.players.values()].find((p) => p.alive)?.id ?? id; this.watching.set(id, w); }
        watch = w;
      }
      out.push({ to: [id], json: snapJsonFor(f, j, id, watch, seat.viewer), drop: true });
    }
  }

  step(now: number): Outbound {
    const out: Send[] = [];
    const inputs = new Map<number, Input>();
    for (const [id, s] of this.seats) if (s.present) inputs.set(id, s.next());
    this.emit(this.sim.step(1 / TICK_HZ, inputs), out);
    if (this.sim.tick % SNAP_EVERY === 0) this.snapshot(out);
    if (this.sim.alive <= 1 || now - this.startedAt > ROUND_MAX_MS) {
      const alive = [...this.sim.players.values()].filter((p) => p.alive).sort((a, b) => b.hp + b.shield - (a.hp + a.shield));
      // time cap with several alive: most health wins, a tie means nobody does
      const top = alive.length === 1 || (alive.length > 1 && alive[0].hp + alive[0].shield > alive[1].hp + alive[1].shield) ? alive[0] : null;
      this.snapshot(out);
      this.ended = true;
      return { roomId: this.roomId, sends: out, ended: { winner: top ? top.id : null } };
    }
    return { roomId: this.roomId, sends: out };
  }
}

// Runs any number of matches on one 30 Hz drift-corrected loop.
export class MatchRunner {
  matches = new Map<string, Match>();
  lastTickMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private next = 0;

  constructor(private deliver: (batch: Outbound[]) => void) {}

  start(roomId: string, seed: number, ids: number[]) { this.matches.set(roomId, new Match(roomId, seed, ids, Date.now())); }
  input(roomId: string, id: number, i: Input) { this.matches.get(roomId)?.input(id, i); }
  leave(roomId: string, id: number) {
    const m = this.matches.get(roomId);
    if (!m) return;
    const sends: Send[] = [];
    m.leave(id, sends);
    if (sends.length) this.deliver([{ roomId, sends }]);
  }
  get players() { let n = 0; for (const m of this.matches.values()) n += m.seats.size; return n; }

  tick() {
    const t0 = performance.now(), now = Date.now();
    const batch: Outbound[] = [];
    for (const [id, m] of this.matches) {
      const o = m.step(now);
      batch.push(o);
      if (m.ended) this.matches.delete(id);
    }
    if (batch.length) this.deliver(batch);
    this.lastTickMs = performance.now() - t0;
  }

  run() {
    const step = 1000 / TICK_HZ;
    this.next = performance.now();
    const loop = () => {
      this.tick();
      this.next += step;
      const wait = this.next - performance.now();
      if (wait < -step * 5) this.next = performance.now(); // fell far behind: resync instead of spiralling
      this.timer = setTimeout(loop, Math.max(0, wait));
    };
    this.timer = setTimeout(loop, step);
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
}
