// Deterministic battle royale simulation. Runs on the server only (and in the offline demo);
// pure functions of (state, inputs, dt) with a seeded RNG, no timers and no I/O, so a room is
// just a Sim plus a tick counter and is trivial to test.
import {
  ARENA_R, ARMOR_MAX, DASH_CD, DASH_SPEED, DASH_TIME, LOOT_COUNT, MEDKIT_HP, PICKUP_R, PILLARS,
  PLAYER_HP, PLAYER_R, PLAYER_SPEED, RING_DPS_START, RING_PHASES, WEAPONS,
  type LootKind, type WeaponId,
} from './constants.ts';

export interface Pillar { x: number; y: number; r: number }
export interface Loot { id: number; x: number; y: number; kind: LootKind }
export interface PlayerState {
  id: number; x: number; y: number; aim: number; hp: number; armor: number; alive: boolean;
  weapon: WeaponId; ammo: number;
  fireCd: number; dashCd: number; dashT: number; dashX: number; dashY: number; kills: number;
}
export interface Bullet { id: number; owner: number; x: number; y: number; vx: number; vy: number; life: number; dmg: number }
export interface Input { mx: number; my: number; aim: number; fire: boolean; dash: boolean }
export interface Ring { x: number; y: number; r: number; nx: number; ny: number; nr: number; phase: number; closing: boolean; dps: number; nextAt: number }
export type SimEvent =
  | { kind: 'hit'; victim: number; by: number }
  | { kind: 'pickup'; player: number; loot: LootKind }
  | { kind: 'elim'; victim: number; by: number | null; cause: 'shot' | 'ring' | 'left' };

// mulberry32: small seeded PRNG so the client can rebuild the same map from the room seed
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePillars(seed: number): Pillar[] {
  const r = rng(seed), out: Pillar[] = [];
  for (let tries = 0; out.length < PILLARS && tries < 500; tries++) {
    const ang = r() * Math.PI * 2, dist = 120 + r() * (ARENA_R - 220), rad = 34 + r() * 48;
    const p = { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r: rad };
    if (out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > q.r + p.r + 90)) out.push(p);
  }
  return out;
}

// loot table: guns are rarer the stronger they are
const LOOT_TABLE: [LootKind, number][] = [['shotgun', 5], ['rifle', 5], ['sniper', 2], ['medkit', 7], ['armor', 6]];
export function makeLoot(seed: number, pillars: Pillar[]): Loot[] {
  const r = rng(seed ^ 0x5bd1e995), out: Loot[] = [];
  const total = LOOT_TABLE.reduce((s, [, w]) => s + w, 0);
  for (let tries = 0; out.length < LOOT_COUNT && tries < 800; tries++) {
    const ang = r() * Math.PI * 2, dist = Math.sqrt(r()) * (ARENA_R - 60);
    const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist;
    if (pillars.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + 30)) continue;
    if (out.some((l) => Math.hypot(l.x - x, l.y - y) < 110)) continue;
    let pick = r() * total, kind: LootKind = 'medkit';
    for (const [k, w] of LOOT_TABLE) { if (pick < w) { kind = k; break; } pick -= w; }
    out.push({ id: out.length + 1, x, y, kind });
  }
  return out;
}

