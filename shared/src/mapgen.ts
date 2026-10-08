// The island layout: named places around a giant tower in the middle (the "hill").
// Buildings are hollow shells: walls with door and window openings, floors with a stairwell,
// and stairs inside that alternate sides each floor so every level is reachable on foot.
import { MAP_HALF } from './constants.ts';
import { rng } from './rng.ts';
import type { Box, World } from './world.ts';

export const INK = { BLUE: 0, RED: 1, GRAPHITE: 2, ORANGE: 3, GREEN: 4, PINK: 5, BROWN: 6, PAPER: 7 } as const;
export interface Poi { name: string; x: number; z: number }
export interface Spot { x: number; y: number; z: number; golden?: boolean }

type Side = 'n' | 's' | 'e' | 'w';
const T = 0.3;            // wall thickness
const SLAB = 0.25;        // floor thickness

interface ShellOpts { fh?: number; ink?: number; doors?: Side[]; windows?: boolean; roofAccess?: boolean; bigDoor?: number; cases?: number; golden?: boolean }

export function generate(w: World, seed: number) {
  const r = rng(seed);
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ink: number, kind: Box['kind']) => {
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01 || z1 - z0 < 0.01) return;
    w.boxes.push({ x0, y0, z0, x1, y1, z1, ink, kind });
  };
  const free = (x0: number, z0: number, x1: number, z1: number, pad = 1.2) =>
    !w.boxes.some((b) => b.y0 < 0.5 && x1 > b.x0 - pad && x0 < b.x1 + pad && z1 > b.z0 - pad && z0 < b.z1 + pad);

  // a wall along x (or z) between `a` and `b` with rectangular openings
  const wall = (alongX: boolean, fixed: number, a: number, b: number, y0: number, y1: number, ops: { a: number; b: number; lo: number; hi: number }[], ink: number) => {
    const cut = [...ops].sort((p, q) => p.a - q.a);
    let at = a;
    const piece = (p0: number, p1: number, q0: number, q1: number) => alongX ? box(p0, q0, fixed - T / 2, p1, q1, fixed + T / 2, ink, 'wall') : box(fixed - T / 2, q0, p0, fixed + T / 2, q1, p1, ink, 'wall');
    for (const o of cut) {
      piece(at, o.a, y0, y1);
      if (o.lo > 0) piece(o.a, o.b, y0, y0 + o.lo);
      if (y0 + o.hi < y1) piece(o.a, o.b, y0 + o.hi, y1);
      at = o.b;
    }
    piece(at, b, y0, y1);
  };

  const shell = (x0: number, z0: number, wd: number, dp: number, floors: number, o: ShellOpts = {}) => {
    const fh = o.fh ?? 3.5, ink = o.ink ?? INK.BLUE, x1 = x0 + wd, z1 = z0 + dp, doors = o.doors ?? ['s'];
    for (let f = 0; f < floors; f++) {
      const y0 = f * fh, y1 = y0 + fh;
      for (const side of ['n', 's', 'e', 'w'] as Side[]) {
        const alongX = side === 'n' || side === 's';
        const len = alongX ? wd : dp, start = alongX ? x0 : z0;
        const ops: { a: number; b: number; lo: number; hi: number }[] = [];
        const door = f === 0 && doors.includes(side);
        const dw = o.bigDoor ?? 1.8;
        if (door) ops.push({ a: start + len / 2 - dw / 2, b: start + len / 2 + dw / 2, lo: 0, hi: Math.min(fh - 0.4, o.bigDoor ? 5 : 2.5) });
        if (o.windows !== false && len > 6) for (const k of [0.22, 0.78]) {
          const c = start + len * k;
          if (door && Math.abs(c - (start + len / 2)) < dw) continue;
          ops.push({ a: c - 0.7, b: c + 0.7, lo: 1.1, hi: 2.3 });
        }
        const fixed = side === 'n' ? z0 : side === 's' ? z1 : side === 'w' ? x0 : x1;
        wall(alongX, fixed, alongX ? x0 : z0, alongX ? x1 : z1, y0, y1, ops, ink);
      }
      // stairs up from this floor: west strip on even floors, east strip on odd ones
      const last = f === floors - 1;
      if (!last || o.roofAccess) {
        const steps = Math.round(fh / 0.5), run = 0.55, west = f % 2 === 0;
        const sx0 = west ? x0 + T : x1 - T - 1.4, zs = z0 + T + 1.2;
        for (let i = 0; i < steps; i++) box(sx0, y0, zs + i * run, sx0 + 1.4, y0 + (i + 1) * (fh / steps), zs + (i + 1) * run, INK.GRAPHITE, 'stair');
      }
      // the floor above (or the roof), with a hole over this floor's stairs
      const ys = y1;
      const holeWest = f % 2 === 0, hasHole = !last || o.roofAccess;
      const hx0 = holeWest ? x0 : x1 - T - 1.6, hx1 = holeWest ? x0 + T + 1.6 : x1;
      const hz0 = z0 + T + 1.0, hz1 = z0 + T + 1.2 + Math.round(fh / 0.5) * 0.55 + 0.2;
      if (!hasHole) box(x0, ys - SLAB, z0, x1, ys, z1, ink, 'floor');
      else {
        box(holeWest ? hx1 : x0, ys - SLAB, z0, holeWest ? x1 : hx0, ys, z1, ink, 'floor');
        box(hx0, ys - SLAB, z0, hx1, ys, hz0, ink, 'floor');
        box(hx0, ys - SLAB, hz1, hx1, ys, z1, ink, 'floor');
      }
      // pencil cases on this floor, clear of the stair strips
      for (let c = 0; c < (o.cases ?? 1); c++) {
        if (r() < 0.35 && !o.golden) continue;
        const cx = x0 + 2.4 + r() * Math.max(0.1, wd - 4.8), cz = z0 + dp * 0.55 + r() * (dp * 0.35 - 1);
        w.caseSpots.push({ x: cx, y: y0, z: Math.min(cz, z1 - 1), golden: false });
      }
    }
    const top = floors * fh;
    w.roofs.push({ x0, z0, x1, z1, y: top });
    if (o.golden) w.caseSpots.push({ x: (x0 + x1) / 2, y: top, z: (z0 + z1) / 2, golden: true });
    return top;
  };

  const house = (cx: number, cz: number, door: Side) => {
    const wd = 9 + r() * 3, dp = 9 + r() * 3, floors = r() < 0.6 ? 2 : 1, flat = r() < 0.3;
    const top = shell(cx - wd / 2, cz - dp / 2, wd, dp, floors, { doors: [door], ink: INK.BLUE, roofAccess: flat });
    if (!flat) w.gables.push({ x0: cx - wd / 2 - 0.3, z0: cz - dp / 2 - 0.3, x1: cx + wd / 2 + 0.3, z1: cz + dp / 2 + 0.3, y: top, h: 2.2, alongX: wd > dp });
  };
  const crate = (x: number, z: number, y = 0, s = 1.2) => box(x, y, z, x + s, y + s, z + s, INK.ORANGE, 'crate');
  const tree = (x: number, z: number) => w.trees.push({ x, z, h: 4 + r() * 4, r: 1.6 + r() * 1.4 });
  const car = (x: number, z: number, alongX: boolean) => {
    const [l, wd] = alongX ? [4.2, 1.9] : [1.9, 4.2];
    box(x, 0, z, x + l, 1.1, z + wd, INK.RED, 'car');
    const inset = 0.9;
    box(x + (alongX ? inset : 0.2), 1.1, z + (alongX ? 0.2 : inset), x + l - (alongX ? inset + 0.5 : 0.2), 1.8, z + wd - (alongX ? 0.2 : inset + 0.5), INK.RED, 'car');
  };

  // ---------- the King's Tower: the hill everyone ends up fighting over ----------
  {
    const s = 34, x0 = -s / 2, z0 = -s / 2;
    shell(x0, z0, s, s, 6, { fh: 4, ink: INK.BLUE, doors: ['n', 's', 'e', 'w'], roofAccess: true, cases: 3, golden: true });
    // inner core walls for cover on every floor
    for (let f = 0; f < 6; f++) { box(-3, f * 4, -3, 3, f * 4 + 1.3, -2.7, INK.GRAPHITE, 'wall'); box(-3, f * 4, 2.7, 3, f * 4 + 1.3, 3, INK.GRAPHITE, 'wall'); }
    // a crown on the roof
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; box(Math.cos(a) * 6 - 0.6, 24, Math.sin(a) * 6 - 0.6, Math.cos(a) * 6 + 0.6, 27, Math.sin(a) * 6 + 0.6, INK.ORANGE, 'wall'); }
    w.pois.push({ name: "King's Tower", x: 0, z: 0 });
    for (const [px, pz] of [[-24, -24], [24, -24], [-24, 24], [24, 24]]) crate(px, pz, 0, 1.4);
  }

  // ---------- Doodle Heights: tall towers packed together ----------
  {
    const cx = -115, cz = -112;
    const tops: { i: number; j: number; x: number; z: number; y: number }[] = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      if (r() < 0.12) continue;
      const x = cx - 30 + i * 18 + (r() - 0.5) * 2, z = cz - 30 + j * 18 + (r() - 0.5) * 2, floors = 2 + Math.floor(r() * 4);
      tops.push({ i, j, x, z, y: floors * 3.5 });
      shell(x - 5, z - 5, 10, 10, floors, { fh: 3.5, ink: [INK.BLUE, INK.PINK, INK.GRAPHITE][Math.floor(r() * 3)], doors: [(['n', 's', 'e', 'w'] as Side[])[Math.floor(r() * 4)]], roofAccess: floors < 5, golden: floors >= 5 && r() < 0.5 });
    }
    // plank bridges between neighbouring rooftops of the same height: run the roofs
    for (const a of tops) for (const b of tops) {
      if (a.y !== b.y || !((b.i === a.i + 1 && b.j === a.j) || (b.j === a.j + 1 && b.i === a.i)) || r() < 0.3) continue;
      if (b.i === a.i + 1) box(a.x + 5, a.y - 0.25, (a.z + b.z) / 2 - 0.9, b.x - 5, a.y, (a.z + b.z) / 2 + 0.9, INK.BROWN, 'floor');
      else box((a.x + b.x) / 2 - 0.9, a.y - 0.25, a.z + 5, (a.x + b.x) / 2 + 0.9, a.y, b.z - 5, INK.BROWN, 'floor');
    }
    // clock tower in the middle
    box(cx - 2, 0, cz - 2, cx + 2, 20, cz + 2, INK.BROWN, 'building'); box(cx - 2.6, 20, cz - 2.6, cx + 2.6, 21, cz + 2.6, INK.BROWN, 'building');
    w.roofs.push({ x0: cx - 2.6, z0: cz - 2.6, x1: cx + 2.6, z1: cz + 2.6, y: 21 });
    w.caseSpots.push({ x: cx, y: 21, z: cz, golden: true });
    w.pois.push({ name: 'Doodle Heights', x: cx, z: cz });
  }

  // ---------- Pencil Park: houses around a green ----------
  {
    const cx = 112, cz = -110;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2, d = 34;
      const hx = cx + Math.cos(a) * d, hz = cz + Math.sin(a) * d;
      const door: Side = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? (Math.cos(a) > 0 ? 'w' : 'e') : (Math.sin(a) > 0 ? 'n' : 's');
      house(hx, hz, door);
    }
    for (let i = 0; i < 10; i++) tree(cx + (r() - 0.5) * 34, cz + (r() - 0.5) * 34);
    // gazebo
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) box(cx + dx - 0.2, 0, cz + dz - 0.2, cx + dx + 0.2, 3, cz + dz + 0.2, INK.BROWN, 'wall');
    box(cx - 3.6, 3, cz - 3.6, cx + 3.6, 3.4, cz + 3.6, INK.BROWN, 'floor');
    w.caseSpots.push({ x: cx, y: 0, z: cz });
    // water tower on the edge of the park: legs, a tank to stand on, a golden case for whoever climbs (grapple it)
    const tx = cx + 14, tz = cz - 14;
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) box(tx + dx - 0.25, 0, tz + dz - 0.25, tx + dx + 0.25, 14, tz + dz + 0.25, INK.GRAPHITE, 'wall');
    box(tx - 3, 14, tz - 3, tx + 3, 18, tz + 3, INK.PINK, 'building');
    w.roofs.push({ x0: tx - 3, z0: tz - 3, x1: tx + 3, z1: tz + 3, y: 18 });
    w.caseSpots.push({ x: tx, y: 18, z: tz, golden: true });
    w.pois.push({ name: 'Pencil Park', x: cx, z: cz });
  }

  // ---------- Margin Mart: a strip of shops and a parking lot ----------
  {
    const cx = 152, cz = 15;
    for (let i = 0; i < 4; i++) shell(cx - 6, cz - 34 + i * 17, 13, 14, 1, { fh: 4.5, ink: [INK.PINK, INK.BLUE, INK.GREEN, INK.ORANGE][i], doors: ['w'], bigDoor: 4, cases: 2, roofAccess: i === 1 });
    for (let i = 0; i < 10; i++) if (r() < 0.7) car(cx - 30 + (i % 2) * 8, cz - 30 + Math.floor(i / 2) * 13, false);
    w.pois.push({ name: 'Margin Mart', x: cx - 10, z: cz });
  }

  // ---------- Staple Depot: three big warehouses and containers ----------
  {
    const cx = 108, cz = 118;
    for (let i = 0; i < 3; i++) shell(cx - 40 + i * 28, cz - 8, 22, 15, 1, { fh: 7, ink: INK.GRAPHITE, doors: ['n', 's'], bigDoor: 6, cases: 3, windows: false });
    for (let i = 0; i < 9; i++) {
      const x = cx - 40 + r() * 76, z = cz + 14 + r() * 18, along = r() < 0.5;
      const [l, d] = along ? [6, 2.5] : [2.5, 6];
      if (!free(x, z, x + l, z + d, 0.6)) continue;
      box(x, 0, z, x + l, 2.6, z + d, INK.ORANGE, 'container');
      if (r() < 0.4) box(x, 2.6, z, x + l, 5.2, z + d, INK.RED, 'container');
    }
    w.pois.push({ name: 'Staple Depot', x: cx - 12, z: cz });
  }

  // ---------- Crumple Junk: crushed cars stacked into walls, and a crane ----------
  {
    const cx = -5, cz = 150;
    for (let i = 0; i < 40; i++) {
      const x = cx - 28 + r() * 56, z = cz - 18 + r() * 36, h = 1 + Math.floor(r() * 3);
      if (!free(x, z, x + 3.6, z + 2, 0.8)) continue;
      for (let k = 0; k < h; k++) box(x + (r() - 0.5) * 0.4, k * 1.1, z + (r() - 0.5) * 0.4, x + 3.6, k * 1.1 + 1.1, z + 2, k % 2 ? INK.RED : INK.ORANGE, 'car');
    }
    box(cx + 22, 0, cz - 22, cx + 23.5, 22, cz - 20.5, INK.ORANGE, 'wall');
    box(cx + 8, 22, cz - 22, cx + 30, 23, cz - 20.5, INK.ORANGE, 'floor');
    w.caseSpots.push({ x: cx + 12, y: 23, z: cz - 21.2, golden: true });
    w.pois.push({ name: 'Crumple Junk', x: cx, z: cz });
  }

  // ---------- Eraser Lake: a lake with a house on its island ----------
  {
    const cx = -112, cz = 110;
    w.lakes.push({ x: cx, z: cz, r: 38 });
    shell(cx - 6, cz - 6, 12, 12, 2, { doors: ['s', 'n'], ink: INK.BLUE, cases: 2, roofAccess: true, golden: true });
    for (let i = 0; i < 6; i++) { const a = r() * Math.PI * 2; tree(cx + Math.cos(a) * 44, cz + Math.sin(a) * 44); }
    w.pois.push({ name: 'Eraser Lake', x: cx, z: cz });
  }

  // ---------- Inkwood: a forest with a cabin ----------
  {
    const cx = -165, cz = -5;
    for (let i = 0; i < 45; i++) tree(cx + (r() - 0.5) * 50, cz + (r() - 0.5) * 80);
    shell(cx - 4, cz - 4, 8, 8, 1, { doors: ['e'], ink: INK.BROWN, cases: 2 });
    w.pois.push({ name: 'Inkwood', x: cx, z: cz });
  }

  // ---------- Notebook Fort: a walled fort up on a plateau ----------
  {
    const cx = 0, cz = -150, s = 16, h = 6;
    box(cx - s, 0, cz - s, cx + s, h, cz + s, INK.GREEN, 'building');
    w.roofs.push({ x0: cx - s, z0: cz - s, x1: cx + s, z1: cz + s, y: h });
    const steps = Math.round(h / 0.5);
    for (let i = 0; i < steps; i++) box(cx - 2, 0, cz + s + (steps - i - 1) * 0.6, cx + 2, (i + 1) * 0.5, cz + s + (steps - i) * 0.6, INK.GRAPHITE, 'stair');
    wall(true, cz - s + 1, cx - s + 1, cx + s - 1, h, h + 2.2, [{ a: cx - 3, b: cx - 1, lo: 1, hi: 1.8 }, { a: cx + 1, b: cx + 3, lo: 1, hi: 1.8 }], INK.BROWN);
    wall(false, cx - s + 1, cz - s + 1, cz + s - 1, h, h + 2.2, [{ a: cz - 1, b: cz + 1, lo: 1, hi: 1.8 }], INK.BROWN);
    wall(false, cx + s - 1, cz - s + 1, cz + s - 1, h, h + 2.2, [{ a: cz - 1, b: cz + 1, lo: 1, hi: 1.8 }], INK.BROWN);
    for (const [dx, dz] of [[-s + 1, -s + 1], [s - 3, -s + 1]]) { box(cx + dx, h, cz + dz, cx + dx + 2, h + 6, cz + dz + 2, INK.BROWN, 'building'); }
    w.caseSpots.push({ x: cx, y: h, z: cz }, { x: cx - 8, y: h, z: cz - 8 }, { x: cx + 8, y: h, z: cz + 4, golden: true });
    w.pois.push({ name: 'Notebook Fort', x: cx, z: cz });
  }

  // ---------- Pit Stop: a gas station at the crossroads ----------
  {
    const cx = 62, cz = 62;
    for (const [dx, dz] of [[-6, -4], [6, -4], [-6, 4], [6, 4]]) box(cx + dx - 0.25, 0, cz + dz - 0.25, cx + dx + 0.25, 4.5, cz + dz + 0.25, INK.GRAPHITE, 'wall');
    box(cx - 8, 4.5, cz - 6, cx + 8, 5, cz + 6, INK.RED, 'floor');            // canopy you can stand on
    w.roofs.push({ x0: cx - 8, z0: cz - 6, x1: cx + 8, z1: cz + 6, y: 5 });
    for (const dx of [-3, 3]) box(cx + dx - 0.5, 0, cz - 0.4, cx + dx + 0.5, 1.6, cz + 0.4, INK.ORANGE, 'crate'); // pumps
    shell(cx - 5, cz + 10, 10, 8, 1, { doors: ['n'], ink: INK.GREEN, cases: 2 });
    w.caseSpots.push({ x: cx, y: 5, z: cz });
    w.pois.push({ name: 'Pit Stop', x: cx, z: cz });
  }

  // roads from every named place to the tower (drawn on the ground; billboards along them)
  for (const p of w.pois) {
    if (p.x === 0 && p.z === 0) continue;
    w.roads.push({ x0: p.x, z0: p.z, x1: 0, z1: 0 });
    const t = 0.55, bx = p.x * t, bz = p.z * t, len = Math.hypot(p.x, p.z), nx = -p.z / len, nz = p.x / len;
    const sx = bx + nx * 9, sz = bz + nz * 9;
    if (free(sx - 3, sz - 3, sx + 3, sz + 3, 2)) {
      for (const k of [-2, 2]) box(sx + nx * k - 0.2, 0, sz + nz * k - 0.2, sx + nx * k + 0.2, 4, sz + nz * k + 0.2, INK.BROWN, 'wall');
      const [ax, az] = Math.abs(nx) > Math.abs(nz) ? [3, 0.2] : [0.2, 3];
      box(sx - ax, 4, sz - az, sx + ax, 6.5, sz + az, INK.ORANGE, 'wall');
    }
  }

  // ---------- in between: farmhouses, cover, trees ----------
  for (let i = 0; i < 14; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 20), z = (r() * 2 - 1) * (MAP_HALF - 20);
    if (w.pois.some((p) => Math.hypot(p.x - x, p.z - z) < 55) || !free(x - 8, z - 8, x + 8, z + 8, 3)) continue;
    house(x, z, (['n', 's', 'e', 'w'] as Side[])[Math.floor(r() * 4)]);
  }
  for (let i = 0; i < 160; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 6), z = (r() * 2 - 1) * (MAP_HALF - 6), s = 1.1 + r() * 0.4;
    if (!free(x, z, x + s, z + s, 1.5) || w.lakes.some((l) => Math.hypot(l.x - x, l.z - z) < l.r)) continue;
    crate(x, z, 0, s);
    if (r() < 0.25) crate(x + 0.05, z + 0.05, s, s - 0.1);
  }
  for (let i = 0; i < 70; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 10), z = (r() * 2 - 1) * (MAP_HALF - 10), len = 4 + r() * 5, along = r() < 0.5;
    const [x0, z0, x1, z1] = along ? [x, z, x + len, z + 0.4] : [x, z, x + 0.4, z + len];
    if (!free(x0, z0, x1, z1, 1.5)) continue;
    box(x0, 0, z0, x1, 1.1 + r() * 0.4, z1, INK.GRAPHITE, 'wall');
  }
  for (let i = 0; i < 110; i++) tree((r() * 2 - 1) * (MAP_HALF - 4), (r() * 2 - 1) * (MAP_HALF - 4));
  w.trees = w.trees.filter((t) => Math.abs(t.x) < MAP_HALF - 2 && Math.abs(t.z) < MAP_HALF - 2 && free(t.x - 0.4, t.z - 0.4, t.x + 0.4, t.z + 0.4, 0.8) && !w.lakes.some((l) => Math.hypot(l.x - t.x, l.z - t.z) < l.r - 2));
  for (const t of w.trees) box(t.x - 0.3, 0, t.z - 0.3, t.x + 0.3, t.h * 0.6, t.z + 0.3, INK.BROWN, 'trunk');

  // a few cases out in the open too
  for (let i = 0; i < 26; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 10), z = (r() * 2 - 1) * (MAP_HALF - 10);
    if (free(x - 1, z - 1, x + 1, z + 1, 0.5)) w.caseSpots.push({ x, y: 0, z });
  }
  // floor loot spots: near every case, plus scattered
  for (const c of w.caseSpots) if (r() < 0.6) w.lootSpots.push({ x: c.x + (r() - 0.5) * 3, y: c.y, z: c.z + (r() - 0.5) * 3 });
  for (let i = 0; i < 60; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 8), z = (r() * 2 - 1) * (MAP_HALF - 8);
    if (free(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 0.3)) w.lootSpots.push({ x, y: 0, z });
  }
}
