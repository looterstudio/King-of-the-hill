// A live match: the simulation, per-player input queues, snapshots and events. It knows nothing
// about sockets; everything it wants sent comes out as (targets, json) pairs. That is what lets
// matches run on worker threads (one per core) while the main thread owns the connections.
import { EYE_H, HEAD_Y, MAP_HALF, ROUND_MAX_MS, SNAP_EVERY, TICK_HZ, VIEW_RANGE } from '../../shared/src/constants.ts';
import { Sim, emptyInput, type Input, type PlayerState, type SimEvent } from '../../shared/src/sim.ts';
import { frame, frameJson, snapJsonFor, type Viewer } from '../../shared/src/snap.ts';
import { Watchdog, type Flag } from './anticheat.ts';

// targets: 'all' = everyone still in the match; otherwise player ids. drop = may be skipped for a slow client
export interface Send { to: 'all' | number[]; json: string; drop?: boolean }
export interface Outbound { roomId: string; sends: Send[]; ended?: { winners: number[] }; flags?: Flag[] }
export interface SpecRequest { dir?: 1 | -1; target?: number; at?: [number, number] | null }

// anti-wallhack: enemies farther than this are only sent while there is a line of sight to them
const LOS_FROM = 40;
const LOS_GRACE_TICKS = TICK_HZ;   // once seen, keep sending for a second (corners, lag)
const LOS_NEAR_TICKS = 4;          // pairs closer than 90 m are re-checked every 2nd snapshot
const LOS_FAR_TICKS = 10;          // farther ones every 5th
const LOS_BUDGET = 450;            // rays per snapshot per match; unchecked pairs are sent (fail open)

class Seat {
  queue: Input[] = [];
  last: Input = emptyInput();
  present = true;
  viewer: Viewer = { lootVer: -1, lootAt: -9 };
  free: { x: number; z: number } | null = null; // free spectator camera
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
  watchdog = new Watchdog();
  private watching = new Map<number, number>(); // dead players keep watching a teammate, or whoever got them
  private seen = new Map<number, { last: number; at: number }>(); // pair key -> last tick in sight, last tick checked
  private rays = 0;
  private startedAt: number;
  private teamSize: number;
  ended = false;

  constructor(public roomId: string, seed: number, ids: number[], now: number, teams?: Record<number, number>) {
    this.sim = new Sim(seed);
    const teamOf = teams ? new Map(Object.entries(teams).map(([k, v]) => [Number(k), v])) : undefined;
    this.sim.spawn(ids, teamOf);
    for (const id of ids) this.seats.set(id, new Seat());
    const sizes = new Map<number, number>();
    for (const p of this.sim.players.values()) sizes.set(p.team, (sizes.get(p.team) ?? 0) + 1);
    this.teamSize = Math.max(1, ...sizes.values());
    this.startedAt = now;
  }

  input(id: number, i: Input) {
    if (!this.watchdog.input(id, i.seq, i.yaw, i.pitch, this.sim.tick)) return;
    this.seats.get(id)?.push(i);
  }

  private mateOf(id: number) {
    const me = this.sim.players.get(id);
    if (!me) return undefined;
    for (const p of this.sim.players.values()) if (p.alive && p.team === me.team && p.id !== id) return p.id;
    return undefined;
  }

