// The offline demo's bots: a pure function of the bot's memory and the simulation (no DOM), so the
// same brain runs in the browser and in headless tests (server/test/bots.test.ts); the server fills its rooms with them too.
import { EYE_H, HEAD_Y, INTERACT_R, ITEMS, KNOCK, PERKS, TICK_HZ, UPGRADE, WEAPONS, isAir, type ItemId, type PerkId, type WeaponId } from './constants.ts';
import { emptyInput, type Case, type Input, type Loot, type PlayerState, type Sim } from './sim.ts';
import { rayBox, type World } from './world.ts';

const DT = 1 / TICK_HZ;
interface Pt { x: number; z: number }
interface Waypoint { x: number; z: number; hop: number; drop: boolean }
interface Plan { gx: number; gz: number; y: number; at: number; pts: Waypoint[]; i: number; noWay: boolean } // noWay: can't get any closer than here
// steering answer: which way to walk (world space), whether to jump something, and whether the goal can't be reached
interface Dir { x: number; z: number; hop: boolean; stuck: boolean }

// names for the bots that fill a room
export const BOT_NAMES = ['degen', 'wagmi', 'ser_pump', 'rugless', 'bonkbro', 'paperhand', 'diamond', 'jeet', 'moonboi', 'gmgm', 'solchad', 'wifhat', 'ape420', 'fomo', 'ngmi', 'rekt', 'gigabrain', 'anon', 'whale', 'hodl', 'pixel', 'scribble', 'inky', 'doodle', 'crayon'];

export interface Bot {
  id: number; rand: () => number; skill: number; strafe: number; aimErr: number; reaction: number;
  target: number | null; los: boolean; vis: number; losT: number; seenT: number; acqT: number; // target visible at the last check (2 head, 1 chest), last seen, first seen
  wp: Pt; wpT: number; carId: number; carT: number; seq: number; dropX: number; dropZ: number; landed: boolean; mode: string; dest: Pt;
  plan: Plan | null; navT: number; direct: boolean; forcePlan: number; groundY: number; jumpT: number; jumps: number;
  goal: { ref: Loot | Case; kind: 'case' | 'loot'; t0: number; arrived: number } | null; scanT: number; skip: Map<number, number>;
  prog: { x: number; z: number; t: number }; gp: { x: number; z: number; best: number; t: number } | null; escape: { yaw: number; until: number } | null; blockT: number;
  life: number; hitT: number; slotT: number; rot: boolean; away: { x: number; z: number; until: number } | null; car: { t: number; best: number; slow: number; back: number; tries: number } | null;
}

export function newBot(id: number, rand: () => number): Bot {
  const skill = 0.3 + rand() * 0.55, strafe = rand() < 0.5 ? 1 : -1, dropX = (rand() - 0.5) * 640, dropZ = (rand() - 0.5) * 640;
  return {
    id, rand, skill, strafe, aimErr: 0, reaction: 0, target: null, los: false, vis: 0, losT: (id % 10) * 0.04, seenT: -99, acqT: 0,
    wp: { x: dropX, z: dropZ }, wpT: 0, carId: 0, carT: 0, seq: 0, dropX, dropZ, landed: false, mode: 'glide', dest: { x: dropX, z: dropZ },
    plan: null, navT: 0, direct: true, forcePlan: 0, groundY: 0, jumpT: -9, jumps: 0,
    goal: null, scanT: (id % 20) * 0.03, skip: new Map(), prog: { x: 0, z: 0, t: 0 }, gp: null, escape: null, blockT: 0,
    life: 500, hitT: -99, slotT: -99, rot: false, away: null, car: null,
  };
}

// a team glides to the same spot
export function teamDrops(bots: Bot[], teams: Map<number, number>, rand: () => number) {
  const spot = new Map<number, { x: number; z: number }>();
  for (const b of bots) { const t = teams.get(b.id)!; const at = spot.get(t) ?? { x: b.dropX, z: b.dropZ }; spot.set(t, at); b.dropX = at.x + (rand() - 0.5) * 8; b.dropZ = at.z + (rand() - 0.5) * 8; }
}

const yawTo = (p: Pt, x: number, z: number) => Math.atan2(-(x - p.x), -(z - p.z));
const angDiff = (a: number, b: number) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
// walk along a world direction while facing `yaw` (forward is -z at yaw 0, like moveBody)
function moveDir(inp: Input, dx: number, dz: number, k = 1) {
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) { inp.fwd = 0; inp.strafe = 0; return; }
  const s = Math.sin(inp.yaw), c = Math.cos(inp.yaw);
  inp.fwd = clamp(((-dx * s - dz * c) / l) * k, -1, 1); inp.strafe = clamp(((dx * c - dz * s) / l) * k, -1, 1);
}

// ---------------- seeing: a ray that only looks at the boxes at its own height ----------------
// World.raycast walks 2D columns and tests every box in them: one ray past The Needle (80 floors) is
// ~0.4 ms. The 3D index keeps a sight line at 0.01-0.02 ms.
const scratch: number[] = [];
function rayT(w: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  let best = maxT;
  if (dy < 0) { const tg = -oy / dy; if (tg < best) best = tg; }
  const CELL = 8, H = 400, G = 100;
  let cx = Math.floor((ox + H) / CELL), cz = Math.floor((oz + H) / CELL);
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  let tx = Math.abs(dx) > 1e-9 ? ((cx + (sx > 0 ? 1 : 0)) * CELL - H - ox) / dx : Infinity, tz = Math.abs(dz) > 1e-9 ? ((cz + (sz > 0 ? 1 : 0)) * CELL - H - oz) / dz : Infinity;
  const ddx = Math.abs(dx) > 1e-9 ? CELL / Math.abs(dx) : Infinity, ddz = Math.abs(dz) > 1e-9 ? CELL / Math.abs(dz) : Infinity;
  let t0 = 0;
  for (let n = 0; n < 200 && t0 < best; n++) {
    const t1 = Math.min(tx, tz, best), ya = oy + dy * t0, yb = oy + dy * t1;
    if (cx >= 0 && cz >= 0 && cx < G && cz < G) {
      const x0 = cx * CELL - H, z0 = cz * CELL - H;
      for (const i of w.near3(x0 + 0.01, Math.min(ya, yb), z0 + 0.01, x0 + CELL - 0.01, Math.max(ya, yb), z0 + CELL - 0.01, scratch)) {
        const b = w.boxes[i];
        if (b.dead) continue;
        const h = rayBox(ox, oy, oz, dx, dy, dz, b);
        if (h >= 0 && h < best) best = h;
      }
    } else if (t0 > 0) break;
    if (tx < tz) { t0 = tx; tx += ddx; cx += sx; } else { t0 = tz; tz += ddz; cz += sz; }
  }
  return best;
}
// how well p sees q: 2 the head, 1 the chest, 0 not at all
function sight(w: World, p: PlayerState, q: PlayerState): number {
  const ox = p.x, oy = p.y + EYE_H, oz = p.z;
  for (const [k, h] of [[1, 1.15], [2, HEAD_Y]] as const) {
    const tx = q.x - ox, ty = q.y + h - oy, tz = q.z - oz, d = Math.hypot(tx, ty, tz) || 1;
    if (rayT(w, ox, oy, oz, tx / d, ty / d, tz / d, d) >= d - 0.3) return k;
  }
  return 0;
}

