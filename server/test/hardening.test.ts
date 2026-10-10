// What a hostile client, a dead worker or a slow RPC used to do to the server, and what it does now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { COUNTDOWN_MS, FILL_WAIT_MS, EPOCH_MS } from '../../shared/src/constants.ts';
import { Client, Room } from '../src/room.ts';
import type { MatchHost } from '../src/host.ts';
import { Match, type Outbound } from '../src/match.ts';
import { Epochs } from '../src/epoch.ts';
import { MockPot } from '../src/pot.ts';
import { config } from '../src/config.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a fake socket that records what it was sent
function fakeClient(id: number) {
  const sent: string[] = [];
  const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s: string) => sent.push(s), terminate() {}, close() {} } as unknown as WebSocket;
  const c = new Client(id, ws, String(id), 'n', 30);
  return { c, sent };
}
const fakeHost = () => { const started: string[] = []; return { started, host: { start: (r: string) => started.push(r), input() {}, spectate() {}, leave() {}, stats: () => ({ tickMs: 0, workers: 0 }) } as MatchHost }; };
const hooks = { minVerifiedForTicket: 1, onScore: () => ({ awarded: true, epoch: 1 }) };

test('a squad room with a single team never starts (it used to end on tick 1 with everyone winning)', () => {
  const { host, started } = fakeHost();
  const room = new Room(hooks, host, 'squad');
  const players = [1, 2, 3, 4].map((i) => fakeClient(i));
  for (const p of players) room.add(p.c);
  let now = Date.now();
  for (let t = 0; t < 10; t++) { room.update(now); now += FILL_WAIT_MS / 4 + COUNTDOWN_MS; }
  assert.equal(started.length, 0, 'four solo players are one squad: no match');
  assert.equal(room.phase, 'waiting');
  room.add(fakeClient(5).c);                                   // a fifth makes a second team
  for (let t = 0; t < 10; t++) { room.update(now); now += FILL_WAIT_MS / 4 + COUNTDOWN_MS; }
  assert.equal(started.length, 1);
  assert.equal(room.teamsAtStart, 2);
});

test('seat list goes out once per lobby tick, however many joins and leaves', () => {
  const { host } = fakeHost();
  const room = new Room(hooks, host, 'solo');
  const watcher = fakeClient(1); room.add(watcher.c);
  room.update(Date.now()); watcher.sent.length = 0;
  for (let i = 2; i < 60; i++) { const p = fakeClient(i); room.add(p.c); room.remove(p.c); }
  room.update(Date.now());
  assert.equal(watcher.sent.filter((s) => s.startsWith('{"t":"room"')).length, 1);
  const msg = JSON.parse(watcher.sent.at(-1)!);
  assert.equal(msg.you, 1); assert.equal(msg.seats.length, 1);
});

test('walking out alive costs the placement points (no farming top places from abandoned rooms)', () => {
  const m = new Match('d', 9, [1, 2, 3], Date.now(), { 1: 0, 2: 0, 3: 1 });
  m.leave(1, []);                                              // leaves at the drop, still alive
  m.sim.eliminate(3, 2, 'shot', []);                           // their teammate wins the match
  const o = m.step(Date.now()) as Outbound;
  assert.ok(o.ended);
  assert.equal(o.ended!.places[1][0], 0, 'deserter: no place');
  assert.equal(o.ended!.places[2][0], 1);
  assert.deepEqual(o.ended!.winners, [2]);
});

test('an epoch never settles on a pot that has not been read: points wait instead of vanishing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ready-'));
  class SlowPot extends MockPot { ok = false; ready() { return this.ok; } }
  const pot = new SlowPot(3_000_000_000n);
  let now = EPOCH_MS * 200 + 1000;
  const ep = new Epochs({ ...config, dataDir: dir, payoutMode: 'prorata', rolloverBps: 1000 }, pot, () => now);
  ep.recordWin('11111111111111111111111111111111', 'a', 50);
  now += EPOCH_MS;
  await ep.check();
  assert.deepEqual(readdirSync(join(dir, 'epochs')), [], 'nothing settled while the pot is unread');
  pot.ok = true; now += 6_000;
  await ep.check();
  assert.deepEqual(readdirSync(join(dir, 'epochs')), ['200.json']);
});

