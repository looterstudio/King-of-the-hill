// The island: a seeded town of blocks, rooftops reachable by stairs, crates, low walls and trees.
// Everything solid is an axis-aligned box, indexed in a 2D grid so collision and raycasts only
// look at nearby boxes. The same code runs on the server and in the browser, so client-side
// prediction moves through exactly the world the server simulates.
import { MAP_HALF, PLAYER_H, PLAYER_R, STEP_H, VEHICLES, type VehicleKind } from './constants.ts';
import { generate, type Poi, type Spot } from './mapgen.ts';

export { INK } from './mapgen.ts';

export interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; ink: number; kind: 'building' | 'stair' | 'crate' | 'wall' | 'trunk' | 'floor' | 'car' | 'container' | 'fort'; dead?: boolean }
export interface Tree { x: number; z: number; h: number; r: number }
export interface Roof { x0: number; z0: number; x1: number; z1: number; y: number }
export interface Lake { x: number; z: number; r: number }

const CELL = 8;
const GRID = Math.ceil((MAP_HALF * 2) / CELL);

export class World {
  boxes: Box[] = [];
  trees: Tree[] = [];
  roofs: Roof[] = [];
  pois: Poi[] = [];
  lakes: Lake[] = [];
  caseSpots: Spot[] = [];
  lootSpots: Spot[] = [];
  gables: { x0: number; z0: number; x1: number; z1: number; y: number; h: number; alongX: boolean }[] = []; // visual roofs
  roads: { x0: number; z0: number; x1: number; z1: number }[] = [];
  vehicleSpots: { kind: VehicleKind; x: number; y: number; z: number; head: number }[] = [];
  private grid: number[][] = Array.from({ length: GRID * GRID }, () => []);

  constructor(public seed: number, boxes?: Box[]) {
    if (boxes) this.boxes = boxes; else generate(this, seed);
    this.index();
    // every pencil case and loot spot rests on a real surface with room around it
    const cases: Spot[] = [];
    for (const c of this.caseSpots) {
      const s = this.settle(c.x, c.y, c.z, 0.55, 1.0);
      if (s && !cases.some((o) => Math.abs(o.y - s.y) < 1 && Math.hypot(o.x - s.x, o.z - s.z) < 1.6)) cases.push({ ...s, golden: c.golden });
    }
    this.caseSpots = cases;
    const loot: Spot[] = [];
    for (const l of this.lootSpots) {
      const s = this.settle(l.x, l.y, l.z);
      if (s && !cases.some((o) => Math.abs(o.y - s.y) < 1 && Math.hypot(o.x - s.x, o.z - s.z) < 1.1)) loot.push(s);
    }
    this.lootSpots = loot;
    // vehicles park where they fit (nudged off anything they would overlap) and nowhere else
    const parked: World['vehicleSpots'] = [];
    for (const v of this.vehicleSpots) {
      const d = VEHICLES[v.kind];
      const s = this.settle(v.x, v.y, v.z, d.r + 0.2, d.h);
      if (s && !parked.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < VEHICLES[o.kind].r + d.r + 1)) parked.push({ ...v, ...s });
    }
    this.vehicleSpots = parked;
  }

  // anything solid in a small cylinder standing at (x, y, z)?
  blocked(x: number, y: number, z: number, r: number, h: number): boolean {
    for (const i of this.near(x - r, z - r, x + r, z + r)) {
      const b = this.boxes[i];
      if (!b.dead && x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1 && y + h > b.y0 && y + 0.02 < b.y1) return true;
    }
    return false;
  }
  // where a dropped item really comes to rest: on the floor under it, out of any wall, and on the
  // same level when possible (an item spilled off a roof edge slides back onto the roof instead of
  // floating in the air or falling to the street). null = nowhere sensible nearby.
  settle(x: number, y: number, z: number, r = 0.3, h = 0.6): Spot | null {
    let fallback: Spot | null = null;
    const lim = MAP_HALF - 2;
    for (let ring = 0; ring <= 6; ring++) {
      const d = ring * 0.45, n = ring === 0 ? 1 : 8 + ring * 2;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring;
        const cx = Math.max(-lim, Math.min(lim, x + Math.cos(a) * d)), cz = Math.max(-lim, Math.min(lim, z + Math.sin(a) * d));
        const gy = this.groundAt(cx, cz, y + 0.6);
        if (this.blocked(cx, gy, cz, r, h)) continue;
        // the floor must be under the whole item, not just its centre (no hanging off a ledge)
        if (Math.min(...[[-r, 0], [r, 0], [0, -r], [0, r]].map(([ox, oz]) => this.groundAt(cx + ox, cz + oz, gy + 0.05))) < gy - 0.05) continue;
        if (gy >= y - 0.6) return { x: cx, y: gy, z: cz };
        fallback ??= { x: cx, y: gy, z: cz };
      }
    }
    return fallback;
  }
  // a hand-built world, for tests
  static custom(boxes: Box[]) { return new World(0, boxes); }

  private index() { this.boxes.forEach((b, i) => this.indexBox(b, i)); }
  private indexBox(b: Box, i: number) {
    const [cx0, cz0] = this.cell(b.x0, b.z0), [cx1, cz1] = this.cell(b.x1, b.z1);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) this.grid[cz * GRID + cx].push(i);
  }
  // structures built mid-match (instant forts); returns their indices so they can be torn down
  addBoxes(list: Box[]): number[] {
    return list.map((b) => { const i = this.boxes.length; this.boxes.push(b); this.indexBox(b, i); return i; });
  }
  killBoxes(ids: number[]) { for (const i of ids) if (this.boxes[i]) this.boxes[i].dead = true; }
  cell(x: number, z: number): [number, number] {
    const c = (v: number) => Math.max(0, Math.min(GRID - 1, Math.floor((v + MAP_HALF) / CELL)));
    return [c(x), c(z)];
  }
  // boxes whose cells touch the given xz rectangle
  private stamp = new Uint32Array(0);
  private visit = 0;
  private rayStamp = new Uint32Array(0);
  private rayVisit = 0;
  near(x0: number, z0: number, x1: number, z1: number, out: number[] = []): number[] {
    out.length = 0;
    if (this.stamp.length < this.boxes.length) this.stamp = new Uint32Array(this.boxes.length * 2);
    const v = ++this.visit;
    const [cx0, cz0] = this.cell(x0, z0), [cx1, cz1] = this.cell(x1, z1);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) for (const i of this.grid[cz * GRID + cx]) if (this.stamp[i] !== v) { this.stamp[i] = v; out.push(i); }
    return out;
  }

  // the first solid box overlapping a square footprint of half-size r and height h standing at y
  hitBox(x: number, y: number, z: number, r: number, h: number): Box | null {
    for (const i of this.near(x - r, z - r, x + r, z + r)) {
      const b = this.boxes[i];
      if (!b.dead && x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1 && y + h > b.y0 && y < b.y1) return b;
    }
    return null;
  }

  overlaps(x: number, y: number, z: number, scratch: number[] = []): Box | null {
    for (const i of this.near(x - PLAYER_R, z - PLAYER_R, x + PLAYER_R, z + PLAYER_R, scratch)) {
      const b = this.boxes[i];
      if (b.dead) continue;
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
    // boxes spanning several cells are tested once per ray (visit stamps, no allocation)
    if (this.rayStamp.length < this.boxes.length) this.rayStamp = new Uint32Array(this.boxes.length * 2);
    const v = ++this.rayVisit;
    while (t <= best) {
      for (const i of this.grid[cz * GRID + cx]) {
        if (this.rayStamp[i] === v) continue;
        this.rayStamp[i] = v;
        if (this.boxes[i].dead) continue;
        const h = rayBox(ox, oy, oz, dx, dy, dz, this.boxes[i]);
        if (h >= 0 && h < best) best = h;
      }
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tdX; cx += stepX; } else { t = tMaxZ; tMaxZ += tdZ; cz += stepZ; }
      if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) break;
    }
    return best;
  }

  // height of the highest surface under (x, z) at or below y (for dropping things onto floors)
  groundAt(x: number, z: number, y: number): number {
    let best = 0;
    for (const i of this.near(x, z, x, z)) {
      const b = this.boxes[i];
      if (!b.dead && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.y1 <= y + 0.01 && b.y1 > best) best = b.y1;
    }
    return best;
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
  launchT: number; // launch pad: fly up first, open the glider at the top
  ride: number; head: number; vpitch: number; spd: number; // in a vehicle: 1 car, 2 heli, 3 plane; its heading, pitch, speed
}
export interface MoveInput { fwd: number; strafe: number; yaw: number; pitch: number; jump: boolean; sprint: boolean; slide: boolean; grapple: boolean; up?: number }

