// The island. A classic battle-royale layout drawn in a notebook: a downtown with the giant
// King's Tower in the middle (the hill, where every match ends), a ring road, and a dozen named
// places around it, each built to play differently: a suburb grid, a castle on a hill, a retail
// strip, a port with a cargo ship and a lighthouse, a factory depot, a junkyard, a lake, a forest
// lodge, farms, a drive-in, a motel stop and a mine with tunnels.
// Buildings are hollow shells: walls with door and window openings, floors with a stairwell, and
// stairs that alternate sides each floor, so every level of everything is reachable on foot.
import { MAP_HALF, type VehicleKind } from './constants.ts';
import { rng } from './rng.ts';
import type { Box, World } from './world.ts';

export const INK = { BLUE: 0, RED: 1, GRAPHITE: 2, ORANGE: 3, GREEN: 4, PINK: 5, BROWN: 6, PAPER: 7 } as const;
export interface Poi { name: string; x: number; z: number }
export interface Spot { x: number; y: number; z: number; golden?: boolean }

type Side = 'n' | 's' | 'e' | 'w';
const SIDES: Side[] = ['n', 's', 'e', 'w'];
const OPP: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };
const T = 0.3;            // wall thickness
const SLAB = 0.25;        // floor thickness
const RISE = 0.5, RUN = 0.6;

interface ShellOpts { doorPos?: number; fh?: number; ink?: number; doors?: Side[]; windows?: boolean; roofAccess?: boolean; bigDoor?: number; cases?: number; golden?: boolean; base?: number; parapet?: boolean }

