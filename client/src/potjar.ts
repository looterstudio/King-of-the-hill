// The hanging glass piggy bank. Coins pour in through the slot on every fee inflow and the pile
// inside rises with the pot. Fill is 1 - e^(-sol/scale): it always moves, never quite tops out.
import { rng } from '../../shared/src/sim.ts';

interface Coin { x: number; y: number; vy: number; tx: number; ty: number; spin: number }

const COINS = 900;

export class PotJar {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0; private dpr = 1;
  private target = 0;
  private shown = 0;
  private falling: Coin[] = [];
  private pile: { x: number; y: number; tilt: number; tone: number }[] = [];
  private t = 0;
  private shake = 0;
  scaleSol = 40;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    // pile positions in unit body space, bottom first, so revealing the first N fills from the bottom
    const r = rng(7);
    for (let i = 0; this.pile.length < COINS && i < COINS * 6; i++) {
      const x = r() * 2 - 1, y = r() * 2 - 1;
      if (x * x + y * y > 0.93) continue;
      this.pile.push({ x, y, tilt: r() * 0.6 - 0.3, tone: r() });
    }
    this.pile.sort((a, b) => b.y - a.y);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
  }

  setSol(sol: number) { this.target = 1 - Math.exp(-Math.max(0, sol) / this.scaleSol); }

  inflow(sol: number) {
    const n = Math.min(40, 3 + Math.round(Math.log10(1 + sol * 100) * 8));
    const g = this.geom();
    for (let i = 0; i < n; i++) {
      this.falling.push({ x: g.cx + g.rx * 0.05 + (Math.random() - 0.5) * 8, y: g.cy - g.ry - 140 - i * 26, vy: 0, tx: g.cx + (Math.random() - 0.5) * g.rx * 1.2, ty: this.surfaceY(g), spin: Math.random() * 6 });
    }
    if (sol > 0.3) this.shake = 0.6;
  }

  private geom() {
    const rx = Math.min(this.w * 0.24, this.h * 0.3), ry = rx * 0.72;
    return { cx: this.w / 2, cy: this.h * 0.33, rx, ry };
  }
  private surfaceY(g: ReturnType<PotJar['geom']>) { return g.cy + g.ry - this.shown * g.ry * 2; }

  frame(dt: number) {
    this.t += dt;
    this.shown += (this.target - this.shown) * Math.min(1, dt * 1.6);
    this.shake = Math.max(0, this.shake - dt);
    const { ctx } = this;
    const g = this.geom();
    const sx = this.shake > 0 ? Math.sin(this.t * 60) * this.shake * 4 : 0;
    const sway = Math.sin(this.t * 0.7) * 2 + sx;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    // spotlight from the ceiling
    const cone = ctx.createLinearGradient(0, 0, 0, this.h);
    cone.addColorStop(0, 'rgba(255,236,170,0.20)'); cone.addColorStop(1, 'rgba(255,236,170,0)');
    ctx.fillStyle = cone;
    ctx.beginPath(); ctx.moveTo(g.cx - 40, 0); ctx.lineTo(g.cx + 40, 0); ctx.lineTo(g.cx + g.rx * 1.9, this.h); ctx.lineTo(g.cx - g.rx * 1.9, this.h); ctx.closePath(); ctx.fill();

    ctx.save();
    ctx.translate(sway, 0);
    // cable
    ctx.strokeStyle = '#3a3f4b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(g.cx, 0); ctx.lineTo(g.cx, g.cy - g.ry - 4); ctx.stroke();

    // glass body path (ellipse + snout + legs) used both to clip the coins and to stroke the glass
    const body = new Path2D();
    body.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
    const snout = new Path2D();
    snout.ellipse(g.cx + g.rx * 0.98, g.cy + g.ry * 0.05, g.rx * 0.16, g.ry * 0.26, 0, 0, Math.PI * 2);

    // coins inside, clipped to the glass
    ctx.save();
    ctx.clip(body);
    const n = Math.floor(this.shown * this.pile.length);
    const cw = g.rx * 0.075, ch = cw * 0.42;
    for (let i = 0; i < n; i++) {
      const c = this.pile[i];
      const x = g.cx + c.x * g.rx, y = g.cy + c.y * g.ry;
      this.coin(x, y, cw, ch, c.tilt, c.tone);
    }
    ctx.restore();

    // glass
    ctx.fillStyle = 'rgba(160,200,255,0.06)'; ctx.fill(body); ctx.fill(snout);
    ctx.strokeStyle = 'rgba(200,225,255,0.55)'; ctx.lineWidth = 2.5; ctx.stroke(body); ctx.stroke(snout);
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(200,225,255,0.4)';
    for (const dx of [-0.55, -0.15, 0.25, 0.6]) {
      ctx.beginPath(); ctx.moveTo(g.cx + dx * g.rx - g.rx * 0.07, g.cy + g.ry * 0.84); ctx.lineTo(g.cx + dx * g.rx - g.rx * 0.07, g.cy + g.ry * 1.18); ctx.lineTo(g.cx + dx * g.rx + g.rx * 0.07, g.cy + g.ry * 1.18); ctx.lineTo(g.cx + dx * g.rx + g.rx * 0.07, g.cy + g.ry * 0.9); ctx.stroke();
    }
    // ears and slot
    ctx.beginPath(); ctx.moveTo(g.cx + g.rx * 0.42, g.cy - g.ry * 0.86); ctx.lineTo(g.cx + g.rx * 0.6, g.cy - g.ry * 1.22); ctx.lineTo(g.cx + g.rx * 0.7, g.cy - g.ry * 0.7); ctx.stroke();
    ctx.fillStyle = '#0d0f14'; ctx.fillRect(g.cx - g.rx * 0.12, g.cy - g.ry - 3, g.rx * 0.24, 6);
    // highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(g.cx - g.rx * 0.2, g.cy - g.ry * 0.15, g.rx * 0.7, g.ry * 0.62, 0, Math.PI * 1.08, Math.PI * 1.38); ctx.stroke();
    ctx.restore();

    // falling coins: drop through the slot, land on the pile
    const surf = this.surfaceY(g);
    this.falling = this.falling.filter((c) => {
      c.vy += 1800 * dt; c.y += c.vy * dt; c.spin += dt * 12;
      if (c.y > g.cy - g.ry) c.x += (c.tx - c.x) * Math.min(1, dt * 6);
      if (c.y >= Math.max(surf, g.cy - g.ry * 0.9)) return false;
      this.coin(c.x + sway, c.y, cw * Math.abs(Math.cos(c.spin)) + 2, cw, 0, 0.6);
      return true;
    });
  }

  private coin(x: number, y: number, w: number, h: number, tilt: number, tone: number) {
    const { ctx } = this;
    ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
    ctx.fillStyle = tone > 0.7 ? '#ffdf73' : tone > 0.3 ? '#f5c542' : '#d9a520';
    ctx.strokeStyle = '#8a6410'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}