// ---------------- walking: straight when the way is clear, a short A* path when it isn't ----------------
// A 64 m window of 0.5 m cells at the bot's own floor height: walls block, low things (crates, sills,
// battlements) are hopped, and where the floor ends is a drop, the way down off a roof or a tower.
const C = 0.5, N = 128, NN = N * N, FREE = 0, NEAR = 1, HOP = 2, BLOCK = 3, DROP = 4;
const cls = new Uint8Array(NN), sup = new Uint8Array(NN), hopTop = new Float32Array(NN), ceil = new Float32Array(NN);
const gs = new Float32Array(NN), from = new Int32Array(NN), seenS = new Uint32Array(NN), doneS = new Uint32Array(NN);
const pass = new Uint8Array(NN), DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1]; // straight first, then diagonals
const heapI = new Int32Array(1 << 17), heapF = new Float32Array(1 << 17);
let stamp = 0;
const budget = new WeakMap<Sim, { tick: number; n: number }>();
const MAX_PLANS = 2; // per tick, all bots together: a plan costs 0.2 ms, 4 ms at worst

function raster(ox: number, oz: number, x0: number, z0: number, x1: number, z1: number, e: number, f: (i: number) => void) {
  const i0 = Math.max(0, Math.ceil((x0 - e - ox) / C - 0.5)), i1 = Math.min(N - 1, Math.floor((x1 + e - ox) / C - 0.5));
  const j0 = Math.max(0, Math.ceil((z0 - e - oz) / C - 0.5)), j1 = Math.min(N - 1, Math.floor((z1 + e - oz) / C - 0.5));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * N + i);
}

function plan(w: World, sx: number, sz: number, y: number, gx: number, gz: number, down: boolean, t: number): Plan {
  // the window: around the midpoint, the goal pulled in to 40 m so both ends have room to go around things
  const gd = Math.hypot(gx - sx, gz - sz), pull = gd > 40 ? 40 / gd : 1, tx = sx + (gx - sx) * pull, tz = sz + (gz - sz) * pull;
  const ox = (sx + tx) / 2 - (N * C) / 2, oz = (sz + tz) / 2 - (N * C) / 2;
  cls.fill(FREE); sup.fill(y < 0.6 ? 1 : 0); hopTop.fill(0); ceil.fill(99);
  for (const i of w.near3(ox, y - 1, oz, ox + N * C, y + 4, oz + N * C, scratch)) {
    const b = w.boxes[i];
    if (b.dead) continue;
    const r0 = b.y0 - y, r1 = b.y1 - y;
    // a floor holds the body while any of its footprint is on it: a drop is only where none of it is
    if (r1 <= 0.56) { if (r1 >= -0.8 && y >= 0.6) raster(ox, oz, b.x0, b.z0, b.x1, b.z1, 0.42, (c) => { sup[c] = 1; }); }
    else if (r0 < 1.8) {
      if (r1 <= 2.0) raster(ox, oz, b.x0, b.z0, b.x1, b.z1, 0.3, (c) => { if (hopTop[c] < r1) hopTop[c] = r1; });
      // blocked out to just past the body's radius (0.4): at 0.3 a waypoint could sit 0.4 m off a door jamb,
      // exactly where the body touches it, and the bot walked into the corner for good; near out to 0.7 so
      // paths keep to the middle of a doorway
      else { raster(ox, oz, b.x0, b.z0, b.x1, b.z1, 0.7, (c) => { if (cls[c] === FREE) cls[c] = NEAR; }); raster(ox, oz, b.x0, b.z0, b.x1, b.z1, 0.42, (c) => { cls[c] = BLOCK; }); }
    } else if (r0 < 3.9) raster(ox, oz, b.x0, b.z0, b.x1, b.z1, 0.3, (c) => { if (ceil[c] > r0) ceil[c] = r0; });
  }
  for (const u of w.updrafts) if (y < u.y1 && y > u.y0 - 2) raster(ox, oz, u.x - u.r, u.z - u.r, u.x + u.r, u.z + u.r, 0.6, (c) => { cls[c] = BLOCK; }); // a lift to the top of The Needle
  for (let c = 0; c < NN; c++) {
    if (cls[c] === BLOCK) continue;
    if (hopTop[c] > 0) cls[c] = ceil[c] - hopTop[c] >= 1.82 ? HOP : BLOCK; // a window sill with no room above it is a wall
    else if (!sup[c]) cls[c] = DROP;
  }
  const cell = (x: number, z: number) => clamp(Math.floor((z - oz) / C), 0, N - 1) * N + clamp(Math.floor((x - ox) / C), 0, N - 1);
  const s = cell(sx, sz), goal = cell(tx, tz), gi = goal % N, gj = (goal / N) | 0;
  cls[s] = FREE;
  // weighted A* (paths a little longer than the best, a fraction of the search), capped: a goal it can't
  // reach used to search the whole window, ~10 ms
  for (let c = 0; c < NN; c++) pass[c] = cls[c] !== BLOCK && (down || cls[c] !== DROP) ? 1 : 0;
  const H = 1.5, h = (c: number) => { const di = Math.abs((c % N) - gi), dj = Math.abs(((c / N) | 0) - gj); return di > dj ? di + 0.414 * dj : dj + 0.414 * di; };
  stamp++;
  let hn = 0;
  const push = (c: number, f: number) => {
    let k = hn++;
    while (k > 0) { const up = (k - 1) >> 1; if (heapF[up] <= f) break; heapI[k] = heapI[up]; heapF[k] = heapF[up]; k = up; }
    heapI[k] = c; heapF[k] = f;
  };
  const pop = () => {
    const top = heapI[0], li = heapI[--hn], lf = heapF[hn];
    let k = 0;
    for (;;) { let m = 2 * k + 1; if (m >= hn) break; if (m + 1 < hn && heapF[m + 1] < heapF[m]) m++; if (heapF[m] >= lf) break; heapI[k] = heapI[m]; heapF[k] = heapF[m]; k = m; }
    heapI[k] = li; heapF[k] = lf;
    return top;
  };
  gs[s] = 0; from[s] = -1; seenS[s] = stamp; push(s, h(s) * H);
  let found = -1, best = s, bestH = h(s), n = 0;
  while (hn > 0 && n < 3000 && hn < heapI.length - 16) {
    const c = pop();
    if (doneS[c] === stamp) continue;
    doneS[c] = stamp; n++;
    if (c === goal || (down && cls[c] === DROP)) { found = c; break; }
    const hc = h(c);
    if (hc < bestH) { bestH = hc; best = c; }
    const ci = c % N, cj = (c / N) | 0, gc = gs[c];
    for (let k = 0; k < 8; k++) {
      const di = DI[k], dj = DJ[k], ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nc = nj * N + ni;
      if (!pass[nc] || doneS[nc] === stamp) continue;
      if (k >= 4 && (!pass[cj * N + ni] || !pass[nj * N + ci])) continue; // no cutting corners
      // on the way down, no hop onto a higher hop: a row of those is a staircase going up, and the plan is
      // at one height, so it used to climb back up a flight to reach "drops" that were the floor above
      if (down && cls[c] === HOP && cls[nc] === HOP && hopTop[nc] > hopTop[c] + 0.3) continue;
      // stepping off something we hopped onto: the body is that much higher, and must fit under what is above
      // the next cell (off the side of a staircase, under the floor above, it doesn't)
      if (cls[c] === HOP && cls[nc] !== HOP && ceil[nc] - hopTop[c] < 1.82) continue;
      const q = cls[nc], g = gc + (k >= 4 ? 1.414 : 1) * (q === NEAR ? 2.5 : q === HOP ? (hopTop[nc] > 1.15 ? 9 : 4) : 1);
      if (seenS[nc] !== stamp || g < gs[nc]) { seenS[nc] = stamp; gs[nc] = g; from[nc] = c; push(nc, g + h(nc) * H); }
    }
  }
  const end = found >= 0 ? found : best, cells: number[] = [];
  for (let c = end; c >= 0; c = from[c]) cells.push(c);
  cells.reverse();
  // string-pull: keep only the corners, every hop and the drop
  const at = (c: number) => ({ x: ox + ((c % N) + 0.5) * C, z: oz + (((c / N) | 0) + 0.5) * C });
  const clear = (a: number, b: number) => {
    const A = at(a), B = at(b), L = Math.hypot(B.x - A.x, B.z - A.z), n = Math.ceil(L / 0.25);
    for (let k = 1; k < n; k++) { const q = cls[cell(A.x + ((B.x - A.x) * k) / n, A.z + ((B.z - A.z) * k) / n)]; if (q !== FREE && q !== NEAR) return false; }
    return true;
  };
  const pts: Waypoint[] = [];
  let anchor = cells[0];
  for (let k = 1; k < cells.length; k++) {
    const c = cells[k], q = cls[c];
    if (q === HOP || q === DROP) {
      if (cells[k - 1] !== anchor) pts.push({ ...at(cells[k - 1]), hop: 0, drop: false });
      pts.push({ ...at(c), hop: q === HOP ? (hopTop[c] > 1.15 ? 2 : 1) : 0, drop: q === DROP });
      if (q === DROP) { // and on over the edge: stopping on it, the body still stands on the floor beside
        const a = at(cells[k - 1]), e = at(c), l = Math.hypot(e.x - a.x, e.z - a.z) || 1;
        pts.push({ x: e.x + ((e.x - a.x) / l) * 1.2, z: e.z + ((e.z - a.z) / l) * 1.2, hop: 0, drop: true });
        break;
      }
      anchor = c;
      continue;
    }
    if (k + 1 < cells.length && cls[cells[k + 1]] !== HOP && cls[cells[k + 1]] !== DROP && clear(anchor, cells[k + 1])) continue;
    pts.push({ ...at(c), hop: 0, drop: false });
    anchor = c;
  }
  const e = at(end), there = found >= 0 && (pull === 1 || cls[end] === DROP);
  return { gx, gz, y, at: t, pts, i: 0, noWay: !there && Math.hypot(e.x - gx, e.z - gz) > 2.5 && Math.hypot(e.x - sx, e.z - sz) < 1.5 };
}

