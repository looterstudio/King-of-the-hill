// Bugs the simulation used to have, each pinned by the smallest case that showed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, emptyInput, type Input } from '../../shared/src/sim.ts';
import { World, newBody, type Box } from '../../shared/src/world.ts';
import { moveVehicle } from '../../shared/src/vehicles.ts';
import { GRAVITY, SLOTS, TICK_HZ, VEHICLES } from '../../shared/src/constants.ts';
import { rng } from '../../shared/src/rng.ts';

const DT = 1 / TICK_HZ;
const inp = (o: Partial<Input> = {}): Input => ({ ...emptyInput(), ...o });
const wall = (x0: number, z0: number, x1: number, z1: number, y1 = 4, y0 = 0): Box => ({ x0, y0, z0, x1, y1, z1, ink: 1, kind: 'wall' });
const ground = (sim: Sim) => { for (const p of sim.players.values()) { p.y = 0; p.gliding = false; p.grounded = true; } };
const still = { fwd: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false, slide: false, grapple: false, up: 0 };

test('a fort built the tick a wall shatters lands at the same block indices on the client', () => {
  const big = wall(-4, -2.3, 4, -2, 3);
  const sim = new Sim(1, World.custom([{ ...big }]));
  const client = World.custom([{ ...big }]);
  sim.spawn([1, 2]); ground(sim);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 30; b.z = 30; b.perk = { kind: 'fort', n: 1 };
  const apply = (ev: ReturnType<Sim['step']>) => { for (const e of ev) {
    if (e.kind === 'build') client.addBoxes(e.boxes.map((x) => ({ ...x })));
    if (e.kind === 'wreck') { client.addBoxes(e.add.map((x) => ({ ...x, hp: undefined }))); client.killBoxes(e.kill); }
  } };
  apply(sim.step(DT, new Map([[1, inp({ slot: SLOTS + 1, seq: 1 })], [2, inp({ seq: 1 })]])));
  for (let i = 0; i < 10; i++) apply(sim.step(DT, new Map([[1, inp({ seq: 2 + i })], [2, inp({ seq: 2 + i })]])));
  // same tick: 1 chops the wall (it shatters into pieces), 2 drops an Instant Fort
  const ev = sim.step(DT, new Map([[1, inp({ fire: true, yaw: 0, pitch: 0, seq: 20 })], [2, inp({ perk: true, seq: 20 })]]));
  const order = ev.map((e) => e.kind).filter((k) => k === 'wreck' || k === 'build');
  assert.deepEqual(order, ['wreck', 'build'], 'the shatter is sent before the fort that indexes after it');
  apply(ev);
  assert.equal(client.boxes.length, sim.world.boxes.length);
  sim.world.boxes.forEach((s, i) => assert.ok(s.kind === client.boxes[i].kind && s.x0 === client.boxes[i].x0 && s.y0 === client.boxes[i].y0, `box ${i} differs`));
});

test('the helicopter on the Needle stays on its pad and can fly off it whichever way it faces', () => {
  const w = new World(1);
  const s = w.vehicleSpots.find((v) => v.kind === 'heli' && v.y > 200);
  assert.ok(s, 'the Needle has a helicopter');
  const p = Object.assign(newBody(s.x, s.y, s.z), { ride: 2, head: s.head, grounded: true }) as Parameters<typeof moveVehicle>[1];
  for (let t = 0; t < 30; t++) moveVehicle(w, p, still, DT, GRAVITY);
  assert.ok(Math.abs(p.y - s.y) < 0.5, `parked heli fell from ${s.y} to ${p.y}`);
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const q = { ...p };
    for (let t = 0; t < 300; t++) moveVehicle(w, q, { ...still, fwd: 1, sprint: true, yaw, up: 1 }, DT, GRAVITY);
    assert.ok(Math.hypot(q.x - s.x, q.z - s.z) > 100, `heading ${yaw.toFixed(2)}: stuck on the roof`);
    assert.ok(q.y < 300, 'the ceiling still holds');
  }
});

test('aircraft dropped onto the real map never end up inside a block', () => {
  const w = new World(1), R = rng(5);
  let tests = 0;
  for (let n = 0; n < 600; n++) {
    const ride = n % 2 ? 3 : 2, def = VEHICLES[ride === 2 ? 'heli' : 'plane'];
    const p = Object.assign(newBody((R() * 2 - 1) * 380, 60 + R() * 20, (R() * 2 - 1) * 380), { ride, head: 0, grounded: false }) as Parameters<typeof moveVehicle>[1];
    if (w.hitBox(p.x, p.y, p.z, def.r, def.h)) continue;
    tests++;
    for (let t = 0; t < 240 && !p.grounded; t++) {
      if (ride === 2) moveVehicle(w, p, { ...still, up: -1 }, DT, GRAVITY, false);
      else { p.spd = 0; p.vpitch = -0.7; moveVehicle(w, p, { ...still, fwd: -1, pitch: -0.7 }, DT, GRAVITY, true); }
      const b = w.hitBox(p.x, p.y + 0.02, p.z, def.r - 0.02, def.h - 0.04);
      assert.equal(b, null, `ride ${ride} sank into a ${b?.kind} at ${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)}`);
    }
  }
  assert.ok(tests > 400);
});