test('the server survives a malformed request, an oversized frame and a connection flood', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: mkdtempSync(join(tmpdir(), 'pr-srv-')), WORKERS: '1', MAX_PER_IP: '5', STATIC_DIR: './dist-none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).status;
  try {
    for (let i = 0; i < 100 && !/pot-royale\] :/.test(log); i++) await sleep(100);
    assert.equal(await health(), 200, log);
    // 1. a request line Node accepts but URL() rejects
    await new Promise<void>((done) => { const s = createConnection(port, '127.0.0.1', () => s.end('GET // HTTP/1.1\r\nHost: x\r\n\r\n')); s.on('close', () => done()); s.on('error', () => done()); s.resume(); });
    assert.equal(await health(), 200, 'alive after GET //');
    // 2. one frame over maxPayload
    await new Promise<void>((done) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); ws.on('open', () => ws.send('x'.repeat(17 * 1024))); ws.on('close', () => done()); ws.on('error', () => done()); });
    assert.equal(await health(), 200, 'alive after a 17 KB frame');
    // 3. more sockets than one address may hold
    const socks = await Promise.all(Array.from({ length: 8 }, () => new Promise<number>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let code = 0; ws.on('close', (c) => { code = c; done(code); }); ws.on('error', () => done(-1));
      setTimeout(() => { done(code); ws.terminate(); }, 1500);
    })));
    assert.equal(socks.filter((c) => c === 1013).length, 3, `per-address cap: ${socks}`);
    assert.equal(await health(), 200);
  } finally { srv.kill('SIGKILL'); }
});

test('a worker that dies ends its matches and gets replaced', async () => {
  const { WorkerHost } = await import('../src/host.ts');
  const out: Outbound[] = [];
  const host = new WorkerHost(1, (b) => out.push(...b));
  host.start('r1', 5, [1, 2], { 1: 1, 2: 2 });
  for (let i = 0; i < 100 && !out.some((o) => o.roomId === 'r1'); i++) await sleep(100);
  await host.kill(0);
  for (let i = 0; i < 50 && !out.some((o) => o.roomId === 'r1' && o.ended); i++) await sleep(100);
  assert.ok(out.some((o) => o.roomId === 'r1' && o.ended && o.ended.winners.length === 0), 'the match ended, nobody scored');
  // the new worker (after the crash-loop pause) runs the next match
  await sleep(5_500);
  host.start('r2', 6, [3, 4], { 3: 1, 4: 2 });
  for (let i = 0; i < 100 && !out.some((o) => o.roomId === 'r2'); i++) await sleep(100);
  assert.ok(out.some((o) => o.roomId === 'r2'), 'the replacement worker runs matches');
  await host.stop();
});

// a client predicting with the same code as the browser, against the real Match, over a network
// that delivers in order (TCP) with the given delay pattern
async function predicted(plan: (k: number) => { gen: number; delay: number }, ticks = 600) {
  const { Sim, moveStep, emptyInput } = await import('../../shared/src/sim.ts');
  const KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'gliding', 'airJumps', 'wallX', 'wallZ', 'wallT', 'slideT', 'dashT', 'dashX', 'dashZ', 'dashReady', 'hook', 'gx', 'gy', 'gz', 'hookCd', 'launchT', 'ride', 'head', 'vpitch', 'spd', 'seat', 'down'] as const;
  const copy = (f: Record<string, unknown>, t: Record<string, unknown>) => { for (const k of KEYS) t[k] = f[k]; };
  const world = new Sim(77).world, m = new Match('p', 77, [1, 2], 0, { 1: 0, 2: 1 });
  type In = ReturnType<typeof emptyInput>;
  let pred: Record<string, unknown> | null = null, seq = 0, now = 0, lastAt = 0, worst = 0, n = 0;
  const pending: In[] = [], net: { at: number; i: In }[] = [], snaps: { at: number; body: Record<string, unknown>; ack: number }[] = [];
  for (let k = 0; k < ticks; k++) {
    const { gen, delay } = plan(k);
    for (let g = 0; g < gen && pred; g++) {
      const i = { ...emptyInput(), seq: ++seq, fwd: 1, sprint: true, yaw: 0.3 + Math.sin(seq / 60) * 0.8, pitch: -0.4, jump: seq % 45 === 0 };
      moveStep(world, pred as never, i, 1 / 30); pending.push(i); lastAt = Math.max(lastAt, k + delay); net.push({ at: lastAt, i });
    }
    while (net.length && net[0].at <= k) m.input(1, net.shift()!.i);
    m.step((now += 1000 / 30));
    const p = m.sim.players.get(1)!, body: Record<string, unknown> = {}; copy(p as never, body); snaps.push({ at: k + 2, body, ack: p.ack });
    for (const s of snaps.filter((x) => x.at <= k)) {
      const before = pred ? [pred.x as number, pred.y as number, pred.z as number] : null, base = { ...s.body };
      for (let j = pending.length - 1; j >= 0; j--) if (pending[j].seq <= s.ack) pending.splice(j, 1);
      for (const q of pending) moveStep(world, base as never, q, 1 / 30);
      if (!pred) pred = base; else copy(base, pred);
      if (before && k > 60) { const d = Math.hypot(before[0] - (pred.x as number), before[1] - (pred.y as number), before[2] - (pred.z as number)); if (d > 0.05) { n++; worst = Math.max(worst, d); } }
    }
    for (let j = snaps.length - 1; j >= 0; j--) if (snaps[j].at <= k) snaps.splice(j, 1);
  }
  return { corrections: n, worst, ack: m.sim.players.get(1)!.ack, seq };
}