// can we walk straight there? Knees (both shoulders) and chest rays, no updraft, and a floor all the way
function clearWalk(w: World, x: number, z: number, y: number, gx: number, gz: number, down: boolean): boolean {
  const d = Math.hypot(gx - x, gz - z);
  if (d < 0.4) return true;
  const L = Math.min(d, 22), dx = (gx - x) / d, dz = (gz - z) / d, sx = -dz * 0.32, sz = dx * 0.32;
  if (rayT(w, x + sx, y + 0.65, z + sz, dx, 0, dz, L) < L || rayT(w, x - sx, y + 0.65, z - sz, dx, 0, dz, L) < L || rayT(w, x, y + 1.5, z, dx, 0, dz, L) < L) return false;
  for (const u of w.updrafts) {
    if (y > u.y1 || y < u.y0 - 2) continue;
    const t = clamp((u.x - x) * dx + (u.z - z) * dz, 0, L);
    if (Math.hypot(x + dx * t - u.x, z + dz * t - u.z) < u.r + 0.8) return false;
  }
  if (y > 0.6 && !down) for (let s = 1; s < L; s += 1) if (w.groundAt(x + dx * s, z + dz * s, y + 0.6) < y - 0.75) return false;
  return true;
}

function steer(b: Bot, sim: Sim, self: PlayerState, gx: number, gz: number, gy: number): Dir {
  const y = b.groundY, down = gy < y - 0.6, t = sim.t;
  b.dest = { x: gx, z: gz };
  if (t >= b.navT) {
    b.navT = t + 0.25 + b.rand() * 0.1;
    b.direct = t >= b.forcePlan && clearWalk(sim.world, self.x, self.z, y, gx, gz, down);
    if (b.direct) b.plan = null;
  }
  let p = b.plan;
  if (p) while (p.i < p.pts.length) { const q = p.pts[p.i]; if (Math.hypot(q.x - self.x, q.z - self.z) < (q.hop || q.drop ? 0.45 : 0.75)) p.i++; else break; }
  // a new plan when the goal moved, we changed floors, it got old, or we walked it all (not more than twice a second)
  const stale = !p || Math.hypot(p.gx - gx, p.gz - gz) > 3 || Math.abs(p.y - y) > 0.8 || t - p.at > 5 || (p.i >= p.pts.length && t - p.at > 0.5);
  if (!b.direct && stale && (!p || t - p.at > 0.4 || Math.hypot(p.gx - gx, p.gz - gz) > 3)) {
    const bud = budget.get(sim) ?? { tick: -1, n: 0 };
    if (bud.tick !== sim.tick) { bud.tick = sim.tick; bud.n = 0; budget.set(sim, bud); }
    if (bud.n < MAX_PLANS) { bud.n++; p = b.plan = plan(sim.world, self.x, self.z, y, gx, gz, down, t); }
  }
  if (b.direct || !p) return { x: gx - self.x, z: gz - self.z, hop: false, stuck: false };
  if (p.i >= p.pts.length) return { x: gx - self.x, z: gz - self.z, hop: false, stuck: p.noWay };
  const q = p.pts[p.i], d = Math.hypot(q.x - self.x, q.z - self.z);
  return { x: q.x - self.x, z: q.z - self.z, hop: q.hop > 0 && d < 1.2, stuck: p.noWay };
}

