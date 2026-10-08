// The island: a seeded town of blocks, rooftops reachable by stairs, crates, low walls and trees.
// Everything solid is an axis-aligned box, indexed in a 2D grid so collision and raycasts only
// look at nearby boxes. The same code runs on the server and in the browser, so client-side
// prediction moves through exactly the world the server simulates.
import { MAP_HALF, PLAYER_H, PLAYER_R, STEP_H } from './constants.ts';
import { rng } from './rng.ts';

export const INK = { BLUE: 0, RED: 1, GRAPHITE: 2, ORANGE: 3, GREEN: 4, PINK: 5, BROWN: 6 } as const;

export interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; ink: number; kind: 'building' | 'stair' | 'crate' | 'wall' | 'trunk' }
export interface Tree { x: number; z: number; h: number; r: number }
export interface Roof { x0: number; z0: number; x1: number; z1: number; y: number }

const CELL = 8;
const GRID = Math.ceil((MAP_HALF * 2) / CELL);

export class World {
  boxes: Box[] = [];
  trees: Tree[] = [];
  roofs: Roof[] = [];
  private grid: number[][] = Array.from({ length: GRID * GRID }, () => []);

  constructor(public seed: number, boxes?: Box[]) {
    if (boxes) this.boxes = boxes; else generate(this, seed);
    this.index();
  }
  // a hand-built world, for tests
  static custom(boxes: Box[]) { return new World(0, boxes); }

  private index() {
    this.boxes.forEach((b, i) => {
      const [cx0, cz0] = this.cell(b.x0, b.z0), [cx1, cz1] = this.cell(b.x1, b.z1);
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) this.grid[cz * GRID + cx].push(i);
    });
  }
  cell(x: number, z: number): [number, number] {
    const c = (v: number) => Math.max(0, Math.min(GRID - 1, Math.floor((v + MAP_HALF) / CELL)));
    return [c(x), c(z)];
  }
  // boxes whose cells touch the given xz rectangle
  near(x0: number, z0: number, x1: number, z1: number, out: number[] = []): number[] {
    out.length = 0;
    const [cx0, cz0] = this.cell(x0, z0), [cx1, cz1] = this.cell(x1, z1);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) for (const i of this.grid[cz * GRID + cx]) if (!out.includes(i)) out.push(i);
    return out;
  }

  overlaps(x: number, y: number, z: number, scratch: number[] = []): Box | null {
    for (const i of this.near(x - PLAYER_R, z - PLAYER_R, x + PLAYER_R, z + PLAYER_R, scratch)) {
      const b = this.boxes[i];
      if (x + PLAYER_R > b.x0 && x - PLAYER_R < b.x1 && z + PLAYER_R > b.z0 && z - PLAYER_R < b.z1 && y + PLAYER_H > b.y0 && y < b.y1) return b;
    }
    return null;
  }

  // distance along a unit ray to the first box or the ground, up to maxT (2D DDA over the grid)
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let best = maxT;
    if (dy < 0) { const tg = -oy / dy; if (tg < best) best = tg; }
    let [cx, cz] = this.cell(ox, oz);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const edge = (c: number, s: number) => -MAP_HALF + (c + (s > 0 ? 1 : 0)) * CELL;
    let tMaxX = dx !== 0 ? (edge(cx, stepX) - ox) / dx : Infinity, tMaxZ = dz !== 0 ? (edge(cz, stepZ) - oz) / dz : Infinity;
    const tdX = dx !== 0 ? CELL / Math.abs(dx) : Infinity, tdZ = dz !== 0 ? CELL / Math.abs(dz) : Infinity;
    let t = 0;
    const seen = new Set<number>();
    while (t <= best) {
      for (const i of this.grid[cz * GRID + cx]) {
        if (seen.has(i)) continue;
        seen.add(i);
        const h = rayBox(ox, oy, oz, dx, dy, dz, this.boxes[i]);
        if (h >= 0 && h < best) best = h;
      }
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tdX; cx += stepX; } else { t = tMaxZ; tMaxZ += tdZ; cz += stepZ; }
      if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) break;
    }
    return best;
  }

  // a free spot on open ground (used for loot and fallbacks)
  freeSpot(r: () => number, radius: number): { x: number; z: number } {
    for (let i = 0; i < 200; i++) {
      const x = (r() * 2 - 1) * radius, z = (r() * 2 - 1) * radius;
      if (!this.overlaps(x, 0, z)) return { x, z };
    }
    return { x: 0, z: 0 };
  }
}

