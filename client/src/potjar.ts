// The prize piggy bank, drawn in ballpoint on the notebook page. It hangs from a string; coins
// (highlighter yellow) drop through the slot on every fee inflow and the pile inside rises with
// the pot. Fill is 1 - e^(-sol/scale): it always moves, never quite tops out.
import { rng } from '../../shared/src/sim.ts';

const COINS = 700;
const INK = '#1d33b8', INK_SOFT = 'rgba(29,51,184,0.55)', COIN = '#ffd23f', COIN_DEEP = '#f2b51c', PAPER = '#f6f2e4';

interface Falling { x: number; y: number; vy: number; tx: number; spin: number }

export class PotJar {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0; private dpr = 1;
  private target = 0;
  private shown = 0;
  private falling: Falling[] = [];
  private pile: { x: number; y: number; tilt: number; tone: number }[] = [];
  private wob: number[];
  private t = 0;
  private bump = 0;
  scaleSol = 40;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const r = rng(11);
    // pile positions in unit body space, bottom first, so revealing the first N fills from the bottom
    for (let i = 0; this.pile.length < COINS && i < COINS * 6; i++) {
      const x = r() * 2 - 1, y = r() * 2 - 1;
      if (x * x + y * y > 0.9) continue;
      this.pile.push({ x, y, tilt: r() * 0.7 - 0.35, tone: r() });
    }
    this.pile.sort((a, b) => b.y - a.y);
    this.wob = Array.from({ length: 48 }, () => r() * 2 - 1); // fixed wobble: hand drawn, never flickers
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
    const n = Math.min(36, 3 + Math.round(Math.log10(1 + sol * 100) * 7));
    const g = this.geom();
    for (let i = 0; i < n; i++) this.falling.push({ x: g.cx + (Math.random() - 0.5) * 6, y: g.top - 60 - i * 24, vy: 0, tx: g.cx + (Math.random() - 0.5) * g.rx * 1.1, spin: Math.random() * 6 });
    this.bump = Math.min(1, 0.25 + sol * 0.4);
  }

  private geom() {
    const rx = Math.min(this.w * 0.27, this.h * 0.36), ry = rx * 0.7;
    const cy = this.h * 0.5;
    return { cx: this.w / 2, cy, rx, ry, top: cy - ry };
  }

  // a wobbly ellipse, stroked twice slightly offset like a pen going over a line again
  private blob(cx: number, cy: number, rx: number, ry: number, amp: number, off = 0) {
    const p = new Path2D(), n = this.wob.length;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, k = 1 + this.wob[(i + off) % n] * amp;
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    return p;
  }
  private pen(p: Path2D, width = 2.6, color = INK) {
    const { ctx } = this;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke(p);
    ctx.save(); ctx.translate(1.2, -0.8); ctx.globalAlpha = 0.45; ctx.lineWidth = width * 0.7; ctx.stroke(p); ctx.restore();
  }

  frame(dt: number) {
    this.t += dt;
    this.shown += (this.target - this.shown) * Math.min(1, dt * 1.6);
    this.bump = Math.max(0, this.bump - dt * 1.5);
    const { ctx } = this;
    const g = this.geom();
    const sway = Math.sin(this.t * 0.8) * 0.025 + Math.sin(this.t * 22) * this.bump * 0.02;
    const squash = 1 + this.bump * 0.04;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    // hook + string from the top of the page
    const hookY = 6;
    ctx.save();
    ctx.translate(g.cx, hookY);
    ctx.rotate(sway);
    const string = new Path2D();
    string.moveTo(0, 0);
    string.bezierCurveTo(2, (g.top - hookY) * 0.3, -2, (g.top - hookY) * 0.7, 0, g.top - hookY - 4);
    this.pen(string, 2);
    ctx.translate(-g.cx, -hookY);

    ctx.translate(g.cx, g.cy); ctx.scale(1 / squash, squash); ctx.translate(-g.cx, -g.cy);

    // body (glass): coins clipped inside, then the outline
    const body = this.blob(g.cx, g.cy, g.rx, g.ry, 0.018);
    ctx.save();
    ctx.clip(body);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill(body);
    const n = Math.floor(this.shown * this.pile.length);
    const cw = g.rx * 0.085, ch = cw * 0.45;
    for (let i = 0; i < n; i++) {
      const c = this.pile[i];
      this.coin(g.cx + c.x * g.rx, g.cy + c.y * g.ry, cw, ch, c.tilt, c.tone);
    }
    // the pile surface gets a pen line so the level reads at a glance
    if (n > 0) {
      const sy = g.cy + g.ry - this.shown * g.ry * 2.05;
      ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let x = g.cx - g.rx; x <= g.cx + g.rx; x += 8) { const y = sy + Math.sin(x * 0.11) * 2.5; if (x === g.cx - g.rx) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // glass hatching on the empty upper part
    ctx.strokeStyle = 'rgba(29,51,184,0.12)'; ctx.lineWidth = 1.2;
    for (let k = -g.rx * 2; k < g.rx * 2; k += 13) { ctx.beginPath(); ctx.moveTo(g.cx + k, g.cy - g.ry); ctx.lineTo(g.cx + k - g.ry * 0.9, g.cy - g.ry * 0.1); ctx.stroke(); }
    ctx.restore();

    // legs
    for (const dx of [-0.58, -0.22, 0.2, 0.55]) {
      const lx = g.cx + dx * g.rx, ly = g.cy + g.ry * 0.82;
      const leg = new Path2D();
      leg.moveTo(lx - g.rx * 0.07, ly); leg.lineTo(lx - g.rx * 0.075, ly + g.ry * 0.3);
      leg.quadraticCurveTo(lx, ly + g.ry * 0.36, lx + g.rx * 0.075, ly + g.ry * 0.3); leg.lineTo(lx + g.rx * 0.07, ly + 2);
      ctx.fillStyle = PAPER; ctx.fill(leg); this.pen(leg, 2.4);
    }
    ctx.fillStyle = 'rgba(0,0,0,0)';
    this.pen(body, 2.8);

    // snout, nostrils, eye, ear, tail, slot
    const sx = g.cx + g.rx * 0.97, sy = g.cy + g.ry * 0.06;
    const snout = this.blob(sx, sy, g.rx * 0.13, g.ry * 0.24, 0.03, 9);
    ctx.fillStyle = PAPER; ctx.fill(snout); this.pen(snout, 2.4);
    ctx.fillStyle = INK;
    for (const oy of [-0.08, 0.08]) { ctx.beginPath(); ctx.ellipse(sx + g.rx * 0.02, sy + oy * g.ry, 2.4, 4, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.arc(g.cx + g.rx * 0.62, g.cy - g.ry * 0.3, 3.6, 0, Math.PI * 2); ctx.fill();
    const ear = new Path2D();
    ear.moveTo(g.cx + g.rx * 0.36, g.cy - g.ry * 0.9); ear.lineTo(g.cx + g.rx * 0.52, g.cy - g.ry * 1.3); ear.lineTo(g.cx + g.rx * 0.66, g.cy - g.ry * 0.74);
    ctx.fillStyle = PAPER; ctx.fill(ear); this.pen(ear, 2.4);
    const tail = new Path2D();
    const tx = g.cx - g.rx * 0.99, ty = g.cy - g.ry * 0.1;
    tail.moveTo(tx, ty);
    for (let a = 0; a < Math.PI * 3.2; a += 0.2) { const rr = 4 + a * 2.2; tail.lineTo(tx - 10 - Math.cos(a) * rr * 0.6 - a * 2, ty - Math.sin(a) * rr * 0.6); }
    this.pen(tail, 2.2);
    const slot = new Path2D();
    slot.moveTo(g.cx - g.rx * 0.13, g.top + 4); slot.lineTo(g.cx + g.rx * 0.13, g.top + 3);
    this.pen(slot, 4.5);
    // glare
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(g.cx - g.rx * 0.25, g.cy - g.ry * 0.1, g.rx * 0.62, g.ry * 0.6, 0, Math.PI * 1.1, Math.PI * 1.36); ctx.stroke();
    ctx.restore();

    // falling coins with motion lines
    const surf = g.cy + g.ry - this.shown * g.ry * 2;
    this.falling = this.falling.filter((c) => {
      c.vy += 1700 * dt; c.y += c.vy * dt; c.spin += dt * 10;
      if (c.y > g.top) c.x += (c.tx - c.x) * Math.min(1, dt * 6);
      if (c.y >= Math.max(surf, g.top + g.ry * 0.25)) return false;
      if (c.y > -20) {
        const w = Math.abs(Math.cos(c.spin)) * cw + 2;
        this.coin(c.x, c.y, w, cw * 0.9, 0, 0.5);
        if (c.vy > 300) {
          ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(c.x - 4, c.y - cw - 6); ctx.lineTo(c.x - 4, c.y - cw - 16); ctx.moveTo(c.x + 4, c.y - cw - 4); ctx.lineTo(c.x + 4, c.y - cw - 12); ctx.stroke();
        }
      }
      return true;
    });
  }

  private coin(x: number, y: number, w: number, h: number, tilt: number, tone: number) {
    const { ctx } = this;
    ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
    ctx.fillStyle = tone > 0.55 ? COIN : COIN_DEEP;
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (w > 6) { ctx.strokeStyle = 'rgba(29,51,184,0.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.55, h * 0.5, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
}
