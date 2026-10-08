// Arena renderer: ballpoint ink on ruled notebook paper. Draws interpolated server snapshots
// ~100 ms in the past so remote players move smoothly between 15 Hz updates.
import { ARENA_R, PLAYER_HP, PLAYER_R } from '../../shared/src/constants.ts';
import type { RoomSeat, ServerMsg, SnapPlayer } from '../../shared/src/protocol.ts';
import { makePillars, rng, type Pillar } from '../../shared/src/sim.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const INTERP = 0.1;
const INK = '#1b2fa8', GRAPHITE = '#2e3240', RED = '#d8213b', PAPER = '#f7f3e8', RULE = 'rgba(80,130,220,0.28)';

// wobble is fixed per shape (seeded), so outlines look hand drawn but never flicker
function wobble(seed: number, n: number) { const r = rng(seed); return Array.from({ length: n }, () => r() * 2 - 1); }

export class Arena {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0; private dpr = 1;
  private pillars: Pillar[] = [];
  private pillarWob: number[][] = [];
  private snaps: { s: Snap; at: number }[] = [];
  private seats = new Map<number, RoomSeat>();
  private marks: { x: number; y: number }[] = [];
  private cam = { x: 0, y: 0 };
  you = -1;
  ringR = ARENA_R;

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
  reset() { this.snaps = []; this.marks = []; }
  pushSnap(s: Snap) {
    this.snaps.push({ s, at: performance.now() / 1000 });
    if (this.snaps.length > 30) this.snaps.shift();
    this.ringR = s.ringR;
  }
  markDeath(id: number) { const p = this.latest(id); if (p) this.marks.push({ x: p.x, y: p.y }); }
  latest(id: number) { return this.snaps.at(-1)?.s.players.find((p) => p.id === id); }
  me() { return this.latest(this.you); }
  seat(id: number) { return this.seats.get(id); }

  // screen position of our own player, so mouse aim is relative to where we are drawn
  myScreen() { const p = this.me(); return p ? this.toScreen(p.x, p.y) : { x: this.w / 2, y: this.h / 2 }; }
  private toScreen(x: number, y: number) { return { x: (x - this.cam.x) * this.scale + this.w / 2, y: (y - this.cam.y) * this.scale + this.h / 2 }; }

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
    const { ctx } = this;
    const { players, snap, age } = this.interpolated();
    const focus = players.find((p) => p.id === this.you && p.alive) ?? players.find((p) => p.alive) ?? players[0];
    if (focus) { const k = Math.min(1, dt * 8); this.cam.x += (focus.x - this.cam.x) * k; this.cam.y += (focus.y - this.cam.y) * k; }
    const s = this.scale;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#d9d3c3'; ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * (this.w / 2 - this.cam.x * s), this.dpr * (this.h / 2 - this.cam.y * s));

    // paper
    ctx.fillStyle = PAPER;
    ctx.beginPath(); ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = RULE; ctx.lineWidth = 2;
    for (let y = -ARENA_R; y <= ARENA_R; y += 44) { ctx.beginPath(); ctx.moveTo(-ARENA_R, y); ctx.lineTo(ARENA_R, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(216,33,59,0.45)'; ctx.beginPath(); ctx.moveTo(-ARENA_R * 0.72, -ARENA_R); ctx.lineTo(-ARENA_R * 0.72, ARENA_R); ctx.stroke();

    // outside the ring: red hatching
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, ARENA_R + 4, 0, Math.PI * 2); ctx.arc(0, 0, this.ringR, 0, Math.PI * 2, true); ctx.clip();
    ctx.fillStyle = 'rgba(216,33,59,0.10)'; ctx.fillRect(-ARENA_R, -ARENA_R, ARENA_R * 2, ARENA_R * 2);
    ctx.strokeStyle = 'rgba(216,33,59,0.35)'; ctx.lineWidth = 2;
    for (let x = -ARENA_R * 2; x < ARENA_R * 2; x += 22) { ctx.beginPath(); ctx.moveTo(x, -ARENA_R); ctx.lineTo(x + ARENA_R * 2, ARENA_R); ctx.stroke(); }
    ctx.restore();
    ctx.restore();

    // arena border and ring
    ctx.strokeStyle = GRAPHITE; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = RED; ctx.lineWidth = 5; ctx.setLineDash([26, 10]); ctx.beginPath(); ctx.arc(0, 0, this.ringR, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);

    // pillars: scribbled ink circles with hatching
    this.pillars.forEach((p, i) => this.inkBlob(p.x, p.y, p.r, this.pillarWob[i], GRAPHITE, true));

    // death marks
    ctx.strokeStyle = RED; ctx.lineWidth = 4;
    for (const m of this.marks) { ctx.beginPath(); ctx.moveTo(m.x - 14, m.y - 14); ctx.lineTo(m.x + 14, m.y + 14); ctx.moveTo(m.x + 14, m.y - 14); ctx.lineTo(m.x - 14, m.y + 14); ctx.stroke(); }

    // bullets: extrapolated from the newest snapshot along their velocity
    if (snap) {
      ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.lineCap = 'round';
      const t = Math.max(0, age - INTERP);
      for (const b of snap.bullets) {
        const x = b.x + b.vx * t, y = b.y + b.vy * t, sp = Math.hypot(b.vx, b.vy) || 1;
        ctx.beginPath(); ctx.moveTo(x - (b.vx / sp) * 16, y - (b.vy / sp) * 16); ctx.lineTo(x, y); ctx.stroke();
      }
    }

    for (const p of players) if (p.alive) this.player(p);
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
      ctx.strokeStyle = 'rgba(46,50,64,0.35)'; ctx.lineWidth = 2;
      for (let k = -r * 2; k < r * 2; k += 9) { ctx.beginPath(); ctx.moveTo(x + k - r, y - r); ctx.lineTo(x + k + r, y + r); ctx.stroke(); }
      ctx.restore();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke(path);
    ctx.save(); ctx.translate(1.5, -1); ctx.globalAlpha = 0.5; ctx.stroke(path); ctx.restore();
  }

  private player(p: SnapPlayer) {
    const { ctx } = this;
    const mine = p.id === this.you;
    const color = mine ? INK : GRAPHITE;
    // gun
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.x + Math.cos(p.aim) * 8, p.y + Math.sin(p.aim) * 8); ctx.lineTo(p.x + Math.cos(p.aim) * (PLAYER_R + 16), p.y + Math.sin(p.aim) * (PLAYER_R + 16)); ctx.stroke();
    // body: tracksuit fill + ink outline
    ctx.fillStyle = mine ? '#1fb5ad' : '#0f8f8a';
    ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2); ctx.fill();
    this.inkBlob(p.x, p.y, PLAYER_R, wobble(p.id * 97, 14), color, false);
    if (p.dash) { ctx.strokeStyle = 'rgba(27,47,168,0.4)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 8, 0, Math.PI * 2); ctx.stroke(); }
    // number like the tracksuits
    const seat = this.seats.get(p.id);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px Oswald, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(seat?.num ?? '?', p.x, p.y + 1);
    // hp
    ctx.strokeStyle = RED; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * p.hp) / PLAYER_HP); ctx.stroke();
    if (mine) { ctx.fillStyle = INK; ctx.font = '18px Gaegu, sans-serif'; ctx.fillText('tú', p.x, p.y - PLAYER_R - 16); }
  }
}