test('a knocked player crawling over a launch pad is not launched', () => {
  const sim = new Sim(1, World.custom([]));
  sim.spawn([1, 2, 3], new Map([[1, 1], [2, 1], [3, 3]])); ground(sim);
  const a = sim.players.get(1)!, b = sim.players.get(2)!, e = sim.players.get(3)!;
  a.x = 0; a.z = 0; b.x = 50; b.z = 50; e.x = 0; e.z = 5;
  sim.effects.push({ id: 999, kind: 'pad', owner: 2, x: 0, y: 0, z: -1, t: 30 });
  (sim as unknown as { fall: (...a: unknown[]) => void }).fall(a, 3, 'shot', [], false);
  assert.ok(a.down > 0);
  let maxY = 0, maxSpd = 0;
  for (let i = 0; i < TICK_HZ * 3; i++) {
    sim.step(DT, new Map([[1, inp({ fwd: 1, seq: i + 1 })]]));
    maxY = Math.max(maxY, a.y); maxSpd = Math.max(maxSpd, Math.hypot(a.vx, a.vz));
  }
  assert.ok(maxY < 0.5 && maxSpd < 2.5, `knocked player flew: height ${maxY.toFixed(1)}, speed ${maxSpd.toFixed(1)}`);
  assert.ok(!a.gliding);
});

test("a passenger's rocket leaves the vehicle they ride in", () => {
  for (const kind of ['car', 'heli'] as const) {
    const sim = new Sim(1, World.custom([]));
    sim.spawn([1, 2], new Map([[1, 1], [2, 1]])); ground(sim);
    const a = sim.players.get(1)!, b = sim.players.get(2)!;
    a.x = a.z = b.x = b.z = 0;
    sim.vehicles = [{ id: 500, kind, hp: 9999, driver: 0, last: 0, body: { ...newBody(0, 0, 0), ride: kind === 'car' ? 1 : 2, grounded: true }, gunCd: 0, bombCd: 0, seats: [] }];
    sim.step(DT, new Map([[1, inp({ interact: true, seq: 1 })], [2, inp({ seq: 1 })]]));
    b.x = 0.5;
    sim.step(DT, new Map([[1, inp({ seq: 2 })], [2, inp({ interact: true, seq: 2 })]]));
    assert.deepEqual(sim.vehicles[0].seats, [2], `${kind}: 2 rides along`);
    b.slots[0] = 'rocket'; b.mags[0] = 1; b.cur = 0; b.fireCd = 0;
    const hp = b.hp + b.shield, evs: ReturnType<Sim['step']> = [];
    for (let i = 0; i < 3; i++) evs.push(...sim.step(DT, new Map([[1, inp({ seq: 3 + i })], [2, inp({ fire: true, yaw: Math.PI / 2, pitch: 0.2, seq: 3 + i })]])));
    assert.ok(!evs.some((e) => e.kind === 'boom'), `${kind}: the rocket blew up on its own vehicle`);
    assert.equal(b.hp + b.shield, hp);
    assert.equal(sim.vehicles[0].hp, 9999);
  }
});

test('bringing a house down on your teammate credits no kill and no hit', () => {
  const boxes = [wall(-5, -5, 5, -4.7), wall(-5, 4.7, 5, 5), wall(-5, -4.7, -4.7, 4.7), wall(4.7, -4.7, 5, 4.7), { x0: -5, y0: 3.7, z0: -5, x1: 5, y1: 4, z1: 5, ink: 1, kind: 'floor' as const }];
  const sim = new Sim(1, World.custom(boxes));
  sim.spawn([1, 2, 3], new Map([[1, 7], [2, 7], [3, 8]])); ground(sim);
  const a = sim.players.get(1)!, mate = sim.players.get(2)!, foe = sim.players.get(3)!;
  a.x = 20; a.z = 0; mate.x = 0; mate.z = 0; foe.x = -200; foe.z = -200;
  sim.damageWorld(5, 2, 0, 1, 0, 99999, 1);
  const ev = sim.step(DT, new Map());
  assert.ok(!ev.some((e) => e.kind === 'hit' && (e as { by?: number }).by === 1), 'no hit marker for hurting a teammate');
  for (let i = 0; i < TICK_HZ * 31 && mate.alive; i++) sim.step(DT, new Map());
  assert.equal(a.kills, 0);
});

test('blowing yourself up with C4 drops what you carried', () => {
  const sim = new Sim(1, World.custom([]));
  sim.spawn([1, 2]); ground(sim);
  const a = sim.players.get(1)!, b = sim.players.get(2)!;
  a.x = 0; a.z = 0; b.x = 100; b.z = 100;
  a.items = { mini: 2, big: 1, med: 1 }; a.perk = { kind: 'c4', n: 2 }; a.shield = 0;
  sim.loot = [];
  sim.step(DT, new Map([[1, inp({ perk: true, pitch: -1.5, seq: 1 })]]));
  for (let i = 0; i < 30; i++) sim.step(DT, new Map([[1, inp({ seq: 2 + i })]]));
  a.hp = 1;
  sim.step(DT, new Map([[1, inp({ perk: true, seq: 40 })]]));
  assert.equal(a.alive, false);
  assert.ok(sim.loot.some((l) => l.kind === 'perk' && l.what === 'c4'), 'the unused charge is on the floor');
  assert.ok(sim.loot.some((l) => l.what === 'big'), 'the potions are on the floor');
  assert.equal(a.perk, null);
});

test('the paper plane runway is clear on every map', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const w = new World(seed);
    for (const s of w.vehicleSpots.filter((v) => v.kind === 'plane' && v.y < 1)) {
      const def = VEHICLES.plane;
      assert.equal(w.hitBox(s.x, s.y + 0.05, s.z, def.r, def.h - 0.1), null, `seed ${seed}: something sits on the plane`);
    }
  }
});
