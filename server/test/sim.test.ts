// Bugs the simulation used to have, each pinned by the smallest case that showed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, emptyInput, moveStep, type Input } from '../../shared/src/sim.ts';
import { World, newBody, type Box } from '../../shared/src/world.ts';
import { moveVehicle } from '../../shared/src/vehicles.ts';
import { GRAVITY, PLAYER_HP, SHIELD_MAX, SLOTS, TICK_HZ, VEHICLES } from '../../shared/src/constants.ts';
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

// ---------- aircraft crashes ----------
// player 1 already at the controls of an aircraft, flying north (-z) at spd
function flying(sim: Sim, kind: 'plane' | 'heli', x: number, y: number, z: number, spd: number) {
  const ride = kind === 'plane' ? 3 : 2;
  const v = { id: 900, kind, hp: VEHICLES[kind].hp, driver: 1, last: 1, body: { ...newBody(x, y, z), ride }, gunCd: 0, bombCd: 0, seats: [] as number[] };
  sim.vehicles.push(v);
  Object.assign(sim.players.get(1)!, { x, y, z, ride, rideV: v.id, head: 0, spd, vpitch: 0, vx: 0, vy: 0, vz: kind === 'heli' ? -spd : 0, grounded: y === 0, gliding: false });
  return v;
}
// fly on (fwd: throttle) until the aircraft is gone or `secs` run out; every event on the way
const fly = (sim: Sim, fwd: number, secs: number) => {
  const ev: ReturnType<Sim['step']> = [];
  for (let i = 0; i < TICK_HZ * secs && sim.vehicles.length; i++) ev.push(...sim.step(DT, new Map([[1, inp({ fwd, yaw: 0, pitch: 0, seq: i + 1 })], [2, inp({ seq: i + 1 })]])));
  for (let i = 0; i < 3; i++) ev.push(...sim.step(DT, new Map()));
  return ev;
};
// a two-storey house (10 x 10 m, a floor slab on each storey) centred at z
const house = (z: number): Box[] => [0, 3.6].flatMap((y0) => [
  wall(-5, z - 5, 5, z - 4.7, y0 + 3.6, y0), wall(-5, z + 4.7, 5, z + 5, y0 + 3.6, y0), wall(-5, z - 4.7, -4.7, z + 4.7, y0 + 3.6, y0), wall(4.7, z - 4.7, 5, z + 4.7, y0 + 3.6, y0),
  { x0: -5, y0: y0 + 3.3, z0: z - 5, x1: 5, y1: y0 + 3.6, z1: z + 5, ink: 1, kind: 'floor' as const },
]);
const crashSim = (boxes: Box[]) => {
  const sim = new Sim(1, World.custom(boxes.map((b) => ({ ...b }))));
  sim.spawn([1, 2]); ground(sim);
  Object.assign(sim.players.get(2)!, { x: 300, z: 300 });
  return sim;
};

test('a plane flown into a house at full speed blows up and flattens it; the pilot goes up with it', () => {
  const sim = crashSim(house(-30)), p = sim.players.get(1)!;
  const s = sim.world.structures[0];
  assert.equal(sim.world.structures.length, 1, 'the house is one building');
  flying(sim, 'plane', 0, 2, 20, VEHICLES.plane.top);
  const ev = fly(sim, 1, 4);
  assert.equal(sim.vehicles.length, 0, 'the plane is wrecked');
  const booms = ev.filter((e) => e.kind === 'boom');
  assert.ok(booms.some((e) => e.kind === 'boom' && e.r >= 10), `a big fireball (${booms.map((e) => e.kind === 'boom' && e.r.toFixed(1)).join(', ')})`);
  assert.ok(s.down, 'the house came down');
  assert.ok(sim.world.boxes.every((b) => b.dead), 'nothing of it is left standing');
  assert.ok(ev.some((e) => e.kind === 'wreck' && e.falls.length > 0), 'clients see it fall');
  assert.equal(p.alive, false, 'an unshielded pilot does not walk away from that');
  assert.equal(p.ride, 0);
});

test('a full shield gets a pilot out of a plane crash alive, but hurt', () => {
  const sim = crashSim(house(-30)), p = sim.players.get(1)!;
  p.shield = SHIELD_MAX;
  flying(sim, 'plane', 0, 2, 20, VEHICLES.plane.top);
  fly(sim, 1, 4);
  assert.equal(sim.vehicles.length, 0);
  assert.ok(p.alive && p.shield + p.hp < SHIELD_MAX + PLAYER_HP / 2, `hp ${p.hp} shield ${p.shield}`);
});

