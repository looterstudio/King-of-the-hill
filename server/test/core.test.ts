import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Sim, emptyInput, moveStep, rayPlayer, sanitizeInput, type Input, type PlayerState } from '../../shared/src/sim.ts';
import { World, newBody, rayBox } from '../../shared/src/world.ts';
import { EPOCH_MS, KNOCK, PLAYER_HP, SHIELD_MAX, SLOTS, TICK_HZ, WEAPONS, WEAPON_IDS, type WeaponId } from '../../shared/src/constants.ts';
const SLOTS_AXE = SLOTS + 1;
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
  assert.equal(i.fire, false); assert.equal(i.slot, SLOTS_AXE);
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
    for (let i = 0; i < TICK_HZ * 480; i++) {
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
  assert.equal(b.hp, PLAYER_HP);
  assert.ok(b.shield < 50);
});

test('a shield potion takes 3 s and caps at full; damage interrupts it', () => {
  const sim = arena([1]);
  const p = sim.players.get(1)!;
  p.items.big = 2; p.shield = 200;
  sim.step(DT, new Map([[1, inp({ item: 1 })]]));
  assert.equal(p.use?.item, 'big');
  for (let i = 0; i < TICK_HZ * 2; i++) sim.step(DT, new Map());
  assert.equal(p.shield, 200, 'not done yet');
  for (let i = 0; i < TICK_HZ * 1.2; i++) sim.step(DT, new Map());
  assert.equal(p.shield, SHIELD_MAX);
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

test('a heavy sniper headshot one-shots full shield and health; a body shot does not', () => {
  const sim = arena([1, 2, 3]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!, c = sim.players.get(3)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -60; b.shield = SHIELD_MAX; c.x = 30; c.z = 0; c.shield = SHIELD_MAX;
  give(a, 'heavy');
  sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: 0, fire: true, aim: true })]]));
  assert.equal(b.alive, false);
  for (let i = 0; i < TICK_HZ * 2.2; i++) sim.step(DT, new Map());
  sim.step(DT, new Map([[1, inp({ yaw: -Math.PI / 2, pitch: -0.025, fire: true, aim: true, seq: 2 })]]));
  assert.ok(c.alive && c.shield < SHIELD_MAX, 'body shot: hurt, standing');
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
  assert.ok(b.hp < PLAYER_HP, 'near the blast: hurt');
  assert.equal(c.hp, PLAYER_HP, 'behind the wall: safe');
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

test('epoch rollover settles points into a claim file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let now = EPOCH_MS * 100 + 1000;
  const pot = new MockPot(3_000_000_000n);
  const ep = new Epochs({ ...config, dataDir: dir, payoutMode: 'prorata', rolloverBps: 1000 }, pot, () => now);
  const w1 = wallet(), w2 = wallet();
  ep.recordWin(w1, 'a'); ep.recordWin(w1, 'a'); ep.recordWin(w2, 'b');
  let settled: unknown = null;
  ep.on('settled', (s) => { settled = s; });
  now += EPOCH_MS;
  await ep.check();
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

test('an epoch missed while the server was down settles on boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let now = EPOCH_MS * 200 + 5;
  const pot = new MockPot(1_000_000_000n);
  const ep = new Epochs({ ...config, dataDir: dir }, pot, () => now);
  ep.recordWin(wallet(), 'x');
  now += EPOCH_MS * 2; // down for two boundaries
  const ep2 = new Epochs({ ...config, dataDir: dir }, pot, () => now);
  await ep2.catchUp();
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

test('the server fast-path snapshot is byte-for-byte the same data as the plain one', async () => {
  const { frame, frameJson, snapFor, snapJsonFor } = await import('../../shared/src/snap.ts');
  const sim = new Sim(77);
  sim.spawn([1, 2, 3, 4, 5]);
  for (let i = 0; i < 60; i++) sim.step(DT, new Map([[1, inp({ fire: true, fwd: 1 })], [2, inp({ fwd: 1, yaw: 1 })]]));
  const f = frame(sim), j = frameJson(f);
  for (const id of [1, 3]) {
    const a = snapFor(f, id, id, { lootVer: -1, lootAt: -9 });
    const b = JSON.parse(snapJsonFor(f, j, id, id, { lootVer: -1, lootAt: -9 }));
    assert.deepEqual(b, JSON.parse(JSON.stringify(a)));
  }
});

test('a live match routes snapshots to each player and ends with its winner', async () => {
  const { Match } = await import('../src/match.ts');
  const m = new Match('r1', 5, [1, 2, 3], Date.now());
  let o = m.step(Date.now());
  o = m.step(Date.now()); // tick 2: snapshot
  const snaps = o.sends.filter((s) => s.drop);
  assert.deepEqual(snaps.map((s) => s.to).sort(), [[1], [2], [3]]);
  const out: import('../src/match.ts').Send[] = [];
  m.leave(2, out);
  assert.ok(out.some((s) => s.json.includes('"left"')));
  m.sim.eliminate(3, 1, 'shot', []);
  const end = m.step(Date.now());
  assert.deepEqual(end.ended?.winners, [1]);
  assert.equal(end.ended?.places[1][0], 1, 'the winner placed first');
});

test('breaking a shield is reported once, on the hit that empties it', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -10; b.shield = 20;
  const hits = [];
  for (let i = 0; i < 20 && b.shield > 0; i++) { a.fireCd = 0; hits.push(...sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.08, fire: true })]])).filter((e) => e.kind === 'hit')); }
  assert.equal(hits.filter((h) => h.kind === 'hit' && h.broke).length, 1);
});

test('teams: no friendly fire, grenades spare teammates, the last team standing wins together', async () => {
  const { Match } = await import('../src/match.ts');
  const m = new Match('r2', 9, [1, 2, 3, 4], Date.now(), { 1: 1, 2: 1, 3: 2, 4: 2 });
  m.sim.world = World.custom([]);
  const sim = m.sim, [a, b, c] = [1, 2, 3].map((id) => sim.players.get(id)!);
  for (const p of sim.players.values()) { p.gliding = false; p.y = 0; p.grounded = true; }
  a.x = 0; a.z = 0; b.x = 0; b.z = -6; c.x = 0; c.z = -12;
  a.slots[0] = 'scar'; a.mags[0] = 30; a.fireCd = 0;
  const ev = sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.05, fire: true })]]));
  assert.ok(!ev.some((e) => e.kind === 'hit' && e.victim === 2), 'teammate in the line of fire takes nothing');
  assert.ok(ev.some((e) => e.kind === 'hit' && e.victim === 3), 'the bullet goes through to the enemy behind');
  m.sim.eliminate(3, 1, 'shot', []); m.sim.eliminate(4, 1, 'shot', []); m.sim.eliminate(2, 4, 'shot', []);
  const end = m.step(Date.now());
  assert.deepEqual(end.ended?.winners, [1, 2], 'a fallen teammate still wins with the team');
});