// slab test; returns entry distance or -1
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }): number {
  let tmin = -Infinity, tmax = Infinity;
  const axis = (o: number, d: number, lo: number, hi: number) => {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { tmin = Infinity; } return; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  };
  axis(ox, dx, b.x0, b.x1); axis(oy, dy, b.y0, b.y1); axis(oz, dz, b.z0, b.z1);
  if (tmin > tmax || tmax < 0) return -1;
  return tmin >= 0 ? tmin : 0;
}

// ---------------- movement (shared by server sim and client prediction) ----------------
// The doodle-shooter movement kit: double jump, wall jump, slide, air dash and a grapple.
// One-shot actions (jump, slide) arrive as edges on a single input; the server applies inputs
// one per tick in order, so the client's prediction replays exactly the same moves.
export interface Body {
  x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; gliding: boolean;
  airJumps: number; wallX: number; wallZ: number; wallT: number; slideT: number; dashT: number; dashX: number; dashZ: number; dashReady: boolean;
  hook: boolean; gx: number; gy: number; gz: number; hookCd: number;
}
export interface MoveInput { fwd: number; strafe: number; yaw: number; pitch: number; jump: boolean; sprint: boolean; slide: boolean; grapple: boolean }

export const newBody = (x: number, y: number, z: number): Body => ({
  x, y, z, vx: 0, vy: 0, vz: 0, grounded: false, gliding: false, airJumps: 1, wallX: 0, wallZ: 0, wallT: 99,
  slideT: 0, dashT: 0, dashX: 0, dashZ: 0, dashReady: true, hook: false, gx: 0, gy: 0, gz: 0, hookCd: 0,
});

const GLIDE_SPEED = 15, GLIDE_FALL = -10;
const SLIDE_TIME = 0.75, SLIDE_SPEED = 11.5, DASH_TIME = 0.18, DASH_SPEED = 17;
const WALL_GRACE = 0.2, WALL_PUSH = 7.5;
export const HOOK_RANGE = 48;
const HOOK_PULL = 40, HOOK_MAX = 24, HOOK_CD = 0.6;
const EYE = 1.62;
const scratch: number[] = [];

