import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Sim, sanitizeInput, segHitsCircle } from '../../shared/src/sim.ts';
import { ARENA_R, EPOCH_MS, PLAYER_HP, TICK_HZ } from '../../shared/src/constants.ts';
import { computePayouts } from '../src/payout.ts';
import { buildTree, leafHash, verify } from '../src/merkle.ts';
import { Epochs } from '../src/epoch.ts';
import { MockPot } from '../src/pot.ts';
import { config } from '../src/config.ts';

const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const policy = (mode: 'prorata' | 'draw', seed = Buffer.alloc(32, 7)) => ({ mode, rolloverBps: 1000, drawTiersBps: [6000, 2500, 1500], seed });

test('sanitizeInput clamps hostile input', () => {
  const i = sanitizeInput({ mx: 50, my: 50, aim: NaN, fire: 'yes' as unknown as boolean });
  assert.ok(Math.hypot(i.mx, i.my) <= 1 + 1e-9);
  assert.equal(i.aim, 0);
  assert.equal(i.fire, false);
});

test('swept bullets cannot tunnel through a player', () => {
  assert.ok(segHitsCircle(-100, 0, 100, 0, 0, 0, 5));
  assert.ok(!segHitsCircle(-100, 20, 100, 20, 0, 0, 5));
});

test('a player shot to zero is eliminated and credited', () => {
  const sim = new Sim(1);
  sim.pillars = [];
  sim.spawn([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  sim.loot = [];
  a.x = 0; a.y = 0; b.x = 200; b.y = 0; a.fireCd = 0;
  const ev = [];
  for (let i = 0; i < TICK_HZ * 4 && b.alive; i++) {
    ev.push(...sim.step(1 / TICK_HZ, new Map([[1, { mx: 0, my: 0, aim: 0, fire: true, dash: false }]])));
    b.x = 200; b.y = 0; // pin the target
  }
  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  assert.ok(ev.some((e) => e.kind === 'elim' && e.victim === 2 && e.by === 1));
});

test('the storm eventually kills anyone outside it', () => {
  const sim = new Sim(2);
  sim.spawn([1]);
  const p = sim.players.get(1)!;
  for (let i = 0; i < TICK_HZ * 200 && p.alive; i++) {
    // stand on the far side of the safe circle
    const g = sim.ring, a = Math.atan2(-g.y, -g.x);
    p.x = Math.cos(a) * (ARENA_R - 30); p.y = Math.sin(a) * (ARENA_R - 30);
    if (Math.hypot(p.x - g.x, p.y - g.y) < g.r) { p.x = g.x + g.r + 40; p.y = g.y; }
    sim.step(1 / TICK_HZ, new Map());
  }
  assert.equal(p.alive, false);
  assert.ok(PLAYER_HP > 0);
});

test('each storm circle sits inside the previous one', () => {
  for (let seed = 1; seed < 30; seed++) {
    const sim = new Sim(seed);
    let prev = { x: sim.ring.x, y: sim.ring.y, r: sim.ring.r };
    for (let i = 0; i < TICK_HZ * 120; i++) {
      sim.step(1 / TICK_HZ, new Map());
      const g = sim.ring;
      assert.ok(Math.hypot(g.nx - g.x, g.ny - g.y) + g.nr <= g.r + 1e-6, `seed ${seed} next circle escapes`);
      assert.ok(g.r <= prev.r + 1e-6);
      prev = { x: g.x, y: g.y, r: g.r };
    }
  }
});

test('loot: pick up a shotgun, it fires pellets and runs dry back to the pistol', () => {
  const sim = new Sim(5);
  sim.pillars = [];
  sim.spawn([1]);
  const p = sim.players.get(1)!;
  sim.loot = [{ id: 1, x: p.x, y: p.y, kind: 'shotgun' }];
  sim.step(1 / TICK_HZ, new Map());
  assert.equal(p.weapon, 'shotgun');
  assert.equal(sim.loot.length, 0);
  p.fireCd = 0;
  sim.step(1 / TICK_HZ, new Map([[1, { mx: 0, my: 0, aim: 0, fire: true, dash: false }]]));
  assert.equal(sim.bullets.length, 6);
  for (let i = 0; i < 400 && p.weapon === 'shotgun'; i++) { p.fireCd = 0; sim.step(1 / TICK_HZ, new Map([[1, { mx: 0, my: 0, aim: 0, fire: true, dash: false }]])); }
  assert.equal(p.weapon, 'pistol');
});

test('armor soaks bullets, medkits heal but never above max', () => {
  const sim = new Sim(6);
  sim.pillars = [];
  sim.spawn([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.y = 0; b.x = 150; b.y = 0; b.armor = 50; a.fireCd = 0;
  for (let i = 0; i < 20 && sim.bullets.length === 0; i++) sim.step(1 / TICK_HZ, new Map([[1, { mx: 0, my: 0, aim: 0, fire: true, dash: false }]]));
  for (let i = 0; i < 10; i++) { b.x = 150; b.y = 0; sim.step(1 / TICK_HZ, new Map()); }
  assert.equal(b.hp, 100);
  assert.ok(b.armor < 50);
  b.hp = 80;
  sim.loot = [{ id: 9, x: b.x, y: b.y, kind: 'medkit' }];
  sim.step(1 / TICK_HZ, new Map());
  assert.equal(b.hp, 100);
});

test('prorata never pays more than the pot and keeps dust in rollover', () => {
  const wins = new Map([[wallet(), 3], [wallet(), 1], [wallet(), 7]]);
  const pot = 1_000_000_007n;
  const r = computePayouts(pot, wins, policy('prorata'));
  const paid = r.payouts.reduce((s, p) => s + p.lamports, 0n);
  assert.equal(paid + r.rollover, pot);
  assert.ok(r.rollover >= pot / 10n);
});

test('no tickets means the whole pot rolls over', () => {
  const r = computePayouts(5n * 10n ** 9n, new Map(), policy('prorata'));
  assert.equal(r.payouts.length, 0);
  assert.equal(r.rollover, 5n * 10n ** 9n);
});

test('draw is deterministic for a seed and pays distinct winners', () => {
  const wins = new Map(Array.from({ length: 20 }, (_, i) => [wallet(), i + 1] as [string, number]));
  const a = computePayouts(10n ** 10n, wins, policy('draw'));
  const b = computePayouts(10n ** 10n, wins, policy('draw'));
  assert.deepEqual(a, b);
  assert.equal(new Set(a.payouts.map((p) => p.wallet)).size, 3);
  assert.equal(a.payouts.reduce((s, p) => s + p.lamports, 0n) + a.rollover, 10n ** 10n);
});

test('every merkle proof verifies for odd and even tree sizes', () => {
  for (const n of [1, 2, 3, 5, 8, 13, 64]) {
    const payouts = Array.from({ length: n }, (_, i) => ({ wallet: wallet(), lamports: BigInt(1000 + i) }));
    const tree = buildTree(42, payouts);
    payouts.forEach((p, i) => assert.ok(verify(leafHash(42, i, p.wallet, p.lamports), tree.proofs[i], tree.root), `n=${n} i=${i}`));
    // a tampered amount must fail
    assert.ok(!verify(leafHash(42, 0, payouts[0].wallet, 999_999n), tree.proofs[0], tree.root));
  }
});

test('epoch rollover settles tickets into a claim file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let now = EPOCH_MS * 100 + 1000;
  const pot = new MockPot(3_000_000_000n);
  const ep = new Epochs({ ...config, dataDir: dir, payoutMode: 'prorata', rolloverBps: 1000 }, pot, () => now);
  const w1 = wallet(), w2 = wallet();
  ep.recordWin(w1, 'a'); ep.recordWin(w1, 'a'); ep.recordWin(w2, 'b');
  let settled: unknown = null;
  ep.on('settled', (s) => { settled = s; });
  now += EPOCH_MS;
  ep.check();
  assert.ok(settled);
  const rec = JSON.parse(readFileSync(join(dir, 'epochs', '100.json'), 'utf8'));
  assert.equal(rec.claims.length, 2);
  assert.equal(BigInt(rec.paid) + BigInt(rec.rollover), 3_000_000_000n);
  // the pot keeps only the rollover once payouts are reserved
  assert.equal(pot.balance(), BigInt(rec.rollover));
  assert.equal(ep.current, 101);
  // a restart replays the wins log without resurrecting the settled epoch's tickets
  const ep2 = new Epochs({ ...config, dataDir: dir }, pot, () => now);
  assert.equal(ep2.leaderboard().length, 0);
});

test('an epoch missed while the server was down settles on boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let now = EPOCH_MS * 200 + 5;
  const pot = new MockPot(1_000_000_000n);
  const ep = new Epochs({ ...config, dataDir: dir }, pot, () => now);
  ep.recordWin(wallet(), 'x');
  now += EPOCH_MS * 2; // down for two boundaries
  const ep2 = new Epochs({ ...config, dataDir: dir }, pot, () => now);
  ep2.catchUp();
  const rec = JSON.parse(readFileSync(join(dir, 'epochs', '200.json'), 'utf8'));
  assert.equal(rec.claims.length, 1);
});

test('hold gate: a one-sample pump does not move the median price', async () => {
  const { PriceFeed } = await import('../src/price.ts');
  let now = 1_000_000;
  const feed = new PriceFeed({ ...config, potSource: 'solana' }, () => now);
  for (let i = 0; i < 20; i++) { feed.push(0.0001); now += 30_000; }
  feed.push(0.01); // 100x spike for one sample
  assert.equal(feed.usd(), 0.0001);
});

test('hold gate fails closed when the price feed goes dark', async () => {
  const { PriceFeed } = await import('../src/price.ts');
  let now = 0;
  const feed = new PriceFeed({ ...config, potSource: 'solana' }, () => now);
  assert.equal(feed.usd(), null);
  feed.push(0.5);
  now += 21 * 60_000;
  assert.equal(feed.usd(), null);
});

test('hold gate: $50 at a given price, rounded up', async () => {
  const { rawNeeded } = await import('../src/price.ts');
  const { fromRaw } = await import('../src/pot.ts');
  // $50 at $0.0001 = 500,000 tokens; pump.fun mints use 6 decimals
  assert.equal(rawNeeded(50, 0.0001, 6), 500_000_000_000n);
  // a price that does not divide evenly rounds up, never down
  const need = rawNeeded(50, 0.0003, 6);
  assert.ok(Number(need) / 1e6 * 0.0003 >= 50);
  assert.ok(Number(need - 1n) / 1e6 * 0.0003 < 50 + 1e-9);
  assert.equal(fromRaw(49_500_000n, 6), '49.5');
  assert.equal(fromRaw(7n, 6), '0.000007');
  assert.equal(fromRaw(500_000_000_000n, 6), '500000');
});
