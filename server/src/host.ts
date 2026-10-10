// Where live matches run: in this thread (dev, tests, small boxes) or spread over worker threads,
// one per core. Rooms only see this interface.
import { Worker } from 'node:worker_threads';
import type { Input } from '../../shared/src/sim.ts';
import { MatchRunner, type Outbound, type SpecRequest } from './match.ts';
import type { ToWorker } from './matchworker.ts';

export interface MatchHost {
  start(roomId: string, seed: number, ids: number[], teams?: Record<number, number>): void;
  input(roomId: string, id: number, i: Input): void;
  spectate(roomId: string, id: number, r: SpecRequest): void;
  leave(roomId: string, id: number): void;
  stats(): { tickMs: number; workers: number };
}

export class InProcessHost implements MatchHost {
  private runner: MatchRunner;
  constructor(deliver: (b: Outbound[]) => void) { this.runner = new MatchRunner(deliver); this.runner.run(); }
  start(roomId: string, seed: number, ids: number[], teams?: Record<number, number>) { this.runner.start(roomId, seed, ids, teams); }
  input(roomId: string, id: number, i: Input) { this.runner.input(roomId, id, i); }
  spectate(roomId: string, id: number, r: SpecRequest) { this.runner.spectate(roomId, id, r); }
  leave(roomId: string, id: number) { this.runner.leave(roomId, id); }
  stats() { return { tickMs: this.runner.lastTickMs, workers: 0 }; }
}

type Slot = { w: Worker; players: number; tickMs: number; pending: [string, number, Input][]; flush: NodeJS.Timeout | null };

export class WorkerHost implements MatchHost {
  private workers: Slot[] = [];
  private where = new Map<string, number>(); // roomId -> worker index
  private stopped = false;

  constructor(n: number, private deliver: (b: Outbound[]) => void) {
    for (let i = 0; i < n; i++) this.workers.push(this.spawn(i));
  }

  private spawn(i: number): Slot {
    const w = new Worker(new URL('./matchworker-boot.mjs', import.meta.url));
    const slot: Slot = { w, players: 0, tickMs: 0, pending: [], flush: null };
    const bornAt = Date.now();
    w.on('message', (m: { t: 'out'; batch: Outbound[] } | { t: 'stats'; tickMs: number; players: number }) => {
      if (m.t === 'out') { for (const o of m.batch) if (o.ended) this.where.delete(o.roomId); this.deliver(m.batch); }
      else if (this.workers[i] === slot) { slot.tickMs = m.tickMs; slot.players = m.players; }
    });
    w.on('error', (e) => console.error(`[worker ${i}]`, e));
    // a dead worker used to leave its rooms live forever (and new matches kept being sent to it):
    // its matches end without points, the rooms close, and a fresh worker takes the slot
    w.on('exit', (code) => {
      if (this.workers[i] !== slot || this.stopped) return;
      if (slot.flush) clearTimeout(slot.flush);
      const dead = [...this.where].filter(([, at]) => at === i).map(([roomId]) => roomId);
      console.error(`[worker ${i}] exited (${code}), ending ${dead.length} match(es) and starting a new worker`);
      for (const r of dead) this.where.delete(r);
      if (dead.length) this.deliver(dead.map((roomId) => ({ roomId, sends: [], ended: { winners: [], places: {} } })));
      // crash loop guard: a worker that dies right after starting is replaced after a pause, and no
      // match is sent its way meanwhile
      slot.players = Number.MAX_SAFE_INTEGER;
      if (Date.now() - bornAt < 5_000) setTimeout(() => { if (this.workers[i] === slot && !this.stopped) this.workers[i] = this.spawn(i); }, 5_000).unref();
      else this.workers[i] = this.spawn(i);
    });
    return slot;
  }
  private send(i: number, m: ToWorker) { this.workers[i].w.postMessage(m); }
  // tests: what happens when a worker dies
  kill(i: number) { return this.workers[i].w.terminate(); }
  async stop() { this.stopped = true; await Promise.all(this.workers.map((s) => s.w.terminate())); }
  start(roomId: string, seed: number, ids: number[], teams?: Record<number, number>) {
    // the least busy worker takes the new match
    let best = 0;
    this.workers.forEach((w, i) => { if (w.players < this.workers[best].players) best = i; });
    this.workers[best].players += ids.length;
    this.where.set(roomId, best);
    this.send(best, { t: 'start', roomId, seed, ids, teams });
  }
  // inputs are coalesced for a few ms so 30 000 inputs/s become a few hundred messages
  input(roomId: string, id: number, i: Input) {
    const at = this.where.get(roomId);
    if (at === undefined) return;
    const w = this.workers[at];
    w.pending.push([roomId, id, i]);
    if (!w.flush) w.flush = setTimeout(() => { w.flush = null; const batch = w.pending; w.pending = []; this.send(at, { t: 'inputs', batch }); }, 4);
  }
  spectate(roomId: string, id: number, r: SpecRequest) { const at = this.where.get(roomId); if (at !== undefined) this.send(at, { t: 'spec', roomId, id, r }); }
  leave(roomId: string, id: number) { const at = this.where.get(roomId); if (at !== undefined) this.send(at, { t: 'leave', roomId, id }); }
  stats() { return { tickMs: Math.max(0, ...this.workers.map((w) => w.tickMs)), workers: this.workers.length }; }
}