export function moveBody(w: World, p: Body, inp: MoveInput, dt: number, gravity: number, walk: number, sprint: number, jumpV: number) {
  const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
  // forward is -z at yaw 0 (three.js camera convention)
  let wx = -sin * inp.fwd + cos * inp.strafe, wz = -cos * inp.fwd - sin * inp.strafe;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  p.wallT += dt;
  p.hookCd = Math.max(0, p.hookCd - dt);

  // ---- one-shot actions ----
  if (inp.slide && !p.gliding) {
    const sp = Math.hypot(p.vx, p.vz);
    if (p.grounded && p.slideT <= 0 && sp > 3) {
      p.slideT = SLIDE_TIME;
      const k = Math.max(sp, SLIDE_SPEED) / sp; p.vx *= k; p.vz *= k;
    } else if (!p.grounded && p.dashReady) {
      const dx = wl > 0.1 ? wx : -sin, dz = wl > 0.1 ? wz : -cos, dl = Math.hypot(dx, dz) || 1;
      p.dashT = DASH_TIME; p.dashX = dx / dl; p.dashZ = dz / dl; p.dashReady = false; p.hook = false;
    }
  }
  if (inp.jump && !p.gliding) {
    if (p.grounded) { p.vy = jumpV; p.grounded = false; p.slideT = 0; } // a slide jump keeps the slide's speed
    else if (p.wallT < WALL_GRACE) { p.vy = jumpV; p.vx += p.wallX * WALL_PUSH; p.vz += p.wallZ * WALL_PUSH; p.wallT = 99; }
    else if (p.airJumps > 0) { p.vy = jumpV * 0.9; p.airJumps--; }
  }

  // ---- grapple: hold to reel toward the first surface under the crosshair ----
  if (inp.grapple && !p.hook && p.hookCd === 0 && !p.gliding) {
    const cp = Math.cos(inp.pitch), dx = -sin * cp, dy = Math.sin(inp.pitch), dz = -cos * cp;
    const t = w.raycast(p.x, p.y + EYE, p.z, dx, dy, dz, HOOK_RANGE);
    if (t < HOOK_RANGE && p.y + EYE + dy * t > 0.3) { p.hook = true; p.gx = p.x + dx * t; p.gy = p.y + EYE + dy * t; p.gz = p.z + dz * t; }
  }
  if (p.hook) {
    const hx = p.gx - p.x, hy = p.gy - (p.y + 1), hz = p.gz - p.z, d = Math.hypot(hx, hy, hz);
    if (!inp.grapple || d < 1.6) { p.hook = false; p.hookCd = HOOK_CD; }
  }

  // ---- velocity ----
  if (p.dashT > 0) {
    p.dashT -= dt; p.vx = p.dashX * DASH_SPEED; p.vz = p.dashZ * DASH_SPEED; p.vy = 0;
  } else if (p.hook) {
    const hx = p.gx - p.x, hy = p.gy - (p.y + 1), hz = p.gz - p.z, d = Math.hypot(hx, hy, hz) || 1;
    p.vx += (hx / d) * HOOK_PULL * dt + wx * 6 * dt; p.vy += (hy / d) * HOOK_PULL * dt - gravity * 0.45 * dt; p.vz += (hz / d) * HOOK_PULL * dt + wz * 6 * dt;
    const sp = Math.hypot(p.vx, p.vy, p.vz);
    if (sp > HOOK_MAX) { p.vx *= HOOK_MAX / sp; p.vy *= HOOK_MAX / sp; p.vz *= HOOK_MAX / sp; }
    p.grounded = false;
  } else if (p.slideT > 0 && p.grounded) {
    p.slideT -= dt;
    const k = Math.max(0, 1 - dt * 1.4); p.vx *= k; p.vz *= k;
    p.vy -= gravity * dt;
  } else {
    p.slideT = 0;
    const speed = p.gliding ? GLIDE_SPEED : inp.sprint && inp.fwd > 0 ? sprint : walk;
    if (p.grounded || p.gliding) { p.vx = wx * speed; p.vz = wz * speed; }
    else {
      // air: steer, but never bleed off momentum from a slide jump, dash or swing
      const ax = p.vx + wx * speed * dt * 4, az = p.vz + wz * speed * dt * 4, cur = Math.hypot(p.vx, p.vz), next = Math.hypot(ax, az), cap = Math.max(cur, speed);
      const k = next > cap ? cap / next : 1; p.vx = ax * k; p.vz = az * k;
    }
    p.vy -= gravity * dt;
    if (p.gliding && p.vy < GLIDE_FALL) p.vy = GLIDE_FALL;
  }

  const wasGrounded = p.grounded;
  slide(w, p, p.vx * dt, 0, wasGrounded);
  slide(w, p, 0, p.vz * dt, wasGrounded);

  p.grounded = false;
  p.y += p.vy * dt;
  const hit = w.overlaps(p.x, p.y, p.z, scratch);
  if (hit) {
    if (p.vy <= 0) { p.y = hit.y1; p.grounded = true; } else p.y = hit.y0 - PLAYER_H - 1e-4;
    p.vy = 0;
  }
  if (p.y <= 0) { p.y = 0; p.vy = 0; p.grounded = true; }
  if (p.grounded) { p.gliding = false; p.airJumps = 1; p.dashReady = true; }

  const lim = MAP_HALF - PLAYER_R;
  if (p.x > lim) p.x = lim; if (p.x < -lim) p.x = -lim;
  if (p.z > lim) p.z = lim; if (p.z < -lim) p.z = -lim;
}

// move along one axis; climb anything up to STEP_H, otherwise stop flush against it
function slide(w: World, p: Body, dx: number, dz: number, grounded: boolean) {
  if (!dx && !dz) return;
  p.x += dx; p.z += dz;
  const b = w.overlaps(p.x, p.y, p.z, scratch);
  if (!b) return;
  const rise = b.y1 - p.y;
  if (grounded && rise > 0 && rise <= STEP_H && !w.overlaps(p.x, b.y1 + 1e-3, p.z, scratch)) { p.y = b.y1; return; }
  if (dx > 0) p.x = b.x0 - PLAYER_R - 1e-4; else if (dx < 0) p.x = b.x1 + PLAYER_R + 1e-4;
  if (dz > 0) p.z = b.z0 - PLAYER_R - 1e-4; else if (dz < 0) p.z = b.z1 + PLAYER_R + 1e-4;
  if (dx) p.vx = 0; if (dz) p.vz = 0;
  // remember the wall for a wall jump (its normal points back at us)
  if (!grounded) { p.wallX = dx > 0 ? -1 : dx < 0 ? 1 : 0; p.wallZ = dz > 0 ? -1 : dz < 0 ? 1 : 0; p.wallT = 0; }
}