test('parties stay together and solo players fill the gaps', async () => {
  const { makeTeams } = await import('../src/room.ts');
  const t = makeTeams([{ id: 1, party: 'AB' }, { id: 2, party: '' }, { id: 3, party: 'AB' }, { id: 4, party: '' }, { id: 5, party: '' }], 2);
  assert.equal(t.get(1), t.get(3));
  assert.notEqual(t.get(2), t.get(1));
  assert.equal(new Set(t.values()).size, 3);
  const squad = makeTeams(Array.from({ length: 9 }, (_, i) => ({ id: i + 1, party: '' })), 4);
  assert.deepEqual([...squad.values()].sort(), [1, 1, 1, 1, 2, 2, 2, 2, 3]);
});

test('anti-wallhack: an enemy behind a wall is not sent, one in the open is', async () => {
  const { Match } = await import('../src/match.ts');
  const m = new Match('r3', 4, [1, 2, 3], Date.now());
  m.sim.world = World.custom([{ x0: -10, y0: 0, z0: -62, x1: 10, y1: 6, z1: -60, ink: 1, kind: 'wall' }]);
  const [a, b, c] = [1, 2, 3].map((id) => m.sim.players.get(id)!);
  for (const p of m.sim.players.values()) { p.gliding = false; p.y = 0; p.grounded = true; }
  a.x = 0; a.z = 0; b.x = 0; b.z = -80; c.x = 60; c.z = 0;
  let snap: { others: number[][] } | null = null;
  for (let i = 0; i < 4; i++) { const o = m.step(Date.now()); const s = o.sends.find((x) => x.drop && (x.to as number[])[0] === 1); if (s) snap = JSON.parse(s.json); }
  const ids = snap!.others.map((o) => o[0]);
  assert.ok(!ids.includes(2), 'behind the wall');
  assert.ok(ids.includes(3), 'in the open');
});

test('anti-cheat: replayed inputs are dropped and a snap-aimbot gets flagged', async () => {
  const { Watchdog } = await import('../src/anticheat.ts');
  const w = new Watchdog();
  assert.ok(w.input(1, 5, 0, 0, 1));
  assert.ok(!w.input(1, 5, 0, 0, 2), 'same seq twice');
  assert.ok(!w.input(1, 3, 0, 0, 3), 'older seq');
  let seq = 10, tick = 10;
  for (let i = 0; i < 40; i++) { w.input(1, seq++, i % 2 ? 1.2 : -1.2, 0, tick); w.hit(1, i % 3 === 0, tick + 1); tick += 20; }
  assert.ok(w.isFlagged(1));
  const honest = new Watchdog();
  for (let i = 0; i < 60; i++) { honest.input(2, i + 1, i * 0.05, 0, i * 20); honest.hit(2, i % 4 === 0, i * 20 + 10); }
  assert.ok(!honest.isFlagged(2));
});

test('spectating: with a teammate alive you watch them and cannot free-fly', async () => {
  const { Match } = await import('../src/match.ts');
  const m = new Match('r4', 6, [1, 2, 3, 4], Date.now(), { 1: 1, 2: 1, 3: 2, 4: 2 });
  m.sim.eliminate(1, 3, 'shot', []);
  const ev: import('../src/match.ts').Send[] = [];
  m.leave(4, ev); // keeps the match going
  m.spectate(1, { at: [50, 50] });
  m.spectate(1, { dir: 1 });
  m.step(Date.now()); const o = m.step(Date.now());
  const s = JSON.parse(o.sends.find((x) => x.drop && (x.to as number[])[0] === 1)!.json);
  assert.equal(s.watch, 2);
});

test('no loot floats or sits inside walls: map spots and everything spilled from every pencil case', () => {
  const sim = new Sim(4321), w = sim.world;
  const bad = (x: number, y: number, z: number) => Math.abs(w.groundAt(x, z, y + 0.05) - y) > 0.06 || w.blocked(x, y, z, 0.25, 0.5);
  for (const l of sim.loot) assert.ok(!bad(l.x, l.y, l.z), `floor loot at ${l.x.toFixed(1)},${l.y},${l.z.toFixed(1)}`);
  for (const c of sim.cases) assert.ok(!bad(c.x, c.y, c.z), `case at ${c.x.toFixed(1)},${c.y},${c.z.toFixed(1)}`);
  const before = new Set(sim.loot.map((l) => l.id));
  const opener = sim.players.get(1) ?? (sim.spawn([1]), sim.players.get(1)!);
  for (const c of sim.cases) { Object.assign(opener, { x: c.x, y: c.y, z: c.z + 1.2, gliding: false }); (sim as unknown as { interact(p: unknown, ev: unknown[]): void }).interact(opener, []); }
  const spilled = sim.loot.filter((l) => !before.has(l.id));
  assert.ok(spilled.length > 100);
  for (const l of spilled) assert.ok(!bad(l.x, l.y, l.z), `spilled ${l.what} at ${l.x.toFixed(1)},${l.y},${l.z.toFixed(1)}`);
});

// ---------------- vehicles, C4, supply drops ----------------
function garage(kind: 'car' | 'heli' | 'plane', boxes: import('../../shared/src/world.ts').Box[] = []) {
  const w = World.custom(boxes);
  w.vehicleSpots = [{ kind, x: 0, y: 0, z: 0, head: 0 }];
  const sim = new Sim(1, w);
  // Sim reads vehicleSpots in its constructor; World.custom has none, so add the vehicle by hand
  if (!sim.vehicles.length) {
    const b = { ...newBody(0, 0, 0), ride: ['car', 'heli', 'plane'].indexOf(kind) + 1, grounded: true };
    sim.vehicles.push({ id: 999, kind, hp: ({ car: 500, heli: 650, plane: 350 } as const)[kind], driver: 0, last: 0, body: b, gunCd: 0, bombCd: 0, seats: [] });
  }
  sim.spawn([1, 2]);
  for (const p of sim.players.values()) { p.y = 0; p.gliding = false; p.grounded = true; }
  const a = sim.players.get(1)!; a.x = 2; a.z = 0;
  sim.players.get(2)!.x = 80;
  return sim;
}
const tickN = (sim: Sim, n: number, i: Partial<Input> = {}, id = 1) => { const ev = []; for (let k = 0; k < n; k++) ev.push(...sim.step(DT, new Map([[id, inp(i)]]))); return ev; };