// jump, then again near the top of the jump: clears 2 m (a fort wall, a battlement)
function hop(b: Bot, self: PlayerState, inp: Input, t: number) {
  if (self.grounded) { inp.jump = true; b.jumpT = t; b.jumps = 1; }
  else if (b.jumps === 1 && t - b.jumpT < 0.8 && self.vy < 1) { inp.jump = true; b.jumps = 2; }
}

// ---------------- guns ----------------
// damage per second this gun would do at range d (the mag it has now, or a full one when null). The
// Stinger is for aircraft: fired at someone on foot it is a 500-damage rocket that kills through full
// shields, which bots leave alone
function gunValue(w: WeaponId, ups: number, mag: number | null, d: number, skill: number, air = false): number {
  const def = WEAPONS[w];
  if (d > def.range * 0.95 || (def.proj && d < 11) || (w === 'stinger') !== air) return 0; // out of reach, our own blast, the wrong job
  const scoped = w === 'heavy' || w === 'hunting', aim = d > 30;
  const spread = def.spread * (aim ? (scoped ? 0.02 : 0.5) : 1) * 1.3 + (1 - skill) * 0.03;
  const hit = def.proj ? 0.55 : Math.min(1, 0.4 / Math.max(0.01, d * spread));
  const fall = def.pellets > 1 ? clamp(1.2 - d / def.range, 0.35, 1) : 1;
  const burst = def.burst ?? 1, shot = def.dmg * (1 + UPGRADE.perLevel * ups) * def.pellets * hit * fall * burst;
  const cycle = def.burst ? def.cd + 0.15 : def.cd, m = def.mag / burst;
  const sustained = (shot * m) / (m * cycle + def.reload);
  if (mag === null) return sustained;
  return mag > 0 ? Math.max(sustained, (shot / cycle) * 0.8) : sustained * 0.35;
}
const worth = (w: WeaponId, ups: number, skill: number) => 0.3 * gunValue(w, ups, null, 8, skill) + 0.5 * gunValue(w, ups, null, 30, skill) + 0.2 * gunValue(w, ups, null, 70, skill);

