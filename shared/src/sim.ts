// King of the Hill Royale simulation: first person, 3D, up to 100 players. Authoritative on the
// server, mirrored in the offline demo. Deterministic for a seed; no timers, no I/O.
// Loot comes from the floor and from pencil cases; the fallen drop everything they carried.
import {
  EYE_H, FORT, GRAVITY, GRENADE, HEADSHOT_MULT, HEAD_R, HEAD_Y, INTERACT_R, ITEMS, JUMP_V, NUKE, PAD, PERKS,
  PLAYER_HP, PLAYER_R, REWIND_MAX_TICKS, RING_DPS_START, RING_HURRY, RING_PHASES, RING_START_R, SHIELD_MAX, SLOTS, SMOKE,
  SPRINT_SPEED, WALK_SPEED, WEAPONS, WEAPON_IDS, type ItemId, type PerkId, type Rarity, type WeaponId,
  AMMO, AMMO_IDS, type AmmoId, AIR_CRASH, AXE, BOMB, BURST_GAP, BUS, GUIDED, SPELL, BUILD, C4, CRASH, KNOCK, BLAST_WORLD, MATERIAL, WRECK_BUDGET, HELI_GUN, MAP_HALF, TANK, TANK_MG, covered, isAir, MISSILE, MOLOTOV, PLANE_GUN, RAM, ROCKET, SHOCK, SUPPLY, UPGRADE, VEHICLES, VEHICLE_KINDS, VEH_BOOM, type VehicleKind,
} from './constants.ts';
import { moveVehicle, tankAim } from './vehicles.ts';
import { rng } from './rng.ts';
import { INK, World, moveBody, newBody, rayBox, type Body, type Box, type Structure } from './world.ts';

export { rng };

export type LootKind = 'weapon' | 'item' | 'perk' | 'ammo';
export interface Loot { id: number; x: number; y: number; z: number; kind: LootKind; what: string; n: number; mag?: number; up?: number }
export interface Case { id: number; x: number; y: number; z: number; golden: boolean; open: boolean; supply?: boolean }
export interface Projectile { id: number; kind: 'grenade' | 'smoke' | 'c4' | 'bomb' | 'rocket' | 'missile' | 'guided' | 'spell' | 'molotov' | 'shock'; stuck?: boolean; tgt?: number; dmg?: number; r?: number; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }
export interface Effect { id: number; kind: 'smoke' | 'pad' | 'nuke' | 'drop' | 'fire'; owner: number; x: number; y: number; z: number; t: number }
// a vehicle: its own body (the physics state while nobody drives), hp, who is in it
export interface Vehicle { id: number; kind: VehicleKind; hp: number; driver: number; last: number; body: Body; gunCd: number; bombCd: number; seats: number[] }
export interface Build { id: number; owner: number; idx: number[]; boxes: Box[]; t: number }

export interface PlayerState extends Body {
  id: number; yaw: number; pitch: number; hp: number; shield: number; alive: boolean;
  slots: (WeaponId | null)[]; mags: number[]; cur: number; ups: number[]; // upgrade level per slot
  ammo: Record<AmmoId, number>; // reserve ammo by type: what reloads take from
  items: Record<ItemId, number>; perk: { kind: PerkId; n: number } | null;
  use: { item: ItemId; t: number } | null;
  reloadT: number; fireCd: number; spin: number; burstLeft: number; burstT: number;
  kills: number; ack: number; team: number; rideV: number; // id of the vehicle you are in, 0 on foot
  downBy: number | null; reviveT: number; reviver: number; // knocked: who did it, revive progress, by whom
  axe: boolean; axeCd: number; mats: number; // axe out (instead of a gun), its swing cooldown, building material
  tp: boolean; // playing in third person: aims down the shoulder camera's ray (aimFrom)
  hitBy?: number; // who hit us last (the bots answer that one)
}
export interface Input {
  seq: number; fwd: number; strafe: number; yaw: number; pitch: number;
  jump: boolean; sprint: boolean; slide: boolean; grapple: boolean;
  fire: boolean; aim: boolean; reload: boolean; slot: number; view: number;
  interact: boolean; item: number; perk: boolean; // item: 1 = best shield, 2 = medkit, 3 = mini shield, 4 = shield potion (the item wheel)
  up: number; // helicopter climb (+1) / descend (-1)
  hold: boolean; // E held down: reviving a knocked teammate
  tp?: boolean; // third-person camera (aimFrom); bots and old clients aim from the eye
}
// per player this tick: one input, several (catching up), none (late: the body waits), or no entry (idle)
export type TickInputs = Map<number, Input | Input[]>;
export interface Ring { x: number; y: number; r: number; nx: number; ny: number; nr: number; phase: number; closing: boolean; dps: number; nextAt: number }
export interface Shot { ox: number; oy: number; oz: number; ex: number; ey: number; ez: number; by: number; hit: boolean }
export type ElimCause = 'shot' | 'ring' | 'left' | 'boom' | 'ram';
export type SimEvent =
  | { kind: 'knock'; victim: number; by: number | null; head: boolean }
  // the world changed: blocks broken off / placed (append in order), boxes gone, buildings coming down
  | { kind: 'wreck'; add: Box[]; kill: number[]; falls: { sid: number; x: number; y: number; z: number }[]; drop?: number[] } // drop: loose pieces that fall (also in kill)
  | { kind: 'chop'; by: number; x: number; y: number; z: number; broke: boolean; left?: number; b?: number[] } // left: the block's health left (0-1), b: its bounds
  | { kind: 'revive'; victim: number; by: number }
  | { kind: 'hit'; victim: number; by: number; dmg: number; head: boolean; shield: boolean; broke: boolean }
  | { kind: 'elim'; victim: number; by: number | null; cause: ElimCause; head: boolean }
  | { kind: 'boom'; x: number; y: number; z: number; r: number; nuke: boolean }
  | { kind: 'zap'; x: number; y: number; z: number } // a spell went off (no blast)
  | { kind: 'slash'; by: number; hit: boolean }     // a blade swung
  | { kind: 'build'; id: number; boxes: Box[] }
  | { kind: 'unbuild'; id: number }
  | { kind: 'nuke'; x: number; z: number; by: number; at: number }
  | { kind: 'open'; caseId: number; by: number; golden: boolean }
  | { kind: 'vhit'; vehicle: number; by: number; dmg: number }
  | { kind: 'drop'; x: number; z: number; landed: boolean }
  | { kind: 'upgrade'; by: number; level: number };

export const emptyInput = (): Input => ({ seq: 0, fwd: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false, slide: false, grapple: false, fire: false, aim: false, reload: false, slot: 0, view: 0, interact: false, item: 0, perk: false, up: 0, hold: false, tp: false });

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// inputs come from the network: never trust shape or range
export function sanitizeInput(raw: Partial<Input> | undefined): Input {
  return {
    seq: Math.floor(finite(raw?.seq)), fwd: clamp(finite(raw?.fwd), -1, 1), strafe: clamp(finite(raw?.strafe), -1, 1),
    yaw: finite(raw?.yaw), pitch: clamp(finite(raw?.pitch), -1.5, 1.5),
    jump: raw?.jump === true, sprint: raw?.sprint === true, slide: raw?.slide === true, grapple: raw?.grapple === true,
    fire: raw?.fire === true, aim: raw?.aim === true, reload: raw?.reload === true,
    slot: clamp(Math.floor(finite(raw?.slot)), 0, SLOTS + 1), view: Math.floor(finite(raw?.view)), // slot SLOTS + 1 = the axe
    interact: raw?.interact === true, item: clamp(Math.floor(finite(raw?.item)), 0, 4), perk: raw?.perk === true,
    up: clamp(finite(raw?.up), -1, 1), hold: raw?.hold === true, tp: raw?.tp === true,
  };
}

// one tick of movement for a player: on foot, or driving / flying. Returns the crash speed, if any.
export const moveStep = (w: World, p: Body, inp: Input, dt: number, using = false): number => {
  if (p.bus) { // aboard the paper plane: it carries you (Sim.stepBus, by the clock) until you jump out
    if (inp.jump || inp.interact) leaveBus(p);
    return 0;
  }
  if (p.seat) return 0; // passengers go wherever the vehicle takes them (set by the server)
  if (p.ride) return moveVehicle(w, p, inp, dt, GRAVITY);
  if (p.down > 0) { // crawling: no glider, pad launch, dash or hook (they all beat the crawl speed several times over)
    p.gliding = false; p.launchT = 0; p.dashT = 0; p.hook = false;
    moveBody(w, p, { ...inp, jump: false, sprint: false, slide: false, grapple: false }, dt, GRAVITY, KNOCK.crawl, KNOCK.crawl, 0); return 0;
  }
  moveBody(w, p, { ...inp, sprint: inp.sprint && !inp.aim && !using }, dt, GRAVITY, inp.aim || using ? WALK_SPEED * 0.55 : WALK_SPEED, SPRINT_SPEED, JUMP_V);
  return 0;
};
const NO_INPUT: Input = emptyInput();

// out of the paper plane (you jumped, or the far edge threw you out): you keep a little of its speed and
// free fall, the glider shut until you open it (moveBody)
export function leaveBus(p: Body) { p.bus = 0; p.gliding = true; p.fall = 1; p.vx *= BUS.exit; p.vz *= BUS.exit; p.vy = 0; }

// the paper plane's line for a match: straight across the island near the middle, from a random side, clear
// of anything that reaches its height (The Needle). A function of the seed alone, so the waiting room draws
// it before the match starts
export function busLine(w: World): { x: number; z: number; dx: number; dz: number } {
  const r = rng(w.seed ^ 0x6b75b05), tall = w.structures.filter((s) => s.y1 > BUS.y - 8);
  let best = { x: 0, z: 0, dx: 1, dz: 0 }, clear = -1;
  for (let k = 0; k < 24 && clear < 30; k++) {
    const a = r() * Math.PI * 2, off = (r() - 0.5) * 2 * BUS.offset, dx = Math.cos(a), dz = Math.sin(a);
    // the closest any tall thing comes to the line (from its edge)
    let near = Infinity;
    for (const s of tall) near = Math.min(near, Math.abs(-dz * ((s.x0 + s.x1) / 2) + dx * ((s.z0 + s.z1) / 2) - off) - Math.hypot(s.x1 - s.x0, s.z1 - s.z0) / 2);
    if (near > clear) { clear = near; best = { x: -dz * off - dx * BUS.len / 2, z: dx * off - dz * BUS.len / 2, dx, dz }; }
  }
  return best;
}

// accuracy: aiming tightens it, moving and being airborne loosen it (a shotgun's cone barely: it is
// the gun you fire on the move, at someone in your face)
export function spreadFor(p: Body, w: WeaponId, aim: boolean): number {
  const base = WEAPONS[w].spread, speed = Math.hypot(p.vx, p.vz), shotgun = WEAPONS[w].pellets > 1;
  const scoped = WEAPONS[w].sight === 'scope';
  let s = base * (aim ? (scoped ? 0.02 : shotgun ? 0.8 : 0.5) : 1) * (1 + speed / (shotgun ? 30 : 8));
  if (!p.grounded) s *= shotgun ? 1.25 : 2;
  return s;
}
// a shotgun pellet's damage over distance: full out to 30% of its range, then down to a third
export const pelletFall = (t: number, range: number) => clamp(1.3 - t / range, 0.35, 1);

// Third person: the camera rides over the right shoulder (TP) and the crosshair is its ray. Everything you
// aim (shots, rockets, the pickaxe, blocks you place) starts on that ray, at the point of it level with your
// eye, so what's under the crosshair is what you hit, and a rocket flies straight down the middle of the
// screen. (From the eye, parallel to the camera, it all landed 0.6 m left of the crosshair.) The shoulder
// point is never behind you or through a wall: with one in the way, it's the eye again. The client puts
// its camera on this same ray (pulled in along it, never off it, when a wall is behind you).
export const TP = { side: 0.75, up: 0.5, back: 3.4, aimBack: 2.0 };
export function aimFrom(w: World, x: number, y: number, z: number, yaw: number, pitch: number, tp: boolean): [number, number, number] {
  const ey = y + EYE_H;
  if (!tp) return [x, ey, z];
  const sp = Math.sin(pitch), cp = Math.cos(pitch), fx = -Math.sin(yaw) * cp, fz = -Math.cos(yaw) * cp;
  // eye + right * side + up * (Y - forward * forward.y): the camera ray's closest point to the eye
  const ox = Math.cos(yaw) * TP.side - fx * sp * TP.up, oy = TP.up * (1 - sp * sp), oz = -Math.sin(yaw) * TP.side - fz * sp * TP.up;
  const len = Math.hypot(ox, oy, oz);
  if (w.raycast(x, ey, z, ox / len, oy / len, oz / len, len + 0.15) < len + 0.15) return [x, ey, z];
  return [x + ox, ey + oy, z + oz];
}

// ---------------- loot tables ----------------
const BY_RARITY: Record<Rarity, WeaponId[]> = { common: [], uncommon: [], rare: [], epic: [], legendary: [] };
for (const id of WEAPON_IDS) BY_RARITY[WEAPONS[id].rarity].push(id);
function weighted<T extends string>(r: () => number, table: [T, number][]): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [k, w] of table) { if (x < w) return k; x -= w; }
  return table[0][0];
}
const FLOOR_RARITY: [Rarity, number][] = [['common', 50], ['uncommon', 30], ['rare', 15], ['epic', 4.5], ['legendary', 0.5]];
const CASE_RARITY: [Rarity, number][] = [['common', 34], ['uncommon', 34], ['rare', 21], ['epic', 9], ['legendary', 2]];
const GOLD_RARITY: [Rarity, number][] = [['epic', 55], ['legendary', 45]];
const ITEM_TABLE: [ItemId, number][] = [['mini', 50], ['big', 25], ['med', 25]];
// loose ammo boxes: mostly what the common guns take
const AMMO_TABLE: [AmmoId, number][] = [['light', 32], ['medium', 30], ['shells', 24], ['heavy', 8], ['rockets', 6]];
const PERK_TABLE: [PerkId, number][] = [['grenade', 30], ['molotov', 22], ['shock', 14], ['smoke', 14], ['launch', 14], ['fort', 11], ['kit', 12], ['c4', 12]];

