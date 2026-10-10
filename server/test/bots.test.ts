// The offline demo's bots (client/src/bots.ts), measured on the real map: whole matches and the places
// they used to get stuck. Every number here was a bug once (see the commit that added this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Sim, emptyInput, type Input } from '../../shared/src/sim.ts';
import { MODES, TICK_HZ, type Mode } from '../../shared/src/constants.ts';
import { makeTeams } from '../../shared/src/teams.ts';
import { rng } from '../../shared/src/rng.ts';
import { botInput, newBot, teamDrops, type Bot } from '../../client/src/bots.ts';

const DT = 1 / TICK_HZ;

// a full match like the demo plays it (40 bots, real map, same-team drop spots), with what went wrong
function match(seed: number, mode: Mode, capS = 600) {
  const sim = new Sim(seed);
  const ids = Array.from({ length: 40 }, (_, i) => i + 1);
  const teams = makeTeams(ids.map((id) => ({ id, party: '' })), MODES[mode].size);
  sim.spawn(ids, teams);
  const bots = ids.map((id) => newBot(id, rng(seed * 1000 + id)));
  teamDrops(bots, teams, rng(seed ^ 0xabc));
  const out = { stuckMax: 0, stormMax: 0, mateHits: 0, blind: 0, shots: 0, ringDeaths: 0, staleView: 0, botMs: 0, ticks: 0 };
  const trail = new Map<number, { x: number; z: number; free: boolean }[]>(), busy = new Set<number>();
  const storm = new Map<number, number>();
  while (sim.teamsAlive.size > 1 && sim.t < capS) {
    const inputs = new Map<number, Input>();
    const t0 = performance.now();
    for (const b of bots) if (sim.players.get(b.id)!.alive) inputs.set(b.id, botInput(b, sim));
    out.botMs += performance.now() - t0; out.ticks++;
    for (const b of bots) {
      const p = sim.players.get(b.id)!, inp = inputs.get(b.id);
      if (!inp) continue;
      if (inp.view !== sim.tick) out.staleView++;
      const tgt = b.target !== null ? sim.players.get(b.target) : null;
      if ((tgt?.alive && b.los) || p.use || inp.hold || inp.fire || p.ride || p.down > 0 || p.gliding) busy.add(b.id);
    }
    for (const e of sim.step(DT, inputs)) {
      if (e.kind === 'hit') { const v = sim.players.get(e.victim)!, by = sim.players.get(e.by); if (by && v.team === by.team && v.id !== by.id) out.mateHits++; }
      if (e.kind === 'elim' && e.cause === 'ring') out.ringDeaths++;
    }
    // every bullet a bot fires: could it see who it was shooting at?
    for (const s of sim.shots) {
      const tgt = bots[s.by - 1].target !== null ? sim.players.get(bots[s.by - 1].target!) : null;
      if (!tgt?.alive) continue;
      out.shots++;
      const seen = [1.15, 1.62].some((h) => { const dx = tgt.x - s.ox, dy = tgt.y + h - s.oy, dz = tgt.z - s.oz, d = Math.hypot(dx, dy, dz); return sim.world.raycast(s.ox, s.oy, s.oz, dx / d, dy / d, dz / d, d) >= d - 0.6; });
      if (!seen) out.blind++;
    }
    sim.shots.length = 0;
    for (const p of sim.players.values()) {
      if (!p.alive) continue;
      const out1 = Math.hypot(p.x - sim.ring.x, p.z - sim.ring.y) > sim.ring.r;
      const s = out1 ? (storm.get(p.id) ?? 0) + DT : 0;
      storm.set(p.id, s); out.stormMax = Math.max(out.stormMax, s);
      // stuck: under 2 m of headway in 20 s with nothing to do (no fight, heal, revive, ride)
      if (sim.tick % TICK_HZ) continue;
      const tr = trail.get(p.id) ?? [];
      tr.push({ x: p.x, z: p.z, free: !busy.has(p.id) && !p.gliding });
      if (tr.length > 21) tr.shift();
      trail.set(p.id, tr);
      let run = 0;
      for (let i = tr.length - 1; i >= 0 && tr[i].free && Math.hypot(tr[i].x - p.x, tr[i].z - p.z) < 2; i--) run++;
      out.stuckMax = Math.max(out.stuckMax, run - 1);
    }
    if (sim.tick % TICK_HZ === 0) busy.clear();
  }
  return { sim, ...out, t: sim.t };
}

test('a 40-bot solo match is fought to a winner: no one stuck, no one left in the storm, no stalemate', () => {
  const m = match(1, 'solo');
  assert.equal(m.sim.teamsAlive.size, 1, `no winner after ${m.t.toFixed(0)} s (${m.sim.alive} alive)`);
  assert.ok(m.t < 420, `took ${m.t.toFixed(0)} s: the storm, not a fight, decided it`);
  assert.ok(m.stuckMax < 20, `a bot stood still for ${m.stuckMax} s with nothing to do`);
  assert.ok(m.stormMax < 12, `a bot stayed ${m.stormMax.toFixed(0)} s in the storm`);
  assert.equal(m.ringDeaths, 0, 'bots walked out of the storm in time');
  assert.equal(m.staleView, 0, 'bots aim at the world as it is now (view 0 rewound every shot 300 ms)');
  assert.ok(m.blind / m.shots < 0.02, `${m.blind} of ${m.shots} bullets fired at a target behind a wall`);
  assert.ok(m.botMs / m.ticks < 4, `40 bots cost ${(m.botMs / m.ticks).toFixed(2)} ms a tick`);
});