test('get in a car, drive it forward, get out beside it', () => {
  const sim = garage('car'), a = sim.players.get(1)!;
  tickN(sim, 1, { interact: true });
  assert.equal(a.ride, 1);
  tickN(sim, 60, { fwd: 1, yaw: 0 });
  assert.ok(a.z < -15, `drove north (z=${a.z.toFixed(1)})`);
  assert.ok(sim.vehicles[0].body.z < -15, 'the car moved with the driver');
  tickN(sim, 1, { interact: true });
  assert.equal(a.ride, 0);
  assert.ok(Math.hypot(a.x - sim.vehicles[0].body.x, a.z - sim.vehicles[0].body.z) > 1.5, 'stepped out beside it');
});

test('running someone over hurts them; crashing into a wall at speed dents the car', () => {
  const sim = garage('car', [{ x0: -20, y0: 0, z0: -60, x1: 20, y1: 6, z1: -59, ink: 1, kind: 'wall' }]);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  b.x = 0; b.z = -30;
  tickN(sim, 1, { interact: true });
  const ev = tickN(sim, 120, { fwd: 1, sprint: true, yaw: 0 });
  assert.ok(ev.some((e) => e.kind === 'hit' && e.victim === 2 && e.by === 1), 'the pedestrian was hit');
  assert.ok(b.hp < PLAYER_HP || !b.alive);
  assert.ok((sim.vehicles[0]?.hp ?? 0) < 500, 'the wall hurt the car');
  assert.ok(a.alive);
});

test('a helicopter climbs and flies; a plane takes off from the runway', () => {
  const heli = garage('heli'), h = heli.players.get(1)!;
  tickN(heli, 1, { interact: true });
  tickN(heli, 60, { up: 1, fwd: 1, yaw: 0 });
  assert.ok(h.y > 8, `climbed to ${h.y.toFixed(1)}`);
  assert.ok(h.z < -5, 'and flew forward');
  const plane = garage('plane'), p = plane.players.get(1)!;
  tickN(plane, 1, { interact: true });
  tickN(plane, 150, { fwd: 1, yaw: 0, pitch: 0.3 });
  assert.ok(p.y > 5, `airborne at ${p.y.toFixed(1)}`);
  assert.ok(p.z < -60, 'covered ground');
});

test('shooting a car damages it; destroying it blows up the driver', () => {
  const sim = garage('car'), a = sim.players.get(1)!, b = sim.players.get(2)!;
  b.x = 0; b.z = 20; b.slots[0] = 'heavy'; b.mags[0] = 4; b.cur = 0; b.fireCd = 0;
  tickN(sim, 1, { interact: true });
  const hp = sim.vehicles[0].hp;
  const ev = sim.step(DT, new Map([[2, inp({ fire: true, yaw: 0, pitch: -0.02 })]]));
  assert.ok(sim.vehicles[0].hp < hp, 'the bullet hit the car');
  assert.ok(ev.some((e) => e.kind === 'vhit'));
  sim.vehicles[0].hp = 5; b.fireCd = 0; b.reloadT = 0; b.mags[0] = 4;
  const ev2 = sim.step(DT, new Map([[2, inp({ fire: true, yaw: 0, pitch: -0.02 })]]));
  assert.equal(sim.vehicles.length, 0, 'wrecked');
  assert.ok(ev2.some((e) => e.kind === 'boom'));
  assert.equal(a.ride, 0);
  assert.ok(a.hp < PLAYER_HP || !a.alive, 'the driver took the blast');
});

test('C4: your own charge takes a full health bar, but shields save you', () => {
  for (const [shield, survives] of [[0, false], [100, true]] as const) {
    const sim = arena([1, 2]), a = sim.players.get(1)!;
    a.x = 0; a.z = 0; a.shield = shield; a.perk = { kind: 'c4', n: 2 };
    sim.step(DT, new Map([[1, inp({ perk: true, pitch: -1.2 })]])); // throw it at your feet
    for (let i = 0; i < 30; i++) sim.step(DT, new Map());
    assert.ok(sim.projectiles.some((g) => g.kind === 'c4' && g.stuck), 'the charge stuck');
    sim.step(DT, new Map([[1, inp({ perk: true })]])); // set it off
    assert.equal(a.alive, survives, `shield ${shield}`);
  }
});

test('supply drops fall into the next circle and land as a supply case full of legendary loot', () => {
  const sim = new Sim(4321);
  sim.spawn([1]);
  let landed = false;
  for (let i = 0; i < 30 * 90 && !landed; i++) landed = sim.step(DT, new Map()).some((e) => e.kind === 'drop' && e.landed);
  assert.ok(landed, 'a drop landed in the first 90 s');
  const c = sim.cases.find((x) => x.supply)!;
  const p = sim.players.get(1)!;
  Object.assign(p, { x: c.x, y: c.y, z: c.z + 1.2, gliding: false });
  const before = new Set(sim.loot.map((l) => l.id));
  (sim as unknown as { interact(p: unknown, ev: unknown[]): void }).interact(p, []);
  const got = sim.loot.filter((l) => !before.has(l.id));
  assert.ok(got.some((l) => l.kind === 'weapon' && WEAPONS[l.what as WeaponId].rarity === 'legendary'));
  assert.ok(got.some((l) => l.kind === 'perk' && (l.what === 'c4' || l.what === 'nuke')));
});