// ---------------- the brain ----------------
// bots: glide to a drop spot, loot, rotate ahead of the storm, fight what they can see, hunt at the end
export function botInput(b: Bot, sim: Sim): Input {
  const R = b.rand, w = sim.world, t = sim.t;
  const self = sim.players.get(b.id)!, g = sim.ring;
  // view: the tick we're looking at. A bot sees the world as it is; 0 meant the oldest lag-compensated
  // positions (300 ms back), so every bullet was tested against where its target used to be
  const inp: Input = { ...emptyInput(), seq: ++b.seq, yaw: self.yaw, pitch: self.pitch, view: sim.tick };
  // the floor we're on, for planning: walking down stairs the body is in the air a moment on every step,
  // and only updating it when grounded left a bot at the foot of a flight planning from the floor above
  // (the plan sent it back up, and round again)
  if (!self.ride) {
    if (self.grounded) b.groundY = self.y;
    else if (!self.gliding) { const gy = w.groundAt(self.x, self.z, self.y + 0.05); if (self.y - gy < 1.2) b.groundY = gy; }
  }

  // the storm: stand inside the next circle, on our side of it; leave early enough to make it, and don't
  // turn back at its edge (rotating out to 0.75 of it, back in from 0.62)
  const dNext = Math.hypot(self.x - g.nx, self.z - g.ny), dCur = Math.hypot(self.x - g.x, self.z - g.y);
  const inStorm = dCur > g.r - 1;
  const waitLeft = g.closing ? 0 : g.nextAt - t, due = waitLeft < 10 + Math.max(0, dNext - g.nr * 0.6) / 6;
  if (inStorm || dCur > g.r * 0.88 - 3 || (due && dNext > g.nr * 0.75)) b.rot = true;
  else if (!due || dNext < g.nr * 0.62) b.rot = false;
  const rotate = b.rot;
  // shot at (the storm only eats health, a little each tick, and only out there)
  const life = self.hp + self.shield, lost = b.life - life;
  if (lost > 0.5 && !(dCur > g.r - 2 && lost <= g.dps * DT + 0.5)) b.hitT = t;
  b.life = life;
  const sr = g.nr * 0.5, safe = dNext > sr ? { x: g.nx + ((self.x - g.nx) / dNext) * sr, z: g.ny + ((self.z - g.ny) / dNext) * sr } : { x: g.nx, z: g.ny };

  if (self.gliding) { glide(b, sim, self, inp, rotate ? safe : null); return inp; }
  b.landed = true;
  if (self.ride) { drive(b, sim, self, inp, safe); return inp; }
  b.car = null;

  const mateNear = (down: boolean, r: number) => {
    let best: PlayerState | null = null, bd = r;
    for (const q of sim.players.values()) { if (!q.alive || q.id === b.id || q.team !== self.team || (q.down > 0) !== down) continue; const d = Math.hypot(q.x - self.x, q.z - self.z); if (d < bd) { bd = d; best = q; } }
    return best;
  };
  // knocked: crawl to the nearest teammate still standing (they come to us too)
  if (self.down > 0) {
    b.mode = 'crawl';
    const m = mateNear(false, 200);
    if (m && Math.hypot(m.x - self.x, m.z - self.z) > 1.2) { const d = steer(b, sim, self, m.x, m.z, m.y); inp.yaw = Math.atan2(-d.x, -d.z); inp.fwd = 1; }
    return inp;
  }

  // ---- what can we see ----
  const late = sim.teamsAlive.size <= 2 || g.phase >= 3 || sim.alive <= 4;
  let tgt = b.target !== null ? sim.players.get(b.target) ?? null : null;
  if (tgt && (!tgt.alive || tgt.gliding)) { tgt = null; b.target = null; b.los = false; }
  if (t >= b.losT) {
    const busy = !!(tgt && b.los);
    b.losT = t + (busy ? 0.12 + R() * 0.08 : 0.3 + R() * 0.2);
    // the few nearest enemies: shoot the nearest one we can see (standing first), else keep track of the
    // nearest; stay on the one we're shooting unless another is much closer
    // (at the end of a match the nearest anywhere, to go and find: two bots must not wait out the storm apart)
    const near: { q: PlayerState; d: number }[] = [];
    let far: { q: PlayerState; d: number } | null = null;
    for (const q of sim.players.values()) {
      if (!q.alive || q.team === self.team || q.gliding) continue; // gliders can't shoot back
      const d = Math.hypot(q.x - self.x, q.z - self.z);
      if (d < 120) near.push({ q, d });
      else if (late && (!far || d < far.d)) far = { q, d };
    }
    if (!near.length && far) near.push(far);
    near.sort((a, c) => a.d - c.d);
    let pick: PlayerState | null = null, vis = 0, knocked: PlayerState | null = null, kv = 0;
    const keep = tgt && b.los ? sight(w, self, tgt) : 0, kd = keep && tgt ? Math.hypot(tgt.x - self.x, tgt.z - self.z) : Infinity;
    for (let i = 0; i < Math.min(3, near.length); i++) {
      const q = near[i].q;
      if (keep && near[i].d > kd * 0.6) break;
      const v = q === tgt && b.los ? keep : sight(w, self, q);
      if (!v) continue;
      if (q.down > 0) { if (!knocked) { knocked = q; kv = v; } continue; }
      pick = q; vis = v; break;
    }
    if (!pick && keep && tgt) { pick = tgt; vis = keep; }
    if (!pick && knocked) { pick = knocked; vis = kv; }
    if (!pick && near.length) pick = near[0].q;
    if (pick && (pick.id !== b.target || (vis && !b.los))) b.acqT = t;
    b.target = pick ? pick.id : null; b.los = vis > 0; b.vis = vis;
    if (vis) b.seenT = t;
    tgt = pick;
  }
  const td = tgt ? Math.hypot(tgt.x - self.x, tgt.z - self.z) : Infinity;
  // who's worth a fight: in reach of what we carry (a pistol doesn't take on a rifle at 100 m; early on a bot
  // would rather loot than trade shots across a field), or shooting at us
  let reach = 0;
  self.slots.forEach((x) => { if (x) reach = Math.max(reach, x === 'pistol' ? 25 : WEAPONS[x].pellets > 1 ? 22 : WEAPONS[x].range < 70 ? 40 : WEAPONS[x].zoom >= 2.4 ? 110 : 65); });
  if (g.phase === 0) reach = Math.min(reach, 40);
  const fighting = !!(tgt && b.los && (td < reach || t - b.hitT < 3 || (td < reach * 1.6 && t - b.seenT < 0.5 && b.mode === 'fight')));
  const alert = t - b.seenT < 2 || t - b.hitT < 2;
  const gun = self.slots[self.cur];
  let moved = false; // movement set below; otherwise walk to `goal`
  let goal: { x: number; z: number; y: number; sprint: boolean } | null = null;

  // a team sticks together: the lowest id still standing leads, the others loot and roam near them
  let lead: PlayerState | null = null;
  for (const q of sim.players.values()) if (q.alive && q.down === 0 && q.team === self.team && q.id !== self.id && q.id < self.id && (!lead || q.id < lead.id)) lead = q;
  const ld = lead ? Math.hypot(lead.x - self.x, lead.z - self.z) : 0;

  // ---- a knocked teammate and nobody shooting at us up close: go and pick them up ----
  const hurt = mateNear(true, 60);
  if (hurt && Math.abs(hurt.y - self.y) < 1.4 && !(fighting && td < 25) && !(inStorm && Math.hypot(hurt.x - g.x, hurt.z - g.y) > g.r)) {
    b.mode = 'revive';
    const d = Math.hypot(hurt.x - self.x, hurt.z - self.z);
    if (d < KNOCK.reach - 0.4) { inp.hold = true; inp.yaw = yawTo(self, hurt.x, hurt.z); moved = true; }
    else goal = { x: hurt.x, z: hurt.z, y: hurt.y, sprint: d > 5 };
  }

  // ---- hurt, and the fight isn't going our way: break off, get out of sight, heal ----
  if (!goal && !moved && fighting && tgt && life < 140 && self.items.big + self.items.mini + self.items.med > 0 && td > 10 && !rotate && tgt.hp + tgt.shield > life) {
    b.mode = 'retreat';
    if (!b.away || t > b.away.until) { const ux = (self.x - tgt.x) / (td || 1), uz = (self.z - tgt.z) / (td || 1); b.away = { x: self.x + ux * 25, z: self.z + uz * 25, until: t + 2.5 }; }
    goal = { x: b.away.x, z: b.away.z, y: b.groundY, sprint: true };
  }

  // ---- fighting ----
  if (!goal && !moved && fighting && tgt) {
    b.mode = 'fight';
    fight(b, sim, self, tgt, td, inp, rotate ? safe : null);
    moved = true;
  }

  // ---- healing: only out of sight, out of the storm and not under fire (damage cancels it) ----
  if (!moved && !goal && !self.use && !inStorm && !alert && self.reloadT === 0 && !(rotate && waitLeft < 4)) {
    if (self.shield < 200 && (self.items.big > 0 || (self.items.mini > 0 && self.shield < (ITEMS.mini.shieldCap ?? 125)))) inp.item = 1;
    else if (self.hp < 190 && self.items.med > 0) inp.item = 2;
  }

  // ---- far from the circle (where the storm will send us): a car, before setting off on foot ----
  if (!moved && !goal && !lead && dNext > g.nr + 90 && !alert && g.phase < 4) {
    // (the one we're going for counts out to 35 m: a single 25 m line had a bot walk round a wall in and
    // out of it, car, case, car, for good) and 15 s to get in it, or it's skipped
    let car = null, cd = Infinity;
    for (const v of sim.vehicles) { if (v.kind !== 'car' || v.driver || v.seats.length || v.hp < 150 || Math.abs(v.body.y - self.y) > 1.5 || b.skip.has(v.id)) continue; const d = Math.hypot(v.body.x - self.x, v.body.z - self.z); if (d < (v.id === b.carId ? 35 : 25) && d < cd) { cd = d; car = v; } }
    if (car && car.id !== b.carId) { b.carId = car.id; b.carT = t; }
    if (car && t - b.carT > 15) { b.skip.set(car.id, t + 60); car = null; }
    if (car) {
      b.mode = 'car';
      goal = { x: car.body.x, z: car.body.z, y: car.body.y, sprint: true };
      if (cd < 2.6 && !caseNear(sim, self)) inp.interact = true;
    }
  }

  // ---- the storm ----
  if (!moved && !goal && rotate) { b.mode = 'storm'; goal = { ...safe, y: 0, sprint: true }; if (self.perk?.kind === 'launch' && dNext > g.nr + 60 && !self.use) inp.perk = true; } // a pad, then run onto it

  // ---- strayed from the team ----
  if (!moved && !goal && lead && ld > 35) { b.mode = 'regroup'; goal = { x: lead.x, z: lead.z, y: lead.y, sprint: true }; }

  // ---- loot ----
  if (!moved && !goal) {
    if (t >= b.scanT) {
      b.scanT = t + 0.5 + R() * 0.2;
      // once the storm is coming, nothing farther from the next circle than we are; near the leader in a team
      const zone = waitLeft < 25 ? Math.max(dNext, g.nr * 0.7) : Infinity;
      pickLoot(b, sim, self, (x, z) => Math.hypot(x - g.nx, z - g.ny) <= zone && (!lead || Math.hypot(x - lead.x, z - lead.z) < 30));
    }
    const lg = b.goal;
    if (lg) {
      const ref = lg.ref, d = Math.hypot(ref.x - self.x, ref.z - self.z);
      const full = !self.slots.includes(null);
      b.mode = lg.kind === 'case' ? 'case' : 'loot';
      if (d < 1.2 && !lg.arrived) lg.arrived = t;
      if (t - lg.t0 > 6 + d / 3 || (lg.arrived && t - lg.arrived > 2.5)) { b.skip.set(ref.id, t + 60); b.goal = null; } // can't get it
      else if (lg.kind === 'case' ? (ref as Case).open : d < 3 && !sim.loot.includes(ref as Loot)) { b.goal = null; b.scanT = t; } // gone: someone was quicker
      else if (lg.kind === 'case') {
        if (d < INTERACT_R - 0.5 && Math.abs(ref.y - self.y) < 1.5) { inp.interact = true; inp.yaw = yawTo(self, ref.x, ref.z); moved = true; }
        else goal = { x: ref.x, z: ref.z, y: ref.y, sprint: d > 6 };
      } else {
        const l = ref as Loot;
        // a swap: hold the gun we'd give up, stand on the new one, press E
        if (l.kind === 'weapon' && full && d < 4) {
          const worst = worstSlot(self, b.skill);
          if (self.cur !== worst) { inp.slot = worst + 1; b.slotT = t; }
          else if (d < 0.9 && !caseNear(sim, self) && self.reloadT === 0) { inp.interact = true; b.goal = null; }
        }
        goal = { x: l.x, z: l.z, y: l.y, sprint: d > 6 };
        if (d < 0.5) { moved = true; inp.fwd = 0; }
      }
    }
  }

  // ---- hunting: late in the match (or shot at from somewhere) go and find the nearest enemy ----
  if (!moved && !goal && tgt && !b.los && (late || td < 35 || t - b.hitT < 3)) {
    b.mode = 'hunt';
    goal = { x: tgt.x, z: tgt.z, y: tgt.y, sprint: td > 15 };
    // high up and the match is ending: come down and fight
    if (late && b.groundY > 4 && tgt.y < b.groundY - 3) goal.y = 0;
  }

  // ---- otherwise roam inside where the storm is heading ----
  if (!moved && !goal) {
    b.mode = 'roam';
    if (Math.hypot(b.wp.x - self.x, b.wp.z - self.z) < 4 || t > b.wpT || (lead && Math.hypot(b.wp.x - lead.x, b.wp.z - lead.z) > 30)) newWaypoint(b, sim, lead ?? self, lead ? 6 : 25, lead ? 18 : 45);
    goal = { x: b.wp.x, z: b.wp.z, y: 0, sprint: b.id % 2 === 0 || g.closing };
  }

  // ---- reloads: never mid-fight unless empty (then another loaded gun first) ----
  if (!fighting && !b.los && gun && !self.use && self.reloadT === 0 && !inp.slot) {
    const def = WEAPONS[gun];
    if (self.mags[self.cur] < def.mag * (alert ? 0.35 : 0.7)) inp.reload = true;
    else if (!alert && t - b.slotT > 2 && self.mags[self.cur] === def.mag && !(b.goal?.kind === 'loot' && (b.goal.ref as Loot).kind === 'weapon')) {
      // safe: top up the other guns too
      const j = self.slots.findIndex((x, i) => x && i !== self.cur && self.mags[i] < WEAPONS[x].mag * 0.6);
      if (j >= 0) { inp.slot = j + 1; b.slotT = t; }
    }
  }

  // ---- walk ----
  let np = 0; // seconds without getting any closer to where we're walking (bobbing at a ledge looks like moving)
  if (goal && !moved) {
    const gd = Math.hypot(goal.x - self.x, goal.z - self.z);
    if (!b.gp || Math.hypot(b.gp.x - goal.x, b.gp.z - goal.z) > 5) b.gp = { x: goal.x, z: goal.z, best: gd, t };
    else if (gd < b.gp.best - 1) { b.gp.best = gd; b.gp.t = t; }
    np = t - b.gp.t;
    const d = steer(b, sim, self, goal.x, goal.z, goal.y);
    // no way to it from here: forget it (a case up on a ledge, a car behind a fence)
    if (d.stuck) { if (b.mode === 'case' || b.mode === 'loot') { if (b.goal) b.skip.set(b.goal.ref.id, t + 60); b.goal = null; } else if (b.mode === 'car') b.skip.set(b.carId, t + 60); else if (b.mode === 'roam') b.wpT = 0; }
    inp.yaw = Math.atan2(-d.x, -d.z); inp.fwd = 1; inp.sprint = goal.sprint && !self.use;
    if (Math.hypot(goal.x - self.x, goal.z - self.z) < 0.4) inp.fwd = 0;
    if (d.hop) hop(b, self, inp, t);
  }
  if (b.jumps === 1 && !self.grounded) hop(b, self, inp, t);

  // ---- stuck: hop it, plan around it, then give up on that goal and step aside ----
  const wants = Math.abs(inp.fwd) + Math.abs(inp.strafe) > 0.3;
  if (!wants || fighting || inp.hold) b.prog = { x: self.x, z: self.z, t };
  else if (Math.hypot(self.x - b.prog.x, self.z - b.prog.z) > 1.5) b.prog = { x: self.x, z: self.z, t };
  const st = t - b.prog.t;
  if (b.escape && t < b.escape.until && !fighting && !inp.hold) { inp.yaw = b.escape.yaw; inp.fwd = 1; inp.strafe = 0; inp.sprint = true; if (st > 0.6) hop(b, self, inp, t); }
  else {
    b.escape = null;
    if (st > 1 && wants) hop(b, self, inp, t);
    if ((st > 2.5 || np > 8) && t >= b.forcePlan) { b.forcePlan = t + 6; b.plan = null; b.navT = t; }
    if (st > 5 || np > 12) {
      if (b.goal) b.skip.set(b.goal.ref.id, t + 60);
      if (b.mode === 'car') b.skip.set(b.carId, t + 60);
      b.goal = null; b.wpT = 0; b.gp = null;
      b.escape = { yaw: inp.yaw + Math.PI * (0.5 + R()), until: t + 1.2 };
      b.prog = { x: self.x, z: self.z, t };
    }
  }
  if (inp.item) { inp.fire = false; inp.slot = 0; inp.reload = false; }
  if (self.use) { inp.slot = 0; inp.reload = false; inp.sprint = false; }
  return inp;
}

