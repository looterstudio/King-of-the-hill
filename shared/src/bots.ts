// The offline demo's bots: a pure function of the bot's memory and the simulation (no DOM), so the
// same brain runs in the browser and in headless tests (server/test/bots.test.ts); the server fills its rooms with them too.
import { AMMO, BUS, type AmmoId, AXE, BUILD, EYE_H, HEAD_Y, INTERACT_R, ITEMS, KNOCK, PERKS, PLAYER_HP, SHIELD_MAX, SLOTS, TICK_HZ, UPGRADE, WEAPONS, isAir, type ItemId, type PerkId, type WeaponId } from './constants.ts';
import { emptyInput, pelletFall, type Case, type Input, type Loot, type PlayerState, type Sim } from './sim.ts';
import { rayBox, type World } from './world.ts';

const DT = 1 / TICK_HZ;
const DROP_REACH = 240; // how far to the side of the plane's line a bot glides to its spot
interface Pt { x: number; z: number }
interface Waypoint { x: number; z: number; hop: number; drop: boolean }
interface Plan { gx: number; gz: number; y: number; at: number; pts: Waypoint[]; i: number; noWay: boolean } // noWay: can't get any closer than here
// steering answer: which way to walk (world space), whether to jump something, and whether the goal can't be reached
interface Dir { x: number; z: number; hop: boolean; stuck: boolean }
interface Bench { id: number; x: number; y: number; z: number } // an upgrade bench as a goal (ids below zero, apart from loot's)
// something going up with the axe's blocks: a wall between us and who is shooting, or a pillar under our feet.
// cells: 1 m blocks by their low corner, bottom row first; cur/curT: the one we aim at, and since when (one we
// can't place is given up on); skip: those given up on
interface Job { kind: 'wall' | 'pillar'; cells: { x: number; y: number; z: number }[]; until: number; cur: number; curT: number; skip: number }

// names for the bots that fill a room
export const BOT_NAMES = ['degen', 'wagmi', 'ser_pump', 'rugless', 'bonkbro', 'paperhand', 'diamond', 'jeet', 'moonboi', 'gmgm', 'solchad', 'wifhat', 'ape420', 'fomo', 'ngmi', 'rekt', 'gigabrain', 'anon', 'whale', 'hodl', 'pixel', 'scribble', 'inky', 'doodle', 'crayon'];

export interface Bot {
  id: number; rand: () => number; skill: number; strafe: number; aimErr: number; reaction: number;
  target: number | null; los: boolean; vis: number; losT: number; seenT: number; acqT: number; // target visible at the last check (2 head, 1 chest), last seen, first seen
  wp: Pt; wpT: number; carId: number; carT: number; seq: number; dropX: number; dropZ: number; landed: boolean; landT: number; mode: string; dest: Pt;
  peace: Map<number, number>; // other bots we decided to leave alone, until when
  plan: Plan | null; navT: number; direct: boolean; forcePlan: number; groundY: number; jumpT: number; jumps: number;
  goal: { ref: Loot | Case | Bench; kind: 'case' | 'loot' | 'bench'; t0: number; arrived: number } | null; scanT: number; skip: Map<number, number>;
  prog: { x: number; z: number; t: number }; gp: { x: number; z: number; best: number; t: number } | null; escape: { yaw: number; until: number } | null; blockT: number;
  life: number; hitT: number; slotT: number; rot: boolean; car: { t: number; best: number; slow: number; back: number; tries: number } | null;
  // where the target was when last seen, and when we last traded shots with it (a fight lasts past a lost sight line)
  seen: { x: number; y: number; z: number } | null; engT: number;
  cover: { x: number; z: number; until: number; at: boolean } | null; // somewhere they can't see us, to heal at (at: got there)
  job: Job | null; jobT: number; perch: { x: number; y: number; z: number } | null; // building, the last build, standing on our own pillar
  chop: { yaw: number; until: number } | null; chopT: number; benches: Set<number>; // gathering material with the axe; benches used
}

// which players in a match are bots: between bots fights start rarely early on and more as the storm closes
// (99 bots fighting everything they saw ended a match in four minutes); against people a bot always fights
const BOTS = new WeakMap<Sim, Set<number>>();
export function markBots(sim: Sim, ids: Iterable<number>) { const s = BOTS.get(sim) ?? new Set<number>(); for (const id of ids) s.add(id); BOTS.set(sim, s); }
const BOT_AGGRO = [0.05, 0.1, 0.2, 0.35, 0.6];

export function newBot(id: number, rand: () => number): Bot {
  // normal players, not aimbots: the best of them plays like a decent human
  const skill = 0.25 + rand() * 0.45, strafe = rand() < 0.5 ? 1 : -1, dropX = (rand() - 0.5) * 640, dropZ = (rand() - 0.5) * 640;
  return {
    id, rand, skill, strafe, aimErr: 0, reaction: 0, target: null, los: false, vis: 0, losT: (id % 10) * 0.04, seenT: -99, acqT: 0,
    wp: { x: dropX, z: dropZ }, wpT: 0, carId: 0, carT: 0, seq: 0, dropX, dropZ, landed: false, landT: 0, mode: 'glide', dest: { x: dropX, z: dropZ },
    plan: null, navT: 0, direct: true, forcePlan: 0, groundY: 0, jumpT: -9, jumps: 0,
    goal: null, scanT: (id % 20) * 0.03, skip: new Map(), prog: { x: 0, z: 0, t: 0 }, gp: null, escape: null, blockT: 0,
    life: 500, hitT: -99, slotT: -99, rot: false, car: null,
    seen: null, engT: -99, cover: null, job: null, jobT: -99, perch: null, chop: null, chopT: 0, benches: new Set(), peace: new Map(),
  };
}

// a team glides to the same spot
// line: the paper plane's flight, when the match starts on it: the spots are spread over what you can glide to
export function teamDrops(bots: Bot[], teams: Map<number, number>, rand: () => number, line?: { x: number; z: number; dx: number; dz: number } | null) {
  const spot = new Map<number, { x: number; z: number }>();
  // each team's spot is the best of a few random picks: the farthest from the spots already taken, so the
  // island fills evenly (uniform picks put three or four people within 40 m of each other, and every match
  // opened with a pistol massacre at the drop)
  const taken: { x: number; z: number }[] = [];
  const pick = (b: Bot) => {
    let best = { x: b.dropX, z: b.dropZ }, far = -1;
    for (let k = 0; k < 12; k++) {
      const c = k === 0 && !line ? best : line ? strip(line, rand) : { x: (rand() - 0.5) * 660, z: (rand() - 0.5) * 660 };
      let d = Infinity; for (const o of taken) d = Math.min(d, Math.hypot(o.x - c.x, o.z - c.z));
      if (d > far) { far = d; best = c; }
    }
    taken.push(best); return best;
  };
  for (const b of bots) { const t = teams.get(b.id)!; const at = spot.get(t) ?? pick(b); spot.set(t, at); b.dropX = at.x + (rand() - 0.5) * 8; b.dropZ = at.z + (rand() - 0.5) * 8; }
}