test('teammates ride along as passengers: they move with the vehicle and can shoot out of it', async () => {
  const { Match } = await import('../src/match.ts');
  const m = new Match('rp', 3, [1, 2, 3], Date.now(), { 1: 1, 2: 1, 3: 2 });
  const sim = m.sim;
  sim.world = World.custom([]);
  sim.vehicles = [{ id: 999, kind: 'plane', hp: 350, driver: 0, last: 0, body: { ...newBody(0, 0, 0), ride: 3, grounded: true }, gunCd: 0, bombCd: 0, seats: [] }];
  for (const p of sim.players.values()) { p.gliding = false; p.y = 0; p.grounded = true; }
  const [a, b, c] = [1, 2, 3].map((id) => sim.players.get(id)!);
  a.x = 2; a.z = 0; b.x = -2; b.z = 0; c.x = 3; c.z = 1;
  sim.step(DT, new Map([[1, inp({ interact: true, seq: 1 })]]));
  sim.step(DT, new Map([[2, inp({ interact: true, seq: 1 })]]));
  sim.step(DT, new Map([[3, inp({ interact: true, seq: 1 })]])); // an enemy cannot board
  assert.equal(a.ride, 3); assert.equal(b.seat, 1); assert.equal(c.ride, 0);
  for (let i = 0; i < 150; i++) sim.step(DT, new Map([[1, inp({ fwd: 1, yaw: 0, pitch: 0.3, seq: i + 2 })]]));
  assert.ok(a.y > 5 && Math.hypot(b.x - a.x, b.z - a.z) < 3 && Math.abs(b.y - a.y) < 1, 'the passenger flies with the plane');
  sim.step(DT, new Map([[2, inp({ interact: true, seq: 99 })]]));
  assert.equal(b.ride, 0); assert.ok(b.gliding, 'bailing out mid-air opens the glider');
});

test('rocket launcher blows up a car; a Stinger missile chases a helicopter down', () => {
  const sim = garage('car'), b = sim.players.get(2)!;
  b.x = 0; b.z = 30; b.slots[0] = 'rocket'; b.mags[0] = 1; b.cur = 0; b.fireCd = 0;
  sim.step(DT, new Map([[2, inp({ fire: true, yaw: 0, pitch: 0.0 })]]));
  for (let i = 0; i < 40; i++) sim.step(DT, new Map());
  assert.ok((sim.vehicles[0]?.hp ?? 0) < 500, 'the rocket hit the car');
  const heli = garage('heli'), pilot = heli.players.get(1)!, gunner = heli.players.get(2)!;
  tickN(heli, 1, { interact: true });
  tickN(heli, 60, { up: 1, yaw: 0 });
  gunner.x = 40; gunner.z = 40; gunner.slots[0] = 'stinger'; gunner.mags[0] = 2; gunner.cur = 0; gunner.fireCd = 0;
  const yaw = Math.atan2(-(pilot.x - gunner.x), -(pilot.z - gunner.z)), pitch = Math.atan2(pilot.y - gunner.y, Math.hypot(pilot.x - gunner.x, pilot.z - gunner.z));
  heli.step(DT, new Map([[2, inp({ fire: true, yaw: yaw + 0.25, pitch })]])); // a little off target: the lock still finds it
  const ev: unknown[] = [];
  for (let i = 0; i < 60; i++) ev.push(...heli.step(DT, new Map([[1, inp({ fwd: 1, yaw: 1, seq: 100 + i })]])));
  assert.ok((heli.vehicles[0]?.hp ?? 0) < 650, 'the missile caught the helicopter');
});

test('upgrade kits and benches add damage; a molotov sets the ground on fire', () => {
  const sim = arena([1, 2]), a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 0; b.z = -10;
  a.perk = { kind: 'kit', n: 1 };
  sim.step(DT, new Map([[1, inp({ perk: true })]]));
  assert.equal(a.ups[0], 1);
  sim.world.upgrades.push({ x: 2, y: 0.95, z: 0 });
  sim.step(DT, new Map([[1, inp({ interact: true })]]));
  assert.equal(a.ups[0], 2, 'bench upgrade');
  sim.step(DT, new Map([[1, inp({ interact: true })]]));
  assert.equal(a.ups[0], 2, 'only once per bench');
  a.fireCd = 0;
  const hit = sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -0.08, fire: true })]])).find((e) => e.kind === 'hit');
  assert.ok(hit && hit.kind === 'hit' && hit.dmg > WEAPONS.ar.dmg * 1.3, 'more damage');
  const s2 = arena([1, 2]), c = s2.players.get(1)!, d = s2.players.get(2)!;
  c.x = 0; c.z = 0; d.x = 0; d.z = -6; c.perk = { kind: 'molotov', n: 2 };
  s2.step(DT, new Map([[1, inp({ perk: true, yaw: 0, pitch: -0.4 })]]));
  for (let i = 0; i < 90; i++) s2.step(DT, new Map());
  assert.ok(s2.effects.some((e) => e.kind === 'fire') || d.hp < 100, 'fire on the ground');
});

// duos and squads: knocked first, picked up by a teammate holding E, out when the team is down
function teamArena(teams: [number, number][]) {
  const sim = new Sim(1, World.custom([]));
  sim.spawn(teams.map(([id]) => id), new Map(teams));
  for (const p of sim.players.values()) { p.y = 0; p.gliding = false; p.grounded = true; p.fireCd = 0; p.pitch = 0; p.slots = ['ar', 'pistol', null, null]; p.mags = [30, 16, 0, 0]; p.cur = 0; }
  return sim;
}

test('with a teammate standing you are knocked, not out; a teammate holding E picks you up', () => {
  const sim = teamArena([[1, 1], [2, 1], [3, 3]]);
  const [a, b, c] = [1, 2, 3].map((i) => sim.players.get(i)!);
  a.x = 0; a.z = 0; b.x = 1; b.z = 0; c.x = 0; c.z = -10;
  a.hp = 5;
  // c is 10 m down -z from a; facing +z (yaw pi) aims at a
  let knocked = false;
  for (let i = 0; i < 20 && !knocked; i++) {
    c.fireCd = 0;
    if (sim.step(DT, new Map([[3, inp({ yaw: Math.PI, pitch: -0.08, fire: true, seq: 2 + i })]])).some((e) => e.kind === 'knock' && e.victim === 1)) knocked = true;
  }
  assert.ok(knocked, 'knocked');
  assert.ok(a.alive && a.down > 0);
  assert.equal(a.hp, KNOCK.hp);
  // knocked players can't shoot
  const before = a.mags[0];
  sim.step(DT, new Map([[1, inp({ fire: true, seq: 99 })]]));
  assert.equal(a.mags[0], before);
  // b holds E next to a for 5 s
  for (let i = 0; i < TICK_HZ * KNOCK.revive + 2; i++) sim.step(DT, new Map([[2, inp({ hold: true, seq: 100 + i })]]));
  assert.equal(a.down, 0, 'back up');
  assert.equal(a.hp, KNOCK.reviveHp);
});

