// Arena renderer: ballpoint ink on ruled notebook paper. Draws interpolated server snapshots
// ~100 ms in the past so remote players move smoothly between 15 Hz updates.
import { ARENA_R, PLAYER_HP, PLAYER_R, WEAPONS, type LootKind } from '../../shared/src/constants.ts';
import type { RoomSeat, ServerMsg, SnapLoot, SnapPlayer, SnapRing } from '../../shared/src/protocol.ts';
import { makePillars, rng, type Pillar } from '../../shared/src/sim.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const INTERP = 0.1;
const INK = '#1d33b8', GRAPHITE = '#2b2f3a', RED = '#d32336', PAPER = '#f6f2e4', PAPER_OUT = '#e9e1c9';
const RULE = 'rgba(64,112,206,0.22)', TEAL = '#13897f', TEAL_ME = '#1aa596', HL = 'rgba(255,222,70,0.6)';

// wobble is fixed per shape (seeded), so outlines look hand drawn but never flicker
function wobble(seed: number, n: number) { const r = rng(seed); return Array.from({ length: n }, () => r() * 2 - 1); }
const GUN_LEN: Record<string, number> = { pistol: 14, shotgun: 20, rifle: 26, sniper: 34 };

export class Arena {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0; private dpr = 1;
  private pillars: Pillar[] = [];
  private pillarWob: number[][] = [];
  private snaps: { s: Snap; at: number }[] = [];
  private seats = new Map<number, RoomSeat>();
  private marks: { x: number; y: number }[] = [];
  private loot: SnapLoot[] = [];
  private cam = { x: 0, y: 0 };
  private t = 0;
  you = -1;
  ring: SnapRing = { x: 0, y: 0, r: ARENA_R, nx: 0, ny: 0, nr: ARENA_R, closing: false, nextIn: 0, phase: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
  }
  get scale() { return Math.max(this.w, this.h) / 1500; }

  setRoom(seed: number, seats: RoomSeat[], you: number) {
    this.pillars = makePillars(seed);
    this.pillarWob = this.pillars.map((_, i) => wobble(seed + i * 31, 22));
    this.seats = new Map(seats.map((s) => [s.id, s]));
    this.you = you;
  }
  reset() { this.snaps = []; this.marks = []; this.loot = []; }
  pushSnap(s: Snap) {
    this.snaps.push({ s, at: performance.now() / 1000 });
    if (this.snaps.length > 30) this.snaps.shift();
    this.ring = s.ring;
    if (s.loot) this.loot = s.loot;
  }
  markDeath(id: number) { const p = this.latest(id); if (p) this.marks.push({ x: p.x, y: p.y }); }
  latest(id: number) { return this.snaps.at(-1)?.s.players.find((p) => p.id === id); }
  me() { return this.latest(this.you); }

  // screen position of our own player, so mouse aim is relative to where we are drawn
  myScreen() { const p = this.me(); return p ? { x: (p.x - this.cam.x) * this.scale + this.w / 2, y: (p.y - this.cam.y) * this.scale + this.h / 2 } : { x: this.w / 2, y: this.h / 2 }; }

