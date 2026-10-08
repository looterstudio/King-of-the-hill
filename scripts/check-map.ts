// Walks the whole island on foot (no jumping, no grapple) and reports every pencil case and
// loot spot a player could not reach. Grid search at 0.5 m: from a standing spot you can step to a
// neighbour if the surface there is at most a stair step higher (or any amount lower: you drop),
// and a player-sized cylinder fits.
//   npx tsx scripts/check-map.ts [seed ...]
import { World } from '../shared/src/world.ts';
import { MAP_HALF, PLAYER_R, STEP_H } from '../shared/src/constants.ts';

const STEP = 0.5, N = Math.floor((MAP_HALF * 2) / STEP);

export function reachability(w: World) {
  const idx = (v: number) => Math.round((v + MAP_HALF) / STEP);
  const pos = (i: number) => -MAP_HALF + i * STEP;
  const key = (i: number, j: number, y: number) => (i * (N + 1) + j) * 4096 + Math.round(y * 20);
  const seen = new Set<number>();
  // the same rules as moveBody: a square footprint, climb a box up to STEP_H if there is room on
  // top of it, otherwise blocked; with nothing in the way, fall onto the highest support under
  // the footprint (so narrow gaps are walked over, as in the game)
  const support = (x: number, z: number, y: number) => {
    let best = 0;
    for (const i of w.near(x - PLAYER_R, z - PLAYER_R, x + PLAYER_R, z + PLAYER_R)) {
      const b = w.boxes[i];
      if (!b.dead && x + PLAYER_R > b.x0 && x - PLAYER_R < b.x1 && z + PLAYER_R > b.z0 && z - PLAYER_R < b.z1 && b.y1 <= y + 1e-3 && b.y1 > best) best = b.y1;
    }
    return best;
  };
  const step1 = (x: number, z: number, y: number): number | null => {
    const b = w.overlaps(x, y, z);
    if (!b) return support(x, z, y);
    const rise = b.y1 - y;
    if (rise > 0 && rise <= STEP_H && !w.overlaps(x, b.y1 + 1e-3, z)) return b.y1;
    return null;
  };
  // walk from (fx, fz) to (x, z) in short strides, climbing and dropping as moveBody does
  let fx = 0, fz = 0;
  const step = (x: number, z: number, y: number): number | null => {
    let cy: number | null = y;
    for (let k = 1; k <= 5 && cy !== null; k++) cy = step1(fx + ((x - fx) * k) / 5, fz + ((z - fz) * k) / 5, cy);
    return cy;
  };
  const stand = (x: number, z: number, y: number) => !w.overlaps(x, y + 1e-3, z) && !w.lakes.some((l) => Math.hypot(l.x - x, l.z - z) < l.r - 1 && y < 0.1);
  // start on open ground in many places so every part of the island seeds the search
  const queue: number[] = [];
  for (let a = 0; a < 64; a++) {
    const x = Math.cos(a) * (30 + a * 2.5), z = Math.sin(a * 1.7) * (30 + a * 2.5);
    const i = idx(x), j = idx(z), y = w.groundAt(pos(i), pos(j), 0.5);
    if (y === 0 && stand(pos(i), pos(j), 0)) { const k = key(i, j, 0); if (!seen.has(k)) { seen.add(k); queue.push(i, j, 0); } }
  }
  // updrafts carry you up their column: from inside one you can step out onto any floor around it
  const lifts = w.updrafts.map((u) => {
    const exits: number[] = [];
    for (let i = idx(u.x - u.r - 1.2); i <= idx(u.x + u.r + 1.2); i++) for (let j = idx(u.z - u.r - 1.2); j <= idx(u.z + u.r + 1.2); j++) {
      const x = pos(i), z = pos(j);
      if (Math.hypot(x - u.x, z - u.z) < u.r) continue;
      const tops = new Set<number>();
      for (const k of w.near(x, z, x, z)) { const b = w.boxes[k]; if (!b.dead && b.y1 >= u.y0 && b.y1 <= u.y1 && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) tops.add(b.y1); }
      for (const h of tops) if (support(x, z, h + 1e-3) === h && stand(x, z, h)) exits.push(i, j, h);
    }
    return { u, exits, used: false };
  });
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let q = 0; q < queue.length; q += 3) {
    const i = queue[q], j = queue[q + 1], y = queue[q + 2] / 100;
    for (const l of lifts) {
      if (l.used || Math.hypot(pos(i) - l.u.x, pos(j) - l.u.z) >= l.u.r || y > l.u.y1) continue;
      l.used = true;
      for (let k = 0; k < l.exits.length; k += 3) { const key2 = key(l.exits[k], l.exits[k + 1], l.exits[k + 2]); if (!seen.has(key2)) { seen.add(key2); queue.push(l.exits[k], l.exits[k + 1], Math.round(l.exits[k + 2] * 100)); } }
    }
    for (const [di, dj] of D) {
      const ni = i + di, nj = j + dj;
      if (ni < 2 || nj < 2 || ni > N - 2 || nj > N - 2) continue;
      const nx = pos(ni), nz = pos(nj);
      fx = pos(i); fz = pos(j);
      if (di && dj && (step(pos(i + di), pos(j), y) === null || step(pos(i), pos(j + dj), y) === null)) continue; // no corner cutting
      const ny = step(nx, nz, y);
      if (ny === null) continue;
      const k = key(ni, nj, ny);
      if (seen.has(k)) continue;
      if (!stand(nx, nz, ny)) continue;
      seen.add(k); queue.push(ni, nj, Math.round(ny * 100));
    }
  }
  const reach = (x: number, y: number, z: number) => {
    const i0 = idx(x), j0 = idx(z);
    for (let di = -3; di <= 3; di++) for (let dj = -3; dj <= 3; dj++) {
      const i = i0 + di, j = j0 + dj;
      const g = support(pos(i), pos(j), y + 0.05);
      if (Math.abs(g - y) < 0.3 && seen.has(key(i, j, g))) return true;
    }
    return false;
  };
  return { nodes: seen.size, reach };
}

if (process.argv[1]?.endsWith("check-map.mjs") || process.argv[1]?.endsWith("check-map.ts")) {
  const seeds = process.argv.slice(2).map(Number);
  for (const seed of seeds.length ? seeds : [1234, 1, 77]) {
    const t0 = performance.now();
    const w = new World(seed);
    const { nodes, reach } = reachability(w);
    const nearest = (x: number, z: number) => w.pois.reduce((b, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(b.x - x, b.z - z) ? p : b)).name;
    const badCases = w.caseSpots.filter((c) => !reach(c.x, c.y, c.z));
    const badLoot = w.lootSpots.filter((l) => !reach(l.x, l.y, l.z));
    console.log(`seed ${seed}: ${nodes} standing spots, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    console.log(`  cases unreachable ${badCases.length}/${w.caseSpots.length}, loot unreachable ${badLoot.length}/${w.lootSpots.length}`);
    for (const c of [...badCases.map((c) => ({ ...c, t: c.golden ? 'GOLDEN' : 'case' })), ...badLoot.map((l) => ({ ...l, t: 'loot' }))].slice(0, 40))
      console.log(`  ${c.t} ${c.x.toFixed(1)}, ${c.y.toFixed(2)}, ${c.z.toFixed(1)}  (${nearest(c.x, c.z)})`);
  }
}