test('a knocked player bleeds out; the last one standing going down takes the knocked with them', () => {
  const sim = teamArena([[1, 1], [2, 1], [3, 3]]);
  const [a, b] = [1, 2].map((i) => sim.players.get(i)!);
  a.x = 0; a.z = 0; b.x = 30; b.z = 0;
  (sim as unknown as { fall: (q: PlayerState, by: number | null, cause: string, ev: unknown[]) => void }).fall(a, 3, 'shot', []);
  assert.ok(a.down > 0);
  for (let i = 0; i < TICK_HZ * (KNOCK.bleed + 1); i++) sim.step(DT, new Map());
  assert.equal(a.alive, false, 'bled out');
  assert.equal(sim.players.get(3)!.kills, 1, 'the knock gets the kill');

  const s2 = teamArena([[1, 1], [2, 1], [3, 3]]);
  const [x, y] = [1, 2].map((i) => s2.players.get(i)!);
  x.x = 0; y.x = 20;
  const fall = (s2 as unknown as { fall: (q: PlayerState, by: number | null, cause: string, ev: unknown[]) => void }).fall.bind(s2);
  fall(x, 3, 'shot', []);
  assert.ok(x.alive && x.down > 0);
  fall(y, 3, 'shot', []); // nobody left to pick anyone up
  assert.equal(x.alive, false);
  assert.equal(y.alive, false);
});

test('solo: no knocks, straight out', () => {
  const sim = arena([1, 2]);
  const a = sim.players.get(1)!;
  (sim as unknown as { fall: (q: PlayerState, by: number | null, cause: string, ev: unknown[]) => void }).fall(a, 2, 'shot', []);
  assert.equal(a.alive, false);
});

// ---------- pot: hold requirement, hidden snapshots, candle close ----------
class ThinPot extends MockPot { held = new Map<string, bigint>(); async holderTokens(w: string) { return { raw: this.held.get(w) ?? 0n, decimals: 6 }; } }

test('the hold requirement is min(HOLD_TOKENS, $HOLD_MIN_USD) and fixed for the epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let price = 0.001; // $1M market cap at 1B supply: $50 = 50K tokens
  const ep = new Epochs({ ...config, dataDir: dir, holdTokens: 50_000, holdMinUsd: 50 }, new MockPot(), () => EPOCH_MS * 300 + 5, () => price);
  assert.equal(ep.requirement(), 50_000);
  price = 0.0001; // dumps 10x: $50 would be 500K tokens, but the cap keeps it at 50K and it is fixed anyway
  assert.equal(ep.requirement(), 50_000);
  const ep2 = new Epochs({ ...config, dataDir: mkdtempSync(join(tmpdir(), 'pr-')), holdTokens: 50_000, holdMinUsd: 50 }, new MockPot(), () => EPOCH_MS * 301 + 5, () => 0.01);
  assert.equal(ep2.requirement(), 5_000, 'pumped 10x: $50 is 5K tokens, new players need less');
});

test('selling before a hidden snapshot voids your points; holders keep theirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let now = EPOCH_MS * 400 + 10;
  const pot = new ThinPot(2_000_000_000n);
  const ep = new Epochs({ ...config, dataDir: dir, holdTokens: 50_000, holdMinUsd: 0, payoutMode: 'prorata', rolloverBps: 0 }, pot, () => now, () => null);
  const holder = wallet(), flipper = wallet();
  pot.held.set(holder, 60_000n * 1_000_000n); pot.held.set(flipper, 60_000n * 1_000_000n);
  ep.recordWin(holder, 'h', 100); ep.recordWin(flipper, 'f', 100);
  pot.held.set(flipper, 0n); // sells
  now = ep.snapshotTimes(400)[0] + 1;
  await ep.check();
  assert.ok(ep.isVoid(400, flipper));
  assert.ok(!ep.isVoid(400, holder));
  now = EPOCH_MS * 401 + 1;
  await ep.check();
  const rec = JSON.parse(readFileSync(join(dir, 'epochs', '400.json'), 'utf8'));
  assert.equal(rec.claims.length, 1);
  assert.equal(rec.claims[0].wallet, holder);
  assert.equal(BigInt(rec.claims[0].lamports), 2_000_000_000n);
});

test('candle close: points scored after the random close count for the next epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  let now = EPOCH_MS * 500 + 10;
  const ep = new Epochs({ ...config, dataDir: dir }, new MockPot(), () => now);
  const close = ep.closeAt(500);
  assert.ok(close >= EPOCH_MS * 501 - 30 * 60_000 && close < EPOCH_MS * 501, 'inside the last 30 minutes');
  assert.equal(ep.recordWin(wallet(), 'early', 20), 500);
  now = close + 1;
  assert.equal(ep.recordWin(wallet(), 'late', 20), 501);
  // the close minute is fixed by the committed secret: a restart computes the same one
  assert.equal(new Epochs({ ...config, dataDir: dir }, new MockPot(), () => now).closeAt(500), close);
});

test('match points: win, top placement, kills (capped)', async () => {
  const { matchPoints } = await import('../../shared/src/constants.ts');
  assert.equal(matchPoints('solo', 1, 3, true), 115);
  assert.equal(matchPoints('solo', 7, 2, false), 30);
  assert.equal(matchPoints('solo', 40, 0, false), 0);
  assert.equal(matchPoints('squad', 3, 0, false), 20, 'top 3 squads');
  assert.equal(matchPoints('squad', 4, 0, false), 0);
  assert.equal(matchPoints('duo', 9, 30, false), 50, 'kills cap at 10');
});

// ---------- QA sweep: every gun, every perk, every kind of crash ----------
test('every gun in the game damages a target in front of it', () => {
  for (const w of WEAPON_IDS) {
    const sim = arena([1, 2]);
    const a = sim.players.get(1)!, b = sim.players.get(2)!;
    const d = Math.min(18, WEAPONS[w].range * 0.5);
    a.x = 0; a.z = 0; b.x = 0; b.z = -d; b.shield = 0;
    give(a, w);
    let hurt = false;
    for (let i = 0; i < TICK_HZ * 6 && !hurt; i++) {
      sim.step(DT, new Map([[1, inp({ yaw: 0, pitch: -Math.atan2(0.7, d), fire: true, aim: true, seq: i + 1 })]]));
      hurt = b.hp < PLAYER_HP || !b.alive;
    }
    assert.ok(hurt, `${w} hit nothing at ${d} m`);
  }
});