// ---------------- map generation ----------------
function generate(w: World, seed: number) {
  const r = rng(seed);
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ink: number, kind: Box['kind']) => w.boxes.push({ x0, y0, z0, x1, y1, z1, ink, kind });
  const BLOCK = 36, SPAN = 5; // 11 x 11 blocks, streets between them
  for (let bx = -SPAN; bx <= SPAN; bx++) for (let bz = -SPAN; bz <= SPAN; bz++) {
    const cx = bx * BLOCK, cz = bz * BLOCK;
    const roll = r();
    if (roll < 0.14) { // park: trees and benches of cover
      for (let i = 0; i < 6; i++) w.trees.push({ x: cx + (r() - 0.5) * 26, z: cz + (r() - 0.5) * 26, h: 4 + r() * 3, r: 1.6 + r() * 1.2 });
      continue;
    }
    if (roll < 0.22) { // plaza: low walls in a square
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2, len = 7 + r() * 5, ox = cx + Math.cos(a) * 9, oz = cz + Math.sin(a) * 9;
        if (i % 2 === 0) box(ox - 0.25, 0, oz - len / 2, ox + 0.25, 1.1, oz + len / 2, INK.GRAPHITE, 'wall');
        else box(ox - len / 2, 0, oz - 0.25, ox + len / 2, 1.1, oz + 0.25, INK.GRAPHITE, 'wall');
      }
      continue;
    }
    const n = r() < 0.45 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const wdt = 8 + r() * 8, dpt = 8 + r() * 8, floors = 1 + Math.floor(r() * 3), h = floors * 3.5;
      const room = 26 - (n === 2 ? 13 : 0);
      const ox = n === 2 ? (k === 0 ? -7 : 7) : 0;
      const x0 = cx + ox - wdt / 2 + (r() - 0.5) * Math.max(0, room - wdt) * 0.5, z0 = cz - dpt / 2 + (r() - 0.5) * Math.max(0, 26 - dpt) * 0.5;
      const bw = Math.min(wdt, n === 2 ? 11 : 15);
      box(x0, 0, z0, x0 + bw, h, z0 + dpt, INK.BLUE, 'building');
      w.roofs.push({ x0, z0, x1: x0 + bw, z1: z0 + dpt, y: h });
      // a staircase up one outside wall, 0.5 m per step
      // depth per step shrinks on short buildings so the top step always lands at roof height
      const steps = Math.round(h / 0.5), side = r() < 0.5 ? -1 : 1, sw = 1.4, sd = Math.min(0.6, (dpt - 0.6) / steps);
      const sx0 = side < 0 ? x0 - sw : x0 + bw;
      for (let i = 0; i < steps; i++) {
        const sz0 = z0 + 0.3 + i * sd;
        box(sx0, 0, sz0, sx0 + sw, (i + 1) * 0.5, sz0 + sd, INK.GRAPHITE, 'stair');
      }
      // rooftop cover
      if (r() < 0.6) { const rx = x0 + 1 + r() * (bw - 3), rz = z0 + 1 + r() * (dpt - 3); box(rx, h, rz, rx + 1.3, h + 1.3, rz + 1.3, INK.ORANGE, 'crate'); }
    }
  }
  // street clutter: crates (some stacked) and walls
  for (let i = 0; i < 320; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 8), z = (r() * 2 - 1) * (MAP_HALF - 8), s = 1.1 + r() * 0.5;
    if (hits(w, x - s, z - s, x + s * 2, z + s * 2)) continue;
    box(x, 0, z, x + s, s, z + s, INK.ORANGE, 'crate');
    if (r() < 0.3) box(x + 0.1, s, z + 0.1, x + s - 0.1, s * 2 - 0.2, z + s - 0.1, INK.ORANGE, 'crate');
  }
  for (let i = 0; i < 150; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 10), z = (r() * 2 - 1) * (MAP_HALF - 10), len = 4 + r() * 6, along = r() < 0.5;
    const [x0, z0, x1, z1] = along ? [x, z, x + len, z + 0.4] : [x, z, x + 0.4, z + len];
    if (hits(w, x0 - 1, z0 - 1, x1 + 1, z1 + 1)) continue;
    box(x0, 0, z0, x1, 1.1 + r() * 0.5, z1, INK.GRAPHITE, 'wall');
  }
  // street trees
  for (let i = 0; i < 120; i++) w.trees.push({ x: (r() * 2 - 1) * (MAP_HALF - 4), z: (r() * 2 - 1) * (MAP_HALF - 4), h: 4 + r() * 4, r: 1.6 + r() * 1.4 });
  w.trees = w.trees.filter((t) => Math.abs(t.x) < MAP_HALF - 2 && Math.abs(t.z) < MAP_HALF - 2 && !hits(w, t.x - 0.5, t.z - 0.5, t.x + 0.5, t.z + 0.5));
  for (const t of w.trees) box(t.x - 0.3, 0, t.z - 0.3, t.x + 0.3, t.h * 0.6, t.z + 0.3, INK.BROWN, 'trunk');
}

function hits(w: World, x0: number, z0: number, x1: number, z1: number) {
  return w.boxes.some((b) => x1 > b.x0 - 1.5 && x0 < b.x1 + 1.5 && z1 > b.z0 - 1.5 && z0 < b.z1 + 1.5);
}