test('a squad match: teammates never hurt each other, knocked teammates get picked up', () => {
  const m = match(2, 'squad');
  assert.equal(m.sim.teamsAlive.size, 1);
  assert.equal(m.mateHits, 0);
  assert.ok(m.stuckMax < 20, `a bot stood still for ${m.stuckMax} s with nothing to do`);
  assert.equal(m.ringDeaths, 0);
});

// one bot put somewhere awkward, the next circle far away: it has to get down and get going
function placed(setup: (sim: Sim, id: number) => void, cx: number, cz: number, secs: number) {
  const sim = new Sim(7);
  sim.spawn([1, 2]);
  const p = sim.players.get(1)!, foe = sim.players.get(2)!;
  Object.assign(foe, { x: 395, y: 0, z: 395, gliding: false, grounded: true }); // so the match goes on
  Object.assign(sim.ring, { nx: cx, ny: cz, nr: 50 });
  setup(sim, 1);
  const b: Bot = newBot(1, rng(99));
  b.landed = true;
  const d0 = Math.hypot(p.x - cx, p.z - cz);
  let ground = -1, out = p.ride ? -1 : 0, maxY = p.y;
  for (let i = 0; i < TICK_HZ * secs; i++) {
    sim.step(DT, new Map([[1, botInput(b, sim)], [2, { ...emptyInput(), seq: i + 1 }]]));
    if (ground < 0 && p.y < 1 && !p.ride) ground = sim.t;
    if (out < 0 && !p.ride) out = sim.t;
    maxY = Math.max(maxY, p.y);
  }
  return { ground, out, maxY, headway: d0 - Math.hypot(p.x - cx, p.z - cz), alive: p.alive };
}
const at = (x: number, y: number, z: number) => (sim: Sim, id: number) => Object.assign(sim.players.get(id)!, { x, y, z, gliding: false, grounded: true });

test('bots come down from The Needle (its roof, a floor, the updraft at its foot) and tall roofs', () => {
  for (const [name, setup, limit] of [
    ['the Needle roof (272 m)', at(-92, 272, -38), 40],
    ['the Needle, floor 40', at(-101, 136, -29), 40],
    ['the Needle updraft', at(-95, 0, -35), 5],
    ["the King's Tower roof", at(5, 24, 5), 20],
    ['the Spire roof', at(81, 105, -75), 30],
    ['the Spire, floor 12 (stairs only)', at(81, 42, -75), 50],
  ] as const) {
    const r = placed(setup, 200, 150, 60);
    assert.ok(r.ground >= 0 && r.ground < limit, `${name}: on the ground ${r.ground < 0 ? 'never' : `after ${r.ground.toFixed(1)} s`}`);
    assert.ok(r.headway > 100, `${name}: only ${r.headway.toFixed(0)} m closer to the circle in a minute`);
  }
});

test('bots get out of cars that are stuck, seats they never meant to take, and their own fort', () => {
  const wall = placed((sim, id) => { // a car parked nose-first against the King's Tower
    const v = sim.vehicles.find((v) => v.kind === 'car')!, p = sim.players.get(id)!;
    Object.assign(v.body, { x: -18.8, z: 6, y: 0, head: -Math.PI / 2, spd: 0, vx: 0, vz: 0 });
    Object.assign(p, { x: v.body.x, z: v.body.z, y: 0, gliding: false, grounded: true });
    (sim as unknown as { enterVehicle: (p: unknown, v: unknown) => void }).enterVehicle(p, v);
  }, -250, 200, 60);
  assert.ok(wall.out >= 0 && wall.out < 15, `stuck car: out after ${wall.out.toFixed(1)} s`);
  assert.ok(wall.headway > 100);
  const seat = placed((sim, id) => {
    const v = sim.vehicles.find((v) => v.kind === 'car')!, p = sim.players.get(id)!;
    Object.assign(p, { x: v.body.x + 1, z: v.body.z, y: v.body.y, gliding: false, grounded: true, rideV: v.id, ride: 1, seat: 1 });
    v.seats.push(id);
  }, -250, 200, 20);
  assert.ok(seat.out >= 0 && seat.out < 1, 'a passenger in a parked car hops out');
  const fort = placed((sim, id) => {
    at(120, 0, 300)(sim, id);
    const p = sim.players.get(id)!;
    p.perk = { kind: 'fort', n: 1 };
    (sim as unknown as { usePerk: (p: unknown, ev: unknown[]) => void }).usePerk(p, []);
  }, -250, -250, 30);
  assert.ok(fort.headway > 150, `walled in by its own fort: ${fort.headway.toFixed(0)} m in 30 s`);
});