test('every perk does something when used', () => {
  for (const k of ['grenade', 'molotov', 'shock', 'smoke', 'launch', 'fort', 'kit', 'c4', 'nuke'] as const) {
    const sim = arena([1]);
    const p = sim.players.get(1)!;
    p.perk = { kind: k, n: 2 };
    const before = { proj: sim.projectiles.length, fx: sim.effects.length, ups: p.ups[0], builds: sim.builds.length };
    sim.step(DT, new Map([[1, inp({ perk: true, pitch: -0.3 })]]));
    const did = sim.projectiles.length > before.proj || sim.effects.length > before.fx || p.ups[0] > before.ups || sim.builds.length > before.builds;
    assert.ok(did, `${k} did nothing`);
  }
});

test('cars crash into each other: both get dented', () => {
  const sim = garage('car'), a = sim.players.get(1)!;
  const b2 = { ...newBody(0, 0, -40), ride: 1, grounded: true, head: Math.PI };
  sim.vehicles.push({ id: 998, kind: 'car', hp: 500, driver: 0, last: 0, body: b2, gunCd: 0, bombCd: 0, seats: [] });
  tickN(sim, 1, { interact: true });
  assert.equal(a.ride, 1);
  tickN(sim, 120, { fwd: 1, sprint: true, yaw: 0 });
  const mine = sim.vehicles.find((v) => v.id !== 998), other = sim.vehicles.find((v) => v.id === 998);
  assert.ok(!other || other.hp < 500, 'the parked car took the hit');
  assert.ok(!mine || mine.hp < 500, 'and so did ours');
});

test('a plane flown into a tower wall at speed is wrecked', () => {
  const tower = { x0: -30, y0: 0, z0: -260, x1: 30, y1: 80, z1: -250, ink: 1, kind: 'wall' as const };
  const sim = garage('plane', [tower]), p = sim.players.get(1)!;
  tickN(sim, 1, { interact: true });
  let wrecked = false;
  for (let i = 0; i < TICK_HZ * 14 && !wrecked; i++) {
    sim.step(DT, new Map([[1, inp({ fwd: 1, sprint: true, yaw: 0, pitch: p.y > 14 ? -0.05 : 0.3, seq: i + 2 })]]));
    wrecked = sim.vehicles.length === 0;
  }
  assert.ok(wrecked, `plane still flying at z=${p.z.toFixed(0)} y=${p.y.toFixed(0)}`);
});

test('a helicopter flown fast into a wall gets dented', () => {
  const sim = garage('heli', [{ x0: -30, y0: 0, z0: -120, x1: 30, y1: 60, z1: -110, ink: 1, kind: 'wall' }]), p = sim.players.get(1)!;
  tickN(sim, 1, { interact: true });
  const v = sim.vehicles[0], hp = v.hp;
  for (let i = 0; i < TICK_HZ * 10 && sim.vehicles.includes(v) && v.hp === hp; i++) sim.step(DT, new Map([[1, inp({ fwd: 1, sprint: true, yaw: 0, up: p.y < 8 ? 1 : 0, seq: i + 2 })]]));
  assert.ok(!sim.vehicles.includes(v) || v.hp < hp, `no damage (z=${p.z.toFixed(0)})`);
});

// ---------- destruction ----------
const wallBox = (x0: number, z0: number, x1: number, z1: number, y1 = 4, y0 = 0) => ({ x0, y0, z0, x1, y1, z1, ink: 1, kind: 'wall' as const });
// a mirror of the world as a client keeps it: applies only the events it is sent
const mirror = (boxes: import('../../shared/src/world.ts').Box[]) => World.custom(boxes.map((b) => ({ ...b })));
const applyWreck = (w: World, ev: ReturnType<Sim['step']>) => { for (const e of ev) if (e.kind === 'wreck') { w.addBoxes(e.add.map((b) => ({ ...b, hp: undefined }))); w.killBoxes(e.kill); } };

test('a rocket blows a hole in a wall: blocks break off, and a client mirror stays identical', () => {
  const boxes = [wallBox(-10, -20.3, 10, -20, 6, 0.6)];
  const sim = new Sim(1, World.custom(boxes.map((b) => ({ ...b }))));
  const client = mirror(boxes);
  sim.spawn([1]);
  const a = sim.players.get(1)!; a.y = 0; a.gliding = false; a.grounded = true; a.x = 0; a.z = 0;
  give(a, 'rocket');
  let ev = sim.step(DT, new Map([[1, inp({ fire: true, yaw: 0, pitch: Math.atan2(2, 20), seq: 1 })]]));
  applyWreck(client, ev);
  for (let i = 0; i < TICK_HZ * 2; i++) { ev = sim.step(DT, new Map()); applyWreck(client, ev); }
  const dead = sim.world.boxes.filter((b) => b.dead).length;
  assert.ok(sim.world.boxes[0].dead, 'the big wall broke into blocks');
  assert.ok(sim.world.boxes.length > 5, 'blocks were added');
  assert.ok(dead >= 2, 'and some of them broke');
  assert.equal(client.boxes.length, sim.world.boxes.length);
  client.boxes.forEach((b, i) => { const s = sim.world.boxes[i]; assert.equal(!!b.dead, !!s.dead, `box ${i}`); assert.equal(b.x0, s.x0); assert.equal(b.y1, s.y1); });
  // there is a hole now: a ray through the middle of the blast goes through
  assert.ok(sim.world.raycast(0, 2, 0, 0, 0, -1, 30) > 20.5, 'you can see through the hole');
});

