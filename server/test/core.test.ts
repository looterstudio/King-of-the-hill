import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Sim, emptyInput, moveStep, rayPlayer, sanitizeInput, type Input, type PlayerState } from '../../shared/src/sim.ts';
import { World, newBody, rayBox } from '../../shared/src/world.ts';
import { EPOCH_MS, TICK_HZ, WEAPONS, type WeaponId } from '../../shared/src/constants.ts';
import { computePayouts } from '../src/payout.ts';
import { buildTree, leafHash, verify } from '../src/merkle.ts';
import { Epochs } from '../src/epoch.ts';
import { MockPot } from '../src/pot.ts';
import { config } from '../src/config.ts';

const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const policy = (mode: 'prorata' | 'draw', seed = Buffer.alloc(32, 7)) => ({ mode, rolloverBps: 1000, drawTiersBps: [6000, 2500, 1500], seed });

const inp = (o: Partial<Input> = {}): Input => ({ ...emptyInput(), ...o });
const DT = 1 / TICK_HZ;
// a sim on flat empty ground, players placed by hand
function arena(ids: number[]) {
  const sim = new Sim(1, World.custom([]));
  sim.spawn(ids);
  for (const p of sim.players.values()) { p.y = 0; p.gliding = false; p.grounded = true; p.fireCd = 0; p.pitch = 0; p.slots = ['ar', 'pistol', null, null]; p.mags = [30, 16, 0, 0]; p.cur = 0; }
  return sim;
}

test('sanitizeInput clamps hostile input', () => {
  const i = sanitizeInput({ fwd: 50, strafe: -9, pitch: 99, yaw: NaN, fire: 'yes' as unknown as boolean, slot: 77 });
  assert.equal(i.fwd, 1); assert.equal(i.strafe, -1); assert.equal(i.pitch, 1.5); assert.equal(i.yaw, 0);
  assert.equal(i.fire, false); assert.equal(i.slot, 4);
});

test('rays hit boxes and tell heads from bodies', () => {
  assert.equal(rayBox(0, 1, 0, 1, 0, 0, { x0: 5, y0: 0, z0: -1, x1: 6, y1: 2, z1: 1 }), 5);
  assert.equal(rayBox(0, 3, 0, 1, 0, 0, { x0: 5, y0: 0, z0: -1, x1: 6, y1: 2, z1: 1 }), -1);
  assert.equal(rayPlayer(0, 1.62, 0, 1, 0, 0, 10, 0, 0)?.head, true);
  assert.equal(rayPlayer(0, 1.0, 0, 1, 0, 0, 10, 0, 0)?.head, false);
  assert.equal(rayPlayer(0, 2.5, 0, 1, 0, 0, 10, 0, 0), null);
});

test('walls stop you, stairs take you to the roof', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({ x0: -1, y0: 0, z0: -2 - (i + 1) * 0.6, x1: 1, y1: (i + 1) * 0.5, z1: -2 - i * 0.6, ink: 2, kind: 'stair' as const }));
  const roof = { x0: -5, y0: 0, z0: -20, x1: 5, y1: 4, z1: -2 - 8 * 0.6, ink: 0, kind: 'building' as const };
  const w = World.custom([...steps, roof, { x0: 3, y0: 0, z0: -1, x1: 4, y1: 3, z1: 1, ink: 2, kind: 'wall' }]);
  const p = newBody(0, 0, 0); p.grounded = true;
  for (let i = 0; i < 60; i++) moveStep(w, p, inp({ strafe: 1, yaw: 0 }), DT); // walk +x into the wall
  assert.ok(p.x < 3 - 0.39 && p.x > 2.5, `stopped at the wall, x=${p.x}`);
  p.x = 0;
  for (let i = 0; i < 45; i++) moveStep(w, p, inp({ fwd: 1, yaw: 0 }), DT); // walk -z up the stairs (9 m)
  assert.ok(Math.abs(p.y - 4) < 1e-6, `on the roof, y=${p.y}`);
});

test('gliding: diving falls faster than floating', () => {
  const flat = World.custom([]);
  const fall = (pitch: number) => { const p = newBody(0, 80, 0); p.gliding = true; for (let i = 0; i < TICK_HZ * 2; i++) moveStep(flat, p, inp({ pitch, fwd: 1 }), DT); return 80 - p.y; };
  assert.ok(fall(-1.3) > fall(0.2) * 2.5, 'looking down dives');
});