function glide(b: Bot, sim: Sim, self: PlayerState, inp: Input, safe: Pt | null) {
  b.mode = 'glide';
  // the first drop goes to the drop spot; a glide later (a launch pad, off a tower) to wherever we were going
  const to = !b.landed ? { x: b.dropX, z: b.dropZ } : safe ?? b.dest;
  const d = Math.hypot(to.x - self.x, to.z - self.z), h = Math.max(1, self.y - sim.world.groundAt(self.x, self.z, self.y));
  inp.yaw = yawTo(self, to.x, to.z);
  if (d < 4) { inp.fwd = 0; inp.pitch = -1.2; return; } // straight down, diving
  // dive just enough to come down on it (no dive covers 12 m per 7 m of fall, a full dive 22 per 30), and
  // never float: a far spot isn't worth half a minute in the air
  const r = d / h, k = r >= 1.7 ? 0 : r <= 0.75 ? 1 : clamp((12 - 7 * r) / (23 * r - 10), 0, 1);
  inp.fwd = 1; inp.pitch = -(0.31 + 0.9 * Math.max(0.3, k));
}

// bots only ever drive cars; passengers and anything else hop straight out
function drive(b: Bot, sim: Sim, self: PlayerState, inp: Input, safe: Pt) {
  b.mode = 'drive';
  if (self.seat || self.ride !== 1) { inp.interact = true; return; }
  const g = sim.ring, t = sim.t, w = sim.world;
  const c = (b.car ??= { t, best: Infinity, slow: 0, back: 0, tries: 0 });
  let enemy: PlayerState | null = null;
  for (const q of sim.players.values()) if (q.alive && !q.ride && !q.gliding && q.team !== self.team && Math.hypot(q.x - self.x, q.z - self.z) < 35) { enemy = q; break; }
  const dest = enemy ?? safe, dd = Math.hypot(dest.x - self.x, dest.z - self.z);
  // there (or nearly: the last circles are small), or no headway for a while: get out
  if (!enemy && (dd < Math.max(10, g.nr * 0.4) || Math.hypot(self.x - g.nx, self.z - g.ny) < g.nr * 0.6)) { inp.interact = true; return; }
  // headway toward where we're going, every 3 s (backing off a wall and hitting it again is no headway)
  if (t - c.t > 3) { c.tries = dd > c.best - 6 ? c.tries + 1 : 0; c.best = Math.min(c.best, dd); c.t = t; }
  if (c.tries >= 2) { inp.interact = true; b.skip.set(self.rideV, t + 30); return; }
  let d = angDiff(yawTo(self, dest.x, dest.z), self.head);
  // something in the way (rays from the middle and both sides of the bonnet): steer for the clearer side,
  // brake instead of crashing into it (a crash at full boost takes half the car)
  const ahead = (a: number) => {
    const yy = self.head + a, dx = -Math.sin(yy), dz = -Math.cos(yy);
    let m = 30;
    for (const o of [-0.9, 0, 0.9]) m = Math.min(m, rayT(w, self.x - dz * o, self.y + 0.8, self.z + dx * o, dx, 0, dz, 30));
    return m;
  };
  const f = ahead(0);
  if (f < 18) { const l = ahead(0.45), r = ahead(-0.45); d = l > r ? Math.max(d, 0.7) : Math.min(d, -0.7); }
  if (c.back > 0) { c.back -= DT; inp.fwd = -1; inp.strafe = clamp(d * 2, -1, 1); inp.yaw = self.head; return; }
  c.slow = Math.abs(self.spd) < 1.5 ? c.slow + DT : 0;
  if (c.slow > 0.8) { c.back = 1.1; c.slow = 0; }
  inp.strafe = clamp(-d * 2, -1, 1); inp.fwd = self.spd > 8 && f < 4 + self.spd * 0.6 ? -1 : 1; inp.sprint = false; inp.yaw = self.head;
}