test('enough damage brings a whole building down; terrain never breaks', () => {
  // a 10-storey tower (four walls and a floor every 3.4 m) on an unbreakable hill
  const boxes: import('../../shared/src/world.ts').Box[] = [{ ...wallBox(-30, -30, 30, 30, 2), kind: 'building', hard: true }];
  for (let f = 0; f < 10; f++) {
    const y0 = 2 + f * 3.4, y1 = y0 + 3.4;
    boxes.push(wallBox(-6, -6, 6, -5.7, y1, y0), wallBox(-6, 5.7, 6, 6, y1, y0), wallBox(-6, -5.7, -5.7, 5.7, y1, y0), wallBox(5.7, -5.7, 6, 5.7, y1, y0));
    boxes.push({ x0: -6, y0: y1 - 0.3, z0: -6, x1: 6, y1, z1: 6, ink: 1, kind: 'floor' });
  }
  const sim = new Sim(1, World.custom(boxes));
  sim.spawn([1]);
  const s = sim.world.structures.find((x) => x.boxes.length >= 50)!;
  assert.ok(s, 'the tower is one structure');
  assert.equal(sim.world.boxes[0].sid, undefined, 'the hill is not part of it');
  let fell = false;
  for (let k = 0; k < 40 && !fell; k++) {
    sim.damageWorld(6, 10, 0, 4, 300, 450, 1);
    const ev = sim.step(DT, new Map());
    fell = ev.some((e) => e.kind === 'wreck' && e.falls.length > 0);
  }
  assert.ok(fell, 'it came down');
  assert.ok(s.boxes.every((i) => sim.world.boxes[i].dead), 'every box of it is gone');
  assert.ok(!sim.world.boxes[0].dead, 'the hill is still there');
  sim.damageWorld(0, 1, 0, 30, 9999, 9999, 1, true);
  assert.ok(!sim.world.boxes[0].dead, 'not even a nuke breaks terrain');
});

test('the axe chops blocks for material; right click places a 1 m block with it', () => {
  const sim = new Sim(1, World.custom([wallBox(-4, -2.3, 4, -2, 3)]));
  sim.spawn([1]);
  const a = sim.players.get(1)!; a.y = 0; a.gliding = false; a.grounded = true; a.x = 0; a.z = 0;
  const mats0 = a.mats;
  tickN(sim, 1, { slot: SLOTS_AXE });
  assert.ok(a.axe, 'axe out');
  let broke = false;
  for (let i = 0; i < TICK_HZ * 4 && !broke; i++) broke = sim.step(DT, new Map([[1, inp({ fire: true, yaw: 0, pitch: 0, seq: i + 2 })]])).some((e) => e.kind === 'chop' && e.broke);
  assert.ok(broke, 'a block broke');
  assert.ok(a.mats > mats0, 'and gave material');
  // build: aim at the floor in front and place a block
  const before = sim.world.boxes.length, m = a.mats;
  for (let i = 0; i < 20; i++) sim.step(DT, new Map([[1, inp({ aim: true, yaw: Math.PI, pitch: -0.6, seq: 100 + i })]]));
  assert.ok(sim.world.boxes.length > before, 'a block was placed');
  const b = sim.world.boxes.at(-1)!;
  assert.equal(b.x1 - b.x0, 1); assert.equal(b.y0, 0);
  assert.ok(a.mats < m, 'it cost material');
});

test('a plane flown into a tower at full speed wrecks the plane and smashes the wall', () => {
  const tower = wallBox(-12, -262, 12, -250, 60, 0.6);
  const sim = garage('plane', [tower]), p = sim.players.get(1)!;
  tickN(sim, 1, { interact: true });
  for (let i = 0; i < TICK_HZ * 14 && sim.vehicles.length; i++) sim.step(DT, new Map([[1, inp({ fwd: 1, sprint: true, yaw: 0, pitch: p.y > 14 ? -0.05 : 0.3, seq: i + 2 })]]));
  assert.equal(sim.vehicles.length, 0, 'plane wrecked');
  assert.ok(sim.world.boxes[0].dead, 'the tower wall broke up');
});

test('a motorbike rides fast; a tank drives through a wall and its cannon blows up a car', () => {
  const sim = garage('car');
  sim.vehicles = [];
  const add = (kind: 'moto' | 'tank', x: number, z: number) => { const b = { ...newBody(x, 0, z), ride: kind === 'moto' ? 4 : 5, grounded: true }; const v = { id: 900 + sim.vehicles.length, kind, hp: kind === 'moto' ? 260 : 2200, driver: 0, last: 0, body: b, gunCd: 0, bombCd: 0, seats: [] as number[] }; sim.vehicles.push(v); return v; };
  const moto = add('moto', 0, 0), a = sim.players.get(1)!;
  a.x = 0; a.z = 0;
  tickN(sim, 1, { interact: true });
  assert.equal(a.ride, 4);
  tickN(sim, 90, { fwd: 1, sprint: true, yaw: 0 });
  assert.ok(a.z < -40, `the bike covered ground (z=${a.z.toFixed(0)})`);
  void moto;
  // tank vs a wall
  const s2 = garage('car', [wallBox(-6, -12.3, 6, -12, 4, 0.6)]);
  s2.vehicles = [];
  const tb = { ...newBody(0, 0, 0), ride: 5, grounded: true };
  s2.vehicles.push({ id: 950, kind: 'tank', hp: 2200, driver: 0, last: 0, body: tb, gunCd: 0, bombCd: 0, seats: [] });
  const car = { ...newBody(0, 0, 40), ride: 1, grounded: true };
  s2.vehicles.push({ id: 951, kind: 'car', hp: 500, driver: 0, last: 0, body: car, gunCd: 0, bombCd: 0, seats: [] });
  const t = s2.players.get(1)!; t.x = 0; t.z = 0;
  tickN(s2, 1, { interact: true });
  assert.equal(t.ride, 5);
  tickN(s2, TICK_HZ * 5, { fwd: 1, yaw: 0 });
  assert.ok(t.z < -13, `drove through the wall (z=${t.z.toFixed(1)})`);
  assert.ok(s2.vehicles.find((v) => v.id === 950)!.hp === 2200, 'and the tank is fine');
  // turn the turret around and shoot the car behind
  t.x = 0; t.z = 0; t.y = 0;
  for (let i = 0; i < TICK_HZ * 3 && s2.vehicles.some((v) => v.id === 951); i++) s2.step(DT, new Map([[1, inp({ fire: true, yaw: Math.PI, pitch: -0.03, seq: 500 + i })]]));
  const c = s2.vehicles.find((v) => v.id === 951);
  assert.ok(!c || c.hp < 500, 'the shell hit the car');
});