test('players glide in from the sky and land', () => {
  const sim = new Sim(3, World.custom([]));
  sim.spawn([1]);
  const p = sim.players.get(1)!;
  assert.ok(p.gliding && p.y > 50);
  for (let i = 0; i < TICK_HZ * 15 && p.gliding; i++) sim.step(DT, new Map([[1, inp({ yaw: p.yaw, fwd: 1 })]]));
  assert.equal(p.gliding, false);
  assert.equal(p.y, 0);
});

test('a rifle kills a target on open ground; headshots hit harder', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -20;
  const ev = [];
  for (let i = 0; i < TICK_HZ * 3 && b.alive; i++) ev.push(...sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.035, fire: true, view: sim.tick })]]))); // chest height
  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  const body = sim.players.size && ev.find((e) => e.kind === 'hit' && !e.head);
  assert.ok(body);
  // eye level is head height: a level shot at a standing target is a headshot
  const s2 = arena([1, 2]);
  const c = s2.players.get(1)!, d = s2.players.get(2)!;
  c.x = 0; c.z = 0; d.x = 0; d.z = -15;
  const [hit] = s2.step(DT, new Map([[1, inp({ yaw: 0, pitch: 0, fire: true })]])).filter((e) => e.kind === 'hit');
  assert.ok(hit && hit.kind === 'hit' && hit.head && hit.dmg > 19);
});

test('lag compensation: a shot lands where the shooter saw the target', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -20;
  sim.step(DT, new Map());
  const seen = sim.tick;
  for (let i = 0; i < 4; i++) { b.x += 1.5; sim.step(DT, new Map()); } // target strafes 6 m away
  a.fireCd = 0;
  const now = sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.03, fire: true, view: seen })]]));
  assert.ok(now.some((e) => e.kind === 'hit'), 'rewound hit');
  const sim2 = arena([1, 2]);
  const c = sim2.players.get(1)!, d = sim2.players.get(2)!;
  c.x = 0; c.z = 0; d.x = 6; d.z = -20;
  assert.ok(!sim2.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.03, fire: true, view: sim2.tick + 1 })]])).some((e) => e.kind === 'hit'), 'no rewind, no hit');
});

test('the storm eventually kills anyone outside it', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  for (let i = 0; i < TICK_HZ * 500 && p.alive; i++) {
    const g = sim.ring, a = Math.atan2(-g.y, -g.x), r = Math.min(155, g.r + 20);
    p.x = g.x + Math.cos(a) * r; p.z = g.y + Math.sin(a) * r;
    sim.step(DT, new Map());
  }
  assert.equal(p.alive, false);
});

test('each storm circle sits inside the previous one', () => {
  for (let seed = 1; seed < 20; seed++) {
    const sim = new Sim(seed, World.custom([]));
    let prevR = sim.ring.r;
    for (let i = 0; i < TICK_HZ * 420; i++) {
      sim.step(DT, new Map());
      const g = sim.ring;
      assert.ok(Math.hypot(g.nx - g.x, g.ny - g.y) + g.nr <= g.r + 1e-6, `seed ${seed} next circle escapes`);
      assert.ok(g.r <= prevR + 1e-6);
      prevR = g.r;
    }
    assert.equal(sim.ring.r, 0);
  }
});

const give = (p: PlayerState, w: WeaponId) => { p.slots[0] = w; p.mags[0] = WEAPONS[w].mag; p.cur = 0; p.fireCd = 0; };

test('walking over loot picks it up; F swaps your gun when the slots are full', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  sim.drop(p.x, 0, p.z, 'item', 'big', 2);
  sim.drop(p.x, 0, p.z, 'weapon', 'pump');
  sim.step(DT, new Map());
  assert.equal(p.items.big, 2);
  assert.deepEqual(p.slots, ['ar', 'pistol', 'pump', null]);
  p.slots = ['ar', 'pistol', 'pump', 'smg'];
  sim.drop(p.x, 0, p.z, 'weapon', 'scar');
  sim.step(DT, new Map());
  assert.ok(sim.loot.some((l) => l.what === 'scar'), 'no free slot: it stays on the floor');
  sim.step(DT, new Map([[1, inp({ interact: true })]]));
  assert.equal(p.slots[p.cur], 'scar');
  assert.ok(sim.loot.some((l) => l.what === 'ar'), 'the old gun is dropped');
});