// ray vs player hitboxes (vertical cylinder body + head sphere); returns {t, head} or null
export function rayPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, px: number, py: number, pz: number): { t: number; head: boolean } | null {
  let best: { t: number; head: boolean } | null = null;
  const hx = ox - px, hy = oy - (py + HEAD_Y), hz = oz - pz;
  const b = hx * dx + hy * dy + hz * dz, c = hx * hx + hy * hy + hz * hz - HEAD_R * HEAD_R, disc = b * b - c;
  if (disc >= 0) { const t = -b - Math.sqrt(disc); if (t >= 0) best = { t, head: true }; }
  const fx = ox - px, fz = oz - pz, a2 = dx * dx + dz * dz;
  if (a2 > 1e-9) {
    const br = fx * dx + fz * dz, cr = fx * fx + fz * fz - (PLAYER_R + 0.05) ** 2, dr = br * br - a2 * cr;
    if (dr >= 0) {
      // the stretch of the ray inside the body's cylinder, cut to the body's height: a ray coming down
      // steeply (an axe swung up close, a shot from above) enters over the shoulders and still goes
      // through the chest (only the entry point was checked, so those all missed)
      const sq = Math.sqrt(dr), top = py + HEAD_Y - HEAD_R;
      let t0 = (-br - sq) / a2, t1 = (-br + sq) / a2;
      if (Math.abs(dy) > 1e-9) { const ya = (py - oy) / dy, yb = (top - oy) / dy; t0 = Math.max(t0, Math.min(ya, yb)); t1 = Math.min(t1, Math.max(ya, yb)); }
      else if (oy < py || oy > top) t1 = -1;
      const t = Math.max(0, t0);
      if (t <= t1 && (!best || t < best.t)) best = { t, head: false };
    }
  }
  return best;
}

