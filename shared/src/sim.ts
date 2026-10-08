// Deterministic arena simulation. Runs on the server only; pure functions of (state, inputs, dt),
// no timers and no I/O, so a room is just a Sim plus a tick counter and is trivial to test.
import {
  ARENA_R, BULLET_DMG, BULLET_LIFE, BULLET_SPEED, DASH_CD, DASH_SPEED, DASH_TIME, FIRE_CD,
  PILLARS, PLAYER_HP, PLAYER_R, PLAYER_SPEED, RING_CLOSE_S, RING_DPS, RING_MIN_R, RING_START_S,
} from './constants.ts';

export interface Pillar { x: number; y: number; r: number }
export interface PlayerState {
  id: number; x: number; y: number; aim: number; hp: number; alive: boolean;
  fireCd: number; dashCd: number; dashT: number; dashX: number; dashY: number; kills: number;
}
export interface Bullet { id: number; owner: number; x: number; y: number; vx: number; vy: number; life: number }
export interface Input { mx: number; my: number; aim: number; fire: boolean; dash: boolean }
export type SimEvent =
  | { kind: 'hit'; victim: number; by: number }
  | { kind: 'elim'; victim: number; by: number | null; cause: 'shot' | 'ring' | 'left' };

// mulberry32: small seeded PRNG so the client can rebuild the same pillars from the room seed
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
  for (let tries = 0; out.length < PILLARS && tries < 400; tries++) {
    const ang = r() * Math.PI * 2, dist = 120 + r() * (ARENA_R - 220), rad = 34 + r() * 46;
    const p = { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r: rad };
    if (out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > q.r + p.r + 90)) out.push(p);
  }
  return out;
}

export const ringRadius = (t: number) => {
  if (t <= RING_START_S) return ARENA_R;
  const k = Math.min(1, (t - RING_START_S) / RING_CLOSE_S);
  return ARENA_R + (RING_MIN_R - ARENA_R) * k;
};

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
  t = 0;
  private nextBullet = 1;

  constructor(seed: number) { this.pillars = makePillars(seed); }

  // seat players evenly on a circle so nobody spawns next to someone else
  spawn(ids: number[]) {
    const n = ids.length;
    ids.forEach((id, i) => {
      const a = (i / n) * Math.PI * 2, d = ARENA_R * 0.72;
      const p: PlayerState = {
        id, x: Math.cos(a) * d, y: Math.sin(a) * d, aim: a + Math.PI, hp: PLAYER_HP, alive: true,
        fireCd: 1, dashCd: 0, dashT: 0, dashX: 0, dashY: 0, kills: 0,
      };
      this.pushOutOfPillars(p);
      this.players.set(id, p);
    });
  }

  get alive() { let n = 0; for (const p of this.players.values()) if (p.alive) n++; return n; }
  get ringR() { return ringRadius(this.t); }

  eliminate(id: number, by: number | null, cause: 'shot' | 'ring' | 'left', ev: SimEvent[]) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false; p.hp = 0;
    if (by !== null) { const k = this.players.get(by); if (k) k.kills++; }
    ev.push({ kind: 'elim', victim: id, by, cause });
  }

  step(dt: number, inputs: Map<number, Input>): SimEvent[] {
    const ev: SimEvent[] = [];
    this.t += dt;
    const ringR = this.ringR;

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

      if (inp.fire && p.fireCd === 0) {
        p.fireCd = FIRE_CD;
        const cx = Math.cos(p.aim), cy = Math.sin(p.aim);
        this.bullets.push({
          id: this.nextBullet++, owner: p.id, x: p.x + cx * (PLAYER_R + 6), y: p.y + cy * (PLAYER_R + 6),
          vx: cx * BULLET_SPEED, vy: cy * BULLET_SPEED, life: BULLET_LIFE,
        });
      }

      if (Math.hypot(p.x, p.y) > ringR) {
        p.hp -= RING_DPS * dt;
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
          p.hp -= BULLET_DMG;
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