test('prediction holds with no corrections through a stall, heavy jitter and a slow client timer', async () => {
  for (const [name, plan] of [
    ['steady', () => ({ gen: 1, delay: 2 })],
    ['250 ms stall', (k: number) => ({ gen: 1, delay: k >= 300 && k < 308 ? 310 - k : 2 })],
    ['jitter 1-5 ticks', (k: number) => ({ gen: 1, delay: 1 + ((k * 7919) % 5) })],
    ['timer at 20 Hz, client catches up', (k: number) => ({ gen: k % 3 === 0 ? 0 : k % 3 === 1 ? 2 : 1, delay: 2 })],
    ['client sending 20 inputs/s', (k: number) => ({ gen: k % 3 === 2 ? 0 : 1, delay: 2 })],
  ] as [string, (k: number) => { gen: number; delay: number }][]) {
    const r = await predicted(plan);
    assert.equal(r.corrections, 0, `${name}: ${r.corrections} corrections, worst ${r.worst.toFixed(2)} m`);
    assert.ok(r.seq - r.ack <= 6, `${name}: server ${r.seq - r.ack} inputs behind`);
  }
});

test('a paused player stops, and moves again the moment they come back', async () => {
  const { emptyInput } = await import('../../shared/src/sim.ts');
  const m = new Match('pz', 77, [1, 2], 0, { 1: 0, 2: 1 });
  const me = () => m.sim.players.get(1)!;
  let seq = 0, now = 0;
  const tick = (i?: Partial<ReturnType<typeof emptyInput>>) => { if (i) m.input(1, { ...emptyInput(), seq: ++seq, yaw: 0, ...i }); m.step((now += 1000 / 30)); };
  for (let k = 0; k < 400; k++) tick({ fwd: 1 });                       // land and walk
  for (let k = 0; k < 30; k++) tick({ fwd: 1, fire: true });
  const at = { x: me().x, z: me().z };
  for (let k = 0; k < 90; k++) tick();                                  // 3 s of nothing (Esc, alt-tab)
  const drift = Math.hypot(me().x - at.x, me().z - at.z);
  assert.ok(drift < 6, `kept running ${drift.toFixed(1)} m while paused`);
  const back = { x: me().x, z: me().z };
  for (let k = 0; k < 60; k++) tick({ strafe: 1 });
  assert.ok(Math.hypot(me().x - back.x, me().z - back.z) > 5, 'moves again right away');
  assert.equal(me().ack, seq);
});

test('a wallet profile keeps its record across restarts and knows where it stands this hour', async () => {
  const { Profiles } = await import('../src/profile.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  const p = new Profiles(dir);
  p.match('W1', 1, 4); p.match('W1', 7, 2); p.match('W1', 0, 0); p.prize('W1', 2_500_000_000n);
  p.flush();
  const back = new Profiles(dir).get('W1');
  assert.deepEqual(back, { matches: 3, wins: 1, kills: 6, best: 1, prizes: 1, prizeLamports: '2500000000' });
  assert.equal(new Profiles(dir).get('nobody').matches, 0);
  let now = EPOCH_MS * 900 + 1000;
  const ep = new Epochs({ ...config, dataDir: dir }, new MockPot(), () => now);
  ep.recordWin('A', 'a', 40); ep.recordWin('B', 'b', 125); ep.recordWin('C', 'c', 40);
  assert.deepEqual(ep.standing('B'), { points: 125, rank: 1 });
  assert.deepEqual(ep.standing('A'), { points: 40, rank: 2 }, 'a tie shares the place');
  assert.deepEqual(ep.standing('nobody'), { points: 0, rank: null });
});