// the next safe circle always sits fully inside the current one
function nextCircle(r: () => number, x: number, y: number, rad: number, nr: number) {
  const room = Math.max(0, rad - nr), a = r() * Math.PI * 2, d = Math.sqrt(r()) * room;
  return { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// inputs come from the network: never trust shape or range
export function sanitizeInput(raw: Partial<Input> | undefined): Input {
  let mx = clamp(finite(raw?.mx), -1, 1), my = clamp(finite(raw?.my), -1, 1);
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  return { mx, my, aim: finite(raw?.aim), fire: raw?.fire === true, dash: raw?.dash === true };
}

export class Sim {
  players = new Map<number, PlayerState>();
  bullets: Bullet[] = [];
  pillars: Pillar[];
  loot: Loot[];
  ring: Ring;
  lootVer = 0;               // bumps whenever loot appears or disappears, so rooms only resend on change
  t = 0;
  private nextBullet = 1;
  private rand: () => number;
  private phaseStart = 0;
  private from = { x: 0, y: 0, r: ARENA_R };

  constructor(seed: number) {
    this.rand = rng(seed ^ 0x9e3779b9);
    this.pillars = makePillars(seed);
    this.loot = makeLoot(seed, this.pillars);
    const first = RING_PHASES[0], c = nextCircle(this.rand, 0, 0, ARENA_R, first.radius);
    this.ring = { x: 0, y: 0, r: ARENA_R, nx: c.x, ny: c.y, nr: first.radius, phase: 0, closing: false, dps: RING_DPS_START, nextAt: first.wait };
  }

  // seat players evenly on a circle so nobody spawns next to someone else
  spawn(ids: number[]) {
    const n = ids.length;
    ids.forEach((id, i) => {
      const a = (i / n) * Math.PI * 2, d = ARENA_R * 0.78;
      const p: PlayerState = {
        id, x: Math.cos(a) * d, y: Math.sin(a) * d, aim: a + Math.PI, hp: PLAYER_HP, armor: 0, alive: true,
        weapon: 'pistol', ammo: Infinity, fireCd: 1, dashCd: 0, dashT: 0, dashX: 0, dashY: 0, kills: 0,
      };
      this.pushOutOfPillars(p);
      this.players.set(id, p);
    });
  }

  get alive() { let n = 0; for (const p of this.players.values()) if (p.alive) n++; return n; }

  eliminate(id: number, by: number | null, cause: 'shot' | 'ring' | 'left', ev: SimEvent[]) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false; p.hp = 0;
    if (by !== null) { const k = this.players.get(by); if (k) k.kills++; }
    // a fallen player's gun drops where they died, so fights pay off
    if (p.weapon !== 'pistol' && p.ammo > 0) this.lootVer++, this.loot.push({ id: 1000 + this.nextBullet++, x: p.x, y: p.y, kind: p.weapon });
    ev.push({ kind: 'elim', victim: id, by, cause });
  }

  private damage(p: PlayerState, amount: number) {
    const soak = Math.min(p.armor, amount);
    p.armor -= soak;
    p.hp -= amount - soak;
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
      ring.dps = phase.dps;
      ring.phase++;
      this.phaseStart = this.t;
      this.from = { x: ring.x, y: ring.y, r: ring.r };
      const next = RING_PHASES[ring.phase];
      if (next) { const c = nextCircle(this.rand, ring.x, ring.y, ring.r, next.radius); ring.nx = c.x; ring.ny = c.y; ring.nr = next.radius; }
    }
  }

  step(dt: number, inputs: Map<number, Input>): SimEvent[] {
    const ev: SimEvent[] = [];
    this.t += dt;
    this.stepRing();
    const ring = this.ring;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const inp = inputs.get(p.id) ?? { mx: 0, my: 0, aim: p.aim, fire: false, dash: false };
      p.aim = inp.aim;
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.dashCd = Math.max(0, p.dashCd - dt);

      if (inp.dash && p.dashCd === 0 && (inp.mx || inp.my)) {
        p.dashT = DASH_TIME; p.dashCd = DASH_CD; p.dashX = inp.mx; p.dashY = inp.my;
      }
      let vx = inp.mx * PLAYER_SPEED, vy = inp.my * PLAYER_SPEED;
      if (p.dashT > 0) { p.dashT -= dt; vx = p.dashX * DASH_SPEED; vy = p.dashY * DASH_SPEED; }
      p.x += vx * dt; p.y += vy * dt;
      this.pushOutOfPillars(p);
      const d = Math.hypot(p.x, p.y), lim = ARENA_R - PLAYER_R;
      if (d > lim) { p.x *= lim / d; p.y *= lim / d; }

      this.pickUp(p, ev);

      if (inp.fire && p.fireCd === 0) {
        const w = WEAPONS[p.weapon];
        p.fireCd = w.cd;
        for (let i = 0; i < w.pellets; i++) {
          const a = p.aim + (w.pellets > 1 ? (i / (w.pellets - 1) - 0.5) * w.spread : 0) + (this.rand() - 0.5) * w.spread * 0.4;
          const cx = Math.cos(a), cy = Math.sin(a);
          this.bullets.push({
            id: this.nextBullet++, owner: p.id, x: p.x + cx * (PLAYER_R + 6), y: p.y + cy * (PLAYER_R + 6),
            vx: cx * w.speed, vy: cy * w.speed, life: w.life, dmg: w.dmg,
          });
        }
        if (p.weapon !== 'pistol' && --p.ammo <= 0) { p.weapon = 'pistol'; p.ammo = Infinity; }
      }

      if (Math.hypot(p.x - ring.x, p.y - ring.y) > ring.r) {
        p.hp -= ring.dps * dt; // the storm ignores armor
        if (p.hp <= 0) this.eliminate(p.id, null, 'ring', ev);
      }
    }

    // bullets: swept segment vs circle so a fast bullet cannot tunnel through a player at 30 Hz
    const keep: Bullet[] = [];
    outer: for (const b of this.bullets) {
      const x0 = b.x, y0 = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.life <= 0 || Math.hypot(b.x, b.y) > ARENA_R) continue;
      for (const pl of this.pillars) if (segHitsCircle(x0, y0, b.x, b.y, pl.x, pl.y, pl.r)) continue outer;
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.owner) continue;
        if (segHitsCircle(x0, y0, b.x, b.y, p.x, p.y, PLAYER_R)) {
          this.damage(p, b.dmg);
          ev.push({ kind: 'hit', victim: p.id, by: b.owner });
          if (p.hp <= 0) this.eliminate(p.id, b.owner, 'shot', ev);
          continue outer;
        }
      }
      keep.push(b);
    }
    this.bullets = keep;
    return ev;
  }

  // walk over loot to take it; a full health bar or armor leaves medkits/armor for others
  private pickUp(p: PlayerState, ev: SimEvent[]) {
    for (let i = this.loot.length - 1; i >= 0; i--) {
      const l = this.loot[i];
      if (Math.hypot(l.x - p.x, l.y - p.y) > PICKUP_R + PLAYER_R) continue;
      if (l.kind === 'medkit') { if (p.hp >= PLAYER_HP) continue; p.hp = Math.min(PLAYER_HP, p.hp + MEDKIT_HP); }
      else if (l.kind === 'armor') { if (p.armor >= ARMOR_MAX) continue; p.armor = ARMOR_MAX; }
      else { if (p.weapon === l.kind && p.ammo >= WEAPONS[l.kind].ammo) continue; p.weapon = l.kind; p.ammo = WEAPONS[l.kind].ammo; }
      this.loot.splice(i, 1);
      this.lootVer++;
      ev.push({ kind: 'pickup', player: p.id, loot: l.kind });
    }
  }

  private pushOutOfPillars(p: PlayerState) {
    for (const pl of this.pillars) {
      const dx = p.x - pl.x, dy = p.y - pl.y, d = Math.hypot(dx, dy), min = pl.r + PLAYER_R;
      if (d < min) {
        const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
        p.x = pl.x + nx * min; p.y = pl.y + ny * min;
      }
    }
  }
}

export function segHitsCircle(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number) {
  const dx = x1 - x0, dy = y1 - y0, fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  const t = a > 0 ? clamp(-(fx * dx + fy * dy) / a, 0, 1) : 0;
  const px = fx + dx * t, py = fy + dy * t;
  return px * px + py * py <= r * r;
}