function fight(b: Bot, sim: Sim, self: PlayerState, tgt: PlayerState, d: number, inp: Input, safe: Pt | null) {
  const R = b.rand, t = sim.t;
  // the gun for the range: switch when another is clearly better (not back and forth), or the mag ran dry
  const air = isAir(tgt.ride) && !tgt.seat;
  const vals = self.slots.map((x, i) => (x ? gunValue(x, self.ups[i], self.mags[i], d, b.skill, air) : -1));
  let best = self.cur;
  vals.forEach((v, i) => { if (v > vals[best]) best = i; });
  const cur = self.slots[self.cur], empty = !!cur && self.mags[self.cur] === 0;
  const reloading = self.reloadT > 0 && self.reloadT < 0.9;
  if (best !== self.cur && vals[best] > 0 && !reloading && ((empty && self.mags[best] > 0) || (vals[best] > vals[self.cur] * 1.35 + 2 && t - b.slotT > 1.5))) { inp.slot = best + 1; b.slotT = t; }
  else if (empty && self.reloadT === 0) inp.reload = true;
  if (b.reaction <= 0) { b.aimErr = (R() - 0.5) * (0.025 + (1 - b.skill) * 0.1); b.reaction = 0.3 + R() * 0.4; if (R() < 0.15) b.strafe *= -1; }
  b.reaction -= DT;
  const def = cur ? WEAPONS[cur] : null;
  // aim where the target was a moment ago (reaction: 0.12 s for the best, 0.26 s for the worst); rockets lead
  // it instead and go for the feet
  const lag = def?.proj ? -d / 58 : 0.08 + (1 - b.skill) * 0.25, ax = tgt.x - tgt.vx * lag, az = tgt.z - tgt.vz * lag;
  const ty = tgt.y + (def?.proj ? 0.3 : b.vis === 2 ? HEAD_Y : HEAD_Y - 0.45) - (self.y + EYE_H); // the head when that's all that shows
  inp.yaw = yawTo(self, ax, az) + b.aimErr;
  inp.pitch = Math.atan2(ty, Math.hypot(ax - self.x, az - self.z)) + b.aimErr * 0.5;
  inp.aim = d > 30;
  // hold fire: not seen a moment ago, out of range, a teammate in the way, our own blast, or still reacting
  let mate = false;
  for (const q of sim.players.values()) {
    if (!q.alive || q.id === self.id || q.team !== self.team) continue;
    const ux = (tgt.x - self.x) / (d || 1), uz = (tgt.z - self.z) / (d || 1), along = (q.x - self.x) * ux + (q.z - self.z) * uz;
    if (along > 0 && along < d && Math.abs((q.x - self.x) * uz - (q.z - self.z) * ux) < 1.1) { mate = true; break; }
  }
  const ready = t - b.acqT > 0.15 + (1 - b.skill) * 0.35;
  if (def && !inp.slot && !mate && ready && vals[self.cur] > 0 && self.mags[self.cur] > 0) {
    inp.fire = def.spinUp ? true : R() < 0.25 + b.skill * 0.45 && (def.auto || R() < 0.4);
    // and only through a sight line checked a moment ago: it may have stepped behind a wall since
    if (inp.fire && t - b.seenT > 0.1) { const v = sight(sim.world, self, tgt); if (v) { b.seenT = t; b.vis = v; } else { inp.fire = false; b.los = false; b.losT = t; } }
  }
  // move: strafe, close in or back off to the gun's range, flip when a wall stops the strafe; the storm comes first
  const pref = !def ? 20 : def.pellets > 1 ? 6 : def.zoom >= 2.4 ? 55 : def.proj ? 30 : def.range < 70 ? 14 : 24;
  const ux = (tgt.x - self.x) / (d || 1), uz = (tgt.z - self.z) / (d || 1);
  let mx = -uz * b.strafe, mz = ux * b.strafe;
  if (safe) { const s = steer(b, sim, self, safe.x, safe.z, 0); const l = Math.hypot(s.x, s.z) || 1; mx = (s.x / l) * 2 + mx * 0.3; mz = (s.z / l) * 2 + mz * 0.3; if (s.hop) hop(b, self, inp, t); }
  else if (d > pref + 12 || mate) { const s = steer(b, sim, self, tgt.x, tgt.z, tgt.y); const l = Math.hypot(s.x, s.z) || 1; mx += (s.x / l) * 1.5; mz += (s.z / l) * 1.5; if (s.hop) hop(b, self, inp, t); }
  else if (d < pref * 0.5) { mx -= ux; mz -= uz; }
  moveDir(inp, mx, mz);
  inp.sprint = !!safe && inp.fwd > 0.3 && !inp.aim;
  if (Math.hypot(self.vx, self.vz) < 1 && self.grounded) { if ((b.blockT += DT) > 0.35) { b.strafe *= -1; b.blockT = 0; } } else b.blockT = 0;
  if (self.perk && !inp.slot) {
    const k = self.perk.kind;
    if ((k === 'grenade' || k === 'molotov') && d > 8 && d < 24 && R() < 0.03) { inp.perk = true; inp.pitch += 0.25; }
    if (k === 'kit' && cur && self.ups[self.cur] < UPGRADE.max) inp.perk = true;
    if (k === 'smoke' && self.hp < 110 && R() < 0.08) inp.perk = true;
    if (k === 'nuke' && d > 40 && R() < 0.05) inp.perk = true;
  }
}