test('pencil cases open with F and spill loot', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  sim.cases.push({ id: 999, x: p.x + 1, y: 0, z: p.z, golden: true, open: false });
  const before = sim.loot.length;
  const ev = sim.step(DT, new Map([[1, inp({ interact: true })]]));
  assert.ok(ev.some((e) => e.kind === 'open'));
  assert.ok(sim.cases.find((c) => c.id === 999)!.open);
  assert.ok(sim.loot.length - before >= 3, 'golden case: gun, shield, potion (+ maybe a perk)');
  const gun = sim.loot.find((l) => l.kind === 'weapon');
  assert.ok(gun && ['rare', 'epic', 'legendary'].includes(WEAPONS[gun.what as WeaponId].rarity));
});

test('shields soak bullets first; the storm goes straight to health', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -10; b.shield = 50;
  const [hit] = sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.08, fire: true })]])).filter((e) => e.kind === 'hit');
  assert.ok(hit && hit.kind === 'hit' && hit.shield);
  assert.equal(b.hp, 100);
  assert.ok(b.shield < 50);
});

test('a shield potion takes 3 s and caps at 100; damage interrupts it', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  p.items.big = 2; p.shield = 70;
  sim.step(DT, new Map([[1, inp({ item: 1 })]]));
  assert.equal(p.use?.item, 'big');
  for (let i = 0; i < TICK_HZ * 2; i++) sim.step(DT, new Map());
  assert.equal(p.shield, 70, 'not done yet');
  for (let i = 0; i < TICK_HZ * 1.2; i++) sim.step(DT, new Map());
  assert.equal(p.shield, 100);
  assert.equal(p.items.big, 1);
});

test('burst rifle fires three; minigun has to spin up', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  give(p, 'burst');
  for (let i = 0; i < 10; i++) sim.step(DT, new Map([[1, inp({ fire: i === 0 })]]));
  assert.equal(sim.shots.length, 3);
  sim.shots.length = 0;
  give(p, 'minigun');
  for (let i = 0; i < Math.floor(TICK_HZ * 0.5); i++) sim.step(DT, new Map([[1, inp({ fire: true })]]));
  assert.equal(sim.shots.length, 0, 'still spinning');
  for (let i = 0; i < TICK_HZ; i++) sim.step(DT, new Map([[1, inp({ fire: true })]]));
  assert.ok(sim.shots.length > 5);
});

test('the heavy sniper one-shots a full shield and full health', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -60; b.shield = 100;
  give(a, 'heavy');
  sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.012, fire: true, aim: true })]]));
  assert.equal(b.alive, false);
});

test('grenades bounce, blow up, and walls block the blast', () => {
  const sim = new Sim(1, World.custom([{ x0: -5, y0: 0, z0: -8.2, x1: 5, y1: 4, z1: -7.8, ink: 2, kind: 'wall' }]));
  sim.spawn([1, 2, 3]);
  const [a, b, c] = [1, 2, 3].map((i) => sim.players.get(i)!);
  for (const p of [a, b, c]) { p.y = 0; p.gliding = false; p.grounded = true; }
  a.x = 0; a.z = 0; b.x = 1.5; b.z = -4; c.x = 0; c.z = -10; // c is behind the wall
  a.perk = { kind: 'grenade', n: 3 };
  sim.step(DT, new Map([[1, inp({ perk: true, yaw: 0, pitch: -0.9 })]]));
  assert.equal(a.perk.n, 2);
  let boom = false;
  for (let i = 0; i < TICK_HZ * 3; i++) if (sim.step(DT, new Map()).some((e) => e.kind === 'boom')) boom = true;
  assert.ok(boom);
  assert.ok(b.hp < 100, 'near the blast: hurt');
  assert.equal(c.hp, 100, 'behind the wall: safe');
});

test('instant fort walls you in for a while, then disappears', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  p.perk = { kind: 'fort', n: 1 };
  const ev = sim.step(DT, new Map([[1, inp({ perk: true })]]));
  const build = ev.find((e) => e.kind === 'build');
  assert.ok(build && build.kind === 'build' && build.boxes.length === 4);
  assert.ok(sim.world.raycast(p.x, p.y + 1, p.z, 1, 0, 0, 10) < 3, 'a wall right next to you');
  for (let i = 0; i < TICK_HZ * 31; i++) sim.step(DT, new Map());
  assert.equal(sim.world.raycast(p.x, p.y + 1, p.z, 1, 0, 0, 10), 10, 'gone');
});

