// King of the Hill Royale simulation: first person, 3D, up to 100 players. Authoritative on the
// server, mirrored in the offline demo. Deterministic for a seed; no timers, no I/O.
// Loot comes from the floor and from pencil cases; the fallen drop everything they carried.
import {
  EYE_H, FORT, GRAVITY, GRENADE, HEADSHOT_MULT, HEAD_R, HEAD_Y, INTERACT_R, ITEMS, JUMP_V, NUKE, PAD, PERKS,
  PLAYER_HP, PLAYER_R, REWIND_MAX_TICKS, RING_DPS_START, RING_PHASES, RING_START_R, SHIELD_MAX, SLOTS, SMOKE,
  SPRINT_SPEED, WALK_SPEED, WEAPONS, WEAPON_IDS, type ItemId, type PerkId, type Rarity, type WeaponId,
} from './constants.ts';
import { rng } from './rng.ts';
import { World, moveBody, newBody, type Body, type Box } from './world.ts';

export { rng };

export type LootKind = 'weapon' | 'item' | 'perk';
export interface Loot { id: number; x: number; y: number; z: number; kind: LootKind; what: string; n: number; mag?: number }
export interface Case { id: number; x: number; y: number; z: number; golden: boolean; open: boolean }
export interface Projectile { id: number; kind: 'grenade' | 'smoke'; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }
export interface Effect { id: number; kind: 'smoke' | 'pad' | 'nuke'; owner: number; x: number; y: number; z: number; t: number }
export interface Build { id: number; owner: number; idx: number[]; boxes: Box[]; t: number }

export interface PlayerState extends Body {
  id: number; yaw: number; pitch: number; hp: number; shield: number; alive: boolean;
  slots: (WeaponId | null)[]; mags: number[]; cur: number;
  items: Record<ItemId, number>; perk: { kind: PerkId; n: number } | null;
  use: { item: ItemId; t: number } | null;
  reloadT: number; fireCd: number; spin: number; burstLeft: number; burstT: number;
  kills: number; ack: number; team: number;
}
export interface Input {
  seq: number; fwd: number; strafe: number; yaw: number; pitch: number;
  jump: boolean; sprint: boolean; slide: boolean; grapple: boolean;
  fire: boolean; aim: boolean; reload: boolean; slot: number; view: number;
  interact: boolean; item: number; perk: boolean; // item: 1 = best shield, 2 = medkit
}
export interface Ring { x: number; y: number; r: number; nx: number; ny: number; nr: number; phase: number; closing: boolean; dps: number; nextAt: number }
export interface Shot { ox: number; oy: number; oz: number; ex: number; ey: number; ez: number; by: number; hit: boolean }
export type ElimCause = 'shot' | 'ring' | 'left' | 'boom';
export type SimEvent =
  | { kind: 'hit'; victim: number; by: number; dmg: number; head: boolean; shield: boolean; broke: boolean }
  | { kind: 'elim'; victim: number; by: number | null; cause: ElimCause; head: boolean }
  | { kind: 'boom'; x: number; y: number; z: number; r: number; nuke: boolean }
  | { kind: 'build'; id: number; boxes: Box[] }
  | { kind: 'unbuild'; id: number }
  | { kind: 'nuke'; x: number; z: number; by: number; at: number }
  | { kind: 'open'; caseId: number; by: number; golden: boolean };

export const emptyInput = (): Input => ({ seq: 0, fwd: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false, slide: false, grapple: false, fire: false, aim: false, reload: false, slot: 0, view: 0, interact: false, item: 0, perk: false });

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// inputs come from the network: never trust shape or range
export function sanitizeInput(raw: Partial<Input> | undefined): Input {
  return {
    seq: Math.floor(finite(raw?.seq)), fwd: clamp(finite(raw?.fwd), -1, 1), strafe: clamp(finite(raw?.strafe), -1, 1),
    yaw: finite(raw?.yaw), pitch: clamp(finite(raw?.pitch), -1.5, 1.5),
    jump: raw?.jump === true, sprint: raw?.sprint === true, slide: raw?.slide === true, grapple: raw?.grapple === true,
    fire: raw?.fire === true, aim: raw?.aim === true, reload: raw?.reload === true,
    slot: clamp(Math.floor(finite(raw?.slot)), 0, SLOTS), view: Math.floor(finite(raw?.view)),
    interact: raw?.interact === true, item: clamp(Math.floor(finite(raw?.item)), 0, 2), perk: raw?.perk === true,
  };
}