// a pencil case within reach takes the E press before a gun on the floor does
function caseNear(sim: Sim, self: PlayerState) {
  for (const c of sim.cases) if (!c.open && Math.abs(c.y - self.y) <= 1.6 && Math.hypot(c.x - self.x, c.z - self.z) < INTERACT_R) return true;
  return false;
}
function worstSlot(self: PlayerState, skill: number) {
  let wi = 0, wv = Infinity;
  self.slots.forEach((x, i) => { const v = x ? worth(x, self.ups[i], skill) : -1; if (v < wv) { wv = v; wi = i; } });
  return wi;
}

// the nearest thing worth having on this floor: an unopened case, a better gun, shields and heals we have room for
function pickLoot(b: Bot, sim: Sim, self: PlayerState, ok: (x: number, z: number) => boolean) {
  const out = (x: number, z: number) => !ok(x, z);
  const t = sim.t;
  for (const [id, until] of b.skip) if (until < t) b.skip.delete(id);
  if (b.goal) { // still there?
    const r = b.goal.ref;
    if ((b.goal.kind === 'case' ? (r as Case).open : !sim.loot.includes(r as Loot)) || out(r.x, r.z)) b.goal = null;
  }
  const full = !self.slots.includes(null), wi = worstSlot(self, b.skill), wv = full ? worth(self.slots[wi]!, self.ups[wi], b.skill) : 0;
  let best: Loot | Case | null = null, kind: 'case' | 'loot' = 'loot', bd = 45;
  for (const c of sim.cases) {
    if (c.open || Math.abs(c.y - self.y) > 1.3 || b.skip.has(c.id) || out(c.x, c.z)) continue;
    const d = Math.hypot(c.x - self.x, c.z - self.z) * 0.85;
    if (d < bd) { bd = d; best = c; kind = 'case'; }
  }
  for (const l of sim.loot) {
    if (Math.abs(l.y - self.y) > 1.2 || b.skip.has(l.id) || out(l.x, l.z)) continue;
    const d = Math.hypot(l.x - self.x, l.z - self.z);
    if (d >= bd) continue;
    let useful = false;
    if (l.kind === 'weapon') { const x = l.what as WeaponId; useful = !self.slots.includes(x) && (!full || worth(x, l.up ?? 0, b.skill) > wv * 1.15 + 3); }
    else if (l.kind === 'item') useful = self.items[l.what as ItemId] < ITEMS[l.what as ItemId].max;
    else useful = !self.perk || (self.perk.kind === l.what && self.perk.n < PERKS[l.what as PerkId].count * 2);
    if (useful) { bd = d; best = l; kind = 'loot'; }
  }
  if (!best) { b.goal = null; return; }
  if (!b.goal || b.goal.ref !== best) b.goal = { ref: best, kind, t0: t, arrived: 0 };
}

// somewhere to walk to: a short way from `at` (new loot to find; near the leader in a team), inside the
// circle the storm is heading for
function newWaypoint(b: Bot, sim: Sim, at: Pt, r0: number, dr: number) {
  const g = sim.ring;
  for (let k = 0; k < 8; k++) {
    const a = b.rand() * Math.PI * 2, rr = r0 + b.rand() * dr, x = at.x + Math.cos(a) * rr, z = at.z + Math.sin(a) * rr;
    if (Math.hypot(x - g.nx, z - g.ny) < g.nr * 0.7 && Math.abs(x) < 390 && Math.abs(z) < 390) { b.wp = { x, z }; b.wpT = sim.t + 20 + b.rand() * 15; return; }
  }
  const a = b.rand() * Math.PI * 2, rr = Math.sqrt(b.rand()) * Math.max(4, g.nr * 0.7);
  b.wp = { x: clamp(g.nx + Math.cos(a) * rr, -390, 390), z: clamp(g.ny + Math.sin(a) * rr, -390, 390) };
  b.wpT = sim.t + 25 + b.rand() * 20;
}