// a random spot within gliding reach of the plane's line, on the island
function strip(l: { x: number; z: number; dx: number; dz: number }, rand: () => number) {
  for (let k = 0; k < 20; k++) {
    const s = 60 + rand() * (BUS.len - 120), side = (rand() - 0.5) * 2 * DROP_REACH, x = l.x + l.dx * s - l.dz * side, z = l.z + l.dz * s + l.dx * side;
    if (Math.abs(x) < 330 && Math.abs(z) < 330) return { x, z };
  }
  return { x: (rand() - 0.5) * 300, z: (rand() - 0.5) * 300 };
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
  if (d > def.range * 0.95 || (def.proj && def.proj !== 'spell' && d < 11) || (w === 'stinger') !== air) return 0; // out of reach, our own blast, the wrong job
  const scoped = w === 'heavy' || w === 'hunting', aim = d > 30;
  const spread = def.spread * (aim ? (scoped ? 0.02 : 0.5) : 1) * 1.3 + (1 - skill) * 0.03;
  const hit = def.proj ? 0.55 : Math.min(1, 0.4 / Math.max(0.01, d * spread));
  const fall = def.pellets > 1 ? pelletFall(d, def.range) : 1;
  const burst = def.burst ?? 1, shot = def.dmg * (1 + UPGRADE.perLevel * ups) * def.pellets * hit * fall * burst;
  const cycle = def.burst ? def.cd + 0.15 : def.cd, m = def.mag / burst;
  const sustained = (shot * m) / (m * cycle + def.reload);
  if (mag === null) return sustained;
  return mag > 0 ? Math.max(sustained, (shot / cycle) * 0.8) : sustained * 0.35;
}
const worth = (w: WeaponId, ups: number, skill: number) => 0.3 * gunValue(w, ups, null, 8, skill) + 0.5 * gunValue(w, ups, null, 30, skill) + 0.2 * gunValue(w, ups, null, 70, skill);