  // a dead player switches who they watch. With teammates still alive you can only watch them:
  // a free camera would let you call out enemy positions to the living (ghosting).
  spectate(id: number, r: SpecRequest) {
    const me = this.sim.players.get(id), seat = this.seats.get(id);
    if (!me || me.alive || !seat) return;
    const mates = [...this.sim.players.values()].filter((p) => p.alive && p.team === me.team && p.id !== id);
    if (r.at !== undefined) {
      if (r.at === null || mates.length) { seat.free = null; return; }
      const [x, z] = r.at;
      if (Number.isFinite(x) && Number.isFinite(z)) seat.free = { x: Math.max(-MAP_HALF, Math.min(MAP_HALF, x)), z: Math.max(-MAP_HALF, Math.min(MAP_HALF, z)) };
      return;
    }
    seat.free = null;
    const pool = (mates.length ? mates : [...this.sim.players.values()].filter((p) => p.alive)).map((p) => p.id).sort((a, b) => a - b);
    if (!pool.length) return;
    if (r.target !== undefined && pool.includes(r.target)) { this.watching.set(id, r.target); return; }
    const cur = pool.indexOf(this.watching.get(id) ?? -1);
    const step = r.dir === -1 ? -1 : 1;
    this.watching.set(id, pool[cur < 0 ? 0 : (cur + step + pool.length) % pool.length]);
  }

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
        // you watch a living teammate first, otherwise whoever got you
        const next = this.mateOf(e.victim) ?? e.by ?? e.victim;
        for (const [k, v] of this.watching) if (v === e.victim) this.watching.set(k, this.mateOf(k) ?? next);
        this.watching.set(e.victim, next);
        out.push({ to: 'all', json: JSON.stringify({ t: 'event', kind: 'elim', victim: e.victim, by: e.by, cause: e.cause, left: this.sim.alive, head: e.head }) });
      } else if (e.kind === 'hit') {
        this.watchdog.hit(e.by, e.head, this.sim.tick);
        out.push({ to: [e.victim, e.by], json: JSON.stringify({ t: 'event', ...e }) }); // only the two involved care
      } else if (e.kind === 'vhit') out.push({ to: [e.by], json: JSON.stringify({ t: 'event', ...e }) });
      else out.push({ to: 'all', json: JSON.stringify({ t: 'event', ...e }) }); // booms, forts, nukes, opened cases, supply drops
    }
  }

  // anti-wallhack: which enemies `from` cannot see right now. Close ones, gliders and anyone seen
  // in the last second are always sent, so nothing pops in when it matters.
  private hiddenFrom(from: PlayerState, live: PlayerState[]): Set<number> | undefined {
    if (from.gliding || !from.alive) return undefined;
    let hide: Set<number> | undefined;
    const tick = this.sim.tick, ox = from.x, oy = from.y + EYE_H, oz = from.z;
    for (const q of live) {
      if (q.id === from.id || q.team === from.team || q.gliding) continue;
      const dx = q.x - ox, dz = q.z - oz;
      if (Math.abs(dx) > VIEW_RANGE || Math.abs(dz) > VIEW_RANGE || dx * dx + dz * dz < LOS_FROM * LOS_FROM) continue;
      const key = Math.min(from.id, q.id) * 65536 + Math.max(from.id, q.id);
      let rec = this.seen.get(key);
      // visibility is (nearly) symmetric, so one check serves both players of the pair. Pairs seen
      // recently stay visible anyway, so they are not re-checked until the grace runs low.
      const every = dx * dx + dz * dz < 8100 ? LOS_NEAR_TICKS : LOS_FAR_TICKS;
      const due = !rec || (tick - rec.last > LOS_GRACE_TICKS / 2 && tick - rec.at >= every);
      if (due && this.rays < LOS_BUDGET) {
        const vis = this.sees(ox, oy, oz, q);
        rec = { last: vis ? tick : rec?.last ?? -1e9, at: tick };
        this.seen.set(key, rec);
      }
      if (rec && tick - rec.last > LOS_GRACE_TICKS) (hide ??= new Set()).add(q.id);
    }
    return hide;
  }
  private sees(ox: number, oy: number, oz: number, q: PlayerState) {
    const w = this.sim.world;
    for (const ty of [q.y + HEAD_Y, q.y + 0.9]) {
      this.rays++;
      const dx = q.x - ox, dy = ty - oy, dz = q.z - oz, d = Math.hypot(dx, dy, dz);
      if (w.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d) >= d - 0.6) return true;
    }
    return false;
  }

  private snapshot(out: Send[]) {
    const f = frame(this.sim), j = frameJson(f);
    const live = [...this.sim.players.values()].filter((p) => p.alive);
    this.rays = 0;
    for (const [id, seat] of this.seats) {
      if (!seat.present) continue;
      let watch = id;
      const me = this.sim.players.get(id);
      if (me && !me.alive) {
        let w = this.watching.get(id);
        if (w === undefined || !this.sim.players.get(w)?.alive) { w = this.mateOf(id) ?? live[0]?.id ?? id; this.watching.set(id, w); }
        watch = w;
        if (seat.free && this.mateOf(id) !== undefined) seat.free = null; // teammates alive: no free camera
      }
      const eye = this.sim.players.get(watch);
      const hide = seat.free || !eye ? undefined : this.hiddenFrom(eye, live);
      let keep: Set<number> | undefined;
      if (this.teamSize > 1 && me) for (const p of live) if (p.team === me.team && p.id !== id) (keep ??= new Set()).add(p.id);
      out.push({ to: [id], json: snapJsonFor(f, j, id, watch, seat.viewer, { at: seat.free, hide, keep }), drop: true });
    }
  }

  step(now: number): Outbound {
    const out: Send[] = [];
    const inputs = new Map<number, Input>();
    for (const [id, s] of this.seats) if (s.present) inputs.set(id, s.next());
    this.emit(this.sim.step(1 / TICK_HZ, inputs), out);
    if (this.sim.tick % SNAP_EVERY === 0) this.snapshot(out);
    const drained = this.watchdog.drain(), flags = drained.length ? drained : undefined;
    const teams = this.sim.teamsAlive;
    if (teams.size <= 1 || now - this.startedAt > ROUND_MAX_MS) {
      this.snapshot(out);
      this.ended = true;
      return { roomId: this.roomId, sends: out, ended: { winners: this.winners(teams) }, flags };
    }
    return { roomId: this.roomId, sends: out, flags };
  }

  // the last team standing wins: every member of it still connected (fallen teammates helped get
  // there). Time cap with several teams alive: most health + shield wins, a tie means nobody does.
  private winners(teams: Set<number>): number[] {
    let team: number | null = null;
    if (teams.size === 1) team = [...teams][0];
    else if (teams.size > 1) {
      const score = new Map<number, number>();
      for (const p of this.sim.players.values()) if (p.alive) score.set(p.team, (score.get(p.team) ?? 0) + p.hp + p.shield);
      const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked[0][1] > ranked[1][1]) team = ranked[0][0];
    }
    if (team === null) return [];
    const all = [...this.sim.players.values()].filter((p) => p.team === team);
    return (this.teamSize === 1 ? all : all.filter((p) => this.seats.get(p.id)?.present)).map((p) => p.id);
  }
}

// Runs any number of matches on one 30 Hz drift-corrected loop.
export class MatchRunner {
  matches = new Map<string, Match>();
  lastTickMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private next = 0;

  constructor(private deliver: (batch: Outbound[]) => void) {}

  start(roomId: string, seed: number, ids: number[], teams?: Record<number, number>) { this.matches.set(roomId, new Match(roomId, seed, ids, Date.now(), teams)); }
  input(roomId: string, id: number, i: Input) { this.matches.get(roomId)?.input(id, i); }
  spectate(roomId: string, id: number, r: SpecRequest) { this.matches.get(roomId)?.spectate(id, r); }
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