export class Sim {
  world: World;
  players = new Map<number, PlayerState>();
  loot: Loot[] = [];
  cases: Case[] = [];
  projectiles: Projectile[] = [];
  effects: Effect[] = [];
  builds: Build[] = [];
  vehicles: Vehicle[] = [];
  private rams = new Map<number, number>(); // vehicle*65536+player -> time of the last hit
  private pendingDrop = false;
  private benchUsed = new Set<string>();
  // destruction this tick, sent as one 'wreck' event; where things may need to fall
  private wreckAdd: Box[] = [];
  private wreckKill: number[] = [];
  private wreckFalls: { sid: number; x: number; y: number; z: number }[] = [];
  private wreckDrop: number[] = [];
  // where the world broke this tick, as separate regions (one merged box spanning two far-apart hits
  // made the support search scan half the map: 22-34 ms in a single tick)
  private dirty: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }[] = [];
  private baseBoxes: number;
  private placed = 0;
  private structBy = new Map<number, number>(); // structure -> who last damaged it
  ring: Ring;
  shots: Shot[] = [];   // drained by whoever encodes snapshots
  lootVer = 0;
  t = 0;
  tick = 0;
  private rand: () => number;
  private phaseStart = 0;   // on the storm's clock
  private clock = 0;        // the storm's clock: the match's, run faster as the field thins out
  private field = 0;        // teams at the start
  private from = { x: 0, y: 0, r: RING_START_R };
  private history: { tick: number; pos: Map<number, { x: number; y: number; z: number }> }[] = [];
  private nextId = 1;

  constructor(public seed: number, world?: World) {
    this.world = world ?? new World(seed);
    this.baseBoxes = this.world.boxes.length;
    this.rand = rng(seed ^ 0x9e3779b9);
    const first = RING_PHASES[0], c = this.nextCircle(0, 0, 0, RING_START_R - 220, first.radius);
    this.ring = { x: 0, y: 0, r: RING_START_R, nx: c.x, ny: c.y, nr: first.radius, phase: 0, closing: false, dps: RING_DPS_START, nextAt: first.wait };
    const lr = rng(seed ^ 0x5bd1e995);
    for (const s of this.world.vehicleSpots) {
      const body = newBody(s.x, s.y, s.z);
      Object.assign(body, { ride: VEHICLE_KINDS.indexOf(s.kind) + 1, head: s.head, grounded: true });
      this.vehicles.push({ id: this.nextId++, kind: s.kind, hp: VEHICLES[s.kind].hp, driver: 0, last: 0, body, gunCd: 0, bombCd: 0, seats: [] });
    }
    for (const s of this.world.caseSpots) this.cases.push({ id: this.nextId++, x: s.x, y: s.y, z: s.z, golden: !!s.golden, open: false });
    for (const s of this.world.lootSpots) {
      const roll = lr();
      if (roll < 0.6 || (s.rich && roll < 0.8)) this.dropGun(s.x, s.y, s.z, this.rollWeapon(lr, s.rich ? CASE_RARITY : FLOOR_RARITY), lr() * Math.PI * 2);
      else if (roll < 0.74) this.drop(s.x, s.y, s.z, 'ammo', weighted(lr, AMMO_TABLE));
      else if (roll < 0.9) this.drop(s.x, s.y, s.z, 'item', weighted(lr, ITEM_TABLE));
      else this.drop(s.x, s.y, s.z, 'perk', weighted(lr, PERK_TABLE));
    }
  }

  // later circles are pulled toward the tower in the middle: the hill is where it ends
  private nextCircle(phase: number, x: number, y: number, rad: number, nr: number) {
    const room = Math.max(0, rad - nr), a = this.rand() * Math.PI * 2, d = Math.sqrt(this.rand()) * room;
    let cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d;
    if (phase >= 2) {
      const pull = phase >= 3 ? 0.9 : 0.6;
      let tx = cx + (0 - cx) * pull, ty = cy + (0 - cy) * pull;
      const off = Math.hypot(tx - x, ty - y);
      if (off > room) { tx = x + ((tx - x) / off) * room; ty = y + ((ty - y) / off) * room; }
      cx = tx; cy = ty;
    }
    return { x: cx, y: cy };
  }

  private rollWeapon(r: () => number, table: [Rarity, number][]): WeaponId {
    const list = BY_RARITY[weighted(r, table)];
    return list[Math.floor(r() * list.length)];
  }

  // a gun on the floor, with a box of its ammo next to it
  private dropGun(x: number, y: number, z: number, w: WeaponId, a = 0) {
    this.drop(x, y, z, 'weapon', w);
    const ammo = WEAPONS[w].ammo;
    if (ammo) this.drop(x + Math.cos(a) * 0.9, y, z + Math.sin(a) * 0.9, 'ammo', ammo);
  }

  drop(x: number, y: number, z: number, kind: LootKind, what: string, n = 1, mag?: number, up = 0) {
    const def = kind === 'weapon' ? WEAPONS[what as WeaponId] : null;
    const at = this.world.settle(x, y, z) ?? { x, y: this.world.groundAt(x, z, y + 0.6), z };
    x = at.x; y = at.y; z = at.z;
    this.loot.push({ id: this.nextId++, x, y, z, kind, what, n: kind === 'perk' ? PERKS[what as PerkId].count : kind === 'ammo' && n === 1 ? AMMO[what as AmmoId].box : n, mag: def ? (mag ?? def.mag) : undefined, up: up || undefined });
    this.lootVer++;
  }

  // everyone drops in from the sky over the island and glides down wherever they like
  // teammates (same team number) jump from the same spot, a few meters apart
  // the paper plane's flight: from (x, z) along (dx, dz), BUS.len long; null when the match starts in the air
  bus: { x: number; z: number; dx: number; dz: number; t: number } | null = null;
  busAt(t = this.t) { const b = this.bus!, s = Math.min(BUS.len, (t - b.t) * BUS.speed); return { x: b.x + b.dx * s, z: b.z + b.dz * s, s }; }

  // opts.bus: everyone boards the paper plane (a match); without it they start gliding over their team's
  // drop spot (the tests, a training ground)
  spawn(ids: number[], teamOf?: Map<number, number>, opts: { bus?: boolean } = {}) {
    if (opts.bus) this.bus = { ...busLine(this.world), t: this.t };
    const bare = !!opts.bus;
    const drop = new Map<number, { x: number; z: number; n: number }>();
    ids.forEach((id) => {
      const team = teamOf?.get(id) ?? id;
      let at = drop.get(team);
      if (!at) { const a = this.rand() * Math.PI * 2, d = 70 + Math.sqrt(this.rand()) * 300; at = { x: Math.cos(a) * d, z: Math.sin(a) * d, n: 0 }; drop.set(team, at); }
      const k = at.n++, x = at.x + (k % 2) * 3 - 1.5 * Math.min(1, k), z = at.z + Math.floor(k / 2) * 3;
      this.players.set(id, {
        ...newBody(x, 95 + this.rand() * 15, z), gliding: true, id,
        yaw: Math.atan2(x, z), pitch: -0.5, hp: PLAYER_HP, shield: 0, alive: true,
        // a match: the pickaxe and nothing else. The training ground (and the tests): a pistol and full ammo
        slots: [bare ? null : 'pistol', null, null, null], mags: [bare ? 0 : WEAPONS.pistol.mag, 0, 0, 0], cur: 0, ups: [0, 0, 0, 0],
        ammo: bare ? { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 } : { light: AMMO.light.max, medium: AMMO.medium.max, heavy: AMMO.heavy.max, shells: AMMO.shells.max, rockets: AMMO.rockets.max },
        items: { mini: 0, big: 0, med: 0 }, perk: null, use: null,
        reloadT: 0, fireCd: 0.5, spin: 0, burstLeft: 0, burstT: 0, kills: 0, ack: 0, team, rideV: 0,
        downBy: null, reviveT: 0, reviver: 0, axe: bare, axeCd: 0, mats: BUILD.startMats, tp: false,
      });
      if (this.bus) Object.assign(this.players.get(id)!, { x: this.bus.x, y: BUS.y, z: this.bus.z, vx: this.bus.dx * BUS.speed, vy: 0, vz: this.bus.dz * BUS.speed, gliding: false, bus: 1, yaw: Math.atan2(-this.bus.dx, -this.bus.dz), pitch: -0.3 });
    });
    this.field = this.teamsAlive.size;
  }
  // everyone aboard is wherever the plane is by the clock (not by their own inputs: a late or bunched input
  // put a rider metres off the plane, and the client's correction showed as the plane jumping about); at the
  // far edge everyone still aboard is thrown out
  private stepBus() {
    if (!this.bus) return;
    const b = this.bus, at = this.busAt(), over = at.s >= BUS.len;
    for (const p of this.players.values()) {
      if (!p.bus || !p.alive) continue;
      p.x = at.x; p.y = BUS.y; p.z = at.z; p.vx = b.dx * BUS.speed; p.vy = 0; p.vz = b.dz * BUS.speed;
      if (over) leaveBus(p);
    }
  }

  get alive() { let n = 0; for (const p of this.players.values()) if (p.alive) n++; return n; }
  // teams with someone still standing (in solo every player is their own team)
  get teamsAlive() { const s = new Set<number>(); for (const p of this.players.values()) if (p.alive) s.add(p.team); return s; }
  friends(a: PlayerState, b: PlayerState) { return a.team === b.team; }
  weaponOf(p: PlayerState): WeaponId | null { return p.slots[p.cur]; }

  eliminate(id: number, by: number | null, cause: ElimCause, ev: SimEvent[], head = false) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    if (p.rideV) this.exitVehicle(p);
    if (p.down > 0 && by === null) by = p.downBy; // bled out or finished by the storm: the knock gets the kill
    p.alive = false; p.hp = 0; p.shield = 0; p.down = 0;
    if (by !== null && by !== id) { const k = this.players.get(by); if (k && k.team !== p.team) k.kills++; } // no kill for a teammate (a building they brought down)
    // everything they carried spills on the floor in a little ring
    const gy = this.world.groundAt(p.x, p.z, p.y + 0.1);
    const spill: [LootKind, string, number, number | undefined, number][] = [];
    p.slots.forEach((w, i) => { if (w) spill.push(['weapon', w, 1, p.mags[i], p.ups[i]]); });
    for (const a of AMMO_IDS) if (p.ammo[a] > 0) spill.push(['ammo', a, p.ammo[a], undefined, 0]);
    for (const it of Object.keys(p.items) as ItemId[]) if (p.items[it] > 0) spill.push(['item', it, p.items[it], undefined, 0]);
    if (p.perk && p.perk.n > 0) spill.push(['perk', p.perk.kind, p.perk.n, undefined, 0]); // an empty perk would block picking up a real one
    spill.forEach(([k, what, n, mag, up], i) => {
      const a = (i / Math.max(1, spill.length)) * Math.PI * 2;
      this.drop(p.x + Math.cos(a) * 1.2, gy, p.z + Math.sin(a) * 1.2, k, what, n, mag, up);
      if (k === 'perk') this.loot[this.loot.length - 1].n = n;
    });
    for (const it of Object.keys(p.items) as ItemId[]) p.items[it] = 0; // it's all on the floor now
    p.perk = null;
    ev.push({ kind: 'elim', victim: id, by, cause, head });
    // nobody left standing on the team: the knocked are out too
    if (!this.standing(p.team)) for (const q of this.players.values()) if (q.alive && q.team === p.team) this.eliminate(q.id, q.downBy, 'shot', ev);
  }

  // anyone on the team still on their feet
  private standing(team: number, except = 0) { for (const q of this.players.values()) if (q.alive && q.down === 0 && q.team === team && q.id !== except) return true; return false; }

  // health ran out: knocked if a teammate can still pick you up, otherwise out
  private fall(q: PlayerState, by: number | null, cause: ElimCause, ev: SimEvent[], head = false) {
    if (!q.alive) return;
    if (q.down === 0 && this.standing(q.team, q.id)) {
      if (q.rideV) this.exitVehicle(q);
      Object.assign(q, { down: KNOCK.bleed, hp: KNOCK.hp, shield: 0, downBy: by === q.id ? null : by, reviveT: 0, reviver: 0, use: null, hook: false, slideT: 0, reloadT: 0, burstLeft: 0, spin: 0 });
      ev.push({ kind: 'knock', victim: q.id, by: q.downBy, head });
      return;
    }
    this.eliminate(q.id, by, cause, ev, head);
  }

  // teammates holding E next to a knocked player bring them back up
  private stepRevives(dt: number, inputs: TickInputs, ev: SimEvent[]) {
    this.reviving.clear();
    // E held, from the latest input; a tick with no input keeps the last answer (a late packet must
    // not reset a five-second revive)
    for (const [id, got] of inputs) { const l = Array.isArray(got) ? got[got.length - 1] : got; if (l) this.holding.set(id, l.hold); }
    for (const p of this.players.values()) {
      if (!p.alive || p.down === 0) continue;
      let by = 0;
      for (const q of this.players.values()) {
        if (!q.alive || q.down > 0 || q.team !== p.team || q.id === p.id || q.ride || q.gliding || !this.holding.get(q.id)) continue;
        if (Math.hypot(q.x - p.x, q.z - p.z) < KNOCK.reach && Math.abs(q.y - p.y) < 1.6) { by = q.id; break; }
      }
      if (!by) { p.reviveT = 0; p.reviver = 0; continue; }
      p.reviver = by; p.reviveT += dt; this.reviving.add(by);
      if (p.reviveT >= KNOCK.revive) {
        Object.assign(p, { down: 0, hp: KNOCK.reviveHp, shield: 0, downBy: null, reviveT: 0, reviver: 0 });
        ev.push({ kind: 'revive', victim: p.id, by });
      }
    }
  }
  private reviving = new Set<number>();
  private holding = new Map<number, boolean>();

  // how fast the storm's clock runs: the match's pace while most teams are still in, up to RING_HURRY.max
  // times that once only a few are left, so the last ones meet in a small circle instead of the match
  // ending (or dragging on) in a big one
  hurry() {
    const frac = this.field > 1 ? this.teamsAlive.size / this.field : 1;
    return 1 + (RING_HURRY.max - 1) * clamp((RING_HURRY.from - frac) / (RING_HURRY.from - RING_HURRY.to), 0, 1);
  }
  private stepRing(dt: number) {
    const ring = this.ring, phase = RING_PHASES[ring.phase];
    if (!phase) return;
    const rate = this.hurry();
    this.clock += dt * rate;
    const since = this.clock - this.phaseStart;
    if (since < phase.wait) { ring.closing = false; ring.nextAt = this.t + (phase.wait - since) / rate; return; }
    ring.closing = true;
    const k = Math.min(1, (since - phase.wait) / phase.shrink);
    ring.x = this.from.x + (ring.nx - this.from.x) * k;
    ring.y = this.from.y + (ring.ny - this.from.y) * k;
    ring.r = this.from.r + (ring.nr - this.from.r) * k;
    ring.nextAt = this.t + Math.max(0, phase.wait + phase.shrink - since) / rate;
    if (k >= 1) {
      ring.dps = phase.dps; ring.phase++; this.phaseStart = this.clock;
      if (ring.phase < RING_PHASES.length) this.pendingDrop = true;
      this.from = { x: ring.x, y: ring.y, r: ring.r };
      const next = RING_PHASES[ring.phase];
      if (next) { const c = this.nextCircle(ring.phase, ring.x, ring.y, ring.r, next.radius); ring.nx = c.x; ring.ny = c.y; ring.nr = next.radius; }
    }
  }

  // shields soak first (except storm damage, which goes straight to health)
  // returns whether the hit landed on shield, and whether it just broke it
  private hurt(p: PlayerState, amount: number, ignoreShield = false): { shield: boolean; broke: boolean } {
    let shield = false, broke = false;
    if (!ignoreShield && p.shield > 0) { const s = Math.min(p.shield, amount); p.shield -= s; amount -= s; shield = true; broke = p.shield <= 0; }
    p.hp -= amount;
    if (p.use) p.use = null; // taking damage interrupts healing
    return { shield, broke };
  }

  private positionsAt(tick: number) { return this.history.find((e) => e.tick === tick)?.pos ?? null; }

  private shoot(p: PlayerState, w: WeaponId, inp: Input, ev: SimEvent[]) {
    const def = WEAPONS[w];
    if (def.melee) { this.slash(p, def, ev); return; }
    p.mags[p.cur]--;
    if (def.proj) {
      const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
      const sp = def.proj === 'rocket' ? ROCKET.speed : def.proj === 'guided' ? GUIDED.speed : def.proj === 'spell' ? SPELL.speed : MISSILE.speed, dmg = def.dmg * (1 + UPGRADE.perLevel * p.ups[p.cur]);
      let tgt: number | undefined;
      if (def.proj === 'missile') { // lock onto the aircraft closest to the crosshair
        let best = MISSILE.cone;
        for (const v of this.vehicles) {
          if (!isAir(VEHICLE_KINDS.indexOf(v.kind) + 1)) continue;
          const d = v.driver ? this.players.get(v.driver) : null;
          if (d && d.team === p.team) continue;
          const tx = v.body.x - p.x, ty = v.body.y + 1 - (p.y + EYE_H), tz = v.body.z - p.z, dist = Math.hypot(tx, ty, tz);
          if (dist > MISSILE.range || dist < 3) continue;
          const ang = Math.acos(clamp((tx * dx + ty * dy + tz * dz) / dist, -1, 1));
          if (ang < best) { best = ang; tgt = v.id; }
        }
      }
      // in third person it leaves on the crosshair's own ray and flies straight down the middle of the screen
      const [ox, oy, oz] = aimFrom(this.world, p.x, p.y, p.z, p.yaw, p.pitch, p.tp), drop = p.tp ? 0 : 0.1;
      const life = def.proj === 'rocket' ? ROCKET.life : def.proj === 'guided' ? GUIDED.life : def.proj === 'spell' ? SPELL.life : MISSILE.life;
      this.projectiles.push({ id: this.nextId++, kind: def.proj, owner: p.id, x: ox + dx * 0.9, y: oy - drop + dy * 0.9, z: oz + dz * 0.9, vx: dx * sp, vy: dy * sp, vz: dz * sp, t: life, tgt, dmg, r: def.proj === 'guided' ? GUIDED.radius : undefined });
      this.shots.push({ ox, oy, oz, ex: ox + dx * 2, ey: oy + dy * 2, ez: oz + dz * 2, by: p.id, hit: false });
      return;
    }
    const spread = spreadFor(p, w, inp.aim);
    const view = clamp(inp.view, this.tick - REWIND_MAX_TICKS, this.tick);
    const past = this.positionsAt(view);
    const [ox, oy, oz] = aimFrom(this.world, p.x, p.y, p.z, p.yaw, p.pitch, p.tp);
    const eye: [number, number, number] | undefined = oy !== p.y + EYE_H || ox !== p.x ? [p.x, p.y + EYE_H, p.z] : undefined;
    for (let i = 0; i < def.pellets; i++) {
      const yaw = p.yaw + (this.rand() - 0.5) * 2 * spread, pitch = p.pitch + (this.rand() - 0.5) * 2 * spread;
      const cp = Math.cos(pitch);
      // pellets and long range fall off a little; headshots multiply
      this.ray(p, ox, oy, oz, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp, def.range, (t, head) =>
        def.dmg * (1 + UPGRADE.perLevel * p.ups[p.cur]) * (def.pellets > 1 ? pelletFall(t, def.range) : 1) * (head ? (def.headMult ?? HEADSHOT_MULT) : 1), ev, past, eye);
    }
  }

  // one bullet: the first wall, player or vehicle along the ray takes it. eye: fired down a third-person
  // crosshair ray, the bullet still leaves your gun: a wall between you and what the crosshair is on stops it
  private ray(p: PlayerState, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number,
    dmgAt: (t: number, head: boolean) => number, ev: SimEvent[], past: Map<number, { x: number; y: number; z: number }> | null = null, eye?: [number, number, number]) {
    let t = this.world.raycast(ox, oy, oz, dx, dy, dz, range);
    let hit: { head: boolean; q: PlayerState } | null = null, vhit: Vehicle | null = null;
    for (const q of this.players.values()) {
      // no friendly fire; pilots sit inside their aircraft (shoot the aircraft); drivers are exposed
      if (!q.alive || q.id === p.id || q.team === p.team || (covered(q.ride) && !q.seat)) continue;
      const at = past?.get(q.id) ?? q;
      if (Math.abs(at.x - ox) > range || Math.abs(at.z - oz) > range) continue;
      const h = rayPlayer(ox, oy, oz, dx, dy, dz, at.x, at.y, at.z);
      if (h && h.t < t) { t = h.t; hit = { head: h.head, q }; }
    }
    for (const v of this.vehicles) {
      if (v.id === p.rideV) continue;
      const b = v.body, r = VEHICLES[v.kind].r, hv = VEHICLES[v.kind].h;
      if (Math.abs(b.x - ox) > range + r || Math.abs(b.z - oz) > range + r) continue;
      const vt = rayBox(ox, oy, oz, dx, dy, dz, { x0: b.x - r, y0: b.y, z0: b.z - r, x1: b.x + r, y1: b.y + hv, z1: b.z + r });
      if (vt >= 0 && vt < t) { t = vt; vhit = v; hit = null; }
    }
    if (eye) {
      const hx = ox + dx * t - eye[0], hy = oy + dy * t - eye[1], hz = oz + dz * t - eye[2], L = Math.hypot(hx, hy, hz);
      const tb = L > 0.1 ? this.world.raycast(eye[0], eye[1], eye[2], hx / L, hy / L, hz / L, L) : L;
      if (tb < L - 0.1) { this.shots.push({ ox: eye[0], oy: eye[1], oz: eye[2], ex: eye[0] + (hx / L) * tb, ey: eye[1] + (hy / L) * tb, ez: eye[2] + (hz / L) * tb, by: p.id, hit: false }); return; }
    }
    this.shots.push({ ox, oy, oz, ex: ox + dx * t, ey: oy + dy * t, ez: oz + dz * t, by: p.id, hit: !!hit || !!vhit });
    if (vhit) { this.damageVehicle(vhit, Math.round(dmgAt(t, false)), p.id, ev); return; }
    if (hit && hit.q.alive) {
      const dmg = Math.round(dmgAt(t, hit.head));
      const h = this.hurt(hit.q, dmg);
      ev.push({ kind: 'hit', victim: hit.q.id, by: p.id, dmg, head: hit.head, ...h });
      if (hit.q.hp <= 0) this.fall(hit.q, p.id, 'shot', ev, hit.head);
    }
  }

  // a blade swing: everyone in the arc in front of you within reach (and in sight) takes it and is shoved
  // back; with nobody there, it cuts into the block you aim at like a heavy pickaxe
  private slash(p: PlayerState, def: (typeof WEAPONS)[WeaponId], ev: SimEvent[]) {
    const m = def.melee!, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), dmg = def.dmg * (1 + UPGRADE.perLevel * p.ups[p.cur]);
    const ex = p.x, ey = p.y + EYE_H, ez = p.z;
    let hit = false;
    for (const q of this.players.values()) {
      if (!q.alive || q.id === p.id || q.team === p.team || (covered(q.ride) && !q.seat)) continue;
      const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
      if (d > m.reach + PLAYER_R || Math.abs(q.y - p.y) > 2.2) continue;
      if (d > 0.8 && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > m.arc) continue;
      const cx = q.x - ex, cy = q.y + 1.1 - ey, cz = q.z - ez, L = Math.hypot(cx, cy, cz);
      if (L > 0.5 && this.world.raycast(ex, ey, ez, cx / L, cy / L, cz / L, L) < L - 0.35) continue; // not through a wall
      const amount = Math.round(dmg), h = this.hurt(q, amount);
      ev.push({ kind: 'hit', victim: q.id, by: p.id, dmg: amount, head: false, ...h });
      if (!q.ride) { q.vx += fx * 7; q.vz += fz * 7; q.vy = Math.max(q.vy, 3.5); q.grounded = false; q.mantleT = 0; }
      if (q.hp <= 0) this.fall(q, p.id, 'shot', ev);
      hit = true;
    }
    for (const v of this.vehicles) {
      if (v.id === p.rideV) continue;
      const r = VEHICLES[v.kind].r, dx = v.body.x - p.x, dz = v.body.z - p.z, d = Math.hypot(dx, dz);
      if (d > m.reach + r || (d > r && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > m.arc)) continue;
      this.damageVehicle(v, Math.round(dmg * 1.2), p.id, ev); hit = true;
    }
    if (!hit) { const cp = Math.cos(p.pitch); hit = this.chopAt(p, -Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp, m.reach, m.block, ev); }
    ev.push({ kind: 'slash', by: p.id, hit });
  }

  // ---------------- vehicles ----------------
  private damageVehicle(v: Vehicle, dmg: number, by: number, ev: SimEvent[]) {
    if (v.hp <= 0 || dmg <= 0) return;
    v.hp -= dmg;
    if (this.players.has(by) && by !== v.driver) ev.push({ kind: 'vhit', vehicle: v.id, by, dmg });
    if (v.hp > 0) return;
    this.wreck(v, by, ev, VEH_BOOM.radius, VEH_BOOM.dmg);
  }
  // wrecked: throw the crew out, then it blows up on them and everyone near. An aircraft crash brings its
  // own blast (and does its own world damage); `hit` collects who it caught
  private wreck(v: Vehicle, by: number, ev: SimEvent[], radius: number, dmg: number, core = 0, hit?: Set<number>) {
    v.hp = 0;
    const d = v.driver ? this.players.get(v.driver) : null;
    if (d) this.exitVehicle(d);
    for (const id of [...v.seats]) { const q = this.players.get(id); if (q) this.exitVehicle(q); }
    this.vehicles = this.vehicles.filter((x) => x !== v);
    const b = v.body;
    this.explode(b.x, b.y + 1, b.z, radius, dmg, by || v.last || (d?.id ?? 0), ev, false, core, !hit, hit);
  }

  // an aircraft flown into something at speed (b: the body that hit, v0: its velocity just before):
  // wrecked on the spot, its crew thrown into the blast, and the fireball goes on through whatever it
  // hit along the way it was flying (gut). A house comes down whole; a tower too big for that loses the
  // floors it went through, and everything above them falls (dropLoose)
  private airCrash(v: Vehicle, b: Body, impact: number, v0: { x: number; y: number; z: number }, by: number, ev: SimEvent[]) {
    const def = AIR_CRASH[v.kind as 'plane' | 'heli'], s = clamp((impact - AIR_CRASH.minSpeed) / (def.at - AIR_CRASH.minSpeed), 0.15, 1.3);
    const sp = Math.hypot(v0.x, v0.y, v0.z), cp = Math.cos(b.vpitch);
    const [dx, dy, dz] = sp > 2 ? [v0.x / sp, v0.y / sp, v0.z / sp] : [-Math.sin(b.head) * cp, Math.sin(b.vpitch), -Math.cos(b.head) * cp];
    const vr = VEHICLES[v.kind].r, ox = b.x + dx * vr, oy = b.y + VEHICLES[v.kind].h / 2 + dy * vr, oz = b.z + dz * vr;
    const r = def.r * (0.55 + 0.45 * s), k = Math.min(1, s), dmg = def.dmg * (0.6 + 0.4 * k);
    let depth = Math.max(1.5, def.depth * s);
    if (dy < -0.05) depth = Math.min(depth, Math.max(0, oy) / -dy); // never on underground
    for (let t = 1; t < depth; t += 2) if (this.inRock(ox + dx * t, oy + dy * t, oz + dz * t)) { depth = t; break; } // nor through a hillside
    const hit = new Set<number>();
    this.wreck(v, by, ev, def.boom * (0.7 + 0.3 * k), dmg, 3, hit); // walls still up: whoever is inside is behind them
    this.gut(ox, oy, oz, dx, dy, dz, depth, r, def.flat, def.struct * s, by);
    // the fireball through the floors it gutted, for whoever was in them (the crew already took theirs)
    this.explode(ox + dx * depth / 2, oy + dy * depth / 2, oz + dz * depth / 2, r, dmg, by || v.last, ev, false, r * 0.4, false, hit);
  }
  private inRock(x: number, y: number, z: number) {
    for (const i of this.world.near(x, z, x, z)) { const q = this.world.boxes[i]; if (q.hard && !q.dead && x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1 && y > q.y0 && y < q.y1) return true; }
    return false;
  }

  private enterVehicle(p: PlayerState, v: Vehicle) {
    const b = v.body;
    p.x = b.x; p.y = b.y; p.z = b.z; p.vx = b.vx; p.vy = b.vy; p.vz = b.vz;
    p.ride = VEHICLE_KINDS.indexOf(v.kind) + 1; p.head = b.head; p.vpitch = b.vpitch; p.spd = b.spd; p.grounded = b.grounded;
    p.gliding = false; p.hook = false; p.slideT = 0; p.dashT = 0; p.launchT = 0; p.use = null;
    v.driver = p.id; v.last = p.id; p.rideV = v.id;
  }

  exitVehicle(p: PlayerState) {
    const v = this.vehicles.find((x) => x.id === p.rideV);
    const ride = p.ride;
    p.rideV = 0; p.ride = 0;
    if (p.seat) { // a passenger hops off; the vehicle carries on
      p.seat = 0; p.spd = 0; p.vpitch = 0;
      if (v) v.seats = v.seats.filter((id) => id !== p.id);
      const b = v?.body ?? p, r = v ? VEHICLES[v.kind].r : 1;
      const sx = Math.cos(b.head), sz = -Math.sin(b.head), out = r + 0.9;
      const spots = [{ x: b.x - sx * out, y: b.y, z: b.z - sz * out }, { x: b.x + sx * out, y: b.y, z: b.z + sz * out }, { x: b.x, y: b.y + 3, z: b.z }];
      const at = this.exitSpot(b, spots);
      p.x = at.x; p.y = at.y; p.z = at.z; p.vx *= 0.3; p.vz *= 0.3; p.vy = 0;
      if (p.y - this.world.groundAt(p.x, p.z, p.y) > 4) p.gliding = true;
      return;
    }
    if (!v) { p.spd = 0; p.vpitch = 0; return; }
    const b = v.body, r = VEHICLES[v.kind].r, h = VEHICLES[v.kind].h;
    Object.assign(b, { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, head: p.head, vpitch: p.vpitch, spd: p.spd, grounded: p.grounded, ride });
    v.driver = 0;
    p.spd = 0; p.vpitch = 0;
    // step out to the side (or onto the roof); bail out of anything in the air under a parachute
    const sx = Math.cos(b.head), sz = -Math.sin(b.head), out = r + 0.9;
    const spots = [{ x: b.x + sx * out, y: b.y, z: b.z + sz * out }, { x: b.x - sx * out, y: b.y, z: b.z - sz * out }, { x: b.x, y: b.y + h + 0.1, z: b.z }];
    const at = this.exitSpot(b, spots);
    p.x = at.x; p.y = at.y; p.z = at.z; p.vx *= 0.3; p.vz *= 0.3; p.vy = Math.max(0, p.vy * 0.3);
    if (p.y - this.world.groundAt(p.x, p.z, p.y) > 4) p.gliding = true;
  }

  // where getting out puts you: a free spot you can reach from the seat (no stepping through a wall or
  // up onto a roof); none free (a tunnel): where the vehicle is, which is clear of the world anyway
  private exitSpot(b: { x: number; y: number; z: number }, spots: { x: number; y: number; z: number }[]) {
    for (const s of spots) {
      if (this.world.overlaps(s.x, s.y, s.z)) continue;
      const dx = s.x - b.x, dy = s.y - b.y, dz = s.z - b.z, len = Math.hypot(dx, dy, dz);
      if (len < 1e-6 || this.world.raycast(b.x, b.y + 1, b.z, dx / len, dy / len, dz / len, len) >= len - 1e-3) return s;
    }
    return { x: b.x, y: b.y, z: b.z };
  }

  private nearVehicle(p: PlayerState): Vehicle | null {
    let best: Vehicle | null = null, bd = Infinity;
    for (const v of this.vehicles) {
      // the crew is the driver, or the passengers still aboard after the driver left: an enemy can't take
      // the wheel of a vehicle with your teammates sitting in it
      const crewId = v.driver || v.seats[0], d0 = crewId ? this.players.get(crewId) : null;
      if (d0 && (d0.team !== p.team || v.seats.length >= VEHICLES[v.kind].seats)) continue;
      const b = v.body, d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < VEHICLES[v.kind].reach && Math.abs(b.y - p.y) < 2.5 && d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // a crate on a balloon, falling into the circle the storm is heading for
  private supplyDrop(ev: SimEvent[]) {
    const g = this.ring, a = this.rand() * Math.PI * 2, d = Math.sqrt(this.rand()) * Math.max(4, g.nr * 0.7);
    const x = clamp(g.nx + Math.cos(a) * d, -MAP_HALF + 8, MAP_HALF - 8), z = clamp(g.ny + Math.sin(a) * d, -MAP_HALF + 8, MAP_HALF - 8);
    this.effects.push({ id: this.nextId++, kind: 'drop', owner: 0, x, y: SUPPLY.height, z, t: 999 });
    ev.push({ kind: 'drop', x, z, landed: false });
  }

  // guns on aircraft: the helicopter aims where you look, the plane fires along its nose
  private vehicleGuns(p: PlayerState, inp: Input, ev: SimEvent[]) {
    const v = this.vehicles.find((x) => x.id === p.rideV);
    if (!v || !covered(p.ride)) return;
    if (v.kind === 'tank') { // the cannon (and the machine gun beside it, on right click) fire at the crosshair
      if ((inp.fire && v.gunCd <= 0) || (inp.aim && v.bombCd <= 0)) {
        const a = tankAim(this.world, p.x, p.y, p.z, inp.yaw, inp.pitch, p.spd);
        if (inp.fire && v.gunCd <= 0) {
          v.gunCd = TANK.cd;
          const ox = a.mx, oy = a.my, oz = a.mz, dx = a.dx, dy = a.dy, dz = a.dz;
          this.projectiles.push({ id: this.nextId++, kind: 'rocket', owner: p.id, x: ox, y: oy, z: oz, vx: dx * TANK.speed, vy: dy * TANK.speed, vz: dz * TANK.speed, t: 6, dmg: TANK.dmg, r: TANK.radius });
          this.shots.push({ ox, oy, oz, ex: ox + dx * 2, ey: oy + dy * 2, ez: oz + dz * 2, by: p.id, hit: false });
        }
        if (inp.aim && v.bombCd <= 0) { // (a tank has no bombs: bombCd is the machine gun's)
          v.bombCd = TANK_MG.cd;
          const yaw = Math.atan2(-a.dx, -a.dz) + (this.rand() - 0.5) * 2 * TANK_MG.spread, pitch = Math.asin(clamp(a.dy, -1, 1)) + (this.rand() - 0.5) * 2 * TANK_MG.spread;
          const cp = Math.cos(pitch);
          this.ray(p, a.mx, a.my + 0.35, a.mz, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp, TANK_MG.range, () => TANK_MG.dmg, ev);
        }
      }
      return;
    }
    const heli = p.ride === 2, g = heli ? HELI_GUN : PLANE_GUN;
    if (inp.fire && v.gunCd <= 0) {
      v.gunCd = g.cd;
      const yaw = (heli ? inp.yaw : p.head) + (this.rand() - 0.5) * 2 * g.spread, pitch = (heli ? inp.pitch : p.vpitch) + (this.rand() - 0.5) * 2 * g.spread;
      const cp = Math.cos(pitch), dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
      const nose = heli ? 2.6 : 3.2;
      this.ray(p, p.x + dx * nose, p.y + 1.1 + dy * nose, p.z + dz * nose, dx, dy, dz, g.range, () => g.dmg, ev);
    }
    if (!heli && inp.aim && v.bombCd <= 0) {
      v.bombCd = BOMB.cd;
      this.projectiles.push({ id: this.nextId++, kind: 'bomb', owner: p.id, x: p.x, y: p.y - 0.6, z: p.z, vx: p.vx, vy: Math.min(0, p.vy) - 2, vz: p.vz, t: 20 });
    }
  }

  private stepVehicles(dt: number, ev: SimEvent[]) {
    for (const v of [...this.vehicles]) {
      if (v.hp <= 0) continue; // wrecked earlier this loop (another one's crash)
      v.gunCd = Math.max(0, v.gunCd - dt); v.bombCd = Math.max(0, v.bombCd - dt);
      const b = v.body;
      if (v.driver) {
        const d = this.players.get(v.driver)!;
        Object.assign(b, { x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, head: d.head, vpitch: d.vpitch, spd: d.spd, grounded: d.grounded });
      } else if (!b.grounded || Math.abs(b.spd) > 0.05 || Math.hypot(b.vx, b.vz) > 0.05) {
        // nobody at the controls: a plane you bailed out of, a helicopter dropping off a roof
        const vx0 = b.vx, vy0 = b.vy, vz0 = b.vz, was = b.grounded;
        const impact = moveVehicle(this.world, b, NO_INPUT, dt, GRAVITY, false);
        if (isAir(b.ride) && impact > (b.grounded && !was ? AIR_CRASH.land : AIR_CRASH.minSpeed)) this.airCrash(v, b, impact, { x: vx0, y: vy0, z: vz0 }, v.last, ev);
        else if (impact > CRASH.minSpeed) this.damageVehicle(v, Math.round((impact - CRASH.minSpeed) * CRASH.dmgPerMs), v.last, ev);
      }
    }
    // passengers sit in their seats: beside / behind the driver, moving with the vehicle
    for (const v of this.vehicles) for (let i = 0; i < v.seats.length; i++) {
      const q = this.players.get(v.seats[i]);
      if (!q || !q.alive) continue;
      const b = v.body, side = i % 2 ? -1 : 1, back = v.kind === 'car' ? (i ? 1.2 : 0) : v.kind === 'moto' ? 0.7 : v.kind === 'tank' ? 0.6 : 0.8 + i * 0.4;
      const lat = v.kind === 'plane' || v.kind === 'moto' || v.kind === 'tank' ? 0 : side * (v.kind === 'heli' ? 1.6 : 0.5);
      const fx = -Math.sin(b.head), fz = -Math.cos(b.head), rx = Math.cos(b.head), rz = -Math.sin(b.head);
      q.x = b.x + rx * lat - fx * back; q.z = b.z + rz * lat - fz * back; q.y = b.y + (v.kind === 'tank' ? 2.3 : v.kind === 'car' || v.kind === 'moto' ? 0.3 : 0.2);
      q.vx = b.vx; q.vy = b.vy; q.vz = b.vz; q.grounded = b.grounded; q.head = b.head; q.vpitch = b.vpitch; q.spd = b.spd;
    }
    // running people over: anything moving fast enough hurts whoever it touches
    for (const v of [...this.vehicles]) {
      const b = v.body, sp = Math.hypot(b.vx, b.vy, b.vz), def = VEHICLES[v.kind];
      if (sp < RAM.minSpeed) continue;
      const owner = this.players.get(v.driver || v.last);
      for (const q of this.players.values()) {
        if (!q.alive || q.ride || q.id === v.driver || v.seats.includes(q.id) || (owner && owner.id !== q.id && owner.team === q.team)) continue;
        if (Math.abs(q.x - b.x) > def.r + 0.6 || Math.abs(q.z - b.z) > def.r + 0.6 || q.y > b.y + def.h || q.y + 1.8 < b.y) continue;
        const key = v.id * 65536 + q.id;
        if (this.t - (this.rams.get(key) ?? -9) < RAM.cooldown) continue;
        this.rams.set(key, this.t);
        const dmg = Math.round(sp * RAM.dmgPerMs), by = owner?.id ?? 0;
        const h = this.hurt(q, dmg);
        if (by && by !== q.id) ev.push({ kind: 'hit', victim: q.id, by, dmg, head: false, ...h });
        q.vx += b.vx * 0.7; q.vz += b.vz * 0.7; q.vy = 7; q.grounded = false; q.gliding = false;
        if (q.hp <= 0) this.fall(q, by && by !== q.id ? by : null, 'ram', ev);
      }
    }
    // vehicles hitting each other: both get dented, the faster the worse
    for (let i = 0; i < this.vehicles.length; i++) for (let j = i + 1; j < this.vehicles.length; j++) {
      const a = this.vehicles[i], c = this.vehicles[j], A = a.body, B = c.body, ra = VEHICLES[a.kind].r, rb = VEHICLES[c.kind].r;
      if (Math.abs(A.x - B.x) > ra + rb || Math.abs(A.z - B.z) > ra + rb || A.y > B.y + VEHICLES[c.kind].h || B.y > A.y + VEHICLES[a.kind].h) continue;
      const rel = Math.hypot(A.vx - B.vx, A.vy - B.vy, A.vz - B.vz);
      const key = -(a.id * 65536 + c.id);
      if (rel < CRASH.minSpeed || this.t - (this.rams.get(key) ?? -9) < 0.5) continue;
      this.rams.set(key, this.t);
      const dmg = Math.round((rel - CRASH.minSpeed) * CRASH.dmgPerMs * 0.8);
      for (const [v, o] of [[a, c], [c, a]] as const) if (!v.driver) { v.body.vx = o.body.vx * 0.6; v.body.vz = o.body.vz * 0.6; v.body.spd = Math.hypot(v.body.vx, v.body.vz); v.body.grounded = false; }
      this.damageVehicle(a, dmg, c.driver || c.last, ev);
      this.damageVehicle(c, dmg, a.driver || a.last, ev);
    }
  }

  // core: inside it the blast does full damage (C4), then it falls off toward the edge
  // world: false when the caller breaks the walls itself; hit: who it caught (and who to leave alone)
  private explode(x: number, y: number, z: number, radius: number, dmg: number, owner: number, ev: SimEvent[], nuke: boolean, core = 0, world = true, hit?: Set<number>) {
    ev.push({ kind: 'boom', x, y, z, r: radius, nuke });
    const team = this.players.get(owner)?.team;
    for (const v of [...this.vehicles]) {
      const b = v.body, d = Math.hypot(b.x - x, b.y + 1 - y, b.z - z);
      if (d < radius + VEHICLES[v.kind].r) this.damageVehicle(v, Math.round(dmg * 1.3 * (nuke ? 3 : 1 - Math.min(1, d / radius) * 0.6)), owner, ev);
    }
    for (const q of this.players.values()) {
      if (!q.alive || (q.id !== owner && q.team === team) || (covered(q.ride) && !q.seat) || hit?.has(q.id)) continue; // pilots and tank crews: the vehicle takes it
      const dx = q.x - x, dy = q.y + 1 - y, dz = q.z - z, d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      if (!nuke) { // walls stop grenade blasts
        const tx = dx / (d || 1), ty = dy / (d || 1), tz = dz / (d || 1);
        if (this.world.raycast(x, y + 0.3, z, tx, ty, tz, d) < d - 0.4) continue;
      }
      const amount = Math.round(dmg * (nuke || d <= core ? 1 : 1 - ((d - core) / (radius - core)) * 0.7));
      const h = this.hurt(q, amount);
      hit?.add(q.id);
      if (owner !== q.id) ev.push({ kind: 'hit', victim: q.id, by: owner, dmg: amount, head: false, ...h });
      if (q.hp <= 0) this.fall(q, owner, 'boom', ev);
    }
    // and the walls around it: blocks break, buildings take structural damage
    if (world) this.damageWorld(x, y, z, nuke ? radius * 0.8 : radius * 0.85, dmg * 1.15 * BLAST_WORLD, dmg * (nuke ? 30 : 1.5) * BLAST_WORLD, owner, nuke);
  }

  // a vehicle slamming into something breaks it: a car punches through a wall (an aircraft only gets
  // here bumping into things too slowly to crash: a dent, nothing comes down)
  private crashWorld(p: PlayerState, v: Vehicle, impact: number) {
    const def = VEHICLES[v.kind], fx = -Math.sin(p.head) * Math.cos(p.vpitch), fy = Math.sin(p.vpitch), fz = -Math.cos(p.head) * Math.cos(p.vpitch);
    const reach = def.r + 0.6, r = v.kind === 'plane' ? 2.6 : v.kind === 'heli' ? 2.4 : v.kind === 'tank' ? 2.6 : 2.2;
    const k = v.kind === 'plane' ? 25 : v.kind === 'heli' ? 20 : v.kind === 'tank' ? 20 : 15;
    this.damageWorld(p.x + fx * reach, p.y + def.h / 2 + fy * reach, p.z + fz * reach, r, v.kind === 'tank' ? 45 : impact * 8, impact * k, p.id);
  }

  // the fireball of an aircraft crash, swept along its path from (ox, oy, oz): a squashed sphere (r
  // across, r * flat tall) dragged `depth` along (dx, dy, dz). Every box it reaches breaks: wholly inside
  // it, gone outright (no rubble to track or budget to spend); at its edge, broken into blocks first so
  // the hole is ragged. Every building it reaches takes structural damage, and a tall one whose floor
  // at the impact it mostly went through loses the rest of that floor too: what is left can't carry the
  // floors above. Terrain never breaks.
  private gut(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, depth: number, r: number, flat: number, structDmg: number, by: number) {
    const w = this.world, rv = r * flat, n = Math.max(2, Math.ceil(depth / (r * 0.5)) + 1), cs: number[] = [];
    for (let k = 0; k < n; k++) { const t = (depth * k) / (n - 1); cs.push(ox + dx * t, oy + dy * t, oz + dz * t); }
    // squared distance of a box (its nearest point, or with far its farthest corner) from the shape: < 1 inside
    const reach = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, far = false) => {
      let best = Infinity;
      for (let k = 0; k < cs.length; k += 3) {
        const cx = cs[k], cy = cs[k + 1], cz = cs[k + 2];
        const ex = far ? Math.max(cx - x0, x1 - cx) : Math.max(x0 - cx, 0, cx - x1);
        const ey = far ? Math.max(cy - y0, y1 - cy) : Math.max(y0 - cy, 0, cy - y1);
        const ez = far ? Math.max(cz - z0, z1 - cz) : Math.max(z0 - cz, 0, cz - z1);
        best = Math.min(best, (ex * ex + ez * ez) / (r * r) + (ey * ey) / (rv * rv));
      }
      return best;
    };
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < cs.length; k += 3) {
      x0 = Math.min(x0, cs[k] - r); y0 = Math.min(y0, cs[k + 1] - rv); z0 = Math.min(z0, cs[k + 2] - r);
      x1 = Math.max(x1, cs[k] + r); y1 = Math.max(y1, cs[k + 1] + rv); z1 = Math.max(z1, cs[k + 2] + r);
    }
    for (const i of w.near3(x0, y0, z0, x1, y1, z1, [])) {
      const b = w.boxes[i];
      if (b.dead || b.hard || reach(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1) >= 1) continue;
      if (World.isBlock(b) || reach(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, true) < 1) { this.killBox(i); continue; }
      const kids = this.shatter(i);
      if (!kids.length) { // out of wreck budget: a big box goes whole or not at all
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
        if (reach(cx, cy, cz, cx, cy, cz) < 1) this.killBox(i);
        continue;
      }
      for (const k of kids) { const c = w.boxes[k]; if (reach(c.x0, c.y0, c.z0, c.x1, c.y1, c.z1) < 1) this.killBox(k); }
    }
    for (const s of w.structures) {
      if (s.down || x1 < s.x0 || x0 > s.x1 || z1 < s.z0 || z0 > s.z1 || y1 < s.y0 || y0 > s.y1) continue;
      const d = Math.sqrt(reach(s.x0, s.y0, s.z0, s.x1, s.y1, s.z1));
      if (d >= 1) continue;
      s.dmg += structDmg * (1 - d * 0.6); this.structBy.set(s.id, by);
      if (s.dmg >= s.hp) { this.collapse(s); continue; }
      if (s.y1 - oy < 4 || oy < s.y0 - 1) continue; // nothing above the impact to come down
      let got = 0;
      for (let a = 0; a < 6; a++) for (let c = 0; c < 6; c++) {
        const x = s.x0 + ((a + 0.5) / 6) * (s.x1 - s.x0), z = s.z0 + ((c + 0.5) / 6) * (s.z1 - s.z0);
        if (reach(x, oy, z, x, oy, z) < 1) got++;
      }
      if (got < 26) continue; // under three quarters of the floor gone (a gash in one side): the rest holds
      for (const i of w.near3(s.x0, oy - 1.8, s.z0, s.x1, oy + 1.8, s.z1, [])) {
        const b = w.boxes[i];
        if (!b.dead && !b.hard && b.sid === s.id && b.y1 > oy - 1.8 && b.y0 < oy + 1.8) this.killBox(i);
      }
    }
  }

  // ---------------- destruction ----------------
  private material(b: Box) {
    if (b.kind === 'crate' || b.kind === 'trunk' || b.kind === 'fort' || b.ink === INK.BROWN) return MATERIAL.wood;
    if (b.kind === 'container' || b.kind === 'car' || b.ink === INK.GRAPHITE) return MATERIAL.metal;
    return MATERIAL.brick;
  }
  // what changed in the world so far this tick, as one event (clients apply adds, then kills, in order)
  private flushWreck(ev: SimEvent[]) {
    if (!this.wreckAdd.length && !this.wreckKill.length) return;
    ev.push({ kind: 'wreck', add: this.wreckAdd, kill: this.wreckKill, falls: this.wreckFalls, drop: this.wreckDrop.length ? this.wreckDrop : undefined });
    this.wreckAdd = []; this.wreckKill = []; this.wreckFalls = []; this.wreckDrop = [];
  }
  private markDirty(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const m = 6; // close enough to share a region
    let d = this.dirty.find((r) => x0 < r.x1 + m && x1 > r.x0 - m && y0 < r.y1 + m && y1 > r.y0 - m && z0 < r.z1 + m && z1 > r.z0 - m);
    if (!d && this.dirty.length >= 24) d = this.dirty[this.dirty.length - 1]; // a hundred blasts in one tick: lump the rest together
    if (!d) { this.dirty.push({ x0, y0, z0, x1, y1, z1 }); return; }
    d.x0 = Math.min(d.x0, x0); d.y0 = Math.min(d.y0, y0); d.z0 = Math.min(d.z0, z0); d.x1 = Math.max(d.x1, x1); d.y1 = Math.max(d.y1, y1); d.z1 = Math.max(d.z1, z1);
  }
  private killBox(i: number) {
    const b = this.world.boxes[i];
    if (!b || b.dead) return;
    b.dead = true; this.wreckKill.push(i);
    this.markDirty(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1);
  }
  // break a big box into blocks where it was hit; returns the new blocks' indices
  private shatter(i: number): number[] {
    if (this.world.boxes.length - this.baseBoxes > WRECK_BUDGET) return [];
    const kids = this.world.shards(i);
    this.killBox(i);
    this.wreckAdd.push(...kids);
    return this.world.addBoxes(kids);
  }
  // damage one block; true if it broke
  private hitBlock(i: number, dmg: number): boolean {
    const b = this.world.boxes[i];
    if (!b || b.dead || b.hard) return false;
    b.hp = (b.hp ?? this.material(b).hp) - dmg;
    if (b.hp > 0) return false;
    this.killBox(i);
    return true;
  }
  private boxDist(b: Box, x: number, y: number, z: number) {
    const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1), dz = Math.max(b.z0 - z, 0, z - b.z1);
    return Math.hypot(dx, dy, dz);
  }
  // a blast, a crash, a nuke: blocks near it break, and the buildings it reaches take structural
  // damage; enough of that and the whole building comes down
  damageWorld(x: number, y: number, z: number, r: number, blockDmg: number, structDmg: number, by: number, nuke = false) {
    for (const i of this.world.near3(x - r, y - r, z - r, x + r, y + r, z + r, [])) {
      const b = this.world.boxes[i];
      if (b.dead || b.hard || this.boxDist(b, x, y, z) >= r) continue;
      if (nuke) { this.killBox(i); continue; } // vaporised whole, no rubble to track
      const parts = World.isBlock(b) ? [i] : this.shatter(i);
      for (const k of parts) {
        const d = this.boxDist(this.world.boxes[k], x, y, z);
        if (d < r) this.hitBlock(k, blockDmg * (1 - (d / r) * 0.7));
      }
    }
    if (structDmg > 0) for (const s of this.world.structures) {
      if (s.down || x + r < s.x0 || x - r > s.x1 || z + r < s.z0 || z - r > s.z1 || y + r < s.y0 || y - r > s.y1) continue;
      s.dmg += structDmg; this.structBy.set(s.id, by);
      if (s.dmg >= s.hp) this.collapse(s);
    }
  }
  private collapsed: Structure[] = [];
  private collapse(s: Structure) {
    s.down = true;
    this.wreckFalls.push({ sid: s.id, x: (s.x0 + s.x1) / 2, y: s.y1, z: (s.z0 + s.z1) / 2 });
    for (const i of s.boxes) this.killBox(i);
    this.collapsed.push(s);
  }
  // pieces left hanging (the top of a wall whose bottom was blown out, a block on a broken bridge)
  // fall: anything near the damage that no longer connects to the ground or to terrain through
  // touching boxes drops, and lands on whoever is underneath
  private dropLoose(ev: SimEvent[]) {
    const w = this.world;
    if (!this.dirty.length) return;
    // the walk goes lowest box first, so a piece that stands reaches the ground in a few steps; only a
    // piece bigger than LIMIT (nothing but The Needle) is taken as standing without proof. It used to be
    // 500 breadth-first: a Needle cut through at the base floated. A plane through The Needle leaves a
    // 2 500-box top to walk: marks live in typed arrays (they were Sets) and bounds come from the world's
    // flat copy (box objects come in many shapes: every read was slow)
    const e = 0.06, LIMIT = 6000, loose: number[] = [], hit: { x0: number; z0: number; x1: number; z1: number; y: number; y1: number }[] = [];
    const boxes = w.boxes, B = w.bounds, n = boxes.length, walkOf = new Int32Array(n), state = new Uint8Array(n); // state: 1 standing, 2 loose
    const near: number[] = [], piece: number[] = [];
    // a small binary heap of box indices by height
    const heap: number[] = [];
    const push = (i: number) => {
      heap.push(i);
      for (let k = heap.length - 1; k > 0;) { const up = (k - 1) >> 1, a = heap[up], b = heap[k]; if (B[a * 6 + 1] <= B[b * 6 + 1]) break; heap[up] = b; heap[k] = a; k = up; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let k = 0; ;) {
          const a = 2 * k + 1, b = a + 1; let m = k;
          if (a < heap.length && B[heap[a] * 6 + 1] < B[heap[m] * 6 + 1]) m = a;
          if (b < heap.length && B[heap[b] * 6 + 1] < B[heap[m] * 6 + 1]) m = b;
          if (m === k) break;
          const t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m;
        }
      }
      return top;
    };
    let walk = 0;
    for (const d of this.dirty) for (const start of w.near3(d.x0 - 3, d.y0 - 3, d.z0 - 3, d.x1 + 3, d.y1 + 3, d.z1 + 3, [])) {
      const s = boxes[start];
      if (s.dead || s.hard || s.y0 <= 0.05 || state[start] || s.y1 < d.y0 - 3 || s.y0 > d.y1 + 3) continue;
      // walk the piece this box belongs to until something in it stands on the ground
      walk++; walkOf[start] = walk; piece.length = 0; piece.push(start);
      let ok = false;
      heap.length = 0; push(start);
      while (heap.length) {
        const i = pop(), o = i * 6, ax0 = B[o], ay0 = B[o + 1], az0 = B[o + 2], ax1 = B[o + 3], ay1 = B[o + 4], az1 = B[o + 5];
        if (ay0 <= 0.05 || state[i] === 1 || piece.length > LIMIT || boxes[i].hard) { ok = true; break; }
        for (const j of w.near3(ax0 - e, ay0 - e, az0 - e, ax1 + e, ay1 + e, az1 + e, near)) {
          if (walkOf[j] === walk) continue;
          const p = j * 6;
          if (ax0 <= B[p + 3] + e && B[p] <= ax1 + e && az0 <= B[p + 5] + e && B[p + 2] <= az1 + e && ay0 <= B[p + 4] + e && B[p + 1] <= ay1 + e && !boxes[j].dead) { walkOf[j] = walk; piece.push(j); push(j); }
        }
      }
      for (const i of piece) if (!state[i]) state[i] = ok ? 1 : 2;
      if (ok) continue;
      const box = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, y: Infinity, y1: -Infinity };
      for (const i of piece) {
        const o = i * 6; loose.push(i);
        box.x0 = Math.min(box.x0, B[o]); box.y = Math.min(box.y, B[o + 1]); box.z0 = Math.min(box.z0, B[o + 2]);
        box.x1 = Math.max(box.x1, B[o + 3]); box.y1 = Math.max(box.y1, B[o + 4]); box.z1 = Math.max(box.z1, B[o + 5]);
      }
      hit.push(box);
    }
    // gone (one dirty region per piece: a tower top marked box by box was another 1.5 ms)
    for (const i of loose) { boxes[i].dead = true; this.wreckKill.push(i); this.wreckDrop.push(i); }
    for (const h of hit) this.markDirty(h.x0, h.y, h.z0, h.x1, h.y1, h.z1);
    for (const h of hit) for (const q of this.players.values()) {
      if (!q.alive || q.x < h.x0 || q.x > h.x1 || q.z < h.z0 || q.z > h.z1 || q.y > h.y) continue;
      this.hurt(q, 25);
      if (q.hp <= 0) this.fall(q, null, 'boom', ev);
    }
  }

  // falling rubble hurts whoever was inside; loot, cases and parked vehicles drop to what is left
  private settleWreck(ev: SimEvent[]) {
    for (const s of this.collapsed) {
      const by = this.structBy.get(s.id) ?? null;
      for (const q of this.players.values()) {
        if (!q.alive || q.x < s.x0 - 1 || q.x > s.x1 + 1 || q.z < s.z0 - 1 || q.z > s.z1 + 1 || q.y > s.y1 + 1) continue;
        const dmg = 50, h = this.hurt(q, dmg), enemy = by !== null && by !== q.id && this.players.get(by)?.team !== q.team;
        if (enemy) ev.push({ kind: 'hit', victim: q.id, by: by!, dmg, head: false, ...h });
        if (q.hp <= 0) this.fall(q, enemy ? by : null, 'boom', ev); // a teammate's collapse is nobody's kill
      }
    }
    this.collapsed = [];
    const regions = this.dirty;
    if (!regions.length) return;
    this.dirty = [];
    const inside = (x: number, y: number, z: number) => regions.some((d) => x > d.x0 - 1 && x < d.x1 + 1 && z > d.z0 - 1 && z < d.z1 + 1 && y > d.y0 - 1 && y < d.y1 + 2);
    for (const l of this.loot) if (inside(l.x, l.y, l.z)) { const g = this.world.groundAt(l.x, l.z, l.y + 0.05); if (g < l.y - 0.05) { l.y = g; this.lootVer++; } }
    for (const c of this.cases) if (inside(c.x, c.y, c.z)) { const g = this.world.groundAt(c.x, c.z, c.y + 0.05); if (g < c.y - 0.05) { c.y = g; this.lootVer++; } }
    for (const v of this.vehicles) if (!v.driver && inside(v.body.x, v.body.y, v.body.z)) v.body.grounded = false;
  }

  // the axe: hit whatever is in front of you
  private swing(p: PlayerState, ev: SimEvent[]) {
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const [ox, oy, oz] = aimFrom(this.world, p.x, p.y, p.z, p.yaw, p.pitch, p.tp);
    let best = AXE.reach, hitP: { q: PlayerState; head: boolean } | null = null, hitV: Vehicle | null = null;
    for (const q of this.players.values()) {
      if (!q.alive || q.id === p.id || q.team === p.team || Math.abs(q.x - ox) > 4 || Math.abs(q.z - oz) > 4) continue;
      const h = rayPlayer(ox, oy, oz, dx, dy, dz, q.x, q.y, q.z);
      if (h && h.t < best) { best = h.t; hitP = { q, head: h.head }; }
    }
    for (const v of this.vehicles) {
      const b = v.body, r = VEHICLES[v.kind].r, hv = VEHICLES[v.kind].h;
      if (Math.abs(b.x - ox) > 6 || Math.abs(b.z - oz) > 6) continue;
      const t = rayBox(ox, oy, oz, dx, dy, dz, { x0: b.x - r, y0: b.y, z0: b.z - r, x1: b.x + r, y1: b.y + hv, z1: b.z + r });
      if (t >= 0 && t < best) { best = t; hitV = v; hitP = null; }
    }
    const wb = this.world.raycastBox(ox, oy, oz, dx, dy, dz, AXE.reach);
    if (wb.i >= 0 && wb.t < best) { this.chopAt(p, dx, dy, dz, AXE.reach, AXE.block, ev); return; }
    // nothing on the crosshair: someone right in front of the body still takes it (over the shoulder, the
    // crosshair runs to the right of whoever is in your face)
    if (!hitP && !hitV) {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), ey = p.y + EYE_H;
      let bd = AXE.reach - 0.6;
      for (const q of this.players.values()) {
        if (!q.alive || q.id === p.id || q.team === p.team || Math.abs(q.y - p.y) > 1.6) continue;
        const qx = q.x - p.x, qz = q.z - p.z, d = Math.hypot(qx, qz);
        if (d > bd + PLAYER_R || (d > 0.6 && (qx * fx + qz * fz) / d < 0.8)) continue; // within about 35 degrees of where you face
        const cy = q.y + 1.1 - ey, L = Math.hypot(qx, cy, qz);
        if (L > 0.5 && this.world.raycast(p.x, ey, p.z, qx / L, cy / L, qz / L, L) < L - 0.35) continue; // not through a wall
        bd = d; hitP = { q, head: false };
      }
    }
    if (hitV) { this.damageVehicle(hitV, AXE.vehicle, p.id, ev); return; }
    if (hitP) {
      const dmg = Math.round(AXE.player * (hitP.head ? 1.5 : 1)), h = this.hurt(hitP.q, dmg);
      ev.push({ kind: 'hit', victim: hitP.q.id, by: p.id, dmg, head: hitP.head, ...h });
      if (hitP.q.hp <= 0) this.fall(hitP.q, p.id, 'shot', ev, hitP.head);
    }
  }

  // a pickaxe (or blade) into the block under the crosshair: breaks it off its wall, hurts it, maybe breaks
  // it (giving material); the building it belongs to takes a little structural damage. false: nothing there
  private chopAt(p: PlayerState, dx: number, dy: number, dz: number, reach: number, blockDmg: number, ev: SimEvent[]): boolean {
    const [ox, oy, oz] = aimFrom(this.world, p.x, p.y, p.z, p.yaw, p.pitch, p.tp);
    const wb = this.world.raycastBox(ox, oy, oz, dx, dy, dz, reach);
    if (wb.i < 0) return false;
    {
      const hx = ox + dx * (wb.t + 0.05), hy = oy + dy * (wb.t + 0.05), hz = oz + dz * (wb.t + 0.05);
      let i = wb.i, broke = false, left = 1;
      const b = this.world.boxes[i];
      if (!b.hard) {
        if (!World.isBlock(b)) i = this.shatter(i).find((k) => { const c = this.world.boxes[k]; return hx >= c.x0 - 0.01 && hx <= c.x1 + 0.01 && hy >= c.y0 - 0.01 && hy <= c.y1 + 0.01 && hz >= c.z0 - 0.01 && hz <= c.z1 + 0.01; }) ?? -1;
        if (i >= 0) {
          const mat = this.material(this.world.boxes[i]);
          broke = this.hitBlock(i, blockDmg);
          left = broke ? 0 : Math.max(0, (this.world.boxes[i].hp ?? mat.hp) / mat.hp);
          if (broke) p.mats = Math.min(BUILD.maxMats, p.mats + mat.yield);
          const s = b.sid ? this.world.structures[b.sid - 1] : null;
          if (s && !s.down) { s.dmg += 8; this.structBy.set(s.id, p.id); if (s.dmg >= s.hp) this.collapse(s); }
        }
      }
      const c = this.world.boxes[i >= 0 ? i : wb.i];
      ev.push({ kind: 'chop', by: p.id, x: hx, y: hy, z: hz, broke, left: Math.round(left * 100) / 100, b: [c.x0, c.y0, c.z0, c.x1, c.y1, c.z1] });
    }
    return true;
  }

  // right click with the axe: a 1 m block where you look (on the face you aimed at, or the ground)
  private place(p: PlayerState) {
    if (p.mats < BUILD.cost || this.placed >= BUILD.cap) return;
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const [ox, oy, oz] = aimFrom(this.world, p.x, p.y, p.z, p.yaw, p.pitch, p.tp);
    const c = this.world.placeCell(ox, oy, oz, dx, dy, dz, BUILD.reach);
    if (!c) return;
    const b: Box = { x0: c.x0, y0: c.y0, z0: c.z0, x1: c.x0 + 1, y1: c.y0 + 1, z1: c.z0 + 1, ink: INK.BROWN, kind: 'fort' };
    for (const q of this.players.values()) if (q.alive && q.x + PLAYER_R > b.x0 && q.x - PLAYER_R < b.x1 && q.z + PLAYER_R > b.z0 && q.z - PLAYER_R < b.z1 && q.y < b.y1 && q.y + 1.8 > b.y0) return;
    for (const v of this.vehicles) { const r = VEHICLES[v.kind].r; if (v.body.x + r > b.x0 && v.body.x - r < b.x1 && v.body.z + r > b.z0 && v.body.z - r < b.z1 && v.body.y < b.y1 && v.body.y + VEHICLES[v.kind].h > b.y0) return; }
    this.world.addBoxes([b]); this.wreckAdd.push(b);
    p.mats -= BUILD.cost; this.placed++;
  }

  private usePerk(p: PlayerState, ev: SimEvent[]) {
    if (!p.perk) return;
    const kind = p.perk.kind;
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const ex = p.x + dx * 0.6, ey = p.y + EYE_H - 0.2, ez = p.z + dz * 0.6;
    if (kind === 'c4') {
      // a live charge goes off; otherwise throw one (it sticks where it lands)
      const mine = this.projectiles.filter((g) => g.kind === 'c4' && g.owner === p.id);
      if (mine.length) {
        this.projectiles = this.projectiles.filter((g) => !mine.includes(g));
        for (const g of mine) this.explode(g.x, g.y, g.z, C4.radius, C4.dmg, p.id, ev, false, C4.core);
        if (p.perk && p.perk.n <= 0) p.perk = null;
        return;
      }
      if (p.perk.n <= 0) { p.perk = null; return; }
      this.projectiles.push({ id: this.nextId++, kind: 'c4', owner: p.id, x: ex, y: ey, z: ez, vx: dx * C4.speed + p.vx * 0.5, vy: dy * C4.speed + 3, vz: dz * C4.speed + p.vz * 0.5, t: 120 });
      p.perk.n--;
      return;
    }
    if (kind === 'kit') {
      if (!p.slots[p.cur] || p.ups[p.cur] >= UPGRADE.max) return; // keep the kit for a gun that can take it
      p.ups[p.cur]++;
    } else if (kind === 'grenade' || kind === 'smoke' || kind === 'molotov' || kind === 'shock') {
      const v = GRENADE.speed;
      this.projectiles.push({ id: this.nextId++, kind, owner: p.id, x: ex, y: ey, z: ez, vx: dx * v + p.vx * 0.5, vy: dy * v + 4, vz: dz * v + p.vz * 0.5, t: kind === 'grenade' ? GRENADE.fuse : kind === 'shock' ? SHOCK.fuse : kind === 'molotov' ? 6 : 1.4 });
    } else if (kind === 'launch') {
      const gx = p.x - Math.sin(p.yaw) * 1.6, gz = p.z - Math.cos(p.yaw) * 1.6;
      this.effects.push({ id: this.nextId++, kind: 'pad', owner: p.id, x: gx, y: this.world.groundAt(gx, gz, p.y + 0.2), z: gz, t: PAD.life });
    } else if (kind === 'fort') {
      const s = FORT.size, y = p.y, h = FORT.height, t = 0.3, list: Box[] = [];
      const walls: [number, number, number, number][] = [[-s, -s, s, -s + t], [-s, s - t, s, s], [-s, -s, -s + t, s], [s - t, -s, s, s]];
      for (const [x0, z0, x1, z1] of walls) {
        const b: Box = { x0: p.x + x0, y0: y, z0: p.z + z0, x1: p.x + x1, y1: y + h, z1: p.z + z1, ink: 6, kind: 'fort' };
        // never wall someone else in
        const blocked = [...this.players.values()].some((q) => q.alive && q.id !== p.id && q.x + PLAYER_R > b.x0 && q.x - PLAYER_R < b.x1 && q.z + PLAYER_R > b.z0 && q.z - PLAYER_R < b.z1 && q.y < b.y1 && q.y + 1.8 > b.y0);
        if (!blocked) list.push(b);
      }
      // shards broken off earlier this tick append to the same box list: they go out first, or every client
      // numbered the fort before them and all later kills hit the wrong boxes for the rest of the match
      this.flushWreck(ev);
      const build: Build = { id: this.nextId++, owner: p.id, idx: this.world.addBoxes(list), boxes: list, t: FORT.life };
      this.builds.push(build);
      ev.push({ kind: 'build', id: build.id, boxes: list });
    } else if (kind === 'nuke') {
      // the bomb lands wherever you're looking (or on the ground straight ahead, far away)
      const [ox, oy, oz] = aimFrom(this.world, p.x, p.y, p.z, p.yaw, p.pitch, p.tp);
      let t = this.world.raycast(ox, oy, oz, dx, dy, dz, NUKE.range);
      if (t >= NUKE.range) t = dy < -0.02 ? -oy / dy : 160;
      const tx = clamp(ox + dx * t, -200, 200), tz = clamp(oz + dz * t, -200, 200);
      this.effects.push({ id: this.nextId++, kind: 'nuke', owner: p.id, x: tx, y: 0, z: tz, t: NUKE.delay });
      ev.push({ kind: 'nuke', x: tx, z: tz, by: p.id, at: this.t + NUKE.delay });
    }
    if (--p.perk.n <= 0) p.perk = null;
  }

  private interact(p: PlayerState, ev: SimEvent[]) {
    if (p.rideV) { this.exitVehicle(p); return; }
    for (const q of this.players.values()) if (q.alive && q.down > 0 && q.team === p.team && q.id !== p.id && Math.hypot(q.x - p.x, q.z - p.z) < KNOCK.reach) return; // E is for reviving
    // open the nearest pencil case, otherwise swap for the nearest gun on the floor
    let best: Case | null = null, bd = INTERACT_R;
    for (const c of this.cases) { if (c.open || Math.abs(c.y - p.y) > 1.6) continue; const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = c; } }
    if (best) {
      best.open = true; this.lootVer++;
      const r = this.rand;
      let out: [LootKind, string][];
      if (best.supply) { // supply drop: a legendary, a heavy perk, full shields and a medkit
        out = [['weapon', this.rollWeapon(r, [['legendary', 1]])], ['perk', r() < 0.3 ? 'nuke' : 'c4'], ['item', 'big'], ['item', 'big'], ['item', 'med']];
      } else {
        out = [['weapon', this.rollWeapon(r, best.golden ? GOLD_RARITY : CASE_RARITY)], ['item', weighted(r, ITEM_TABLE)]];
        if (best.golden) { const k = r(); out.push(['perk', k < 0.15 ? 'nuke' : k < 0.5 ? 'c4' : weighted(r, PERK_TABLE)], ['item', 'big']); }
        else if (r() < 0.35) out.push(['perk', weighted(r, PERK_TABLE)]);
      }
      // loot spills out the far side of the case, fanned out, so you choose what to grab
      const away = Math.atan2(best.x - p.x, best.z - p.z);
      for (const [k, what] of [...out]) if (k === 'weapon' && WEAPONS[what as WeaponId].ammo) out.push(['ammo', WEAPONS[what as WeaponId].ammo!]); // each gun with its ammo
      out.push(['ammo', weighted(r, AMMO_TABLE)]);
      out.forEach(([k, what], i) => { const a = away + (i - (out.length - 1) / 2) * 0.55; this.drop(best!.x + Math.sin(a) * 1.4, best!.y, best!.z + Math.cos(a) * 1.4, k, what); });
      ev.push({ kind: 'open', caseId: best.id, by: p.id, golden: best.golden });
      return;
    }
    // an upgrade bench: improves the gun in your hands, once per player per bench
    const bi = this.world.upgrades.findIndex((u) => Math.hypot(u.x - p.x, u.z - p.z) < UPGRADE.benchReach && Math.abs(u.y - 0.95 - p.y) < 1.6);
    if (bi >= 0 && p.slots[p.cur] && p.ups[p.cur] < UPGRADE.max && !this.benchUsed.has(`${bi}:${p.id}`)) {
      this.benchUsed.add(`${bi}:${p.id}`); p.ups[p.cur]++;
      ev.push({ kind: 'upgrade', by: p.id, level: p.ups[p.cur] });
      return;
    }
    let gun: Loot | null = null; bd = INTERACT_R;
    for (const l of this.loot) { if (l.kind !== 'weapon' || Math.abs(l.y - p.y) > 1.6) continue; const d = Math.hypot(l.x - p.x, l.z - p.z); if (d < bd) { bd = d; gun = l; } }
    if (!gun) {
      const v = this.nearVehicle(p);
      if (v && !v.driver) this.enterVehicle(p, v);
      else if (v) { // ride along with your teammate
        v.seats.push(p.id); p.rideV = v.id; p.ride = VEHICLE_KINDS.indexOf(v.kind) + 1; p.seat = v.seats.length;
        p.gliding = false; p.hook = false; p.use = null;
      }
      return;
    }
    let slot = p.slots.findIndex((s) => s === null);
    if (slot < 0) { // full: drop what's in hand
      slot = p.cur;
      const held = p.slots[slot];
      if (held) this.drop(p.x, this.world.groundAt(p.x, p.z, p.y + 0.1), p.z, 'weapon', held, 1, p.mags[slot], p.ups[slot]);
    }
    p.slots[slot] = gun.what as WeaponId; p.mags[slot] = gun.mag ?? WEAPONS[gun.what as WeaponId].mag; p.ups[slot] = gun.up ?? 0; p.cur = slot; p.reloadT = 0; p.axe = false;
    this.loot.splice(this.loot.indexOf(gun), 1); this.lootVer++;
  }

  // loot bucketed in 4 m cells, rebuilt whenever loot changes, so pickup checks only nearby items
  private lootGrid = new Map<number, Loot[]>();
  private lootGridVer = -1;
  private nearLoot(x: number, z: number): Loot[] {
    if (this.lootGridVer !== this.lootVer) {
      this.lootGrid.clear();
      for (const l of this.loot) { const k = Math.floor(l.x / 4) * 4096 + Math.floor(l.z / 4); const b = this.lootGrid.get(k); if (b) b.push(l); else this.lootGrid.set(k, [l]); }
      this.lootGridVer = this.lootVer;
    }
    const out: Loot[] = [], cx = Math.floor(x / 4), cz = Math.floor(z / 4);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const b = this.lootGrid.get((cx + i) * 4096 + cz + j); if (b) out.push(...b); }
    return out;
  }

  // walking over shields, heals, perks and (with a free slot) guns picks them up
  private autoPickup(p: PlayerState) {
    const near = this.nearLoot(p.x, p.z);
    for (let n = near.length - 1; n >= 0; n--) {
      const l = near[n];
      if (Math.abs(l.y - p.y) > 1.4 || Math.hypot(l.x - p.x, l.z - p.z) > 1.5) continue;
      const i = this.loot.indexOf(l);
      if (i < 0) continue;
      if (l.kind === 'item') {
        const it = l.what as ItemId, room = ITEMS[it].max - p.items[it];
        if (room <= 0) continue;
        const take = Math.min(room, l.n);
        p.items[it] += take; l.n -= take;
        if (l.n > 0) { this.lootVer++; continue; }
      } else if (l.kind === 'ammo') {
        const a = l.what as AmmoId, take = Math.min(AMMO[a].max - p.ammo[a], l.n);
        if (take <= 0) continue;
        p.ammo[a] += take; l.n -= take;
        if (l.n > 0) { this.lootVer++; continue; }
      } else if (l.kind === 'perk') {
        if (p.perk && p.perk.kind !== l.what) continue;
        const cap = PERKS[l.what as PerkId].count * 2;
        if (p.perk) { if (p.perk.n >= cap) continue; p.perk.n = Math.min(cap, p.perk.n + l.n); }
        else p.perk = { kind: l.what as PerkId, n: l.n };
      } else {
        const slot = p.slots.findIndex((s) => s === null);
        if (slot < 0 || p.slots.includes(l.what as WeaponId)) continue;
        p.slots[slot] = l.what as WeaponId; p.mags[slot] = l.mag ?? WEAPONS[l.what as WeaponId].mag; p.ups[slot] = l.up ?? 0;
        if (p.axe && p.slots.filter(Boolean).length === 1) { p.axe = false; p.cur = slot; } // your first gun goes straight to your hands
      }
      this.loot.splice(i, 1); this.lootVer++;
    }
  }

  // a rocket or missile: straight (or steering toward its locked aircraft), in short sub-steps so it
  // can't skip through a thin wall; it blows up on anything solid, any player or vehicle it reaches
  private stepRocket(g: Projectile, dt: number, ev: SimEvent[]): boolean {
    const radius = g.r ?? (g.kind === 'rocket' ? ROCKET.radius : MISSILE.radius), dmg = g.dmg ?? 100; // tank shells carry their own blast
    const tgt = g.tgt !== undefined ? this.vehicles.find((v) => v.id === g.tgt) : null;
    let aim: { x: number; y: number; z: number } | null = tgt ? { x: tgt.body.x, y: tgt.body.y + 1, z: tgt.body.z } : null;
    const pilot = g.kind === 'guided' ? this.players.get(g.owner) : null;
    if (pilot?.alive && pilot.slots[pilot.cur] === 'guided' && !pilot.axe && !pilot.down) {
      // guided: toward whatever the pilot's crosshair is on right now
      const [ox, oy, oz] = aimFrom(this.world, pilot.x, pilot.y, pilot.z, pilot.yaw, pilot.pitch, pilot.tp);
      const cp = Math.cos(pilot.pitch), dx = -Math.sin(pilot.yaw) * cp, dy = Math.sin(pilot.pitch), dz = -Math.cos(pilot.yaw) * cp;
      const t = Math.max(8, this.world.raycast(ox, oy, oz, dx, dy, dz, 450));
      aim = { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t };
    }
    if (aim) {
      const tx = aim.x - g.x, ty = aim.y - g.y, tz = aim.z - g.z, d = Math.hypot(tx, ty, tz) || 1, sp = Math.hypot(g.vx, g.vy, g.vz);
      const k = Math.min(1, (g.kind === 'guided' ? GUIDED.turn : MISSILE.turn) * dt);
      g.vx += ((tx / d) * sp - g.vx) * k; g.vy += ((ty / d) * sp - g.vy) * k; g.vz += ((tz / d) * sp - g.vz) * k;
      const s2 = Math.hypot(g.vx, g.vy, g.vz) || 1; g.vx *= sp / s2; g.vy *= sp / s2; g.vz *= sp / s2; // turning doesn't slow it
    }
    for (let s = 0; s < 4; s++) {
      const nx = g.x + (g.vx * dt) / 4, ny = g.y + (g.vy * dt) / 4, nz = g.z + (g.vz * dt) / 4;
      const hitWorld = ny < 0.05 || this.world.near(nx, nz, nx, nz).some((i) => { const q = this.world.boxes[i]; return !q.dead && nx > q.x0 && nx < q.x1 && nz > q.z0 && nz < q.z1 && ny > q.y0 && ny < q.y1; });
      const owner = this.players.get(g.owner); // a passenger's own rocket doesn't blow up on their own vehicle
      const hitVeh = this.vehicles.some((v) => v.driver !== g.owner && v.id !== owner?.rideV && Math.hypot(v.body.x - nx, v.body.z - nz) < VEHICLES[v.kind].r + 0.8 && ny > v.body.y - 0.5 && ny < v.body.y + VEHICLES[v.kind].h + 0.8);
      const victim = [...this.players.values()].find((q) => q.alive && q.id !== g.owner && (!owner || q.team !== owner.team) && !(covered(q.ride) && !q.seat) && Math.hypot(q.x - nx, q.z - nz) < (g.kind === 'spell' ? 0.8 : 0.7) && ny > q.y && ny < q.y + 1.9);
      g.x = nx; g.y = ny; g.z = nz;
      if (g.kind === 'spell' && (hitWorld || hitVeh || victim)) { if (victim) this.spellHit(g, victim, ev); ev.push({ kind: 'zap', x: g.x, y: g.y, z: g.z }); return false; }
      if (hitWorld || hitVeh || victim) { this.explode(g.x, Math.max(0.3, g.y), g.z, radius, dmg, g.owner, ev, false, 1.5); return false; }
    }
    if ((g.t -= dt) <= 0) { if (g.kind === 'spell') ev.push({ kind: 'zap', x: g.x, y: g.y, z: g.z }); else this.explode(g.x, g.y, g.z, radius, dmg, g.owner, ev, false, 1.5); return false; }
    return true;
  }
  // the wand's spell landed on someone: it hurts, and throws them back the way it was flying, off their feet
  private spellHit(g: Projectile, q: PlayerState, ev: SimEvent[]) {
    const amount = Math.round(g.dmg ?? 40), h = this.hurt(q, amount), sp = Math.hypot(g.vx, g.vz) || 1;
    ev.push({ kind: 'hit', victim: q.id, by: g.owner, dmg: amount, head: false, ...h });
    if (!q.ride) {
      q.vx = (g.vx / sp) * SPELL.push; q.vz = (g.vz / sp) * SPELL.push; q.vy = Math.max(q.vy, SPELL.lift);
      q.grounded = false; q.gliding = false; q.slideT = 0; q.mantleT = 0; q.hook = false; q.dashT = 0;
    }
    if (q.hp <= 0) this.fall(q, g.owner, 'shot', ev);
  }

  // a shockwave grenade: no damage, it throws everyone nearby (you too) through the air
  private shockwave(x: number, y: number, z: number, ev: SimEvent[]) {
    ev.push({ kind: 'boom', x, y, z, r: SHOCK.radius, nuke: false });
    for (const q of this.players.values()) {
      if (!q.alive || q.ride) continue;
      const dx = q.x - x, dz = q.z - z, d = Math.hypot(dx, q.y + 1 - y, dz);
      if (d > SHOCK.radius) continue;
      const k = (1 - d / SHOCK.radius) * SHOCK.push + 6, l = Math.hypot(dx, dz) || 1;
      q.vx += (dx / l) * k * 0.8; q.vz += (dz / l) * k * 0.8; q.vy = Math.max(q.vy, k * 0.75); q.grounded = false; q.gliding = false; q.slideT = 0;
    }
  }

  private stepProjectiles(dt: number, ev: SimEvent[]) {
    const keep: Projectile[] = [];
    for (const g of this.projectiles) {
      if (g.kind === 'rocket' || g.kind === 'missile' || g.kind === 'guided' || g.kind === 'spell') { if (this.stepRocket(g, dt, ev)) keep.push(g); continue; }
      if (g.stuck) { if ((g.t -= dt) > 0) keep.push(g); else this.explode(g.x, g.y, g.z, C4.radius, C4.dmg, g.owner, ev, false, C4.core); continue; }
      g.vy -= GRAVITY * dt;
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt, nz = g.z + g.vz * dt;
      // bounce off the ground and anything solid (bombs go off, C4 sticks)
      const b = this.world.near(nx, nz, nx, nz).map((i) => this.world.boxes[i]).find((q) => !q.dead && nx > q.x0 && nx < q.x1 && nz > q.z0 && nz < q.z1 && ny > q.y0 && ny < q.y1);
      if ((b || ny < 0.05) && g.kind === 'molotov') { // shatters: a patch of fire where it lands
        const fy = b && g.y >= b.y1 - 0.15 ? b.y1 : this.world.groundAt(g.x, g.z, g.y + 0.2);
        this.effects.push({ id: this.nextId++, kind: 'fire', owner: g.owner, x: g.x, y: fy, z: g.z, t: MOLOTOV.life });
        ev.push({ kind: 'boom', x: g.x, y: fy, z: g.z, r: 2, nuke: false });
        continue;
      }
      if ((b || ny < 0.05) && (g.kind === 'bomb' || g.kind === 'c4')) {
        if (g.kind === 'bomb') { this.explode(g.x, Math.max(0.3, g.y), g.z, BOMB.radius, BOMB.dmg, g.owner, ev, false); continue; }
        g.stuck = true; g.y = b && g.y >= b.y1 - 0.15 ? b.y1 + 0.05 : Math.max(0.05, g.y); keep.push(g); continue;
      }
      if (b) {
        if (g.y >= b.y1 - 0.05) { g.vy = -g.vy * 0.35; g.y = b.y1 + 0.02; }
        else if (g.x <= b.x0 || g.x >= b.x1) g.vx = -g.vx * 0.4;
        else g.vz = -g.vz * 0.4;
        g.vx *= 0.7; g.vz *= 0.7;
      } else { g.x = nx; g.y = ny; g.z = nz; }
      if (g.y < 0.05) { g.y = 0.05; g.vy = Math.abs(g.vy) * 0.35; g.vx *= 0.7; g.vz *= 0.7; }
      g.t -= dt;
      if (g.t > 0) { keep.push(g); continue; }
      if (g.kind === 'grenade') this.explode(g.x, g.y, g.z, GRENADE.radius, GRENADE.dmg, g.owner, ev, false);
      else if (g.kind === 'shock') this.shockwave(g.x, g.y, g.z, ev);
      else if (g.kind === 'molotov') this.effects.push({ id: this.nextId++, kind: 'fire', owner: g.owner, x: g.x, y: this.world.groundAt(g.x, g.z, g.y + 0.2), z: g.z, t: MOLOTOV.life });
      else if (g.kind === 'bomb' || g.kind === 'c4') this.explode(g.x, g.y, g.z, g.kind === 'bomb' ? BOMB.radius : C4.radius, g.kind === 'bomb' ? BOMB.dmg : C4.dmg, g.owner, ev, false);
      else this.effects.push({ id: this.nextId++, kind: 'smoke', owner: g.owner, x: g.x, y: g.y, z: g.z, t: SMOKE.life });
    }
    this.projectiles = keep;
  }

  private stepEffects(dt: number, ev: SimEvent[]) {
    const keep: Effect[] = [];
    for (const e of this.effects) {
      if (e.kind === 'drop') {
        e.y -= SUPPLY.fall * dt;
        const g = this.world.groundAt(e.x, e.z, e.y + 0.5);
        if (e.y > g) { keep.push(e); continue; }
        const at = this.world.settle(e.x, g, e.z, 0.55, 1) ?? { x: e.x, y: g, z: e.z };
        this.cases.push({ id: this.nextId++, x: at.x, y: at.y, z: at.z, golden: true, open: false, supply: true }); this.lootVer++;
        ev.push({ kind: 'drop', x: at.x, z: at.z, landed: true });
        continue;
      }
      e.t -= dt;
      if (e.kind === 'fire' && this.tick % 10 === 0) { // burns whoever stands in it (its thrower included)
        const owner = this.players.get(e.owner);
        for (const q of this.players.values()) {
          if (!q.alive || (covered(q.ride) && !q.seat) || (owner && q.id !== owner.id && q.team === owner.team)) continue;
          if (Math.hypot(q.x - e.x, q.z - e.z) > MOLOTOV.radius || Math.abs(q.y - e.y) > 2.5) continue;
          const dmg = Math.round(MOLOTOV.dps / 3), h = this.hurt(q, dmg);
          if (q.id !== e.owner) ev.push({ kind: 'hit', victim: q.id, by: e.owner, dmg, head: false, ...h });
          if (q.hp <= 0) this.fall(q, q.id === e.owner ? null : e.owner, 'boom', ev);
        }
      }
      if (e.kind === 'pad') for (const p of this.players.values()) {
        // not vehicles (thrown 11 m, a wrecked landing), not the knocked
        if (p.alive && p.grounded && !p.ride && p.down === 0 && Math.hypot(p.x - e.x, p.z - e.z) < 1.4 && Math.abs(p.y - e.y) < 0.6) { p.vy = PAD.launch; p.grounded = false; p.launchT = 1.1; p.slideT = 0; }
      }
      if (e.t > 0) { keep.push(e); continue; }
      if (e.kind === 'nuke') this.explode(e.x, 0, e.z, NUKE.radius, NUKE.dmg, e.owner, ev, true);
    }
    this.effects = keep;
    for (const b of this.builds) b.t -= dt;
    for (const b of this.builds.filter((x) => x.t <= 0)) { this.world.killBoxes(this.world.withShards(b.idx)); ev.push({ kind: 'unbuild', id: b.id }); }
    this.builds = this.builds.filter((x) => x.t > 0);
  }

  // one of a player's inputs: their own timeline (aim, movement, cooldowns, shooting, healing)
  private playerInput(p: PlayerState, inp: Input, dt: number, ev: SimEvent[]) {
    const fresh = inp.seq !== p.ack; // (an idle tick repeats the last seq: aboard the plane it moves nobody, as on the client)
    p.ack = inp.seq;
    p.yaw = inp.yaw; p.pitch = inp.pitch; p.tp = !!inp.tp;
    if (p.bus) { if (fresh) moveStep(this.world, p, inp, dt); return; } // aboard: look around, jump out when you like
    p.fireCd = Math.max(0, p.fireCd - dt);
    p.burstT = Math.max(0, p.burstT - dt);
    if (p.down > 0) { moveStep(this.world, p, inp, dt); return; } // knocked: crawl, nothing else (bleeding is per tick)

    p.axeCd = Math.max(0, p.axeCd - dt);
    if (inp.slot >= 1 && inp.slot <= SLOTS && p.slots[inp.slot - 1] && (inp.slot - 1 !== p.cur || p.axe)) {
      p.cur = inp.slot - 1; p.reloadT = 0; p.spin = 0; p.burstLeft = 0; p.use = null; p.fireCd = Math.max(p.fireCd, 0.25); p.axe = false;
    } else if (inp.slot === SLOTS + 1 && !p.axe) { p.axe = true; p.reloadT = 0; p.spin = 0; p.burstLeft = 0; p.use = null; p.axeCd = Math.max(p.axeCd, 0.2); } // swapping can't skip the swing cooldown
    if (inp.interact && !p.gliding) this.interact(p, ev);
    if (inp.perk && !p.gliding && (!p.ride || p.seat > 0)) this.usePerk(p, ev); // passengers can throw things too
    if (!p.alive || p.down > 0) return; // blew themselves up with their own C4: no healing, moving or looting after

    // healing / shielding takes time and you walk slowly while doing it
    if (inp.item && !p.use && !p.gliding && !p.ride) {
      const big = p.items.big > 0 && p.shield < SHIELD_MAX, mini = p.items.mini > 0 && p.shield < (ITEMS.mini.shieldCap ?? 50);
      const it: ItemId | null = inp.item === 2 ? (p.items.med > 0 && p.hp < PLAYER_HP ? 'med' : null)
        : inp.item === 3 ? (mini ? 'mini' : null) : inp.item === 4 ? (big ? 'big' : null)
        : big ? 'big' : mini ? 'mini' : null;
      if (it) { p.use = { item: it, t: ITEMS[it].use }; p.reloadT = 0; }
    }
    if (p.use) {
      if (inp.fire || inp.slot) p.use = null;
      else if ((p.use.t -= dt) <= 0) {
        const def = ITEMS[p.use.item];
        p.items[p.use.item]--;
        if (def.shield) p.shield = Math.min(def.shieldCap ?? SHIELD_MAX, p.shield + def.shield);
        if (def.heal) p.hp = Math.min(PLAYER_HP, p.hp + def.heal);
        p.use = null;
      }
    }

    const w = p.axe ? null : this.weaponOf(p);
    if (w) {
      const def = WEAPONS[w];
      // a reload fills the magazine from your reserve of its ammo (as far as it goes); with none left there's no reload
      const spare = def.ammo ? p.ammo[def.ammo] : Infinity;
      if (p.reloadT > 0) {
        p.reloadT -= dt;
        if (p.reloadT <= 0) { const take = Math.min(def.mag - p.mags[p.cur], spare); p.reloadT = 0; p.mags[p.cur] += take; if (def.ammo) p.ammo[def.ammo] -= take; }
      } else if (spare > 0 && ((inp.reload && p.mags[p.cur] < def.mag) || (inp.fire && p.mags[p.cur] === 0 && p.burstLeft === 0))) { p.reloadT = def.reload; p.use = null; }
    }

    const vx0 = p.vx, vy0 = p.vy, vz0 = p.vz, was = p.grounded;
    const impact = moveStep(this.world, p, inp, dt, !!p.use);
    if (p.rideV) {
      // crashes dent the vehicle (an aircraft fast enough is wrecked and blows up); aircraft guns and bombs
      const v = this.vehicles.find((x) => x.id === p.rideV);
      if (v && v.kind === 'tank') { if (impact > 0) this.crashWorld(p, v, impact); } // tracks plough through walls, no damage to the tank
      else if (v && isAir(p.ride) && impact > (p.grounded && !was ? AIR_CRASH.land : AIR_CRASH.minSpeed)) this.airCrash(v, p, impact, { x: vx0, y: vy0, z: vz0 }, p.id, ev);
      else if (v && impact > CRASH.minSpeed) { this.crashWorld(p, v, impact); this.damageVehicle(v, Math.round((impact - CRASH.minSpeed) * CRASH.dmgPerMs), p.id, ev); }
      if (covered(p.ride) && !p.seat) this.vehicleGuns(p, inp, ev);
    } else this.autoPickup(p);
    if (!p.alive || p.down > 0) return;

    // the axe: left click swings, right click places a block
    if (p.axe && !p.gliding && !p.ride && !p.use && !this.reviving.has(p.id) && p.axeCd === 0) {
      if (inp.fire) { p.axeCd = AXE.cd; this.swing(p, ev); }
      else if (inp.aim) { p.axeCd = BUILD.cd; this.place(p); }
    }
    // on foot, or leaning out of a car window (drive-by); never from inside an aircraft
    if (w && !p.gliding && p.reloadT === 0 && !p.use && !this.reviving.has(p.id) && (!covered(p.ride) || p.seat > 0)) {
      const def = WEAPONS[w];
      if (def.spinUp) p.spin = inp.fire ? Math.min(def.spinUp, p.spin + dt) : Math.max(0, p.spin - dt * 2);
      const spunUp = !def.spinUp || p.spin >= def.spinUp;
      if (def.burst) {
        if (inp.fire && p.fireCd === 0 && p.burstLeft === 0 && p.mags[p.cur] > 0) p.burstLeft = Math.min(def.burst, p.mags[p.cur]);
        if (p.burstLeft > 0 && p.burstT === 0) {
          this.shoot(p, w, inp, ev); p.burstLeft--; p.burstT = BURST_GAP;
          if (p.burstLeft === 0) p.fireCd = def.cd;
        }
      } else if (inp.fire && spunUp && p.fireCd === 0 && p.mags[p.cur] > 0) { p.fireCd = def.cd; this.shoot(p, w, inp, ev); }
    }
  }

  step(dt: number, inputs: TickInputs): SimEvent[] {
    const ev: SimEvent[] = [];
    this.t += dt; this.tick++;
    this.stepBus(); // the plane moves first: who jumps this tick leaves from where it is now
    this.stepRing(dt);
    const ring = this.ring;
    // supply drops: one a minute in, then one every time the storm moves on
    if (this.pendingDrop || (this.tick === Math.round(60 / dt))) { this.pendingDrop = false; this.supplyDrop(ev); }
    this.stepRevives(dt, inputs, ev);

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const got = inputs.get(p.id);
      // an entry with no inputs: this player's input is late, their body waits the tick (the server
      // catches up next tick). No entry at all (left, or a caller that doesn't track inputs): idle.
      const list = got === undefined ? [{ ...emptyInput(), yaw: p.yaw, pitch: p.pitch, seq: p.ack }] : Array.isArray(got) ? got : [got];
      for (const inp of list) { if (!p.alive) break; this.playerInput(p, inp, dt, ev); }
      if (!p.alive) continue;
      // world time, not the player's: bleeding out and the storm go on whether or not an input came
      if (p.down > 0 && (p.down -= dt) <= 0) { p.down = 0.001; this.eliminate(p.id, p.downBy, 'shot', ev); continue; }
      if (Math.hypot(p.x - ring.x, p.z - ring.y) > ring.r) {
        this.hurt(p, ring.dps * dt, true);
        if (p.hp <= 0) this.fall(p, null, 'ring', ev);
      }
    }

    this.stepVehicles(dt, ev);
    this.stepProjectiles(dt, ev);
    this.stepEffects(dt, ev);
    if (this.dirty.length) this.dropLoose(ev); // anything broke this tick (a fort may already have flushed the kills)
    this.flushWreck(ev);
    this.settleWreck(ev);

    const pos = new Map<number, { x: number; y: number; z: number }>();
    for (const p of this.players.values()) if (p.alive) pos.set(p.id, { x: p.x, y: p.y, z: p.z });
    this.history.push({ tick: this.tick, pos });
    if (this.history.length > REWIND_MAX_TICKS + 2) this.history.shift();
    for (const e of ev) if (e.kind === 'hit' && e.by && e.by !== e.victim) { const v = this.players.get(e.victim); if (v) v.hitBy = e.by; }
    return ev;
  }
}