// ---------------- the brain ----------------
// bots: glide to a drop spot, loot, rotate ahead of the storm, fight what they can see (walling up, or breaking
// off to heal behind cover, when it goes badly; pushing when it goes well), build up to whoever is above, hunt
// at the end
export function botInput(b: Bot, sim: Sim): Input {
  const R = b.rand, w = sim.world, t = sim.t;
  const self = sim.players.get(b.id)!, g = sim.ring;
  // view: the tick we're looking at. A bot sees the world as it is; 0 meant the oldest lag-compensated
  // positions (300 ms back), so every bullet was tested against where its target used to be
  const inp: Input = { ...emptyInput(), seq: ++b.seq, yaw: self.yaw, pitch: self.pitch, view: sim.tick };
  // aboard the paper plane: pull our drop spot within gliding reach of the flight line (DROP_REACH to the side
  // at most), and jump when the plane is level with it (a little before: we glide on forward)
  if (self.bus && sim.bus) {
    const B = sim.bus, at = { s: (self.x - B.x) * B.dx + (self.z - B.z) * B.dz }, rx = b.dropX - B.x, rz = b.dropZ - B.z;
    const along = rx * B.dx + rz * B.dz, side = -rx * B.dz + rz * B.dx, reach = DROP_REACH;
    if (Math.abs(side) > reach) {
      const k = side - Math.sign(side) * reach;
      b.dropX += B.dz * k; b.dropZ -= B.dx * k; b.wp = { x: b.dropX, z: b.dropZ }; b.dest = { x: b.dropX, z: b.dropZ };
    }
    inp.yaw = Math.atan2(-(b.dropX - self.x), -(b.dropZ - self.z)); inp.pitch = -0.4;
    if (at.s >= Math.max(70, along - 30)) inp.jump = true;
    return inp;
  }
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
  // (a storm that hurries as the field thins out closes faster than its countdown says: leave earlier for it)
  const hurry = sim.hurry(), waitLeft = g.closing ? 0 : g.nextAt - t, due = waitLeft < (10 + Math.max(0, dNext - g.nr * 0.6) / 6) * hurry;
  if (inStorm || dCur > g.r * 0.88 - 3 * hurry || (due && dNext > g.nr * 0.75)) b.rot = true;
  else if (!due || dNext < g.nr * 0.62) b.rot = false;
  const rotate = b.rot;
  // the storm's edge is about to reach us (a hurried storm closes several meters a second): run, don't stop to fight or build.
  // Already where it's closing to (the last circles), there's nowhere to run: fight
  const flee = rotate && dCur > g.r - 6 * hurry && dNext > Math.max(g.nr * 0.75, 8);
  // shot at (the storm only eats health, a little each tick, and only out there)
  const life = self.hp + self.shield, lost = b.life - life;
  if (lost > 0.5 && !(dCur > g.r - 2 && lost <= g.dps * DT + 0.5)) b.hitT = t;
  b.life = life;
  const sr = g.nr * 0.5, safe = dNext > sr ? { x: g.nx + ((self.x - g.nx) / dNext) * sr, z: g.ny + ((self.z - g.ny) / dNext) * sr } : { x: g.nx, z: g.ny };

  if (self.gliding) { b.job = null; b.perch = null; glide(b, sim, self, inp, rotate ? safe : null); return turn(self, inp, 4, false); }
  if (!b.landed) b.landT = t;
  b.landed = true;
  if (self.ride) { b.job = null; b.chop = null; drive(b, sim, self, inp, safe); return inp; }
  b.car = null;

  const mateNear = (down: boolean, r: number) => {
    let best: PlayerState | null = null, bd = r;
    for (const q of sim.players.values()) { if (!q.alive || q.id === b.id || q.team !== self.team || (q.down > 0) !== down) continue; const d = Math.hypot(q.x - self.x, q.z - self.z); if (d < bd) { bd = d; best = q; } }
    return best;
  };
  // knocked: crawl to the nearest teammate still standing (they come to us too)
  if (self.down > 0) {
    b.mode = 'crawl'; b.job = null; b.perch = null; b.chop = null; b.cover = null;
    const m = mateNear(false, 200);
    if (m && Math.hypot(m.x - self.x, m.z - self.z) > 1.2) { const d = steer(b, sim, self, m.x, m.z, m.y); inp.yaw = Math.atan2(-d.x, -d.z); inp.fwd = 1; }
    return turn(self, inp, 5, false);
  }

  // ---- what can we see ----
  const late = sim.teamsAlive.size <= 2 || g.phase >= 3 || sim.alive <= 4;
  let tgt = b.target !== null ? sim.players.get(b.target) ?? null : null;
  if (tgt && (!tgt.alive || tgt.gliding)) { tgt = null; b.target = null; b.los = false; b.seen = null; }
  if (t >= b.losT) {
    const busy = !!(tgt && b.los);
    b.losT = t + (busy ? 0.12 + R() * 0.08 : 0.3 + R() * 0.2);
    // the few nearest enemies: shoot the nearest one we can see (standing first), else keep track of the
    // nearest; stay on the one we're shooting unless another is much closer
    // (at the end of a match the nearest anywhere, to go and find: two bots must not wait out the storm apart)
    const near: { q: PlayerState; d: number }[] = [], bots = BOTS.get(sim);
    let far: { q: PlayerState; d: number } | null = null;
    for (const q of sim.players.values()) {
      if (!q.alive || q.team === self.team || q.gliding) continue; // gliders can't shoot back
      const d = Math.hypot(q.x - self.x, q.z - self.z);
      if (d < 120) near.push({ q, d });
      else if (late && (!far || d < far.d)) far = { q, d };
    }
    if (!near.length && far) near.push(far);
    near.sort((a, c) => a.d - c.d);
    // who we'd take on (or keep tracking): someone new is only noticed in front of us (a person's field of
    // view), close enough to hear, or once we're shot at (a bot saw all round, so every bot met at a loot
    // spot started a fight); another bot is a fight or not, decided once in a while
    const hit = t - b.hitT < 2 ? self.hitBy : undefined;
    for (let i = near.length - 1; i >= 0; i--) {
      const q = near[i].q;
      if (q.id === hit) { b.peace.set(q.id, -1); continue; } // whoever shot us: always
      if (q === tgt && b.los) continue;
      if (bots?.has(q.id)) {
        const until = b.peace.get(q.id);
        if (until !== undefined && t < until) { near.splice(i, 1); continue; }
        if (until === undefined || t >= until) {
          if (R() >= (BOT_AGGRO[g.phase] ?? 1)) { b.peace.set(q.id, t + 30); near.splice(i, 1); continue; }
          b.peace.set(q.id, -1); // a fight: stays one until it's over
        }
      }
      if (near[i].d > 4 && Math.abs(angDiff(yawTo(self, q.x, q.z), self.yaw)) > 1.2 && q !== tgt) near.splice(i, 1);
    }
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
    if (pick && pick.id !== b.target) b.seen = null;
    b.target = pick ? pick.id : null; b.los = vis > 0; b.vis = vis;
    if (vis) b.seenT = t;
    tgt = pick;
  }
  if (tgt && b.los) b.seen = { x: tgt.x, y: tgt.y, z: tgt.z };
  const td = tgt ? Math.hypot(tgt.x - self.x, tgt.z - self.z) : Infinity, foe = tgt ? tgt.hp + tgt.shield : 0;
  // who's worth a fight: in reach of what we carry (a pistol doesn't take on a rifle at 100 m; early on a bot
  // would rather loot than trade shots across a field), or shooting at us
  let reach = 0;
  self.slots.forEach((x) => { if (x) reach = Math.max(reach, WEAPONS[x].melee ? 6 : x === 'pistol' ? 25 : WEAPONS[x].pellets > 1 ? 22 : WEAPONS[x].range < 70 ? 40 : WEAPONS[x].zoom >= 2.4 ? 110 : 65); });
  // early on people loot more than they fight: only the close ones (or whoever shoots at us) until the storm starts to bite
  reach = Math.min(reach, [8, 25, 40][g.phase] ?? Infinity);
  // something to fight with: a melee gun, or one with rounds in it or to reload with (landing with only the pickaxe, we loot first)
  const armed = self.slots.some((x, i) => !!x && (!!WEAPONS[x].melee || self.mags[i] > 0 || !WEAPONS[x].ammo || self.ammo[WEAPONS[x].ammo!] > 0));
  // just landed: a while of looting first, like people do (unless someone starts it)
  const settling = g.phase === 0 && t - b.landT < 30 + (1 - b.skill) * 30 && t - b.hitT > 3;
  const fighting = !!(tgt && b.los && armed && !settling && (td < reach || t - b.hitT < 3 || (td < reach * 1.6 && t - b.seenT < 0.5 && b.mode === 'fight')));
  if (fighting) b.engT = t;
  const alert = t - b.seenT < 2 || t - b.hitT < 2;
  const gun = self.slots[self.cur];
  let moved = false; // movement set below; otherwise walk to `goal`
  let goal: { x: number; z: number; y: number; sprint: boolean } | null = null;

  // a team sticks together: the lowest id still standing leads, the others loot and roam near them
  let lead: PlayerState | null = null;
  for (const q of sim.players.values()) if (q.alive && q.down === 0 && q.team === self.team && q.id !== self.id && q.id < self.id && (!lead || q.id < lead.id)) lead = q;
  const ld = lead ? Math.hypot(lead.x - self.x, lead.z - self.z) : 0;

  // on top of our own pillar: hold it while the fight lasts (off it, the fight over or the storm coming: forget it)
  const perched = !!b.perch && Math.hypot(self.x - b.perch.x, self.z - b.perch.z) < 0.6 && Math.abs(self.y - b.perch.y) < 0.4;
  if (b.perch && (!perched || rotate || t - b.engT > 3)) b.perch = null;

  // ---- a build in hand runs to the end (a wall going up, a pillar under us) ----
  if (b.job) { if (build(b, sim, self, inp)) moved = true; else b.job = null; }

  // ---- a knocked teammate and nobody shooting at us up close: go and pick them up ----
  const hurt = moved ? null : mateNear(true, 60);
  if (hurt && Math.abs(hurt.y - self.y) < 1.4 && !(fighting && td < 25) && !(inStorm && Math.hypot(hurt.x - g.x, hurt.z - g.y) > g.r)) {
    b.mode = 'revive';
    const d = Math.hypot(hurt.x - self.x, hurt.z - self.z);
    if (d < KNOCK.reach - 0.4) { inp.hold = true; inp.yaw = yawTo(self, hurt.x, hurt.z); moved = true; }
    else goal = { x: hurt.x, z: hurt.z, y: hurt.y, sprint: d > 5 };
  }

  // ---- shot at in the open and not winning it: wall up between us (an instant fort, if we carry one) ----
  if (!goal && !moved && fighting && tgt && tgt.down === 0 && t - b.hitT < 0.4 && td > 7 && t - b.jobT > 6 && self.grounded && !self.use && !inStorm && !rotate && !perched
    && (life < (PLAYER_HP + SHIELD_MAX) * 0.32 || life + (PLAYER_HP + SHIELD_MAX) * 0.08 < foe) && R() < 0.3 + b.skill * 0.6) {
    b.jobT = t;
    if (self.perk?.kind === 'fort') { inp.perk = true; b.cover = { x: self.x, z: self.z, until: t + 6, at: true }; b.mode = 'fort'; moved = true; }
    else if (self.mats >= BUILD.cost * 4 && (b.job = wallJob(w, self, b.groundY, tgt, t))) { b.cover = { x: self.x, z: self.z, until: t + 7, at: true }; moved = build(b, sim, self, inp); }
  }

  // ---- they're up high and close (a roof, a tower floor, their own pillar): build our way up to them ----
  if (!goal && !moved && tgt && tgt.down === 0 && t - b.jobT > 8 && self.grounded && b.skill > 0.4 && !rotate && td > 2.5 && td < 22 && (fighting || late || t - b.seenT < 1.5)) {
    const up = tgt.y - b.groundY, n = Math.ceil(up - 0.4);
    if (up > 2.6 && n <= 6 && self.mats >= BUILD.cost * n && rayT(w, self.x, self.y + 1.85, self.z, 0, 1, 0, n + 0.3) >= n + 0.3 && (b.job = pillarJob(w, self, b.groundY, n, t))) { b.jobT = t; moved = build(b, sim, self, inp); }
  }

  // ---- hurt, and the fight isn't going our way: break off to somewhere they can't see us, heal there ----
  if (!goal && !moved && fighting && tgt && !b.cover && life < (PLAYER_HP + SHIELD_MAX) * 0.28 && self.items.big + self.items.mini + self.items.med > 0 && td > 10 && !rotate && foe > life && spend(coverBudget, sim, 2)) {
    b.mode = 'retreat';
    const c = coverFrom(w, self, b.groundY, tgt, R() * Math.PI * 2);
    if (c) b.cover = { x: c.x, z: c.z, until: t + 1.5 + Math.hypot(c.x - self.x, c.z - self.z) / 6 + 5, at: false }; // time to get there, and to heal
    else if (self.mats >= BUILD.cost * 4 && t - b.jobT > 3 && (b.job = wallJob(w, self, b.groundY, tgt, t))) { b.jobT = t; b.cover = { x: self.x, z: self.z, until: t + 7, at: true }; moved = build(b, sim, self, inp); }
    else { const ux = (self.x - tgt.x) / (td || 1), uz = (self.z - tgt.z) / (td || 1); b.cover = { x: self.x + ux * 25, z: self.z + uz * 25, until: t + 2.5, at: false }; } // nowhere to hide: run
  }
  // on the way to cover nothing turns us back (a retreat used to flip back to looting, toward them, the
  // moment they were out of sight, and back again); once there, a fight from it doesn't send us back to it
  if (b.cover && (t > b.cover.until || rotate)) b.cover = null;
  if (b.cover && !b.cover.at && Math.hypot(b.cover.x - self.x, b.cover.z - self.z) < 1.2) b.cover.at = true;
  if (!goal && !moved && b.cover && !b.cover.at) { b.mode = 'retreat'; goal = { x: b.cover.x, z: b.cover.z, y: b.groundY, sprint: true }; }

  // ---- fighting ----
  if (!goal && !moved && fighting && tgt && !flee) {
    b.mode = 'fight';
    fight(b, sim, self, tgt, td, inp, rotate ? safe : null, perched);
    moved = true;
  }

  // ---- behind cover: heal up, reload, look where they were (they come to us) ----
  if (!goal && !moved && b.cover) {
    const healthy = (self.hp >= PLAYER_HP * 0.8 || self.items.med === 0) && (self.shield >= SHIELD_MAX * 0.6 || self.items.big + self.items.mini === 0);
    if (healthy && !self.use && self.reloadT === 0) b.cover = null;
    else { b.mode = 'cover'; moved = true; if (b.seen) aimAt(inp, self, b.seen.x, b.seen.y + 1.3, b.seen.z); }
  }

  // ---- lost sight of who we were trading shots with: after them when they're nearly down (or we're well
  // ahead), else hold the angle a moment (a fight used to flip to looting and back every time they ducked) ----
  if (!goal && !moved && tgt && !b.los && b.seen && t - b.engT < 3.5 && !rotate) {
    if (Math.abs(b.seen.y - b.groundY) < 2.5 && life > (PLAYER_HP + SHIELD_MAX) * 0.16 && (foe < (PLAYER_HP + SHIELD_MAX) * 0.22 || tgt.down > 0 || life > foe + (PLAYER_HP + SHIELD_MAX) * 0.14)) { b.mode = 'push'; goal = { x: b.seen.x, z: b.seen.z, y: b.seen.y, sprint: true }; }
    else { b.mode = 'hold'; moved = true; aimAt(inp, self, b.seen.x, b.seen.y + 1.3, b.seen.z); }
  }

  // ---- the axe out for material, or to cut through what we're stuck on ----
  if (!moved && b.chop) {
    if (t > b.chop.until || fighting || alert || self.mats >= BUILD.maxMats - 10) b.chop = null;
    else { b.mode = 'chop'; moved = true; if (!self.axe) inp.slot = SLOTS + 1; inp.yaw = b.chop.yaw; inp.pitch = -0.25; inp.fire = self.axe && self.axeCd <= DT; }
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
      b.mode = lg.kind;
      if (d < 1.2 && !lg.arrived) lg.arrived = t;
      if (t - lg.t0 > 6 + d / 3 || (lg.arrived && t - lg.arrived > 2.5)) { b.skip.set(ref.id, t + 60); b.goal = null; } // can't get it
      else if (lg.kind === 'case' ? (ref as Case).open : lg.kind === 'bench' ? b.benches.has(-1 - ref.id) : d < 3 && !sim.loot.includes(ref as Loot)) { b.goal = null; b.scanT = t; } // gone: someone was quicker
      else if (lg.kind === 'case') {
        if (d < INTERACT_R - 0.5 && Math.abs(ref.y - self.y) < 1.5) { inp.interact = true; inp.yaw = yawTo(self, ref.x, ref.z); moved = true; }
        else goal = { x: ref.x, z: ref.z, y: ref.y, sprint: d > 6 };
      } else if (lg.kind === 'bench') {
        // the best gun in hand, then E at the bench (it improves the gun we hold, once per bench)
        if (d < UPGRADE.benchReach - 0.5) {
          const best = bestSlot(self, b.skill);
          moved = true; inp.yaw = yawTo(self, ref.x, ref.z);
          if (self.cur !== best || self.axe) { if (t - b.slotT > 0.4) { inp.slot = best + 1; b.slotT = t; } }
          else if (!caseNear(sim, self) && self.reloadT === 0 && !self.use) { inp.interact = true; b.benches.add(-1 - ref.id); b.goal = null; }
        } else goal = { x: ref.x, z: ref.z, y: ref.y, sprint: d > 6 };
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

  // ---- hunting: late in the match (or shot at from somewhere) go and find the nearest enemy; not up a
  // tower's floors before then (two bots on different floors of The Needle stalked each other for minutes) ----
  if (!moved && !goal && tgt && !b.los && (late || td < 35 || t - b.hitT < 3) && (late || Math.abs(tgt.y - b.groundY) < 3)) {
    b.mode = 'hunt';
    goal = { x: tgt.x, z: tgt.z, y: tgt.y, sprint: td > 15 };
    // high up and the match is ending: come down and fight
    if (late && b.groundY > 4 && tgt.y < b.groundY - 3) goal.y = 0;
  }

  // ---- otherwise roam inside where the storm is heading (low on material: chop a wall for some first) ----
  if (!moved && !goal) {
    b.mode = 'roam';
    if (self.mats < 24 && t >= b.chopT && !alert) {
      b.chopT = t + 5 + R() * 4;
      for (let k = 0; k < 4 && !b.chop; k++) { const yaw = self.yaw + (k * Math.PI) / 2; if (breakable(w, self, yaw, 2.2)) b.chop = { yaw, until: t + 1.6 + R() * 1.6 }; }
    }
    if (Math.hypot(b.wp.x - self.x, b.wp.z - self.z) < 4 || t > b.wpT || (lead && Math.hypot(b.wp.x - lead.x, b.wp.z - lead.z) > 30)) newWaypoint(b, sim, lead ?? self, lead ? 6 : 25, lead ? 18 : 45);
    goal = { x: b.wp.x, z: b.wp.z, y: 0, sprint: b.id % 2 === 0 || g.closing };
  }

  // ---- healing: out of sight and not shot at for a moment (damage cancels it), never on the way to cover ----
  const exposed = b.los || t - b.hitT < 1.2;
  if (!self.use && !inStorm && !exposed && self.reloadT === 0 && !(rotate && waitLeft < 4) && !b.job && !b.chop && !inp.hold && !inp.interact && b.mode !== 'retreat' && b.mode !== 'push') {
    if (self.shield < SHIELD_MAX * 0.8 && (self.items.big > 0 || (self.items.mini > 0 && self.shield < (ITEMS.mini.shieldCap ?? 50)))) inp.item = 1;
    else if (self.hp < PLAYER_HP * 0.76 && self.items.med > 0) inp.item = 2;
    else if (self.perk?.kind === 'kit' && gun && !self.axe && self.ups[self.cur] < UPGRADE.max && !alert) inp.perk = true; // a quiet moment: the upgrade kit on the gun in hand
  }

  // ---- the axe back for the gun once nothing needs it ----
  if (self.axe && !b.job && !b.chop && !inp.slot) { inp.slot = self.cur + 1; inp.fire = false; }

  // ---- reloads: never mid-fight unless empty (then another loaded gun first) ----
  if (!fighting && !b.los && gun && !self.use && !self.axe && self.reloadT === 0 && !inp.slot) {
    const def = WEAPONS[gun];
    if (self.mags[self.cur] < def.mag * (alert ? 0.35 : 0.7)) inp.reload = true;
    else if (!alert && t - b.slotT > 2 && self.mags[self.cur] === def.mag && !(b.goal?.kind === 'loot' && (b.goal.ref as Loot).kind === 'weapon') && b.goal?.kind !== 'bench') {
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
    if (d.stuck) { if (b.goal && (b.mode === 'case' || b.mode === 'loot' || b.mode === 'bench')) { b.skip.set(b.goal.ref.id, t + 60); b.goal = null; } else if (b.mode === 'car') b.skip.set(b.carId, t + 60); else if (b.mode === 'roam') b.wpT = 0; }
    inp.yaw = Math.atan2(-d.x, -d.z); inp.fwd = 1; inp.sprint = goal.sprint && !self.use;
    if (Math.hypot(goal.x - self.x, goal.z - self.z) < 0.4) inp.fwd = 0;
    if (d.hop) hop(b, self, inp, t);
  }
  if (b.jumps === 1 && !self.grounded && !b.job) hop(b, self, inp, t);

  // ---- stuck: hop it, cut through it, plan around it, then give up on that goal and step aside ----
  const wants = Math.abs(inp.fwd) + Math.abs(inp.strafe) > 0.3;
  if (!wants || fighting || inp.hold || b.job) b.prog = { x: self.x, z: self.z, t };
  else if (Math.hypot(self.x - b.prog.x, self.z - b.prog.z) > 1.5) b.prog = { x: self.x, z: self.z, t };
  const st = t - b.prog.t;
  if (b.escape && t < b.escape.until && !fighting && !inp.hold && !b.job) { inp.yaw = b.escape.yaw; inp.fwd = 1; inp.strafe = 0; inp.sprint = true; if (st > 0.6) hop(b, self, inp, t); }
  else {
    b.escape = null;
    if (st > 1 && wants) hop(b, self, inp, t);
    if ((st > 2.5 || np > 8) && t >= b.forcePlan) {
      // a wall in the way we can break (a fence, a house with no door this side): cut through it, like a player would
      if (st > 2.5 && !b.chop && self.mats < BUILD.maxMats - 10 && breakable(w, self, inp.yaw, 1.6)) b.chop = { yaw: inp.yaw, until: t + 2.5 };
      b.forcePlan = t + 6; b.plan = null; b.navT = t;
    }
    if (st > 5 || np > 12) {
      if (b.goal) b.skip.set(b.goal.ref.id, t + 60);
      if (b.mode === 'car') b.skip.set(b.carId, t + 60);
      b.goal = null; b.wpT = 0; b.gp = null; b.chop = null;
      b.escape = { yaw: inp.yaw + Math.PI * (0.5 + R()), until: t + 1.2 };
      b.prog = { x: self.x, z: self.z, t };
    }
  }
  if (inp.item) { inp.fire = false; inp.slot = 0; inp.reload = false; }
  if (self.use) { inp.slot = 0; inp.reload = false; inp.sprint = false; }
  // turn like a player on a mouse, and only fire once the turn gets there
  const want = inp.yaw;
  turn(self, inp, b.job ? BUILD_TURN : fighting || b.mode === 'hold' || b.mode === 'cover' ? 7 + b.skill * 8 : 6);
  if (inp.fire && Math.abs(angDiff(want, inp.yaw)) > 0.1 && !(gun && WEAPONS[gun].spinUp && !self.axe)) inp.fire = false;
  return inp;
}

// turn like a player on a mouse: quick, never instant (a bot that snapped half a turn in one tick, every time
// it changed its mind, read as broken). The walk keeps its world direction while the facing catches up
const BUILD_TURN = 12;
function turn(self: PlayerState, inp: Input, rate: number, pitch = true): Input {
  const m = rate * DT, d = angDiff(inp.yaw, self.yaw);
  if (Math.abs(d) > m) {
    const s0 = Math.sin(inp.yaw), c0 = Math.cos(inp.yaw), wx = -s0 * inp.fwd + c0 * inp.strafe, wz = -c0 * inp.fwd - s0 * inp.strafe;
    inp.yaw = self.yaw + Math.sign(d) * m;
    const s = Math.sin(inp.yaw), c = Math.cos(inp.yaw);
    inp.fwd = clamp(-wx * s - wz * c, -1, 1); inp.strafe = clamp(wx * c - wz * s, -1, 1);
  }
  if (pitch) { const dp = inp.pitch - self.pitch; if (Math.abs(dp) > m) inp.pitch = self.pitch + Math.sign(dp) * m; }
  return inp;
}
function aimAt(inp: Input, self: PlayerState, x: number, y: number, z: number) {
  inp.yaw = yawTo(self, x, z); inp.pitch = clamp(Math.atan2(y - (self.y + EYE_H), Math.hypot(x - self.x, z - self.z)), -1.5, 1.5);
}

// ---------------- building: the axe's 1 m blocks, placed the way a player places them ----------------
// a wall two blocks high and three wide, two cells toward whoever is shooting (square to the axis they're
// along), on the floor we stand on; null: no room for one here
function wallJob(w: World, self: PlayerState, y: number, foe: PlayerState, t: number): Job | null {
  const dx = foe.x - self.x, dz = foe.z - self.z, ew = Math.abs(dx) > Math.abs(dz), fx = Math.floor(self.x), fz = Math.floor(self.z);
  const cells: Job['cells'] = [];
  for (let row = 0; row < 2; row++) for (const k of [0, -1, 1]) {
    const x = ew ? fx + Math.sign(dx) * 2 : fx + k, z = ew ? fz + k : fz + Math.sign(dz) * 2;
    if (row === 0 && (Math.abs(w.groundAt(x + 0.5, z + 0.5, y + 0.5) - y) > 0.05 || w.hitBox(x + 0.5, y + 0.01, z + 0.5, 0.49, 0.98))) continue;
    if (row === 1 && !cells.some((c) => c.x === x && c.z === z)) continue;
    cells.push({ x, y: y + row, z });
  }
  return cells.length >= 4 ? { kind: 'wall', cells, until: t + 2.6, cur: -1, curT: t, skip: 0 } : null;
}
// a column of n blocks where we stand: jump, and at the top of the jump put a block under our feet
function pillarJob(w: World, self: PlayerState, y: number, n: number, t: number): Job | null {
  const x = Math.floor(self.x), z = Math.floor(self.z), cells: Job['cells'] = [];
  for (let k = 0; k < n; k++) { if (w.hitBox(x + 0.5, y + k + 0.01, z + 0.5, 0.49, 0.98)) return null; cells.push({ x, y: y + k, z }); }
  return { kind: 'pillar', cells, until: t + 1.5 + n * 1.1, cur: -1, curT: t, skip: 0 };
}
// one tick of the job: the axe out, aim at the face the next block goes on, right click when the block would
// land exactly there (what the sim will do with this aim). false: done, or given up
function build(b: Bot, sim: Sim, self: PlayerState, inp: Input): boolean {
  const j = b.job!, w = sim.world, t = sim.t;
  if (t > j.until || self.mats < BUILD.cost || self.use) { if (j.kind === 'pillar' && j.cur > 0) b.perch = { x: j.cells[0].x + 0.5, y: j.cells[j.cur - 1].y + 1, z: j.cells[0].z + 0.5 }; return false; }
  const filled = (c: { x: number; y: number; z: number }) => !!w.hitBox(c.x + 0.5, c.y + 0.01, c.z + 0.5, 0.49, 0.98);
  // the next block: the first one not up yet that has what it stands on
  let k = -1;
  for (let i = 0; i < j.cells.length && k < 0; i++) {
    const c = j.cells[i];
    if (j.skip & (1 << i) || filled(c)) continue;
    const under = j.cells.find((u) => u.x === c.x && u.z === c.z && Math.abs(u.y + 1 - c.y) < 0.05);
    if (!under || filled(under)) k = i;
  }
  if (k < 0) { if (j.kind === 'pillar') b.perch = { x: j.cells[0].x + 0.5, y: j.cells[j.cells.length - 1].y + 1, z: j.cells[0].z + 0.5 }; return false; }
  if (k !== j.cur) { j.cur = k; j.curT = t; }
  else if (t - j.curT > (j.kind === 'pillar' ? 1.6 : 0.6)) { j.skip |= 1 << k; return true; } // that one won't go in: the next
  b.mode = 'build';
  const c = j.cells[k];
  if (!self.axe) inp.slot = SLOTS + 1;
  if (j.kind === 'wall') aimAt(inp, self, c.x + 0.5, c.y, c.z + 0.5); // the middle of what it stands on (the floor, the block under it)
  else {
    // straight down over the middle of the cell; jump from there once the axe is ready
    const cx = c.x + 0.5, cz = c.z + 0.5, off = Math.hypot(cx - self.x, cz - self.z);
    inp.pitch = -1.5;
    if (self.grounded) {
      if (off > 0.12) moveDir(inp, cx - self.x, cz - self.z, Math.min(1, off * 2.5));
      else if (self.axe && self.axeCd < 0.2) inp.jump = true;
    }
  }
  turn(self, inp, BUILD_TURN);
  // (a pillar block fits under us only once our feet are above it, after this tick's move)
  const fy = self.y + self.vy * DT - 12 * DT * DT;
  if (self.axe && self.axeCd <= DT && (j.kind === 'wall' || (!self.grounded && fy >= c.y + 1.02))) {
    const cp = Math.cos(inp.pitch), dx = -Math.sin(inp.yaw) * cp, dy = Math.sin(inp.pitch), dz = -Math.cos(inp.yaw) * cp;
    const at = w.placeCell(self.x, (j.kind === 'wall' ? self.y : fy) + EYE_H, self.z, dx, dy, dz, BUILD.reach);
    if (at && at.x0 === c.x && at.z0 === c.z && Math.abs(at.y0 - c.y) < 0.05) inp.aim = true;
  }
  return true;
}
// a block within reach along yaw (knee to chest high) that the axe can break: not the ground, a hill, a mountain
function breakable(w: World, self: PlayerState, yaw: number, reach: number): boolean {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw), hit = w.raycastBox(self.x, self.y + 1.1, self.z, dx, 0, dz, reach + 0.4);
  return hit.i >= 0 && !w.boxes[hit.i].hard;
}

// a little search per tick, shared by every bot in the match (like the path planner's)
const coverBudget = new WeakMap<Sim, { tick: number; n: number }>();
function spend(m: WeakMap<Sim, { tick: number; n: number }>, sim: Sim, max: number) {
  const bud = m.get(sim) ?? { tick: -1, n: 0 };
  if (bud.tick !== sim.tick) { bud.tick = sim.tick; bud.n = 0; m.set(sim, bud); }
  return bud.n < max && ++bud.n > 0;
}
// somewhere close the foe can't see (chest high from their eyes), that we can walk straight to, not toward
// them; nearest first. null: nowhere
function coverFrom(w: World, self: PlayerState, y: number, foe: PlayerState, rot: number): Pt | null {
  const ex = foe.x, ey = foe.y + EYE_H, ez = foe.z, fd = Math.hypot(foe.x - self.x, foe.z - self.z) || 1, ux = (foe.x - self.x) / fd, uz = (foe.z - self.z) / fd;
  for (const r of [3.5, 6.5, 10]) for (let k = 0; k < 10; k++) {
    const a = rot + (k / 10) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
    if (cx * ux + cz * uz > 0.3) continue;
    const x = self.x + cx * r, z = self.z + cz * r, dx = x - ex, dy = y + 1.2 - ey, dz = z - ez, L = Math.hypot(dx, dy, dz);
    if (rayT(w, ex, ey, ez, dx / L, dy / L, dz / L, L) >= L - 0.6) continue;
    if (clearWalk(w, self.x, self.z, y, x, z, false)) return { x, z };
  }
  return null;
}

function glide(b: Bot, sim: Sim, self: PlayerState, inp: Input, safe: Pt | null) {
  b.mode = 'glide';
  // the first drop goes to the drop spot; a glide later (a launch pad, off a tower) to wherever we were going
  const to = !b.landed ? { x: b.dropX, z: b.dropZ } : safe ?? b.dest;
  const d = Math.hypot(to.x - self.x, to.z - self.z), h = Math.max(1, self.y - sim.world.groundAt(self.x, self.z, self.y));
  inp.yaw = yawTo(self, to.x, to.z);
  // out of the paper plane, glider shut: stay shut while the spot is close to under us (the fastest way
  // down), open it to cover distance (free fall drifts ~0.4 m per meter of drop, the glider 1.7)
  if (self.fall && d > h * 0.45) inp.jump = true;
  if (d < 4) { inp.fwd = -1; inp.pitch = -1.2; return; } // straight down, diving (S holds the glider back)
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

// still: on top of our own pillar (one step and we're off it): stand and shoot
function fight(b: Bot, sim: Sim, self: PlayerState, tgt: PlayerState, d: number, inp: Input, safe: Pt | null, still: boolean) {
  const R = b.rand, t = sim.t;
  // the gun for the range: switch when another is clearly better (not back and forth), or the mag ran dry
  const air = isAir(tgt.ride) && !tgt.seat;
  // a gun that's empty with nothing to reload it is worth nothing
  const vals = self.slots.map((x, i) => (!x ? -1 : self.mags[i] === 0 && WEAPONS[x].ammo && self.ammo[WEAPONS[x].ammo!] === 0 ? 0 : gunValue(x, self.ups[i], self.mags[i], d, b.skill, air)));
  let best = self.cur;
  vals.forEach((v, i) => { if (v > vals[best]) best = i; });
  const cur = self.slots[self.cur], empty = !!cur && self.mags[self.cur] === 0;
  const reloading = self.reloadT > 0 && self.reloadT < 0.9;
  if (best !== self.cur && vals[best] > 0 && !reloading && ((empty && self.mags[best] > 0) || (vals[best] > vals[self.cur] * 1.35 + 2 && t - b.slotT > 1.5))) { inp.slot = best + 1; b.slotT = t; }
  else if (empty && self.reloadT === 0) inp.reload = true;
  if (b.reaction <= 0) { b.aimErr = (R() - 0.5) * (0.06 + (1 - b.skill) * 0.16); b.reaction = 0.3 + R() * 0.4; if (R() < 0.15) b.strafe *= -1; }
  b.reaction -= DT;
  const def = cur ? WEAPONS[cur] : null;
  // aim where the target was a moment ago (reaction: 0.12 s for the best, 0.26 s for the worst); rockets lead
  // it instead and go for the feet
  const lag = def?.proj ? -d / 58 : 0.08 + (1 - b.skill) * 0.25, ax = tgt.x - tgt.vx * lag, az = tgt.z - tgt.vz * lag;
  const ty = tgt.y + (def?.proj ? 0.3 : b.vis === 2 ? HEAD_Y : HEAD_Y - 0.45) - (self.y + EYE_H); // the head when that's all that shows
  inp.yaw = yawTo(self, ax, az) + b.aimErr;
  inp.pitch = Math.atan2(ty, Math.hypot(ax - self.x, az - self.z)) + b.aimErr * 0.5;
  // they're nearly down (or knocked, or reloading while we're fine): close in and finish it
  const life = self.hp + self.shield, foe = tgt.hp + tgt.shield;
  const push = life > (PLAYER_HP + SHIELD_MAX) * 0.16 && (foe < (PLAYER_HP + SHIELD_MAX) * 0.2 || tgt.down > 0 || (tgt.reloadT > 0 && life > (PLAYER_HP + SHIELD_MAX) * 0.3));
  if (push) b.mode = 'push';
  inp.aim = d > 30 && !push;
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
    // and only through a sight line checked a moment ago: it may have stepped behind a wall since (every shot
    // while they have the axe out: a wall may be going up between us)
    if (inp.fire && (t - b.seenT > 0.1 || tgt.axe)) { const v = sight(sim.world, self, tgt); if (v) { b.seenT = t; b.vis = v; } else { inp.fire = false; b.los = false; b.losT = t; } }
  }
  // move: strafe, close in or back off to the gun's range, flip when a wall stops the strafe; the storm comes first
  const pref = !def ? 20 : def.melee ? 1.5 : push ? (def.proj ? 14 : 4) : def.pellets > 1 ? 6 : def.zoom >= 2.4 ? 55 : def.proj ? 30 : def.range < 70 ? 14 : 24;
  const ux = (tgt.x - self.x) / (d || 1), uz = (tgt.z - self.z) / (d || 1);
  let mx = -uz * b.strafe, mz = ux * b.strafe;
  if (still) { mx = 0; mz = 0; }
  else if (safe) { const s = steer(b, sim, self, safe.x, safe.z, 0); const l = Math.hypot(s.x, s.z) || 1; mx = (s.x / l) * 2 + mx * 0.3; mz = (s.z / l) * 2 + mz * 0.3; if (s.hop) hop(b, self, inp, t); }
  else if (d > pref + (push ? 2 : 12) || mate) { const s = steer(b, sim, self, tgt.x, tgt.z, tgt.y); const l = Math.hypot(s.x, s.z) || 1, k = push ? 3 : 1.5; mx += (s.x / l) * k; mz += (s.z / l) * k; if (s.hop) hop(b, self, inp, t); }
  else if (d < pref * 0.5) { mx -= ux; mz -= uz; }
  moveDir(inp, mx, mz);
  inp.sprint = (!!safe || push) && inp.fwd > 0.3 && !inp.aim;
  if (still) b.blockT = 0;
  else if (Math.hypot(self.vx, self.vz) < 1 && self.grounded) { if ((b.blockT += DT) > 0.35) { b.strafe *= -1; b.blockT = 0; } } else b.blockT = 0;
  // the better ones jump while they strafe, now and then (harder to hit, and over what's in the way)
  if (!still && !safe && self.grounded && d > 8 && R() < 0.012 * b.skill) inp.jump = true;
  if (self.perk && !inp.slot) {
    const k = self.perk.kind;
    if ((k === 'grenade' || k === 'molotov') && d > 8 && d < 24 && R() < 0.03) { inp.perk = true; inp.pitch += 0.25; }
    if (k === 'kit' && cur && self.ups[self.cur] < UPGRADE.max) inp.perk = true;
    if (k === 'smoke' && self.hp < PLAYER_HP * 0.44 && R() < 0.08) inp.perk = true;
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
// the gun worth most that a bench can still improve
function bestSlot(self: PlayerState, skill: number) {
  let bi = self.cur, bv = -1;
  self.slots.forEach((x, i) => { const v = x && self.ups[i] < UPGRADE.max ? worth(x, self.ups[i], skill) : -1; if (v > bv) { bv = v; bi = i; } });
  return bi;
}

// the nearest thing worth having on this floor: an unopened case, a better gun, shields and heals we have room for
function pickLoot(b: Bot, sim: Sim, self: PlayerState, ok: (x: number, z: number) => boolean) {
  const out = (x: number, z: number) => !ok(x, z);
  const t = sim.t;
  for (const [id, until] of b.skip) if (until < t) b.skip.delete(id);
  if (b.goal) { // still there?
    const r = b.goal.ref;
    if ((b.goal.kind === 'case' ? (r as Case).open : b.goal.kind === 'bench' ? b.benches.has(-1 - r.id) : !sim.loot.includes(r as Loot)) || out(r.x, r.z)) b.goal = null;
  }
  const full = !self.slots.includes(null), wi = worstSlot(self, b.skill), wv = full ? worth(self.slots[wi]!, self.ups[wi], b.skill) : 0;
  let best: Loot | Case | Bench | null = null, kind: 'case' | 'loot' | 'bench' = 'loot', bd = 45;
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
    else if (l.kind === 'ammo') { const a = l.what as AmmoId; useful = self.ammo[a] < AMMO[a].max && (self.ammo[a] < AMMO[a].box * 3 || self.slots.some((x) => !!x && WEAPONS[x].ammo === a)); } // what our guns take, and a little of anything
    else useful = !self.perk || (self.perk.kind === l.what && self.perk.n < PERKS[l.what as PerkId].count * 2);
    if (useful) { bd = d; best = l; kind = 'loot'; }
  }
  // an upgrade bench for our best gun (each one once), when nothing on the floor is nearer
  const bi = bestSlot(self, b.skill);
  if (self.slots[bi] && self.ups[bi] < UPGRADE.max) sim.world.upgrades.forEach((u, i) => {
    const y = u.y - 0.95, d = Math.hypot(u.x - self.x, u.z - self.z) * 0.9;
    if (d < bd && Math.abs(y - self.y) < 1.2 && !b.benches.has(i) && !b.skip.has(-1 - i) && !out(u.x, u.z)) { bd = d; best = { id: -1 - i, x: u.x, y, z: u.z }; kind = 'bench'; }
  });
  if (!best) { b.goal = null; return; }
  const pick: Loot | Case | Bench = best;
  if (!b.goal || b.goal.kind !== kind || b.goal.ref.id !== pick.id) b.goal = { ref: pick, kind, t0: t, arrived: 0 };
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