export function generate(w: World, seed: number) {
  const r = rng(seed);
  const pick = <V>(a: V[]) => a[Math.floor(r() * a.length)];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ink: number, kind: Box['kind']) => {
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01 || z1 - z0 < 0.01) return;
    w.boxes.push({ x0, y0, z0, x1, y1, z1, ink, kind });
  };
  const free = (x0: number, z0: number, x1: number, z1: number, pad = 1.2) =>
    !w.boxes.some((b) => b.y0 < 0.5 && x1 > b.x0 - pad && x0 < b.x1 + pad && z1 > b.z0 - pad && z0 < b.z1 + pad);
  const cases = (...s: Spot[]) => w.caseSpots.push(...s);
  const loot = (x: number, y: number, z: number, n = 1, spread = 2) => { for (let i = 0; i < n; i++) w.lootSpots.push({ x: x + (r() - 0.5) * spread, y, z: z + (r() - 0.5) * spread }); };

  // a wall along x (or z) between `a` and `b` with rectangular openings
  const wall = (alongX: boolean, fixed: number, a: number, b: number, y0: number, y1: number, ops: { a: number; b: number; lo: number; hi: number }[], ink: number, t = T) => {
    const cut = [...ops].sort((p, q) => p.a - q.a);
    let at = a;
    const piece = (p0: number, p1: number, q0: number, q1: number) => alongX ? box(p0, q0, fixed - t / 2, p1, q1, fixed + t / 2, ink, 'wall') : box(fixed - t / 2, q0, p0, fixed + t / 2, q1, p1, ink, 'wall');
    for (const o of cut) {
      piece(at, o.a, y0, y1);
      if (o.lo > 0) piece(o.a, o.b, y0, y0 + o.lo);
      if (y0 + o.hi < y1) piece(o.a, o.b, y0 + o.hi, y1);
      at = o.b;
    }
    piece(at, b, y0, y1);
  };
  // battlements: a low wall with regular gaps (castles, rooftops)
  const crenel = (alongX: boolean, fixed: number, a: number, b: number, y: number, ink: number) => {
    box(alongX ? a : fixed - 0.25, y, alongX ? fixed - 0.25 : a, alongX ? b : fixed + 0.25, y + 1.0, alongX ? fixed + 0.25 : b, ink, 'wall');
    for (let p = a; p + 1 <= b; p += 2) box(alongX ? p : fixed - 0.25, y + 1.0, alongX ? fixed - 0.25 : p, alongX ? p + 1 : fixed + 0.25, y + 1.7, alongX ? fixed + 0.25 : p + 1, ink, 'wall');
  };

  // straight stairs from `y0` up to a platform edge at (ex, ez), height y1; `away` is the direction
  // the flight runs out from the platform
  const stairs = (ex: number, ez: number, y0: number, y1: number, away: Side, wd = 3, ink: number = INK.GRAPHITE) => {
    const n = Math.max(1, Math.round((y1 - y0) / RISE));
    for (let i = 0; i < n; i++) {
      const top = y1 - i * ((y1 - y0) / n), d0 = i * RUN, d1 = (i + 1) * RUN;
      if (away === 'n') box(ex - wd / 2, y0, ez - d1, ex + wd / 2, top, ez - d0, ink, 'stair');
      else if (away === 's') box(ex - wd / 2, y0, ez + d0, ex + wd / 2, top, ez + d1, ink, 'stair');
      else if (away === 'w') box(ex - d1, y0, ez - wd / 2, ex - d0, top, ez + wd / 2, ink, 'stair');
      else box(ex + d0, y0, ez - wd / 2, ex + d1, top, ez + wd / 2, ink, 'stair');
    }
    return n * RUN;
  };

  const shell = (x0: number, z0: number, wd: number, dp: number, floors: number, o: ShellOpts = {}) => {
    const fh = o.fh ?? 3.5, ink = o.ink ?? INK.BLUE, x1 = x0 + wd, z1 = z0 + dp, doors = o.doors ?? ['s'], base = o.base ?? 0;
    const steps = Math.round(fh / RISE), run = 0.55, len = steps * run, dw = o.bigDoor ?? 1.8;
    // a stair strip hugging one wall: c0..c1 across the strip, the run from `start`, hole h0..h1
    const stripGeom = (s: Side) => s === 'w' ? { alongZ: true, c0: x0 + T, c1: x0 + T + 1.4, h0: x0, h1: x0 + T + 1.6, start: z0 + T + 1.2 }
      : s === 'e' ? { alongZ: true, c0: x1 - T - 1.4, c1: x1 - T, h0: x1 - T - 1.6, h1: x1, start: z0 + T + 1.2 }
      : s === 'n' ? { alongZ: false, c0: z0 + T, c1: z0 + T + 1.4, h0: z0, h1: z0 + T + 1.6, start: x0 + T + 1.2 }
      : { alongZ: false, c0: z1 - T - 1.4, c1: z1 - T, h0: z1 - T - 1.6, h1: z1, start: x0 + T + 1.2 };
    const fits = (s: Side) => {
      const g = stripGeom(s), end = g.start + len + 0.9, limit = g.alongZ ? z1 - T : x1 - T;
      if (end > limit) return false;
      if (!doors.includes(s)) return true;
      const mid = g.alongZ ? (z0 + z1) / 2 : (x0 + x1) / 2; // that wall's door, centred
      return mid + dw / 2 + 0.5 < g.start - 0.3 || mid - dw / 2 - 0.5 > end;
    };
    const strip: Side = (['w', 'e', 'n', 's'] as Side[]).find(fits) ?? 'w';
    for (let f = 0; f < floors; f++) {
      const y0 = base + f * fh, y1 = y0 + fh;
      for (const side of SIDES) {
        const alongX = side === 'n' || side === 's';
        const len = alongX ? wd : dp, start = alongX ? x0 : z0;
        const ops: { a: number; b: number; lo: number; hi: number }[] = [];
        const door = f === 0 && doors.includes(side);
        if (door) ops.push({ a: start + len * (o.doorPos ?? 0.5) - dw / 2, b: start + len * (o.doorPos ?? 0.5) + dw / 2, lo: 0, hi: Math.min(fh - 0.4, o.bigDoor ? 5 : 2.5) });
        if (o.windows !== false && len > 6) for (const k of len > 16 ? [0.15, 0.38, 0.62, 0.85] : [0.22, 0.78]) {
          const c = start + len * k;
          if (door && Math.abs(c - (start + len * (o.doorPos ?? 0.5))) < dw + 0.7) continue;
          ops.push({ a: c - 0.7, b: c + 0.7, lo: 1.1, hi: 2.3 });
        }
        const fixed = side === 'n' ? z0 : side === 's' ? z1 : side === 'w' ? x0 : x1;
        wall(alongX, fixed, alongX ? x0 : z0, alongX ? x1 : z1, y0, y1, ops, ink);
      }
      // stairs up from this floor, in a strip along one wall. The ground floor picks a wall whose
      // run (and the landing at its top) stays clear of the doors; floors above alternate with the
      // opposite wall so a flight never stands over the hole you arrive through.
      const last = f === floors - 1, hasHole = !last || o.roofAccess;
      const g = stripGeom(f % 2 === 0 ? strip : OPP[strip]);
      if (hasHole) for (let i = 0; i < steps; i++) {
        const h = y0 + (i + 1) * (fh / steps), a = g.start + i * run, b = a + run;
        if (g.alongZ) box(g.c0, y0, a, g.c1, h, b, INK.GRAPHITE, 'stair'); else box(a, y0, g.c0, b, h, g.c1, INK.GRAPHITE, 'stair');
      }
      // the floor above (or the roof), with a hole over this floor's stairs
      if (!hasHole) box(x0, y1 - SLAB, z0, x1, y1, z1, ink, 'floor');
      else {
        const [hx0, hz0, hx1, hz1] = g.alongZ ? [g.h0, g.start - 0.2, g.h1, g.start + len + 0.2] : [g.start - 0.2, g.h0, g.start + len + 0.2, g.h1];
        box(x0, y1 - SLAB, z0, x1, y1, hz0, ink, 'floor');
        box(x0, y1 - SLAB, hz1, x1, y1, z1, ink, 'floor');
        box(x0, y1 - SLAB, hz0, hx0, y1, hz1, ink, 'floor');
        box(hx1, y1 - SLAB, hz0, x1, y1, hz1, ink, 'floor');
      }
      // pencil cases and floor loot on this floor, clear of the stair strips
      for (let c = 0; c < (o.cases ?? 1); c++) {
        if (r() < 0.3 && !o.golden) continue;
        const cx = x0 + 2.6 + r() * Math.max(0.1, wd - 5.2), cz = z0 + dp * 0.55 + r() * Math.max(0.1, dp * 0.35 - 1);
        cases({ x: cx, y: y0, z: Math.min(cz, z1 - 1) });
      }
      if (wd > 7) loot(x0 + wd / 2, y0, z0 + dp * 0.7, r() < 0.5 ? 2 : 1, Math.min(wd, dp) * 0.4);
    }
    const top = base + floors * fh;
    w.roofs.push({ x0, z0, x1, z1, y: top });
    if (o.parapet && o.roofAccess) {
      crenel(true, z0 + 0.25, x0, x1, top, ink); crenel(true, z1 - 0.25, x0, x1, top, ink);
      crenel(false, x0 + 0.25, z0 + 0.5, z1 - 0.5, top, ink); crenel(false, x1 - 0.25, z0 + 0.5, z1 - 0.5, top, ink);
    }
    if (o.golden) cases({ x: (x0 + x1) / 2, y: top, z: (z0 + z1) / 2 + (o.roofAccess ? 1.5 : 0), golden: true });
    if (o.roofAccess) loot((x0 + x1) / 2, top, (z0 + z1) / 2, 1, 2);
    return top;
  };

  const gable = (x0: number, z0: number, x1: number, z1: number, y: number, h = 2.2) => w.gables.push({ x0: x0 - 0.3, z0: z0 - 0.3, x1: x1 + 0.3, z1: z1 + 0.3, y, h, alongX: x1 - x0 > z1 - z0 });
  const house = (cx: number, cz: number, door: Side, o: { floors?: number; ink?: number; flat?: boolean; wd?: number; dp?: number } = {}) => {
    const wd = o.wd ?? 9 + r() * 3, dp = o.dp ?? 9 + r() * 3, floors = o.floors ?? (r() < 0.6 ? 2 : 1), flat = o.flat ?? r() < 0.25;
    const top = shell(cx - wd / 2, cz - dp / 2, wd, dp, floors, { doors: [door], ink: o.ink ?? INK.BLUE, roofAccess: flat });
    if (!flat) gable(cx - wd / 2, cz - dp / 2, cx + wd / 2, cz + dp / 2, top);
    return { wd, dp, top };
  };
  const fence = (x0: number, z0: number, x1: number, z1: number, gap: Side, ink: number = INK.BROWN) => {
    for (const s of SIDES) {
      const alongX = s === 'n' || s === 's', fixed = s === 'n' ? z0 : s === 's' ? z1 : s === 'w' ? x0 : x1;
      const a = alongX ? x0 : z0, b = alongX ? x1 : z1, m = (a + b) / 2;
      const seg = (p: number, q: number) => box(alongX ? p : fixed - 0.1, 0, alongX ? fixed - 0.1 : p, alongX ? q : fixed + 0.1, 1.0, alongX ? fixed + 0.1 : q, ink, 'wall');
      if (s === gap) { seg(a, m - 1.6); seg(m + 1.6, b); } else seg(a, b);
    }
  };
  const crate = (x: number, z: number, y = 0, s = 1.2, ink: number = INK.ORANGE) => box(x, y, z, x + s, y + s, z + s, ink, 'crate');
  const tree = (x: number, z: number, big = 1) => w.trees.push({ x, z, h: (4 + r() * 4) * big, r: (1.6 + r() * 1.4) * big });
  const car = (x: number, z: number, alongX: boolean, ink: number = pick([INK.RED, INK.BLUE, INK.GREEN, INK.PINK, INK.ORANGE])) => {
    const [l, wd] = alongX ? [4.2, 1.9] : [1.9, 4.2];
    box(x, 0, z, x + l, 1.1, z + wd, ink, 'car');
    const inset = 0.9;
    box(x + (alongX ? inset : 0.2), 1.1, z + (alongX ? 0.2 : inset), x + l - (alongX ? inset + 0.5 : 0.2), 1.8, z + wd - (alongX ? 0.2 : inset + 0.5), ink, 'car');
  };
  const container = (x: number, z: number, alongX: boolean, y = 0, ink: number = pick([INK.ORANGE, INK.RED, INK.BLUE, INK.GREEN])) => {
    const [l, d] = alongX ? [6, 2.5] : [2.5, 6];
    box(x, y, z, x + l, y + 2.6, z + d, ink, 'container');
  };
  const pillar = (x: number, z: number, h: number, s = 0.5, ink: number = INK.GRAPHITE, y0 = 0) => box(x - s / 2, y0, z - s / 2, x + s / 2, h, z + s / 2, ink, 'wall');
  // a flat-topped hill with stairs on the given sides
  const plateau = (cx: number, cz: number, sx: number, sz: number, h: number, ink: number, ups: Side[], base = 0) => {
    box(cx - sx / 2, base, cz - sz / 2, cx + sx / 2, base + h, cz + sz / 2, ink, 'building');
    w.roofs.push({ x0: cx - sx / 2, z0: cz - sz / 2, x1: cx + sx / 2, z1: cz + sz / 2, y: base + h });
    for (const s of ups) {
      if (s === 'n') stairs(cx, cz - sz / 2, base, base + h, 'n', 4);
      if (s === 's') stairs(cx, cz + sz / 2, base, base + h, 's', 4);
      if (s === 'w') stairs(cx - sx / 2, cz, base, base + h, 'w', 4);
      if (s === 'e') stairs(cx + sx / 2, cz, base, base + h, 'e', 4);
    }
  };
  const poi = (name: string, x: number, z: number) => w.pois.push({ name, x, z });
  // heading: 0 faces -z (north), PI/2 faces -x (west), -PI/2 faces +x (east), PI faces +z
  const vehicle = (kind: VehicleKind, x: number, z: number, head: number, y = 0) => w.vehicleSpots.push({ kind, x, y, z, head });
  const N = 0, W = Math.PI / 2, E = -Math.PI / 2, S = Math.PI;

  // =====================================================================================
  // CROWN CITY: downtown around the King's Tower. Tall blocks, a plaza, a clock tower.
  // =====================================================================================
  {
    const s = 34, x0 = -s / 2, z0 = -s / 2;
    shell(x0, z0, s, s, 6, { fh: 4, ink: INK.BLUE, doors: ['n', 's', 'e', 'w'], bigDoor: 3, roofAccess: true, cases: 3, golden: true, parapet: true });
    for (let f = 0; f < 6; f++) { box(-3, f * 4, -3, 3, f * 4 + 1.3, -2.7, INK.GRAPHITE, 'wall'); box(-3, f * 4, 2.7, 3, f * 4 + 1.3, 3, INK.GRAPHITE, 'wall'); }
    // the crown on the roof
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; box(Math.cos(a) * 6 - 0.6, 24, Math.sin(a) * 6 - 0.6, Math.cos(a) * 6 + 0.6, 27.5, Math.sin(a) * 6 + 0.6, INK.ORANGE, 'wall'); }
    poi("King's Tower", 0, 0);
    // six downtown blocks around the plaza, different heights, all climbable to the roof
    const blocks: [number, number, number, number, number, number][] = [
      [-48, -42, 12, 12, 5, INK.PINK], [-48, 30, 12, 13, 3, INK.GRAPHITE], [35, -44, 13, 12, 4, INK.GREEN],
      [36, 30, 12, 12, 6, INK.PINK], [-6, -56, 12, 10, 3, INK.ORANGE], [-6, 44, 12, 10, 4, INK.GREEN],
    ];
    for (const [bx, bz, bw, bd, fl, ink] of blocks) {
      const doors: Side[] = [Math.abs(bx) > Math.abs(bz) ? (bx < 0 ? 'e' : 'w') : (bz < 0 ? 's' : 'n')];
      shell(bx, bz, bw, bd, fl, { fh: 3.5, ink, doors, roofAccess: true, cases: 2, golden: fl >= 6, parapet: true });
    }
    // plaza: a ring of planters, crates for cover, bus shelters
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + 0.26; box(26 * Math.cos(a) - 0.7, 0, 26 * Math.sin(a) - 0.7, 26 * Math.cos(a) + 0.7, 0.9, 26 * Math.sin(a) + 0.7, INK.GREEN, 'wall'); }
    for (const [px, pz] of [[-23, -23], [22, -23], [-23, 22], [22, 22]]) { crate(px, pz, 0, 1.4); crate(px + 1.6, pz, 0, 1.2, INK.BROWN); }
    for (const [x, z] of [[18, -31], [-23, 31]]) { box(x, 2.6, z, x + 5, 2.8, z + 2, INK.RED, 'floor'); pillar(x + 0.3, z + 1, 2.6, 0.3); pillar(x + 4.7, z + 1, 2.6, 0.3); }
    // clock tower on the west side
    const kx = -36, kz = -6;
    shell(kx - 3.5, kz - 3.5, 7, 7, 5, { fh: 3.5, ink: INK.BROWN, doors: ['e'], roofAccess: true, golden: true });
    for (const [dx, dz] of [[-3.5, -3.5], [3, -3.5], [-3.5, 3], [3, 3]]) box(kx + dx, 17.5, kz + dz, kx + dx + 0.5, 20.5, kz + dz + 0.5, INK.BROWN, 'wall');
    box(kx - 4, 20.5, kz - 4, kx + 4, 21, kz + 4, INK.RED, 'floor');
    w.gables.push({ x0: kx - 4, z0: kz - 4, x1: kx + 4, z1: kz + 4, y: 21, h: 3.5, alongX: true });
    // downtown streets: a square around the plaza
    for (const [a, b, c, d] of [[-62, -64, 62, -64], [62, -64, 62, 62], [62, 62, -62, 62], [-62, 62, -62, -64]]) w.roads.push({ x0: a, z0: b, x1: c, z1: d });
  }

  // =====================================================================================
  // SCRIBBLE SUBURBS (NW): a grid of houses with yards, a mansion and a sports park
  // =====================================================================================
  {
    const cx = -130, cz = -130;
    poi('Scribble Suburbs', cx, cz);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const hx = cx + i * 30, hz = cz + j * 30;
      if (i === 0 && j === 0) continue;
      const door: Side = j === -1 ? 's' : j === 1 ? 'n' : i === -1 ? 'e' : 'w';
      if (i === 1 && j === -1) { // the mansion: three floors, battlements on the roof, the golden case up there
        shell(hx - 8, hz - 7, 16, 14, 3, { doors: ['s', 'w'], ink: INK.PINK, cases: 2, roofAccess: true, golden: true, parapet: true });
        fence(hx - 12, hz - 11, hx + 12, hz + 11, 's', INK.PINK);
        continue;
      }
      house(hx, hz, door, { ink: pick([INK.BLUE, INK.GREEN, INK.PINK, INK.ORANGE]) });
      fence(hx - 10.5, hz - 10.5, hx + 10.5, hz + 10.5, door);
      tree(hx + 8, hz - 8, 0.7);
    }
    // the park in the middle: a pitch with two goals, a gazebo, a slide
    for (const dz of [-10, 10]) { pillar(cx - 3, cz + dz, 2.4, 0.25, INK.PAPER); pillar(cx + 3, cz + dz, 2.4, 0.25, INK.PAPER); box(cx - 3.1, 2.4, cz + dz - 0.12, cx + 3.1, 2.65, cz + dz + 0.12, INK.PAPER, 'wall'); }
    for (const [dx, dz] of [[-9, -3], [-5, -3], [-9, 1], [-5, 1]]) pillar(cx + dx, cz + dz, 3, 0.3, INK.BROWN);
    box(cx - 9.6, 3, cz - 3.6, cx - 4.4, 3.35, cz + 1.6, INK.BROWN, 'floor');
    w.gables.push({ x0: cx - 10, z0: cz - 4, x1: cx - 4, z1: cz + 2, y: 3.35, h: 1.6, alongX: true });
    cases({ x: cx - 7, y: 0, z: cz - 1 });
    box(cx + 7.4, 0, cz + 1.4, cx + 8.6, 2.5, cz + 2.6, INK.RED, 'crate');
    stairs(cx + 8, cz + 2.6, 0, 2.5, 's', 1.2, INK.RED);
    loot(cx, 0, cz, 3, 10);
    for (const [a, b, c, d] of [[cx - 45, cz - 15, cx + 45, cz - 15], [cx - 45, cz + 15, cx + 45, cz + 15], [cx - 15, cz - 45, cx - 15, cz + 45], [cx + 15, cz - 45, cx + 15, cz + 45]]) w.roads.push({ x0: a, z0: b, x1: c, z1: d });
  }

  // =====================================================================================
  // CASTLE CRAYON (N): a castle on a two-step hill, towers on every corner, a keep
  // =====================================================================================
  {
    const cx = 0, cz = -160;
    poi('Castle Crayon', cx, cz);
    plateau(cx, cz, 64, 44, 4, INK.GREEN, ['s', 'e', 'w']);
    plateau(cx, cz - 2, 46, 32, 4, INK.GREEN, ['s'], 4);
    const y = 8, x0 = cx - 19, x1 = cx + 19, z0 = cz - 14.5, z1 = cz + 10.5;
    // curtain walls with battlements, a gate on the south, arrow slits east and west
    // the curtain walls run between the corner towers (never through them)
    const tw = 3.5;
    wall(true, z0, x0 + tw, x1 - tw, y, y + 3, [], INK.GRAPHITE, 0.6); crenel(true, z0, x0 + tw, x1 - tw, y + 3, INK.GRAPHITE);
    wall(true, z1, x0 + tw, x1 - tw, y, y + 3, [{ a: cx - 2.5, b: cx + 2.5, lo: 0, hi: 3 }], INK.GRAPHITE, 0.6);
    wall(false, x0, z0 + tw, z1 - tw, y, y + 3, [{ a: cz - 3, b: cz - 1, lo: 1.2, hi: 2.2 }], INK.GRAPHITE, 0.6); crenel(false, x0, z0 + tw, z1 - tw, y + 3, INK.GRAPHITE);
    wall(false, x1, z0 + tw, z1 - tw, y, y + 3, [{ a: cz - 3, b: cz - 1, lo: 1.2, hi: 2.2 }], INK.GRAPHITE, 0.6); crenel(false, x1, z0 + tw, z1 - tw, y + 3, INK.GRAPHITE);
    box(cx - 3.5, y + 3, z1 - 0.5, cx + 3.5, y + 4.5, z1 + 0.5, INK.RED, 'wall'); // gate arch
    // corner towers, each a 3-floor shell with battlements on top
    for (const [tx, tz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) shell(tx - 3.5, tz - 3.5, 7, 7, 3, { base: y, fh: 3.5, ink: INK.GRAPHITE, doors: [tz === z0 ? 's' : 'n'], doorPos: tx === x0 ? 0.8 : 0.2, roofAccess: true, parapet: true, cases: 1 });
    // the keep: three floors, golden case on the roof
    shell(cx - 7, cz - 10, 14, 12, 3, { base: y, fh: 4, ink: INK.PINK, doors: ['s'], roofAccess: true, golden: true, cases: 2, parapet: true });
    for (const dx of [-12, 12]) { crate(cx + dx, cz + 5, y, 1.3, INK.BROWN); crate(cx + dx + 1.5, cz + 5, y, 1.3, INK.BROWN); }
    loot(cx, y, cz + 6, 3, 14);
    // the bailey below the walls: market stalls
    for (let i = 0; i < 4; i++) { const sx = cx - 26 + i * 15; box(sx, 6.6, cz + 16, sx + 4, 6.8, cz + 19, INK.ORANGE, 'floor'); pillar(sx + 0.3, cz + 18.7, 6.6, 0.3, INK.BROWN, 4); pillar(sx + 3.7, cz + 18.7, 6.6, 0.3, INK.BROWN, 4); }
    cases({ x: cx - 24, y: 4, z: cz + 17 }, { x: cx + 26, y: 4, z: cz + 17 });
  }

  // =====================================================================================
  // MARGIN MART (NE): retail row, a supermarket with aisles, a water tower, parking
  // =====================================================================================
  {
    const cx = 128, cz = -120;
    poi('Margin Mart', cx, cz);
    const colors = [INK.PINK, INK.BLUE, INK.GREEN, INK.ORANGE, INK.RED];
    for (let i = 0; i < 5; i++) {
      const sx = cx - 40 + i * 15;
      shell(sx, cz - 18, 13, 12, i % 2 ? 2 : 1, { fh: 4, ink: colors[i], doors: ['s'], bigDoor: 3.5, cases: 2, roofAccess: true });
      box(sx, 3.2, cz - 6, sx + 13, 3.45, cz - 4.6, colors[i], 'floor'); // awning
    }
    // the supermarket across the street, aisles of shelves inside
    const mx = cx - 32, mz = cz + 8;
    shell(mx, mz, 34, 20, 1, { fh: 6, ink: INK.BLUE, doors: ['n'], bigDoor: 6, cases: 4, roofAccess: true });
    for (let i = 0; i < 5; i++) box(mx + 4 + i * 5.5, 0, mz + 6, mx + 5, 1.8, mz + 17, INK.ORANGE, 'wall');
    loot(mx + 17, 0, mz + 12, 4, 16);
    // a water tower with a staircase up a leg, golden case on the tank
    const tx = cx + 34, tz = cz + 14;
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) pillar(tx + dx, tz + dz, 14, 0.5);
    box(tx - 3, 14, tz - 3, tx + 3, 18, tz + 3, INK.PINK, 'building');
    stairs(tx, tz + 3, 0, 18, 's', 1.4, INK.GRAPHITE);
    w.roofs.push({ x0: tx - 3, z0: tz - 3, x1: tx + 3, z1: tz + 3, y: 18 });
    cases({ x: tx, y: 18, z: tz, golden: true });
    // parking lot and lamps
    for (let i = 0; i < 12; i++) if (r() < 0.75) car(cx + 6 + (i % 4) * 6, cz + 4 + Math.floor(i / 4) * 7, false);
    for (let i = 0; i < 4; i++) pillar(cx + 4 + i * 8, cz + 30, 5, 0.25);
    w.roads.push({ x0: cx - 50, z0: cz - 2, x1: cx + 50, z1: cz - 2 });
  }

  // =====================================================================================
  // PAPER PORT (E): docks on the bay, a cargo ship you can board, a lighthouse, cranes
  // =====================================================================================
  {
    const cx = 152, cz = 14;
    poi('Paper Port', cx, cz);
    w.lakes.push({ x: 232, z: cz, r: 66 });
    // piers
    for (const pz of [-30, 0, 30]) { box(pz ? 170 : 160, 0, cz + pz - 3, 197, 0.5, cz + pz + 3, INK.BROWN, 'floor'); for (let k = 0; k < 5; k++) pillar(171 + k * 6, cz + pz + 3.2, 1.4, 0.4, INK.BROWN); }
    // the cargo ship moored at the middle pier: hull, deck, containers, a bridge tower at the stern
    const sx0 = 170, sx1 = 192, sz0 = cz + 4, sz1 = cz + 14;
    box(sx0, 0, sz0, sx1, 5, sz1, INK.RED, 'building');
    box(sx1, 0, sz0 + 1.5, sx1 + 4, 5, sz1 - 1.5, INK.RED, 'building'); // bow
    w.roofs.push({ x0: sx0, z0: sz0, x1: sx1 + 4, z1: sz1, y: 5 });
    box(sx0 + 9, 5, sz1 - 0.3, sx1 + 4, 6, sz1, INK.GRAPHITE, 'wall'); // rail on the sea side
    for (let i = 0; i < 3; i++) { container(sx0 + 11 + i * 3.8, sz0 + 3.5, false, 5); if (i !== 1) container(sx0 + 11 + i * 3.8, sz0 + 3.5, false, 7.6); }
    shell(sx0 + 0.5, sz0 + 1, 7, 8, 2, { base: 5, fh: 3.5, ink: INK.PAPER, doors: ['e'], roofAccess: true, golden: true });
    stairs(sx0 + 10, sz0, 0.5, 5, 'n', 2, INK.BROWN); // gangway up from the pier
    // lighthouse on a rocky point
    const lx = 176, lz = cz - 54;
    plateau(lx, lz, 16, 16, 2, INK.GRAPHITE, ['w']);
    shell(lx - 3.5, lz - 3.5, 7, 7, 7, { base: 2, fh: 3.5, ink: INK.RED, doors: ['w'], roofAccess: true, golden: true, parapet: true });
    // harbour warehouse and two gantry cranes over the quay
    shell(cx - 20, cz - 12, 22, 14, 1, { fh: 7, ink: INK.GRAPHITE, doors: ['e', 'w'], bigDoor: 5, cases: 3, windows: false, roofAccess: true });
    for (const gz of [cz - 26, cz + 30]) {
      for (const dx of [0, 12]) { pillar(cx + dx, gz - 4, 16, 0.8, INK.ORANGE); pillar(cx + dx, gz + 4, 16, 0.8, INK.ORANGE); }
      box(cx - 1, 16, gz - 4.4, cx + 30, 17, gz + 4.4, INK.ORANGE, 'floor'); w.roofs.push({ x0: cx - 1, z0: gz - 4.4, x1: cx + 30, z1: gz + 4.4, y: 17 });
      stairs(cx - 1, gz, 0, 17, 'w', 1.4, INK.ORANGE);
      cases({ x: cx + 22, y: 17, z: gz });
    }
    for (let i = 0; i < 10; i++) { const x = cx - 26 + (i % 5) * 7, z = cz + 17 + Math.floor(i / 5) * 4; if (i % 3) container(x, z, true); if (i % 4 === 0) container(x, z, true, 2.6); }
  }

  // =====================================================================================
  // STAPLE DEPOT (SE): warehouses with catwalks, a glue factory with chimneys, a container yard
  // =====================================================================================
  {
    const cx = 114, cz = 124;
    poi('Staple Depot', cx, cz);
    for (let i = 0; i < 3; i++) {
      const x0 = cx - 44 + i * 28, z0 = cz - 28;
      shell(x0, z0, 22, 15, 1, { fh: 8, ink: INK.GRAPHITE, doors: ['n', 's'], bigDoor: 6, cases: 3, windows: false, roofAccess: true });
      // catwalk along the back wall inside, with its own stairs
      box(x0 + T, 4, z0 + 11, x0 + 22 - T, 4.25, z0 + 15 - T, INK.ORANGE, 'floor');
      stairs(x0 + 17.8, z0 + 11, 0, 4.25, 'n', 1.6, INK.ORANGE);
      cases({ x: x0 + 8, y: 4.25, z: z0 + 13 });
      crate(x0 + 15, z0 + 3, 0, 1.4); crate(x0 + 16.5, z0 + 3, 0, 1.4); crate(x0 + 15.7, z0 + 3, 1.4, 1.3);
    }
    // the factory: two floors, chimneys, tanks joined by a pipe walk
    const fx = cx - 34, fz = cz + 2;
    shell(fx, fz, 30, 18, 2, { fh: 5, ink: INK.BROWN, doors: ['n', 'e'], bigDoor: 4, cases: 3, roofAccess: true });
    for (const dx of [6, 16, 26]) box(fx + dx - 1, 10, fz + 13, fx + dx + 1, 24, fz + 15, INK.RED, 'wall');
    for (const dx of [36, 43]) { box(fx + dx - 2.5, 0, fz + 4, fx + dx + 2.5, 9, fz + 9, INK.PAPER, 'building'); w.roofs.push({ x0: fx + dx - 2.5, z0: fz + 4, x1: fx + dx + 2.5, z1: fz + 9, y: 9 }); }
    box(fx + 30, 8.75, fz + 5.5, fx + 40.5, 9, fz + 7.5, INK.ORANGE, 'floor'); // pipe walk: drop off the roof onto the tanks
    cases({ x: fx + 43, y: 9, z: fz + 6.5, golden: true });
    // container yard: stacks and alleys
    for (let i = 0; i < 16; i++) {
      const x = cx + 14 + (i % 4) * 9, z = cz + 4 + Math.floor(i / 4) * 5.5;
      if (r() < 0.2) continue;
      container(x, z, true);
      if (r() < 0.4) container(x, z, true, 2.6);
    }
  }

  // =====================================================================================
  // CRUMPLE JUNK (S): rows of crushed cars, a crusher, a crane, the scrap office
  // =====================================================================================
  {
    const cx = -4, cz = 162;
    poi('Crumple Junk', cx, cz);
    for (let row = 0; row < 4; row++) for (let k = 0; k < 7; k++) {
      if (r() < 0.25) continue;
      const x = cx - 30 + k * 8.5, z = cz - 20 + row * 9.5, h = 1 + Math.floor(r() * 3);
      for (let q = 0; q < h; q++) box(x + (r() - 0.5) * 0.3, q * 1.1, z + (r() - 0.5) * 0.3, x + 4, q * 1.1 + 1.1, z + 2.1, pick([INK.RED, INK.ORANGE, INK.BLUE, INK.GREEN]), 'car');
    }
    // the crusher: a press on a platform with stairs
    plateau(cx + 34, cz + 2, 10, 8, 3, INK.GRAPHITE, ['w']);
    box(cx + 31, 3, cz - 2, cx + 37, 7, cz - 1.4, INK.RED, 'wall'); box(cx + 31, 7, cz - 2, cx + 37, 8, cz + 6, INK.RED, 'floor');
    cases({ x: cx + 35, y: 3, z: cz + 3 });
    // the crane: a lattice mast you climb inside, a long jib off the top, golden case at the far end
    const kx = cx + 26, kz = cz - 30;
    shell(kx - 3.5, kz - 3.5, 7, 7, 6, { fh: 3.5, ink: INK.ORANGE, doors: ['s'], roofAccess: true, cases: 0 });
    box(kx - 22, 20.75, kz - 1, kx - 3.5, 21, kz + 1, INK.ORANGE, 'floor');
    for (const zz of [kz - 1, kz + 0.8]) box(kx - 22, 21, zz, kx - 3.5, 21.6, zz + 0.2, INK.ORANGE, 'wall');
    w.roofs.push({ x0: kx - 22, z0: kz - 1, x1: kx - 3.5, z1: kz + 1, y: 21 });
    cases({ x: kx - 19, y: 21, z: kz, golden: true });
    // scrap office: a trailer with roof access
    shell(cx - 44, cz - 8, 12, 7, 1, { fh: 3.5, ink: INK.GREEN, doors: ['e'], cases: 2, roofAccess: true });
    loot(cx, 0, cz, 5, 40);
  }

  // =====================================================================================
  // ERASER LAKE (SW): the lake, the lake house on its island, piers and a boathouse
  // =====================================================================================
  {
    const cx = -114, cz = 114;
    poi('Eraser Lake', cx, cz);
    w.lakes.push({ x: cx, z: cz, r: 38 });
    plateau(cx, cz, 24, 24, 0.3, INK.GREEN, []);
    shell(cx - 7, cz - 7, 14, 14, 2, { base: 0.3, doors: ['s', 'n'], ink: INK.BLUE, cases: 2, roofAccess: true, golden: true, parapet: true });
    // piers from the shore toward the island
    for (const [px, pz, alongX] of [[cx + 12, cz, true], [cx - 40, cz, true], [cx, cz + 12, false], [cx, cz - 40, false]] as const) {
      if (alongX) box(px, 0, pz - 1.3, px + 28, 0.3, pz + 1.3, INK.BROWN, 'floor');
      else box(px - 1.3, 0, pz, px + 1.3, 0.3, pz + 28, INK.BROWN, 'floor');
    }
    // boathouse on the north shore
    shell(cx - 6, cz - 52, 12, 9, 1, { fh: 4, ink: INK.BROWN, doors: ['s', 'n'], bigDoor: 4, cases: 2 });
    gable(cx - 6, cz - 52, cx + 6, cz - 43, 4);
    for (let i = 0; i < 12; i++) { const a = r() * Math.PI * 2; tree(cx + Math.cos(a) * (44 + r() * 10), cz + Math.sin(a) * (44 + r() * 10)); }
  }

  // =====================================================================================
  // INKWOOD (W): deep forest, the lookout lodge tower, cabins, a campfire clearing
  // =====================================================================================
  {
    const cx = -170, cz = -8;
    poi('Inkwood', cx, cz);
    shell(cx - 3.5, cz - 3.5, 7, 7, 7, { fh: 3.5, ink: INK.BROWN, doors: ['e'], roofAccess: true, golden: true, parapet: true });
    for (const [dx, dz, door] of [[16, -20, 'w'], [18, 18, 'w'], [-12, 24, 'n']] as const) house(cx + dx, cz + dz, door, { floors: 1, ink: INK.BROWN, wd: 8, dp: 7, flat: false });
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; box(cx + 20 + Math.cos(a) * 3.2 - 0.4, 0, cz + Math.sin(a) * 3.2 - 0.4, cx + 20 + Math.cos(a) * 3.2 + 0.4, 0.5, cz + Math.sin(a) * 3.2 + 0.4, INK.GRAPHITE, 'crate'); }
    cases({ x: cx + 20, y: 0, z: cz + 6 });
    for (let i = 0; i < 80; i++) tree(cx + (r() - 0.5) * 56, cz + (r() - 0.5) * 110, 1.1);
    loot(cx, 0, cz, 4, 40);
  }

  // =====================================================================================
  // TALLY FARMS (mid NW): red barns with haylofts, silos, crop rows, hay bales
  // =====================================================================================
  {
    const cx = -100, cz = -45;
    poi('Tally Farms', cx, cz);
    for (const [bx, bz] of [[-14, -8], [12, 2]]) {
      const x0 = cx + bx - 8, z0 = cz + bz - 6;
      shell(x0, z0, 16, 12, 1, { fh: 6, ink: INK.RED, doors: ['n', 's'], bigDoor: 4, cases: 2, windows: false });
      gable(x0, z0, x0 + 16, z0 + 12, 6, 3.5);
      box(x0 + T, 3, z0 + T, x0 + 5.5, 3.25, z0 + 12 - T, INK.BROWN, 'floor'); // hayloft
      stairs(x0 + 5.5, z0 + 9.5, 0, 3.25, 'e', 1.6, INK.BROWN);
      cases({ x: x0 + 2.8, y: 3.25, z: z0 + 6 });
      crate(x0 + 1.2, z0 + 1.2, 3.25, 1.3, INK.ORANGE);
    }
    // twin silos with stairs inside and a plank between their tops
    for (const sx of [cx + 14, cx + 22]) shell(sx - 3, cz - 20, 6, 6, 3, { fh: 4, ink: INK.GRAPHITE, doors: ['s'], roofAccess: true, windows: false, cases: 0 });
    box(cx + 17, 11.75, cz - 18, cx + 19, 12, cz - 16, INK.BROWN, 'floor');
    cases({ x: cx + 22, y: 12, z: cz - 16.5, golden: true });
    house(cx - 14, cz - 22, 'e', { floors: 2, ink: INK.PAPER, flat: false, wd: 11, dp: 10 });
    // crop rows and hay bales: low cover in the fields
    for (let i = 0; i < 8; i++) box(cx - 26, 0, cz + 6 + i * 2.6, cx - 10, 0.7, cz + 6.8 + i * 2.6, INK.GREEN, 'wall');
    for (let i = 0; i < 7; i++) box(cx + 4, 0, cz + 12 + i * 2.4, cx + 24, 0.7, cz + 12.8 + i * 2.4, INK.GREEN, 'wall');
    for (let i = 0; i < 12; i++) { const x = cx - 27 + r() * 54, z = cz - 27 + r() * 54; if (free(x, z, x + 1.8, z + 1.8, 1)) box(x, 0, z, x + 1.8, 1.4, z + 1.8, INK.ORANGE, 'crate'); }
    fence(cx - 30, cz - 30, cx + 30, cz + 30, 'e');
  }

  // =====================================================================================
  // DOODLE DRIVE-IN (mid NE): a giant screen with a walkway on top, rows of parked cars
  // =====================================================================================
  {
    const cx = 74, cz = -62;
    poi('Doodle Drive-In', cx, cz);
    box(cx - 16, 3, cz - 20, cx + 16, 15, cz - 19.4, INK.BLUE, 'wall');
    box(cx - 16.4, 2.6, cz - 19.4, cx + 16.4, 3, cz - 19, INK.RED, 'wall'); box(cx - 16.4, 15, cz - 19.4, cx + 16.4, 15.4, cz - 19, INK.RED, 'wall');
    for (const dx of [-15, -5, 5, 15]) pillar(cx + dx, cz - 18.7, 15, 0.6, INK.GRAPHITE);
    box(cx - 16, 15, cz - 21, cx + 16, 15.25, cz - 18, INK.GRAPHITE, 'floor');
    w.roofs.push({ x0: cx - 16, z0: cz - 21, x1: cx + 16, z1: cz - 18, y: 15.25 });
    cases({ x: cx, y: 15.25, z: cz - 19.5, golden: true });
    stairs(cx + 16, cz - 19.5, 0, 15.25, 'e', 1.6, INK.GRAPHITE);
    for (let row = 0; row < 3; row++) for (let k = 0; k < 7; k++) if (r() < 0.8) car(cx - 18 + k * 5.5, cz - 8 + row * 9, false);
    // snack bar with the projector booth upstairs
    shell(cx - 7, cz + 22, 14, 9, 2, { fh: 3.5, ink: INK.PINK, doors: ['n'], cases: 2, roofAccess: true });
    loot(cx, 0, cz, 4, 30);
  }

  // =====================================================================================
  // PIT STOP (mid SE): gas station, a diner and a two-storey motel with an outside walkway
  // =====================================================================================
  {
    const cx = 64, cz = 66;
    poi('Pit Stop', cx, cz);
    for (const [dx, dz] of [[-6, -4], [6, -4], [-6, 4], [6, 4]]) pillar(cx + dx, cz + dz, 4.5, 0.5);
    box(cx - 8, 4.5, cz - 6, cx + 8, 5, cz + 6, INK.RED, 'floor');
    w.roofs.push({ x0: cx - 8, z0: cz - 6, x1: cx + 8, z1: cz + 6, y: 5 });
    for (const dx of [-3, 3]) box(cx + dx - 0.5, 0, cz - 0.4, cx + dx + 0.5, 1.6, cz + 0.4, INK.ORANGE, 'crate');
    cases({ x: cx, y: 5, z: cz + 2 });
    stairs(cx + 8, cz, 0, 5, 'e', 1.4, INK.GRAPHITE); // up onto the canopy
    shell(cx - 24, cz - 4, 12, 9, 1, { doors: ['e'], ink: INK.GREEN, cases: 2, roofAccess: true }); // diner
    // motel: long two-floor block; the upstairs walkway runs along the front, stairs at the end
    const mx = cx - 6, mz = cz + 16;
    shell(mx, mz, 26, 8, 2, { fh: 3.5, ink: INK.ORANGE, doors: ['n'], cases: 3, roofAccess: true });
    box(mx, 3.25, mz - 2, mx + 26, 3.5, mz, INK.BROWN, 'floor');
    stairs(mx + 26, mz - 1, 0, 3.5, 'e', 2, INK.BROWN);
    for (let i = 0; i < 4; i++) car(mx + 2 + i * 6, mz - 10, false);
  }

  // =====================================================================================
  // GRAPHITE MINE (mid W): a hill with tunnels running through it, the mine head on top
  // =====================================================================================
  {
    const cx = -86, cz = 16, sx = 36, sz = 30, h = 7, cw = 4, ch = 3.4;
    poi('Graphite Mine', cx, cz);
    const xs = [cx - sx / 2, cx - cw / 2, cx + cw / 2, cx + sx / 2], zs = [cz - sz / 2, cz - cw / 2, cz + cw / 2, cz + sz / 2];
    // four rock blocks around two crossing tunnels, rock over each tunnel
    for (const [a, b] of [[0, 2], [2, 0], [0, 0], [2, 2]]) box(xs[a], 0, zs[b], xs[a + 1], h, zs[b + 1], INK.GRAPHITE, 'building');
    box(xs[1], ch, zs[0], xs[2], h, zs[3], INK.GRAPHITE, 'building');
    box(xs[0], ch, zs[1], xs[3], h, zs[2], INK.GRAPHITE, 'building');
    w.roofs.push({ x0: xs[0], z0: zs[0], x1: xs[3], z1: zs[3], y: h });
    stairs(cx + 10, cz - sz / 2, 0, h, 'n', 3);
    stairs(cx + sx / 2, cz + 9, 0, h, 'e', 3);
    // inside the tunnels: carts, cases, the golden one at the crossing
    cases({ x: cx, y: 0, z: cz, golden: true }, { x: cx - 13, y: 0, z: cz }, { x: cx, y: 0, z: cz + 11 });
    box(cx + 7, 0, cz - 1.2, cx + 9, 1.1, cz + 0.6, INK.BROWN, 'crate'); box(cx - 1, 0, cz - 10, cx + 0.8, 1.1, cz - 8, INK.BROWN, 'crate');
    loot(cx - 7, 0, cz, 2, 1.5); loot(cx, 0, cz - 6, 2, 1.5); loot(cx + 12, 0, cz, 1, 1.5);
    // the mine head on top: a frame tower and a shack
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) pillar(cx + 8 + dx, cz - 6 + dz, h + 9, 0.5, INK.BROWN, h);
    box(cx + 5.5, h + 9, cz - 8.5, cx + 10.5, h + 9.3, cz - 3.5, INK.BROWN, 'floor');
    shell(cx - 12, cz - 11, 8, 7, 1, { base: h, fh: 3, ink: INK.BROWN, doors: ['s'], cases: 1 });
  }

  // =====================================================================================
  // PAPER PLANE FIELD (S W): a runway, a hangar, a control tower and the planes
  // =====================================================================================
  {
    const cx = -62, cz = 180;
    poi('Paper Plane Field', cx, cz);
    w.roads.push({ x0: -104, z0: 189, x1: -18, z1: 189 }, { x0: -104, z0: 189, x1: -104, z1: 172 });
    shell(-118, 160, 22, 15, 1, { fh: 7, ink: INK.GRAPHITE, doors: ['s', 'e'], bigDoor: 8, cases: 3, roofAccess: true });
    gable(-118, 160, -96, 175, 7, 2.5);
    shell(cx - 6, 164, 7, 7, 4, { fh: 3.5, ink: INK.PAPER, doors: ['s'], roofAccess: true, golden: true, parapet: true });
    for (const [x, z] of [[-80, 168], [-40, 168], [-30, 168]]) { box(x, 0, z, x + 1.5, 1.5, z + 1.5, INK.ORANGE, 'crate'); }
    for (let i = 0; i < 12; i++) box(-100 + i * 7, 0, 184.4, -98.5 + i * 7, 0.15, 184.8, INK.PAPER, 'floor'); // runway marks
    vehicle('plane', -96, 189, E); vehicle('plane', -84, 189, E); vehicle('plane', -107, 167, S);
    vehicle('car', -88, 178, E);
  }

  // ---------- vehicles everywhere else: cars on the roads, helicopters on rooftops ----------
  for (const [x, z, h] of [[62, -20, N], [-62, 20, S], [20, 62, W], [-20, -64, E], [62, 40, N], [-62, -40, S]] as const) vehicle('car', x, z, h);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + 0.2; vehicle('car', Math.cos(a) * 100, Math.sin(a) * 100, -a); }
  vehicle('car', -145, -105, N); vehicle('car', -115, -155, E);         // suburbs
  vehicle('car', 84, -122, E); vehicle('car', 175, -122, W);           // margin mart
  vehicle('car', 96, -50, N);                                          // drive-in
  vehicle('car', 80, 54, W); vehicle('car', 44, 80, N);                // pit stop
  vehicle('car', -78, -40, N);                                         // farms
  vehicle('car', 126, -4, S); vehicle('car', 64, 104, E);              // port, depot
  vehicle('car', -40, 132, E); vehicle('car', -60, 30, N);              // junk, mine
  vehicle('car', 0, -128, N);                                          // castle road
  vehicle('heli', -10, 10, N, 24);                                     // on the King's Tower
  vehicle('heli', 141, 6, W, 7);                                       // port warehouse roof
  vehicle('heli', 5, -153, S, 8);                                      // castle courtyard
  vehicle('heli', 95, 135, N, 10);                                     // factory roof

  // =====================================================================================
  // roads: a ring road, spokes into downtown, and a road out to every place
  // =====================================================================================
  const RING = 100, SEG = 24;
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
    w.roads.push({ x0: Math.cos(a0) * RING, z0: Math.sin(a0) * RING, x1: Math.cos(a1) * RING, z1: Math.sin(a1) * RING });
  }
  for (const [x, z] of [[62, 0], [-62, 0], [0, 62], [0, -64]]) w.roads.push({ x0: x, z0: z, x1: (Math.sign(x) || 0) * RING, z1: (Math.sign(z) || 0) * RING });
  for (const p of w.pois) {
    const d = Math.hypot(p.x, p.z);
    if (d < 70) continue;
    const ex = (p.x / d) * RING, ez = (p.z / d) * RING;
    w.roads.push({ x0: p.x, z0: p.z, x1: ex, z1: ez });
    // a billboard by the road
    const bx = (ex + p.x) / 2, bz = (ez + p.z) / 2, nx = -p.z / d, nz = p.x / d, sx = bx + nx * 9, sz = bz + nz * 9;
    if (Math.abs(d - RING) > 24 && free(sx - 3.5, sz - 3.5, sx + 3.5, sz + 3.5, 2)) {
      for (const k of [-2, 2]) box(sx + nx * k - 0.2, 0, sz + nz * k - 0.2, sx + nx * k + 0.2, 4, sz + nz * k + 0.2, INK.BROWN, 'wall');
      const [ax, az] = Math.abs(nx) > Math.abs(nz) ? [3, 0.2] : [0.2, 3];
      box(sx - ax, 4, sz - az, sx + ax, 6.5, sz + az, pick([INK.ORANGE, INK.PINK, INK.GREEN]), 'wall');
    }
  }

  // =====================================================================================
  // the wild in between: lone farmhouses, boulders, cover walls, crates, trees
  // =====================================================================================
  const nearPoi = (x: number, z: number, d: number) => w.pois.some((p) => Math.hypot(p.x - x, p.z - z) < (p.x === 0 && p.z === 0 ? 72 : d));
  const inLake = (x: number, z: number, pad = 0) => w.lakes.some((l) => Math.hypot(l.x - x, l.z - z) < l.r + pad);
  for (let i = 0; i < 18; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 22), z = (r() * 2 - 1) * (MAP_HALF - 22);
    if (nearPoi(x, z, 60) || inLake(x, z, 8) || !free(x - 9, z - 9, x + 9, z + 9, 3)) continue;
    house(x, z, pick(SIDES), { ink: pick([INK.BLUE, INK.GREEN, INK.PAPER]) });
    if (r() < 0.5) cases({ x: x + 8, y: 0, z: z + 8 });
  }
  for (let i = 0; i < 45; i++) { // boulders: stacked graphite blocks
    const x = (r() * 2 - 1) * (MAP_HALF - 8), z = (r() * 2 - 1) * (MAP_HALF - 8), s = 2 + r() * 3;
    if (nearPoi(x, z, 45) || inLake(x, z, 2) || !free(x, z, x + s, z + s, 2)) continue;
    box(x, 0, z, x + s, s * 0.7, z + s * 0.9, INK.GRAPHITE, 'crate');
    if (r() < 0.5) box(x + s * 0.2, s * 0.7, z + s * 0.15, x + s * 0.8, s * 1.1, z + s * 0.7, INK.GRAPHITE, 'crate');
  }
  for (let i = 0; i < 150; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 6), z = (r() * 2 - 1) * (MAP_HALF - 6), s = 1.1 + r() * 0.4;
    if (nearPoi(x, z, 30) || inLake(x, z) || !free(x, z, x + s, z + s, 1.5)) continue;
    crate(x, z, 0, s);
    if (r() < 0.25) crate(x + 0.05, z + 0.05, s, s - 0.1);
  }
  for (let i = 0; i < 70; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 10), z = (r() * 2 - 1) * (MAP_HALF - 10), len = 4 + r() * 5, along = r() < 0.5;
    const [x0, z0, x1, z1] = along ? [x, z, x + len, z + 0.4] : [x, z, x + 0.4, z + len];
    if (nearPoi(x, z, 30) || inLake(x, z) || !free(x0, z0, x1, z1, 1.5)) continue;
    box(x0, 0, z0, x1, 1.1 + r() * 0.4, z1, INK.GRAPHITE, 'wall');
  }
  for (let i = 0; i < 150; i++) { const x = (r() * 2 - 1) * (MAP_HALF - 4), z = (r() * 2 - 1) * (MAP_HALF - 4); if (!nearPoi(x, z, 42)) tree(x, z); }
  w.trees = w.trees.filter((t) => Math.abs(t.x) < MAP_HALF - 2 && Math.abs(t.z) < MAP_HALF - 2 && free(t.x - 0.4, t.z - 0.4, t.x + 0.4, t.z + 0.4, 0.8) && !inLake(t.x, t.z, -2));
  for (const t of w.trees) box(t.x - 0.3, 0, t.z - 0.3, t.x + 0.3, t.h * 0.6, t.z + 0.3, INK.BROWN, 'trunk');

  // cases and loot out in the open, away from water
  for (let i = 0; i < 30; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 10), z = (r() * 2 - 1) * (MAP_HALF - 10);
    if (!inLake(x, z, 2) && free(x - 1, z - 1, x + 1, z + 1, 0.5)) cases({ x, y: 0, z });
  }
  for (const c of [...w.caseSpots]) if (r() < 0.5) loot(c.x, c.y, c.z, 1, 3);
  for (let i = 0; i < 70; i++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 8), z = (r() * 2 - 1) * (MAP_HALF - 8);
    if (!inLake(x, z) && free(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 0.3)) w.lootSpots.push({ x, y: 0, z });
  }

  // last pass: props (parked cars, crates, containers) never cut into a building, wall, floor or
  // stairs; any that would are left out, so no doorway, stairwell or room is ever plugged
  const STRUCT = new Set<Box['kind']>(['wall', 'stair', 'floor', 'building']);
  const PROP = new Set<Box['kind']>(['car', 'crate', 'container']);
  const structural = w.boxes.filter((b) => STRUCT.has(b.kind));
  const cuts = (p: Box) => structural.some((b) => p.x0 < b.x1 - 0.05 && p.x1 > b.x0 + 0.05 && p.y0 < b.y1 - 0.05 && p.y1 > b.y0 + 0.05 && p.z0 < b.z1 - 0.05 && p.z1 > b.z0 + 0.05);
  w.boxes = w.boxes.filter((b) => !PROP.has(b.kind) || !cuts(b));
}