test('loose pieces fall: blow out the bottom of a wall and the top comes down; a held piece stays', () => {
  // a free-standing wall 8 m tall, already broken into 2 m blocks (4 x 4)
  const boxes: import('../../shared/src/world.ts').Box[] = [];
  for (let ix = 0; ix < 4; ix++) for (let iy = 0; iy < 4; iy++) boxes.push({ x0: ix * 2, y0: iy * 2, z0: -10.2, x1: ix * 2 + 2, y1: iy * 2 + 2, z1: -10, ink: 1, kind: 'wall' });
  const sim = new Sim(1, World.custom(boxes));
  const client = mirror(boxes);
  sim.spawn([1]);
  const p = sim.players.get(1)!; p.x = 30; p.z = 30; p.y = 0; p.gliding = false;
  // knock out the whole bottom row: everything above is left hanging
  sim.damageWorld(4, 1, -10.1, 4.6, 9999, 0, 1);
  const ev = sim.step(DT, new Map());
  applyWreck(client, ev);
  const w = ev.find((e) => e.kind === 'wreck');
  assert.ok(w && w.kind === 'wreck' && (w.drop?.length ?? 0) > 0, 'something fell');
  assert.ok(sim.world.boxes.every((b) => b.dead), 'nothing is left floating');
  client.boxes.forEach((b, i) => assert.equal(!!b.dead, !!sim.world.boxes[i].dead, `mirror box ${i}`));
  // a wall with a hole in the middle keeps its top: it still stands on its sides
  const s2 = new Sim(1, World.custom(boxes.map((b) => ({ ...b, dead: undefined }))));
  s2.spawn([1]);
  s2.damageWorld(3.5, 1, -10.1, 1.2, 9999, 0, 1); // one bottom block in the middle
  s2.step(DT, new Map());
  const top = s2.world.boxes.filter((b) => b.y0 >= 6);
  assert.ok(top.every((b) => !b.dead), 'the top row still stands');
});

test('a network hiccup never moves a player twice or leaves input lag behind', async () => {
  const { Match } = await import('../src/match.ts');
  const m = new Match('j', 77, [1, 2], 0, { 1: 0, 2: 1 });
  const seat = (m as unknown as { seats: Map<number, { inputs: { queue: Input[] } }> }).seats.get(1)!.inputs;
  let seq = 0, now = 0;
  const late: Input[] = [];
  for (let k = 0; k < 200; k++) {
    const i: Input = { ...emptyInput(), seq: ++seq, fwd: 1, sprint: true, yaw: 0.3 };
    if (k >= 100 && k < 108) late.push(i);              // 250 ms of inputs stuck in the network...
    else { if (k === 108) for (const l of late) m.input(1, l); m.input(1, i); } // ...arrive all at once
    m.step((now += 1000 / TICK_HZ));
    if (k > 120) assert.ok(seat.queue.length <= 1, `queue ${seat.queue.length} at tick ${k}: input lag piling up`);
  }
  // every input ran exactly once: the body waited while they were stuck and caught up after
  assert.equal(m.sim.players.get(1)!.ack, seq);
});

test('payouts fit one root: at most MAX_CLAIMS winners and nothing under the minimum', async () => {
  const { MAX_CLAIMS, MIN_PAYOUT_LAMPORTS } = await import('../src/payout.ts');
  const wins = new Map(Array.from({ length: MAX_CLAIMS + 500 }, (_, i) => [wallet(), (i % 50) + 1] as [string, number]));
  const pot = 5000n * 10n ** 9n;
  const r = computePayouts(pot, wins, policy('prorata'));
  assert.ok(r.payouts.length <= MAX_CLAIMS, `${r.payouts.length} claims`);
  assert.ok(r.payouts.every((p) => p.lamports >= MIN_PAYOUT_LAMPORTS));
  assert.equal(r.payouts.reduce((s, p) => s + p.lamports, 0n) + r.rollover, pot);
  // the ones left out are the lowest scorers
  const minPaid = Math.min(...r.payouts.map((p) => wins.get(p.wallet)!));
  assert.ok([...wins.values()].filter((w) => w > minPaid).length <= MAX_CLAIMS);
  // a tiny pot pays nobody rather than shares a claim would cost more than
  const tiny = computePayouts(5_000_000n, new Map([[wallet(), 1], [wallet(), 1], [wallet(), 1], [wallet(), 1], [wallet(), 1], [wallet(), 1]]), policy('prorata'));
  assert.equal(tiny.payouts.length, 0); assert.equal(tiny.rollover, 5_000_000n);
});

test('the live pot is exactly what the vault program will accept', async () => {
  const { SolanaPot } = await import('../src/pot.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pr-pot-'));
  const cfg = { ...config, dataDir: dir, vaultAddress: 'V', configAddress: 'C', holdMinUsd: 0, vaultReserveLamports: 1_000_000n };
  const SOL = 1_000_000_000n;
  let vault = 100n * SOL, chain = { last: 0n, any: false, reserved: 0n };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    const m = JSON.parse(init.body).method as string;
    const d = Buffer.alloc(99); d.writeBigUInt64LE(chain.last, 48); d[56] = chain.any ? 1 : 0; d.writeBigUInt64LE(chain.reserved, 57);
    const result = m === 'getBalance' ? { value: Number(vault) } : { value: { data: [d.toString('base64'), 'base64'] } };
    return { json: async () => ({ result }) } as Response;
  }) as typeof fetch;
  try {
    const pot = new SolanaPot(cfg);
    assert.equal(pot.balance(), 0n, 'nothing to allocate before the chain was read');
    await pot.poll();
    assert.equal(pot.balance(), 100n * SOL - 1_000_000n);
    pot.markPaid(5, 90n * SOL);                      // settled here, keeper hasn't posted yet
    assert.equal(pot.balance(), 10n * SOL - 1_000_000n);
    chain = { last: 5n, any: true, reserved: 90n * SOL }; await pot.poll();   // posted
    assert.equal(pot.balance(), 10n * SOL - 1_000_000n, 'counted once, not twice');
    vault -= 90n * SOL; chain.reserved = 0n; vault += 5n * SOL; await pot.poll(); // winners claimed, new fees came in
    assert.equal(pot.balance(), 15n * SOL - 1_000_000n, 'claims free nothing twice: the next pot sees the new fees');
    // a restart before the keeper posts epoch 6 still holds its reservation (read back from data/epochs)
    pot.markPaid(6, 4n * SOL);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'epochs'), { recursive: true }); writeFileSync(join(dir, 'epochs', '6.json'), JSON.stringify({ paid: (4n * SOL).toString() }));
    const again = new SolanaPot(cfg); await again.poll();
    assert.equal(again.balance(), 11n * SOL - 1_000_000n);
    assert.throws(() => new SolanaPot({ ...cfg, configAddress: '' }), /CONFIG_ADDRESS/);
  } finally { globalThis.fetch = realFetch; }
});
