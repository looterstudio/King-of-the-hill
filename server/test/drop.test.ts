// The drop (the paper plane, free fall, the glider) and the ways landing and walking used to go wrong:
// half inside a wall after landing near a roof, and stairs you could never walk down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUS, MODES, TICK_HZ } from '../../shared/src/constants.ts';
import { OTHER_BUS, OTHER_FALL } from '../../shared/src/protocol.ts';
import { Sim, busLine, emptyInput, leaveBus, moveStep, type Input } from '../../shared/src/sim.ts';
import { FALL, World, newBody, type Body, type Box } from '../../shared/src/world.ts';
import { frame } from '../../shared/src/snap.ts';
import { makeTeams } from '../../shared/src/teams.ts';
import { rng } from '../../shared/src/rng.ts';
import { botInput, newBot, teamDrops } from '../../shared/src/bots.ts';

const DT = 1 / TICK_HZ;
const inp = (o: Partial<Input> = {}): Input => ({ ...emptyInput(), ...o });
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: Box['kind'] = 'wall'): Box => ({ x0, y0, z0, x1, y1, z1, ink: 2, kind });

test('a match starts aboard the paper plane, on a line clear of The Needle that the seed alone decides', () => {
  const sim = new Sim(5);
  sim.spawn([1, 2, 3], undefined, { bus: true });
  const line = busLine(new World(5)); // what the waiting room draws before the match
  assert.deepEqual({ x: sim.bus!.x, z: sim.bus!.z, dx: sim.bus!.dx, dz: sim.bus!.dz }, line);
  for (const p of sim.players.values()) { assert.equal(p.bus, 1); assert.equal(p.y, BUS.y); }
  assert.ok(frame(sim).others.get(1)![7] & OTHER_BUS, 'drawn as the plane, not as a person');
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const w = new World(seed), l = busLine(w);
    for (const s of w.structures.filter((x) => x.y1 > BUS.y)) {
      const off = Math.abs(-l.dz * ((s.x0 + s.x1) / 2 - l.x) + l.dx * ((s.z0 + s.z1) / 2 - l.z));
      assert.ok(off > Math.hypot(s.x1 - s.x0, s.z1 - s.z0) / 2 + 5, `seed ${seed}: the plane flies through a tower`);
    }
  }
});

test('nobody stays aboard: the far edge throws out whoever never jumped', () => {
  const sim = new Sim(9);
  sim.spawn([1, 2], undefined, { bus: true });
  for (let k = 0; k < (BUS.len / BUS.speed + 1) * TICK_HZ; k++) sim.step(DT, new Map());
  for (const p of sim.players.values()) { assert.equal(p.bus, 0); assert.ok(p.gliding && p.fall === 1, 'out in free fall'); }
  assert.ok(frame(sim).others.get(1)![7] & OTHER_FALL);
});

test('out of the plane you free fall fast, the glider opens on Space, or by itself low down', () => {
  const flat = World.custom([]);
  const out = () => { const p = newBody(0, BUS.y, 0); p.bus = 1; p.vx = BUS.speed; leaveBus(p); return p; };
  // two seconds of free fall drop much further than two seconds under the glider
  const a = out(), b = out(); b.fall = 0;
  for (let k = 0; k < 2 * TICK_HZ; k++) { moveStep(flat, a, inp({ fwd: 1, pitch: -0.3 }), DT); moveStep(flat, b, inp({ fwd: 1, pitch: -0.3 }), DT); }
  assert.ok(BUS.y - a.y > (BUS.y - b.y) * 2.5, `free fall ${(BUS.y - a.y).toFixed(1)} m, glider ${(BUS.y - b.y).toFixed(1)} m`);
  assert.ok(a.vy < -25 && a.gliding && a.fall === 1);
  // Space opens it, and the fall slows to a glide
  moveStep(flat, a, inp({ fwd: 1, jump: true }), DT);
  assert.equal(a.fall, 0); assert.ok(a.gliding);
  for (let k = 0; k < TICK_HZ; k++) moveStep(flat, a, inp({ fwd: 1 }), DT);
  assert.ok(a.vy > -10, `gliding at ${a.vy.toFixed(1)} m/s`);
  // never pressing anything: it opens FALL.open over the ground, and you come down gently
  const c = out();
  let openedAt = -1;
  for (let k = 0; k < 40 * TICK_HZ && !c.grounded; k++) { moveStep(flat, c, inp({ pitch: -1.3 }), DT); if (openedAt < 0 && !c.fall) openedAt = c.y; }
  assert.ok(openedAt > FALL.open - 3 && openedAt <= FALL.open, `opened at ${openedAt.toFixed(1)} m`);
  assert.ok(c.grounded && !c.gliding);
});