test('bumping into a house slowly only dents the aircraft: no explosion, the house stands', () => {
  for (const [kind, spd, fwd] of [['plane', 12, 0], ['heli', 10, 0.4]] as const) {
    const sim = crashSim(house(-30));
    const v = flying(sim, kind, 0, kind === 'plane' ? 0 : 2, 20, spd);
    const ev: ReturnType<Sim['step']> = [];
    for (let i = 0; i < TICK_HZ * 6 && v.hp === VEHICLES[kind].hp; i++) ev.push(...sim.step(DT, new Map([[1, inp({ fwd, yaw: 0, seq: i + 1 })]])));
    assert.ok(sim.vehicles.includes(v) && v.hp < VEHICLES[kind].hp, `${kind}: dented, not wrecked (hp ${v.hp})`);
    assert.ok(!ev.some((e) => e.kind === 'boom'), `${kind}: nothing blew up`);
    assert.ok(!sim.world.structures[0].down, `${kind}: the house still stands`);
    assert.ok(sim.world.boxes.filter((b) => b.dead).length <= 12, `${kind}: a dent, not a hole`);
    assert.ok(sim.players.get(1)!.alive);
  }
});

test('a plane flown into a mountainside blows up and the rock does not break', () => {
  const rock: Box = { x0: -40, y0: 0, z0: -80, x1: 40, y1: 60, z1: -40, ink: 4, kind: 'building', hard: true };
  const sim = crashSim([rock]);
  flying(sim, 'plane', 0, 10, 20, VEHICLES.plane.boost);
  const ev = fly(sim, 1, 4);
  assert.equal(sim.vehicles.length, 0, 'the plane is wrecked');
  assert.ok(ev.some((e) => e.kind === 'boom'));
  assert.equal(sim.world.boxes.length, 1, 'no blocks broke off');
  assert.ok(!sim.world.boxes[0].dead, 'the rock is still there');
});

test('a plane through a 40-floor tower takes out the floors it hit and everything above comes down', () => {
  const boxes: Box[] = [];
  for (let f = 0; f < 40; f++) {
    const y0 = f * 3.4, y1 = y0 + 3.4;
    boxes.push(wall(-6, -66, 6, -65.7, y1, y0), wall(-6, -54.3, 6, -54, y1, y0), wall(-6, -65.7, -5.7, -54.3, y1, y0), wall(5.7, -65.7, 6, -54.3, y1, y0));
    boxes.push({ x0: -6, y0: y1 - 0.3, z0: -66, x1: 6, y1, z1: -54, ink: 1, kind: 'floor' });
  }
  const sim = crashSim(boxes), s = sim.world.structures[0];
  assert.ok(s.hp > 20000, 'too big to come down whole from one plane');
  flying(sim, 'plane', 0, 60, 0, VEHICLES.plane.top);
  const ev = fly(sim, 1, 3);
  assert.equal(sim.vehicles.length, 0);
  assert.ok(!s.down, 'the tower did not collapse as a whole');
  const drop = ev.flatMap((e) => (e.kind === 'wreck' ? e.drop ?? [] : []));
  assert.ok(drop.length > 100, `the top fell (${drop.length} pieces)`);
  const live = sim.world.boxes.filter((b) => !b.dead);
  assert.ok(!live.some((b) => b.y0 > 70), 'nothing is left hanging above the impact');
  assert.ok(live.filter((b) => b.y1 < 50).length >= 70, 'the floors below it still stand');
});

test('a plane into The Needle cuts it at the impact: the top falls, the base stands, and the tick stays cheap', () => {
  const sim = new Sim(1);
  sim.spawn([1, 2]);
  Object.assign(sim.players.get(2)!, { x: 300, y: 0, z: 300, gliding: false });
  const needle = sim.world.structures.reduce((a, b) => (b.boxes.length > a.boxes.length ? b : a));
  assert.ok(needle.y1 > 270, 'found The Needle');
  flying(sim, 'plane', (needle.x0 + needle.x1) / 2, 120, needle.z1 + 60, VEHICLES.plane.top); // from the south: open air in front
  let worst = 0, drop = 0;
  for (let i = 0; i < TICK_HZ * 4; i++) {
    const t = performance.now();
    const ev = sim.step(DT, new Map([[1, inp({ fwd: 1, yaw: 0, seq: i + 1 })], [2, inp({ seq: i + 1 })]]));
    worst = Math.max(worst, performance.now() - t);
    for (const e of ev) if (e.kind === 'wreck') drop += e.drop?.length ?? 0;
  }
  assert.ok(!sim.vehicles.some((v) => v.id === 900), 'the plane is wrecked');
  assert.ok(drop > 1000, `the top came down (${drop} pieces)`);
  const live = needle.boxes.filter((i) => !sim.world.boxes[i].dead).map((i) => sim.world.boxes[i]);
  assert.ok(!live.some((b) => b.y0 > 130), 'nothing of it is left above the impact');
  assert.ok(live.filter((b) => b.y1 < 100).length > 1500, 'the base still stands');
  assert.ok(worst < 150, `worst tick ${worst.toFixed(1)} ms`); // ~10 ms warm, ~35 ms in a cold process
});