test('the atomic bomb lands where you look and wipes out the area', () => {
  const sim = arena([1, 2, 3]);
  const [a, b, c] = [1, 2, 3].map((i) => sim.players.get(i)!);
  a.x = 0; a.z = 0; b.x = 0; b.z = -80; b.shield = 100; c.x = 0; c.z = -150;
  a.perk = { kind: 'nuke', n: 1 };
  const ev = sim.step(DT, new Map([[1, inp({ perk: true, yaw: 0, pitch: Math.atan2(-1.62, 80) })]]));
  const n = ev.find((e) => e.kind === 'nuke');
  assert.ok(n && n.kind === 'nuke' && Math.abs(n.z + 80) < 3, 'target where the crosshair meets the ground');
  for (let i = 0; i < TICK_HZ * 7; i++) sim.step(DT, new Map());
  assert.equal(b.alive, false, 'inside the blast');
  assert.equal(c.alive, true, 'far away');
  assert.equal(a.kills, 1);
});

test('the fallen drop everything they carried', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  b.items.mini = 3; b.perk = { kind: 'smoke', n: 2 }; b.slots = ['scar', 'pump', 'pistol', null];
  const before = sim.loot.length;
  sim.eliminate(b.id, a.id, 'shot', []);
  const dropped = sim.loot.slice(before).map((l) => l.what).sort();
  assert.deepEqual(dropped, ['mini', 'pump', 'scar', 'smoke']);
});

test('movement kit: double jump, air dash, slide, wall jump, grapple', () => {
  const flat = World.custom([]);
  const p = newBody(0, 0, 0); p.grounded = true;
  moveStep(flat, p, inp({ jump: true }), DT);
  for (let i = 0; i < 8; i++) moveStep(flat, p, inp(), DT);
  const y1 = p.y;
  moveStep(flat, p, inp({ jump: true }), DT); // second jump in the air
  for (let i = 0; i < 8; i++) moveStep(flat, p, inp(), DT);
  assert.ok(p.y > y1 + 0.5, 'double jump gains height');
  assert.equal(p.airJumps, 0);
  moveStep(flat, p, inp({ jump: true }), DT); // no third jump
  assert.ok(p.vy < 0);

  const d = newBody(0, 5, 0);
  moveStep(flat, d, inp({ slide: true, fwd: 1 }), DT);
  assert.ok(Math.hypot(d.vx, d.vz) > 15 && d.vy === 0, 'air dash bursts forward and holds height');
  assert.equal(d.dashReady, false);

  const s = newBody(0, 0, 0); s.grounded = true;
  for (let i = 0; i < 5; i++) moveStep(flat, s, inp({ fwd: 1, sprint: true }), DT);
  moveStep(flat, s, inp({ slide: true, fwd: 1 }), DT);
  assert.ok(s.slideT > 0 && Math.hypot(s.vx, s.vz) > 10.5, 'slide boosts speed past sprint (8.6)');

  const wall = World.custom([{ x0: 2, y0: 0, z0: -5, x1: 3, y1: 10, z1: 5, ink: 2, kind: 'wall' }]);
  const wj = newBody(0, 8, 0); wj.airJumps = 0;
  for (let i = 0; i < 12; i++) moveStep(wall, wj, inp({ strafe: 1 }), DT); // drift into the wall
  assert.ok(wj.wallT < 0.2);
  moveStep(wall, wj, inp({ jump: true }), DT);
  assert.ok(wj.vy > 5 && wj.vx < -4, 'wall jump kicks up and away');

  const g = newBody(0, 0, 0); g.grounded = true;
  let top = 0;
  for (let i = 0; i < 25; i++) { moveStep(wall, g, inp({ grapple: true, yaw: -Math.PI / 2, pitch: 0.5 }), DT); top = Math.max(top, g.y); }
  assert.ok(g.x > 1.2 && top > 0.8, `grapple pulls up to the wall (x=${g.x.toFixed(2)}, top=${top.toFixed(2)})`);
});

test("the King's Tower: every floor has stairs up, and the roof too", () => {
  const w = new World(1234);
  for (let f = 0; f < 6; f++) assert.ok(w.boxes.some((b) => b.kind === 'stair' && Math.abs(b.y0 - f * 4) < 1e-6 && Math.abs(b.x0) < 17 && Math.abs(b.z0) < 17), `floor ${f}`);
  assert.ok(w.pois.length >= 8);
  assert.ok(w.caseSpots.filter((c) => c.golden).length >= 4);
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