test('the jump out, the free fall and the glide predict exactly (the server and moveStep agree tick by tick)', () => {
  const sim = new Sim(11);
  sim.spawn([1], undefined, { bus: true });
  const me = sim.players.get(1)!, pred = { ...me } as Body;
  const KEYS = Object.keys(newBody(0, 0, 0)) as (keyof Body)[];
  for (let k = 1; k < 25 * TICK_HZ; k++) {
    const i = inp({ seq: k, fwd: 1, strafe: Math.sin(k / 20), yaw: 0.4 + Math.sin(k / 50), pitch: k < 200 ? -1.2 : -0.4, jump: k === 30 || k === 120 });
    // aboard, the plane carries you by the clock (the client rides its own estimate of it): the same here
    if (pred.bus) { const at = sim.busAt(sim.t + DT); Object.assign(pred, { x: at.x, y: BUS.y, z: at.z, vx: sim.bus!.dx * BUS.speed, vy: 0, vz: sim.bus!.dz * BUS.speed }); }
    moveStep(sim.world, pred, i, DT);
    sim.step(DT, new Map([[1, i]]));
    for (const key of KEYS) assert.equal(pred[key], me[key], `tick ${k}: ${key} ${pred[key]} vs ${me[key]}`);
  }
  assert.ok(me.grounded, 'landed');
});

test('bots out of the plane open their gliders for far spots, and everyone is down long before the storm moves', () => {
  const sim = new Sim(3), ids = Array.from({ length: 24 }, (_, i) => i + 1), teams = makeTeams(ids.map((id) => ({ id, party: '' })), MODES.duo.size);
  sim.spawn(ids, teams, { bus: true });
  const bots = ids.map((id) => newBot(id, rng(3000 + id)));
  teamDrops(bots, teams, rng(77));
  const landed = new Set<number>(), opened = new Set<number>(), was = new Map<number, number>();
  for (let k = 0; k < 50 * TICK_HZ; k++) {
    sim.step(DT, new Map(bots.filter((b) => sim.players.get(b.id)!.alive).map((b) => [b.id, botInput(b, sim)])));
    for (const p of sim.players.values()) {
      if (!p.bus && p.grounded) landed.add(p.id);
      if (was.get(p.id) === 1 && !p.fall && p.y - sim.world.groundAt(p.x, p.z, p.y) > FALL.open + 5) opened.add(p.id); // pulled it high up
      was.set(p.id, p.fall);
    }
  }
  assert.equal(landed.size, ids.length, `${ids.length - landed.size} still in the air`);
  assert.ok(opened.size > 0, 'some bots opened their glider to reach a far spot');
});

// every step of a body against a world: never left inside a box (a mantle tucks you through a window on
// purpose, so not while one runs)
function inside(w: World, p: Body) { return p.mantleT > 0 ? null : w.overlaps(p.x, p.y, p.z); }