export const newBody = (x: number, y: number, z: number): Body => ({
  x, y, z, vx: 0, vy: 0, vz: 0, grounded: false, gliding: false, airJumps: 1, wallX: 0, wallZ: 0, wallT: 99,
  slideT: 0, dashT: 0, dashX: 0, dashZ: 0, dashReady: true, hook: false, gx: 0, gy: 0, gz: 0, hookCd: 0, launchT: 0,
  ride: 0, head: 0, vpitch: 0, spd: 0,
});

// gliding: look down to dive (fast fall, fast forward), look up to float and cover distance
const GLIDE_SPEED = 12, GLIDE_DIVE_SPEED = 22, GLIDE_FALL = -7, GLIDE_DIVE_FALL = -30;
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
  if (p.launchT > 0) { p.launchT -= dt; if (p.launchT <= 0 && !p.grounded) p.gliding = true; }

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
    const dive = p.gliding ? Math.max(0, Math.min(1, (-inp.pitch - 0.3) / 0.9)) : 0;
    const speed = p.gliding ? GLIDE_SPEED + (GLIDE_DIVE_SPEED - GLIDE_SPEED) * dive : inp.sprint && inp.fwd > 0 ? sprint : walk;
    if (p.grounded || p.gliding) { p.vx = wx * speed; p.vz = wz * speed; }
    else {
      // air: steer, but never bleed off momentum from a slide jump, dash or swing
      const ax = p.vx + wx * speed * dt * 4, az = p.vz + wz * speed * dt * 4, cur = Math.hypot(p.vx, p.vz), next = Math.hypot(ax, az), cap = Math.max(cur, speed);
      const k = next > cap ? cap / next : 1; p.vx = ax * k; p.vz = az * k;
    }
    if (p.gliding) { const cap = GLIDE_FALL + (GLIDE_DIVE_FALL - GLIDE_FALL) * dive; p.vy += (cap - p.vy) * Math.min(1, dt * 4); }
    else p.vy -= gravity * dt;
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