export const moveStep = (w: World, p: Body, inp: Input, dt: number, using = false) =>
  moveBody(w, p, { ...inp, sprint: inp.sprint && !inp.aim && !using }, dt, GRAVITY, inp.aim || using ? WALK_SPEED * 0.55 : WALK_SPEED, SPRINT_SPEED, JUMP_V);

// accuracy: aiming tightens it, moving and being airborne loosen it
export function spreadFor(p: Body, w: WeaponId, aim: boolean): number {
  const base = WEAPONS[w].spread, speed = Math.hypot(p.vx, p.vz);
  const scoped = w === 'heavy' || w === 'hunting';
  let s = base * (aim ? (scoped ? 0.02 : 0.5) : 1) * (1 + speed / 8);
  if (!p.grounded) s *= 2;
  return s;
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
const GOLD_RARITY: [Rarity, number][] = [['rare', 30], ['epic', 45], ['legendary', 25]];
const ITEM_TABLE: [ItemId, number][] = [['mini', 50], ['big', 25], ['med', 25]];
const PERK_TABLE: [PerkId, number][] = [['grenade', 40], ['smoke', 25], ['launch', 20], ['fort', 15]];

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
      const t = (-br - Math.sqrt(dr)) / a2, y = oy + dy * t;
      if (t >= 0 && y >= py && y <= py + HEAD_Y - HEAD_R && (!best || t < best.t)) best = { t, head: false };
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
  ring: Ring;
  shots: Shot[] = [];   // drained by whoever encodes snapshots
  lootVer = 0;
  t = 0;
  tick = 0;
  private rand: () => number;
  private phaseStart = 0;
  private from = { x: 0, y: 0, r: RING_START_R };
  private history: { tick: number; pos: Map<number, { x: number; y: number; z: number }> }[] = [];
  private nextId = 1;

  constructor(public seed: number, world?: World) {
    this.world = world ?? new World(seed);
    this.rand = rng(seed ^ 0x9e3779b9);
    const first = RING_PHASES[0], c = this.nextCircle(0, 0, 0, RING_START_R - 110, first.radius);
    this.ring = { x: 0, y: 0, r: RING_START_R, nx: c.x, ny: c.y, nr: first.radius, phase: 0, closing: false, dps: RING_DPS_START, nextAt: first.wait };
    const lr = rng(seed ^ 0x5bd1e995);
    for (const s of this.world.caseSpots) this.cases.push({ id: this.nextId++, x: s.x, y: s.y, z: s.z, golden: !!s.golden, open: false });
    for (const s of this.world.lootSpots) {
      const roll = lr();
      if (roll < 0.6) this.drop(s.x, s.y, s.z, 'weapon', this.rollWeapon(lr, FLOOR_RARITY));
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

  drop(x: number, y: number, z: number, kind: LootKind, what: string, n = 1, mag?: number) {
    const def = kind === 'weapon' ? WEAPONS[what as WeaponId] : null;
    this.loot.push({ id: this.nextId++, x, y, z, kind, what, n: kind === 'perk' ? PERKS[what as PerkId].count : n, mag: def ? (mag ?? def.mag) : undefined });
    this.lootVer++;
  }

  // everyone drops in from the sky over the island and glides down wherever they like
  // teammates (same team number) jump from the same spot, a few meters apart
  spawn(ids: number[], teamOf?: Map<number, number>) {
    const drop = new Map<number, { x: number; z: number; n: number }>();
    ids.forEach((id) => {
      const team = teamOf?.get(id) ?? id;
      let at = drop.get(team);
      if (!at) { const a = this.rand() * Math.PI * 2, d = 40 + Math.sqrt(this.rand()) * 140; at = { x: Math.cos(a) * d, z: Math.sin(a) * d, n: 0 }; drop.set(team, at); }
      const k = at.n++, x = at.x + (k % 2) * 3 - 1.5 * Math.min(1, k), z = at.z + Math.floor(k / 2) * 3;
      this.players.set(id, {
        ...newBody(x, 95 + this.rand() * 15, z), gliding: true, id,
        yaw: Math.atan2(x, z), pitch: -0.5, hp: PLAYER_HP, shield: 0, alive: true,
        slots: ['pistol', null, null, null], mags: [WEAPONS.pistol.mag, 0, 0, 0], cur: 0,
        items: { mini: 0, big: 0, med: 0 }, perk: null, use: null,
        reloadT: 0, fireCd: 0.5, spin: 0, burstLeft: 0, burstT: 0, kills: 0, ack: 0, team,
      });
    });
  }

  get alive() { let n = 0; for (const p of this.players.values()) if (p.alive) n++; return n; }
  // teams with someone still standing (in solo every player is their own team)
  get teamsAlive() { const s = new Set<number>(); for (const p of this.players.values()) if (p.alive) s.add(p.team); return s; }
  friends(a: PlayerState, b: PlayerState) { return a.team === b.team; }
  weaponOf(p: PlayerState): WeaponId | null { return p.slots[p.cur]; }

  eliminate(id: number, by: number | null, cause: ElimCause, ev: SimEvent[], head = false) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false; p.hp = 0; p.shield = 0;
    if (by !== null && by !== id) { const k = this.players.get(by); if (k) k.kills++; }
    // everything they carried spills on the floor in a little ring
    const gy = this.world.groundAt(p.x, p.z, p.y + 0.1);
    const spill: [LootKind, string, number, number | undefined][] = [];
    p.slots.forEach((w, i) => { if (w && w !== 'pistol') spill.push(['weapon', w, 1, p.mags[i]]); });
    for (const it of Object.keys(p.items) as ItemId[]) if (p.items[it] > 0) spill.push(['item', it, p.items[it], undefined]);
    if (p.perk) spill.push(['perk', p.perk.kind, p.perk.n, undefined]);
    spill.forEach(([k, what, n, mag], i) => {
      const a = (i / Math.max(1, spill.length)) * Math.PI * 2;
      this.drop(p.x + Math.cos(a) * 1.2, gy, p.z + Math.sin(a) * 1.2, k, what, n, mag);
      if (k === 'perk') this.loot[this.loot.length - 1].n = n;
    });
    ev.push({ kind: 'elim', victim: id, by, cause, head });
  }

  private stepRing() {
    const ring = this.ring, phase = RING_PHASES[ring.phase];
    if (!phase) return;
    const since = this.t - this.phaseStart;
    if (since < phase.wait) { ring.closing = false; ring.nextAt = this.phaseStart + phase.wait; return; }
    ring.closing = true;
    const k = Math.min(1, (since - phase.wait) / phase.shrink);
    ring.x = this.from.x + (ring.nx - this.from.x) * k;
    ring.y = this.from.y + (ring.ny - this.from.y) * k;
    ring.r = this.from.r + (ring.nr - this.from.r) * k;
    ring.nextAt = this.phaseStart + phase.wait + phase.shrink;
    if (k >= 1) {
      ring.dps = phase.dps; ring.phase++; this.phaseStart = this.t;
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
    p.mags[p.cur]--;
    const spread = spreadFor(p, w, inp.aim);
    const view = clamp(inp.view, this.tick - REWIND_MAX_TICKS, this.tick);
    const past = this.positionsAt(view);
    const ox = p.x, oy = p.y + EYE_H, oz = p.z;
    for (let i = 0; i < def.pellets; i++) {
      const yaw = p.yaw + (this.rand() - 0.5) * 2 * spread, pitch = p.pitch + (this.rand() - 0.5) * 2 * spread;
      const cp = Math.cos(pitch), dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
      const tWorld = this.world.raycast(ox, oy, oz, dx, dy, dz, def.range);
      let hit: { t: number; head: boolean; q: PlayerState } | null = null;
      for (const q of this.players.values()) {
        if (!q.alive || q.id === p.id || q.team === p.team) continue; // no friendly fire
        const at = past?.get(q.id) ?? q;
        if (Math.abs(at.x - ox) > def.range || Math.abs(at.z - oz) > def.range) continue;
        const h = rayPlayer(ox, oy, oz, dx, dy, dz, at.x, at.y, at.z);
        if (h && h.t < tWorld && (!hit || h.t < hit.t)) hit = { ...h, q };
      }
      const t = hit ? hit.t : tWorld;
      this.shots.push({ ox, oy, oz, ex: ox + dx * t, ey: oy + dy * t, ez: oz + dz * t, by: p.id, hit: !!hit });
      if (hit && hit.q.alive) {
        // pellets and long range fall off a little; headshots multiply
        const falloff = def.pellets > 1 ? clamp(1.2 - hit.t / def.range, 0.35, 1) : 1;
        const dmg = Math.round(def.dmg * falloff * (hit.head ? (def.headMult ?? HEADSHOT_MULT) : 1));
        const h = this.hurt(hit.q, dmg);
        ev.push({ kind: 'hit', victim: hit.q.id, by: p.id, dmg, head: hit.head, ...h });
        if (hit.q.hp <= 0) this.eliminate(hit.q.id, p.id, 'shot', ev, hit.head);
      }
    }
  }

  private explode(x: number, y: number, z: number, radius: number, dmg: number, owner: number, ev: SimEvent[], nuke: boolean) {
    ev.push({ kind: 'boom', x, y, z, r: radius, nuke });
    const team = this.players.get(owner)?.team;
    for (const q of this.players.values()) {
      if (!q.alive || (q.id !== owner && q.team === team)) continue;
      const dx = q.x - x, dy = q.y + 1 - y, dz = q.z - z, d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      if (!nuke) { // walls stop grenade blasts
        const tx = dx / (d || 1), ty = dy / (d || 1), tz = dz / (d || 1);
        if (this.world.raycast(x, y + 0.3, z, tx, ty, tz, d) < d - 0.4) continue;
      }
      const amount = Math.round(dmg * (nuke ? 1 : 1 - (d / radius) * 0.7));
      const h = this.hurt(q, amount);
      if (owner !== q.id) ev.push({ kind: 'hit', victim: q.id, by: owner, dmg: amount, head: false, ...h });
      if (q.hp <= 0) this.eliminate(q.id, owner, 'boom', ev);
    }
  }

  private usePerk(p: PlayerState, ev: SimEvent[]) {
    if (!p.perk) return;
    const kind = p.perk.kind;
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const ex = p.x + dx * 0.6, ey = p.y + EYE_H - 0.2, ez = p.z + dz * 0.6;
    if (kind === 'grenade' || kind === 'smoke') {
      const v = GRENADE.speed;
      this.projectiles.push({ id: this.nextId++, kind, owner: p.id, x: ex, y: ey, z: ez, vx: dx * v + p.vx * 0.5, vy: dy * v + 4, vz: dz * v + p.vz * 0.5, t: kind === 'grenade' ? GRENADE.fuse : 1.4 });
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
      const build: Build = { id: this.nextId++, owner: p.id, idx: this.world.addBoxes(list), boxes: list, t: FORT.life };
      this.builds.push(build);
      ev.push({ kind: 'build', id: build.id, boxes: list });
    } else if (kind === 'nuke') {
      // the bomb lands wherever you're looking (or on the ground straight ahead, far away)
      const ox = p.x, oy = p.y + EYE_H, oz = p.z;
      let t = this.world.raycast(ox, oy, oz, dx, dy, dz, NUKE.range);
      if (t >= NUKE.range) t = dy < -0.02 ? -oy / dy : 160;
      const tx = clamp(ox + dx * t, -200, 200), tz = clamp(oz + dz * t, -200, 200);
      this.effects.push({ id: this.nextId++, kind: 'nuke', owner: p.id, x: tx, y: 0, z: tz, t: NUKE.delay });
      ev.push({ kind: 'nuke', x: tx, z: tz, by: p.id, at: this.t + NUKE.delay });
    }
    if (--p.perk.n <= 0) p.perk = null;
  }

  private interact(p: PlayerState, ev: SimEvent[]) {
    // open the nearest pencil case, otherwise swap for the nearest gun on the floor
    let best: Case | null = null, bd = INTERACT_R;
    for (const c of this.cases) { if (c.open || Math.abs(c.y - p.y) > 1.6) continue; const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = c; } }
    if (best) {
      best.open = true; this.lootVer++;
      const r = this.rand;
      const out: [LootKind, string][] = [['weapon', this.rollWeapon(r, best.golden ? GOLD_RARITY : CASE_RARITY)], ['item', weighted(r, ITEM_TABLE)]];
      if (r() < (best.golden ? 0.75 : 0.35)) out.push(['perk', best.golden && r() < 0.2 ? 'nuke' : weighted(r, PERK_TABLE)]);
      if (best.golden) out.push(['item', 'big']);
      // loot spills out the far side of the case, fanned out, so you choose what to grab
      const away = Math.atan2(best.x - p.x, best.z - p.z);
      out.forEach(([k, what], i) => { const a = away + (i - (out.length - 1) / 2) * 0.55; this.drop(best!.x + Math.sin(a) * 1.4, best!.y, best!.z + Math.cos(a) * 1.4, k, what); });
      ev.push({ kind: 'open', caseId: best.id, by: p.id, golden: best.golden });
      return;
    }
    let gun: Loot | null = null; bd = INTERACT_R;
    for (const l of this.loot) { if (l.kind !== 'weapon' || Math.abs(l.y - p.y) > 1.6) continue; const d = Math.hypot(l.x - p.x, l.z - p.z); if (d < bd) { bd = d; gun = l; } }
    if (!gun) return;
    let slot = p.slots.findIndex((s) => s === null);
    if (slot < 0) { // full: drop what's in hand
      slot = p.cur;
      const held = p.slots[slot];
      if (held) this.drop(p.x, this.world.groundAt(p.x, p.z, p.y + 0.1), p.z, 'weapon', held, 1, p.mags[slot]);
    }
    p.slots[slot] = gun.what as WeaponId; p.mags[slot] = gun.mag ?? WEAPONS[gun.what as WeaponId].mag; p.cur = slot; p.reloadT = 0;
    this.loot.splice(this.loot.indexOf(gun), 1); this.lootVer++;
  }

  // walking over shields, heals, perks and (with a free slot) guns picks them up
  private autoPickup(p: PlayerState) {
    for (let i = this.loot.length - 1; i >= 0; i--) {
      const l = this.loot[i];
      if (Math.abs(l.y - p.y) > 1.4 || Math.hypot(l.x - p.x, l.z - p.z) > 1.5) continue;
      if (l.kind === 'item') {
        const it = l.what as ItemId, room = ITEMS[it].max - p.items[it];
        if (room <= 0) continue;
        const take = Math.min(room, l.n);
        p.items[it] += take; l.n -= take;
        if (l.n > 0) { this.lootVer++; continue; }
      } else if (l.kind === 'perk') {
        if (p.perk && p.perk.kind !== l.what) continue;
        const cap = PERKS[l.what as PerkId].count * 2;
        if (p.perk) { if (p.perk.n >= cap) continue; p.perk.n = Math.min(cap, p.perk.n + l.n); }
        else p.perk = { kind: l.what as PerkId, n: l.n };
      } else {
        const slot = p.slots.findIndex((s) => s === null);
        if (slot < 0 || p.slots.includes(l.what as WeaponId)) continue;
        p.slots[slot] = l.what as WeaponId; p.mags[slot] = l.mag ?? WEAPONS[l.what as WeaponId].mag;
      }
      this.loot.splice(i, 1); this.lootVer++;
    }
  }

  private stepProjectiles(dt: number, ev: SimEvent[]) {
    const keep: Projectile[] = [];
    for (const g of this.projectiles) {
      g.vy -= GRAVITY * dt;
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt, nz = g.z + g.vz * dt;
      // bounce off the ground and anything solid
      const b = this.world.near(nx, nz, nx, nz).map((i) => this.world.boxes[i]).find((q) => !q.dead && nx > q.x0 && nx < q.x1 && nz > q.z0 && nz < q.z1 && ny > q.y0 && ny < q.y1);
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
      else this.effects.push({ id: this.nextId++, kind: 'smoke', owner: g.owner, x: g.x, y: g.y, z: g.z, t: SMOKE.life });
    }
    this.projectiles = keep;
  }

  private stepEffects(dt: number, ev: SimEvent[]) {
    const keep: Effect[] = [];
    for (const e of this.effects) {
      e.t -= dt;
      if (e.kind === 'pad') for (const p of this.players.values()) {
        if (p.alive && p.grounded && Math.hypot(p.x - e.x, p.z - e.z) < 1.4 && Math.abs(p.y - e.y) < 0.6) { p.vy = PAD.launch; p.grounded = false; p.launchT = 1.1; p.slideT = 0; }
      }
      if (e.t > 0) { keep.push(e); continue; }
      if (e.kind === 'nuke') this.explode(e.x, 0, e.z, NUKE.radius, NUKE.dmg, e.owner, ev, true);
    }
    this.effects = keep;
    for (const b of this.builds) b.t -= dt;
    for (const b of this.builds.filter((x) => x.t <= 0)) { this.world.killBoxes(b.idx); ev.push({ kind: 'unbuild', id: b.id }); }
    this.builds = this.builds.filter((x) => x.t > 0);
  }

  step(dt: number, inputs: Map<number, Input>): SimEvent[] {
    const ev: SimEvent[] = [];
    this.t += dt; this.tick++;
    this.stepRing();
    const ring = this.ring;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const inp = inputs.get(p.id) ?? { ...emptyInput(), yaw: p.yaw, pitch: p.pitch };
      p.ack = inp.seq;
      p.yaw = inp.yaw; p.pitch = inp.pitch;
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.burstT = Math.max(0, p.burstT - dt);

      if (inp.slot >= 1 && inp.slot <= SLOTS && p.slots[inp.slot - 1] && inp.slot - 1 !== p.cur) {
        p.cur = inp.slot - 1; p.reloadT = 0; p.spin = 0; p.burstLeft = 0; p.use = null; p.fireCd = Math.max(p.fireCd, 0.25);
      }
      if (inp.interact && !p.gliding) this.interact(p, ev);
      if (inp.perk && !p.gliding) this.usePerk(p, ev);

      // healing / shielding takes time and you walk slowly while doing it
      if (inp.item && !p.use && !p.gliding) {
        const it: ItemId | null = inp.item === 2 ? (p.items.med > 0 && p.hp < PLAYER_HP ? 'med' : null)
          : p.items.big > 0 && p.shield < SHIELD_MAX ? 'big' : p.items.mini > 0 && p.shield < (ITEMS.mini.shieldCap ?? 50) ? 'mini' : null;
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

      const w = this.weaponOf(p);
      if (w) {
        const def = WEAPONS[w];
        if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) { p.reloadT = 0; p.mags[p.cur] = def.mag; } }
        else if ((inp.reload && p.mags[p.cur] < def.mag) || (inp.fire && p.mags[p.cur] === 0 && p.burstLeft === 0)) { p.reloadT = def.reload; p.use = null; }
      }

      moveStep(this.world, p, inp, dt, !!p.use);
      this.autoPickup(p);

      if (w && !p.gliding && p.reloadT === 0 && !p.use) {
        const def = WEAPONS[w];
        if (def.spinUp) p.spin = inp.fire ? Math.min(def.spinUp, p.spin + dt) : Math.max(0, p.spin - dt * 2);
        const spunUp = !def.spinUp || p.spin >= def.spinUp;
        if (def.burst) {
          if (inp.fire && p.fireCd === 0 && p.burstLeft === 0 && p.mags[p.cur] > 0) p.burstLeft = Math.min(def.burst, p.mags[p.cur]);
          if (p.burstLeft > 0 && p.burstT === 0) {
            this.shoot(p, w, inp, ev); p.burstLeft--; p.burstT = 0.075;
            if (p.burstLeft === 0) p.fireCd = def.cd;
          }
        } else if (inp.fire && spunUp && p.fireCd === 0 && p.mags[p.cur] > 0) { p.fireCd = def.cd; this.shoot(p, w, inp, ev); }
      }

      if (Math.hypot(p.x - ring.x, p.z - ring.y) > ring.r) {
        this.hurt(p, ring.dps * dt, true);
        if (p.hp <= 0) this.eliminate(p.id, null, 'ring', ev);
      }
    }

    this.stepProjectiles(dt, ev);
    this.stepEffects(dt, ev);

    const pos = new Map<number, { x: number; y: number; z: number }>();
    for (const p of this.players.values()) if (p.alive) pos.set(p.id, { x: p.x, y: p.y, z: p.z });
    this.history.push({ tick: this.tick, pos });
    if (this.history.length > REWIND_MAX_TICKS + 2) this.history.shift();
    return ev;
  }
}
