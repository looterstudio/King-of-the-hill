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