  private interpolated(): { players: SnapPlayer[]; snap: Snap | null; age: number } {
    if (!this.snaps.length) return { players: [], snap: null, age: 0 };
    const last = this.snaps[this.snaps.length - 1];
    const now = performance.now() / 1000;
    const rt = last.s.time + (now - last.at) - INTERP;
    let a = this.snaps[0], b = last;
    for (let i = 0; i < this.snaps.length - 1; i++) if (this.snaps[i].s.time <= rt && this.snaps[i + 1].s.time >= rt) { a = this.snaps[i]; b = this.snaps[i + 1]; break; }
    const span = b.s.time - a.s.time;
    const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.s.time) / span)) : 1;
    const players = b.s.players.map((pb) => {
      const pa = a.s.players.find((p) => p.id === pb.id) ?? pb;
      let da = pb.aim - pa.aim; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      return { ...pb, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k, aim: pa.aim + da * k };
    });
    return { players, snap: last.s, age: now - last.at };
  }

  frame(dt: number) {
    this.t += dt;
    const { ctx } = this;
    const { players, snap, age } = this.interpolated();
    const focus = players.find((p) => p.id === this.you && p.alive) ?? players.find((p) => p.alive) ?? players[0];
    if (focus) { const k = Math.min(1, dt * 8); this.cam.x += (focus.x - this.cam.x) * k; this.cam.y += (focus.y - this.cam.y) * k; }
    const s = this.scale, g = this.ring;

    // the whole canvas is paper: darker outside the arena, ruled lines everywhere
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PAPER_OUT; ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * (this.w / 2 - this.cam.x * s), this.dpr * (this.h / 2 - this.cam.y * s));
    const vx0 = this.cam.x - this.w / 2 / s, vx1 = this.cam.x + this.w / 2 / s, vy0 = this.cam.y - this.h / 2 / s, vy1 = this.cam.y + this.h / 2 / s;

    ctx.fillStyle = PAPER; ctx.beginPath(); ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = RULE; ctx.lineWidth = 2;
    for (let y = Math.floor(vy0 / 44) * 44; y <= vy1; y += 44) { ctx.beginPath(); ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(214,64,76,0.4)'; ctx.beginPath(); ctx.moveTo(-ARENA_R * 0.72, vy0); ctx.lineTo(-ARENA_R * 0.72, vy1); ctx.stroke();

    // storm: red hatching everywhere outside the safe circle
    ctx.save();
    ctx.beginPath(); ctx.rect(vx0 - 10, vy0 - 10, vx1 - vx0 + 20, vy1 - vy0 + 20); ctx.arc(g.x, g.y, Math.max(0.1, g.r), 0, Math.PI * 2, true); ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(211,35,54,0.09)'; ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    ctx.strokeStyle = 'rgba(211,35,54,0.32)'; ctx.lineWidth = 2;
    const off = (this.t * 18) % 24;
    for (let x = Math.floor((vx0 - (vy1 - vy0)) / 24) * 24; x < vx1; x += 24) { ctx.beginPath(); ctx.moveTo(x + off, vy0); ctx.lineTo(x + off + (vy1 - vy0), vy1); ctx.stroke(); }
    ctx.restore();

    // arena border, current storm edge, and the next safe circle
    ctx.strokeStyle = GRAPHITE; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = RED; ctx.lineWidth = 5; ctx.setLineDash([26, 10]); ctx.beginPath(); ctx.arc(g.x, g.y, Math.max(0.1, g.r), 0, Math.PI * 2); ctx.stroke();
    if (g.nr > 0 && (g.nx !== g.x || g.ny !== g.y || g.nr !== g.r)) {
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([8, 10]);
      ctx.beginPath(); ctx.arc(g.nx, g.ny, g.nr, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);

    this.pillars.forEach((p, i) => this.inkBlob(p.x, p.y, p.r, this.pillarWob[i], GRAPHITE, true));
    for (const l of this.loot) this.lootIcon(l);

    ctx.strokeStyle = RED; ctx.lineWidth = 4;
    for (const m of this.marks) { ctx.beginPath(); ctx.moveTo(m.x - 14, m.y - 14); ctx.lineTo(m.x + 14, m.y + 14); ctx.moveTo(m.x + 14, m.y - 14); ctx.lineTo(m.x - 14, m.y + 14); ctx.stroke(); }

    if (snap) {
      ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.lineCap = 'round';
      const t = Math.max(0, age - INTERP);
      for (const b of snap.bullets) {
        const x = b.x + b.vx * t, y = b.y + b.vy * t, sp = Math.hypot(b.vx, b.vy) || 1, len = sp > 1500 ? 34 : 16;
        ctx.beginPath(); ctx.moveTo(x - (b.vx / sp) * len, y - (b.vy / sp) * len); ctx.lineTo(x, y); ctx.stroke();
      }
    }

    for (const p of players) if (p.alive) this.player(p);

    // off-screen pointer to the next safe circle when we're outside it
    const me = players.find((p) => p.id === this.you && p.alive);
    if (me && g.nr > 0 && Math.hypot(me.x - g.nx, me.y - g.ny) > g.nr) {
      const a = Math.atan2(g.ny - me.y, g.nx - me.x), d = PLAYER_R + 44;
      const ax = me.x + Math.cos(a) * d, ay = me.y + Math.sin(a) * d;
      ctx.strokeStyle = INK; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax - Math.cos(a) * 14, ay - Math.sin(a) * 14); ctx.lineTo(ax, ay);
      ctx.lineTo(ax - Math.cos(a - 0.5) * 10, ay - Math.sin(a - 0.5) * 10); ctx.moveTo(ax, ay); ctx.lineTo(ax - Math.cos(a + 0.5) * 10, ay - Math.sin(a + 0.5) * 10); ctx.stroke();
    }
  }

  private inkBlob(x: number, y: number, r: number, wob: number[], color: string, hatch: boolean) {
    const { ctx } = this;
    const n = wob.length;
    const path = new Path2D();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, rr = r * (1 + wob[i % n] * 0.05);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
    }
    if (hatch) {
      ctx.save(); ctx.clip(path);
      ctx.fillStyle = PAPER; ctx.fill(path);
      ctx.strokeStyle = 'rgba(43,47,58,0.35)'; ctx.lineWidth = 2;
      for (let k = -r * 2; k < r * 2; k += 9) { ctx.beginPath(); ctx.moveTo(x + k - r, y - r); ctx.lineTo(x + k + r, y + r); ctx.stroke(); }
      ctx.restore();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke(path);
    ctx.save(); ctx.translate(1.5, -1); ctx.globalAlpha = 0.5; ctx.stroke(path); ctx.restore();
  }

  // loot as little doodles on a highlighter dot, bobbing a touch so they read as pickups
  private lootIcon(l: SnapLoot) {
    const { ctx } = this;
    const bob = Math.sin(this.t * 3 + l.id) * 2;
    const x = l.x, y = l.y + bob;
    ctx.fillStyle = HL; ctx.beginPath(); ctx.ellipse(x, l.y + 4, 24, 20, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = INK; ctx.fillStyle = PAPER; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const kind: LootKind = l.kind;
    if (kind === 'medkit') {
      ctx.beginPath(); ctx.rect(-13, -10, 26, 20); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = RED; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.stroke();
    } else if (kind === 'armor') {
      ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(12, -8); ctx.quadraticCurveTo(11, 8, 0, 14); ctx.quadraticCurveTo(-11, 8, -12, -8); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, 9); ctx.stroke();
    } else {
      const len = kind === 'sniper' ? 30 : kind === 'rifle' ? 24 : 18;
      ctx.rotate(-0.35);
      ctx.beginPath(); ctx.rect(-len / 2, -4, len, 8); ctx.fill(); ctx.stroke();               // body
      ctx.beginPath(); ctx.moveTo(-len / 2 + 4, 4); ctx.lineTo(-len / 2 + 1, 12); ctx.stroke(); // grip
      ctx.beginPath(); ctx.moveTo(len / 2, 0); ctx.lineTo(len / 2 + (kind === 'shotgun' ? 4 : 9), 0); ctx.stroke();
      if (kind === 'sniper') { ctx.beginPath(); ctx.rect(-3, -9, 9, 4); ctx.stroke(); }
      if (kind === 'shotgun') { ctx.beginPath(); ctx.moveTo(-len / 2, -1); ctx.lineTo(len / 2, -1); ctx.stroke(); }
    }
    ctx.restore();
    ctx.fillStyle = INK; ctx.font = '600 15px Caveat, cursive'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(kind === 'medkit' ? 'botiquín' : kind === 'armor' ? 'escudo' : WEAPONS[kind].name, x, l.y + 22);
  }

  private player(p: SnapPlayer) {
    const { ctx } = this;
    const mine = p.id === this.you;
    const color = mine ? INK : GRAPHITE;
    const gun = GUN_LEN[p.weapon] ?? 14;
    ctx.strokeStyle = color; ctx.lineWidth = p.weapon === 'shotgun' ? 8 : 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.x + Math.cos(p.aim) * 8, p.y + Math.sin(p.aim) * 8); ctx.lineTo(p.x + Math.cos(p.aim) * (PLAYER_R + gun), p.y + Math.sin(p.aim) * (PLAYER_R + gun)); ctx.stroke();
    if (p.armor > 0) { ctx.strokeStyle = 'rgba(29,51,184,0.5)'; ctx.lineWidth = 3; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 10, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = mine ? TEAL_ME : TEAL;
    ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2); ctx.fill();
    this.inkBlob(p.x, p.y, PLAYER_R, wobble(p.id * 97, 14), color, false);
    if (p.dash) { ctx.strokeStyle = 'rgba(29,51,184,0.4)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 8, 0, Math.PI * 2); ctx.stroke(); }
    const seat = this.seats.get(p.id);
    ctx.fillStyle = PAPER; ctx.font = '800 13px "Shantell Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(seat?.num ?? '?', p.x, p.y + 1);
    ctx.strokeStyle = RED; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * p.hp) / PLAYER_HP); ctx.stroke();
    ctx.fillStyle = mine ? INK : GRAPHITE; ctx.font = '700 18px Caveat, cursive'; ctx.textBaseline = 'bottom';
    ctx.fillText(mine ? 'vos' : seat?.name ?? '', p.x, p.y - PLAYER_R - 12);
  }
}