test('walking into a corner never throws you through the far wall (a sill, a pier and a wall meeting)', () => {
  // a window corner: a wall along x, a pier along z, the sill and the lintel of the window next to the pier.
  // Walking at it diagonally, the old code pushed you flush against the first wall it found, into the pier,
  // and the next axis threw you 1.4 m back out of the pier onto the sill, half inside the wall
  const w = World.custom([box(-6, 0, 53.85, -4.06, 3.5, 54.15), box(-6.15, 0, 52.5, -5.85, 3.5, 54), box(-6.15, 0, 51.1, -5.85, 1.1, 52.5), box(-6.15, 2.3, 51.1, -5.85, 3.5, 52.5)]);
  const p = newBody(-6.55, 0, 53.516); p.grounded = true;
  for (let k = 0; k < 20; k++) {
    const z = p.z;
    moveStep(w, p, inp({ fwd: 1, sprint: true, yaw: -2.0 }), DT);
    assert.equal(inside(w, p), null, `tick ${k}: inside a wall at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
    assert.ok(p.z >= z - 1e-6 && p.y === 0, `tick ${k}: thrown back to z ${p.z.toFixed(2)}, y ${p.y.toFixed(2)}`);
  }
});

test('gliding or falling onto roof edges, parapets and walls never leaves you inside one', () => {
  // a house with a parapet round its roof, a lower wing with a sill and a pier, and the real map's roofs
  const house = [box(0, 0, 0, 12, 6, 10, 'building'), box(0, 6, 0, 12, 7, 0.3), box(0, 6, 9.7, 12, 7, 10), box(0, 6, 0.3, 0.3, 7, 9.7), box(11.7, 6, 0.3, 12, 7, 9.7),
    box(12, 0, 2, 18, 3.5, 2.3), box(17.7, 0, 2.3, 18, 3.5, 6), box(17.7, 0, 6, 18, 1.1, 8), box(17.7, 2.3, 6, 18, 3.5, 8), box(12, 3.25, 2, 18, 3.5, 8, 'floor')];
  const worlds: [World, { x0: number; z0: number; x1: number; z1: number; y: number }[]][] = [[World.custom(house), [{ x0: 0, z0: 0, x1: 12, z1: 10, y: 7 }, { x0: 12, z0: 2, x1: 18, z1: 8, y: 3.5 }]]];
  const real = new World(1);
  worlds.push([real, real.roofs]);
  const r = rng(4242);
  let runs = 0;
  for (const [w, roofs] of worlds) for (let n = 0; n < 500; n++) {
    const rf = roofs[Math.floor(r() * roofs.length)], ex = rf.x0 + (rf.x1 - rf.x0) * r(), ez = rf.z0 + (rf.z1 - rf.z0) * r(), a = r() * Math.PI * 2, back = 3 + r() * 25;
    const p = newBody(ex + Math.cos(a) * back, rf.y + 2 + r() * 25, ez + Math.sin(a) * back);
    if (w.overlaps(p.x, p.y, p.z)) continue;
    p.gliding = r() < 0.75; p.fall = p.gliding && r() < 0.3 ? 1 : 0;
    const yaw = Math.atan2(-(ex - p.x), -(ez - p.z)), pitch = -r() * 1.4;
    runs++;
    for (let k = 0; k < 8 * TICK_HZ && !(p.grounded && k > 60); k++) {
      moveStep(w, p, inp({ fwd: 1, strafe: r() < 0.2 ? r() * 2 - 1 : 0, sprint: true, yaw: yaw + (r() - 0.5) * 0.4, pitch, jump: r() < 0.03 }), DT);
      const b = inside(w, p);
      assert.equal(b, null, `run ${n}, tick ${k}: inside ${b ? [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].join(',') : ''} at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
    }
  }
  assert.ok(runs > 800);
});

test('something built on top of you pushes you out the short way, never through it', () => {
  const w = World.custom([box(-2, 0, -0.1, 2, 3, 0.3)]); // a wall that went up across your feet
  const p = newBody(0, 0, 0.5); p.grounded = true;
  moveStep(w, p, inp(), DT);
  assert.equal(inside(w, p), null);
  assert.ok(p.z > 0.69 && p.z < 0.75 && p.y === 0, `out to the near side: z ${p.z.toFixed(2)}, y ${p.y.toFixed(2)}`);
});

test('walking down a flight of stairs gets you downstairs, in third person as in first', () => {
  // a house's stairwell: steps down -z inside a hole in the floor above, which carries on over the foot of the
  // flight. Between two steps you are in the air a moment, and that floor came within mantle reach: it pulled
  // you back up onto it every time
  const steps = Array.from({ length: 7 }, (_, i) => box(-0.7, 0, -i * 0.55 - 0.55, 0.7, 3.5 - i * 0.5, -i * 0.55, 'stair'));
  const w = World.custom([...steps,
    box(-1, 3.25, -5.35, 11, 3.5, -4.05, 'floor'), box(-1, 3.25, 0.2, 11, 3.5, 6, 'floor'), box(0.9, 3.25, -4.05, 11, 3.5, 0.2, 'floor'),
    box(-1.15, 0, -5.5, 1, 3.5, -5.2), box(-1.15, 0, -5.2, -0.85, 3.5, 3)]);
  for (const tp of [true, false]) {
    const p = newBody(0, 3.5, -0.3); p.grounded = true;
    let top = 3.5, low = 3.5;
    for (let k = 0; k < 60; k++) {
      moveStep(w, p, inp({ seq: k + 1, fwd: 1, yaw: 0, pitch: -0.35, tp }), DT);
      low = Math.min(low, p.y); top = Math.max(top, p.y - low);
      assert.ok(p.mantleT <= 0, `tp ${tp}, tick ${k}: climbing back up at y ${p.y.toFixed(2)}`);
    }
    assert.equal(p.y, 0, `tp ${tp}: downstairs (y ${p.y.toFixed(2)}, z ${p.z.toFixed(2)})`);
    assert.ok(p.z < -4.5, `tp ${tp}: out at the foot of the flight`);
  }
});
