// Worker thread entry: runs a MatchRunner and talks to the main thread in batches.
import { parentPort } from 'node:worker_threads';
import type { Input } from '../../shared/src/sim.ts';
import { MatchRunner, type SpecRequest } from './match.ts';

export type ToWorker =
  | { t: 'start'; roomId: string; seed: number; ids: number[]; teams?: Record<number, number>; bots?: number[] }
  | { t: 'spec'; roomId: string; id: number; r: SpecRequest }
  | { t: 'inputs'; batch: [string, number, Input][] }
  | { t: 'leave'; roomId: string; id: number };

const port = parentPort!;
const runner = new MatchRunner((batch) => port.postMessage({ t: 'out', batch }));
port.on('message', (m: ToWorker) => {
  if (m.t === 'start') runner.start(m.roomId, m.seed, m.ids, m.teams, m.bots);
  else if (m.t === 'spec') runner.spectate(m.roomId, m.id, m.r);
  else if (m.t === 'inputs') for (const [roomId, id, i] of m.batch) runner.input(roomId, id, i);
  else if (m.t === 'leave') runner.leave(m.roomId, m.id);
});
setInterval(() => port.postMessage({ t: 'stats', tickMs: runner.lastTickMs, players: runner.players, matches: runner.matches.size }), 1000);
runner.run();