// ---------- mantling ----------
// run at an obstacle (north, -z) and jump: where do you end up after 2 s?
function vault(boxes: Box[], jumpAt = 6) {
  const w = World.custom(boxes);
  const p = Object.assign(newBody(0, 0, 0), { grounded: true });
  for (let t = 0; t < TICK_HZ * 2; t++) moveStep(w, p, inp({ fwd: 1, sprint: true, jump: t === jumpAt, seq: t + 1 }), DT);
  return p;
}
test('a crate you jump at, you vault onto; a wall you can reach the top of, you climb', () => {
  const crate = vault([{ x0: -1, y0: 0, z0: -3, x1: 1, y1: 1.2, z1: -1.6, ink: 6, kind: 'crate' }], 2);
  assert.ok(crate.y > 1.1 || crate.z < -1.6, `crate: still in front of it (y ${crate.y.toFixed(2)} z ${crate.z.toFixed(2)})`);
  const ledge = vault([{ x0: -4, y0: 0, z0: -40, x1: 4, y1: 2.1, z1: -2.5, ink: 1, kind: 'wall' }]);
  assert.ok(Math.abs(ledge.y - 2.1) < 0.05 && ledge.z < -2.6, `2.1 m ledge: not on top (y ${ledge.y.toFixed(2)} z ${ledge.z.toFixed(2)})`);
  const tall = vault([{ x0: -4, y0: 0, z0: -40, x1: 4, y1: 3.6, z1: -2.5, ink: 1, kind: 'wall' }]);
  assert.ok(tall.y < 0.05 && tall.z > -2.5, `a 3.6 m wall was climbed (y ${tall.y.toFixed(2)})`);
});
test('jump at a window and you go through it and out the other side (if you fit, tucked)', () => {
  const z0 = -3, z1 = -2.7; // a 30 cm wall with a 1.6 m wide opening from 0.9 m to 3 m
  const p = vault([
    { x0: -5, y0: 0, z0, x1: -0.8, y1: 4, z1, ink: 1, kind: 'wall' }, { x0: 0.8, y0: 0, z0, x1: 5, y1: 4, z1, ink: 1, kind: 'wall' },
    { x0: -0.8, y0: 0, z0, x1: 0.8, y1: 0.9, z1, ink: 1, kind: 'wall' }, { x0: -0.8, y0: 3, z0, x1: 0.8, y1: 4, z1, ink: 1, kind: 'wall' },
  ]);
  assert.ok(p.z < z0 - 0.3, `still on this side (z ${p.z.toFixed(2)})`);
  const small = vault([ // the same wall with a window too small for you
    { x0: -5, y0: 0, z0, x1: -0.8, y1: 4, z1, ink: 1, kind: 'wall' }, { x0: 0.8, y0: 0, z0, x1: 5, y1: 4, z1, ink: 1, kind: 'wall' },
    { x0: -0.8, y0: 0, z0, x1: 0.8, y1: 0.9, z1, ink: 1, kind: 'wall' }, { x0: -0.8, y0: 1.7, z0, x1: 0.8, y1: 4, z1, ink: 1, kind: 'wall' },
  ]);
  assert.ok(small.z > z1, `squeezed through an 80 cm window (z ${small.z.toFixed(2)})`);
  const house = vault([ // a house window (1.4 x 1.2 m, sill at 1.1 m): you dive through it tucked
    { x0: -5, y0: 0, z0, x1: -0.7, y1: 4, z1, ink: 1, kind: 'wall' }, { x0: 0.7, y0: 0, z0, x1: 5, y1: 4, z1, ink: 1, kind: 'wall' },
    { x0: -0.7, y0: 0, z0, x1: 0.7, y1: 1.1, z1, ink: 1, kind: 'wall' }, { x0: -0.7, y0: 2.3, z0, x1: 0.7, y1: 4, z1, ink: 1, kind: 'wall' },
  ]);
  assert.ok(house.z < z0 - 0.3, `house window: still outside (z ${house.z.toFixed(2)})`);
});
