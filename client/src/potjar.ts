// The prize piggy bank, drawn in ballpoint. It hangs from a string; coins (highlighter yellow)
// drop through the slot on every fee inflow and the pile inside rises with the pot. Level marks
// on the glass show how much SOL each height means. Fill is 1 - e^(-sol/scale): it always moves,
// never quite tops out.
import { rng } from '../../shared/src/rng.ts';

const COINS = 700;
const INK = '#1d33b8', INK_SOFT = 'rgba(29,51,184,0.55)', RED = '#d32336', COIN = '#ffd23f', COIN_DEEP = '#f2b51c', PAPER = '#f6f2e4', PINK = 'rgba(232,96,140,0.5)';
const MARKS = [1, 5, 10, 25, 50, 100, 250];

interface Falling { x: number; y: number; vy: number; tx: number; spin: number }
export interface JarOptions { string?: boolean; marks?: boolean }

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
  private blink = 0;
  scaleSol = 40;
  sol = 0;

  constructor(private canvas: HTMLCanvasElement, private opts: JarOptions = { string: true, marks: true }) {
    this.ctx = canvas.getContext('2d')!;
    const r = rng(11);
    for (let i = 0; this.pile.length < COINS && i < COINS * 6; i++) {
      const x = r() * 2 - 1, y = r() * 2 - 1;
      if (x * x + y * y > 0.9) continue;
      this.pile.push({ x, y, tilt: r() * 0.7 - 0.35, tone: r() });
    }
    this.pile.sort((a, b) => b.y - a.y); // bottom first: revealing the first N fills from the bottom
    this.wob = Array.from({ length: 48 }, () => r() * 2 - 1); // fixed wobble: hand drawn, never flickers
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr)); this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
  }

  fillFor(sol: number) { return 1 - Math.exp(-Math.max(0, sol) / this.scaleSol); }
  setSol(sol: number) { this.sol = sol; this.target = this.fillFor(sol); }
  get percent() { return Math.round(this.target * 100); }

  inflow(sol: number) {
    const g = this.geom();
    const n = Math.min(36, 3 + Math.round(Math.log10(1 + sol * 100) * 7));
    for (let i = 0; i < n; i++) this.falling.push({ x: g.cx + (Math.random() - 0.5) * 6, y: g.top - 50 - i * 22, vy: 0, tx: g.cx + (Math.random() - 0.5) * g.rx * 1.1, spin: Math.random() * 6 });
    this.bump = Math.min(1, 0.25 + sol * 0.4);
  }

  private geom() {
    const compact = !this.opts.string;
    const rx = compact ? Math.min(this.w * 0.33, this.h * 0.5) : Math.min(this.w * 0.25, this.h * 0.34);
    const ry = rx * 0.76, cy = compact ? this.h * 0.52 : this.h * 0.52;
    return { cx: this.w / 2 - rx * 0.06, cy, rx, ry, top: cy - ry };
  }

  private blob(cx: number, cy: number, rx: number, ry: number, amp: number, off = 0) {
    const p = new Path2D(), n = this.wob.length;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, k = 1 + this.wob[(i + off) % n] * amp;
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    return p;
  }
  // stroke twice, slightly offset, like a pen going over a line again
  private pen(p: Path2D, width = 2.6, color = INK) {
    const { ctx } = this;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke(p);
    ctx.save(); ctx.translate(1.1, -0.7); ctx.globalAlpha = 0.45; ctx.lineWidth = width * 0.7; ctx.stroke(p); ctx.restore();
  }
  private surfaceY(g: ReturnType<PotJar['geom']>, f: number) { return g.cy + g.ry - f * g.ry * 2; }

  frame(dt: number) {
    if (this.w < 2) { this.resize(); if (this.w < 2) return; }
    this.t += dt;
    this.shown += (this.target - this.shown) * Math.min(1, dt * 1.6);
    this.bump = Math.max(0, this.bump - dt * 1.5);
    this.blink -= dt; if (this.blink < -3 - Math.random() * 3) this.blink = 0.12;
    const { ctx } = this;
    const g = this.geom();
    const lw = this.opts.string ? 1 : 0.7; // thinner pen when small
    const sway = Math.sin(this.t * 0.8) * 0.025 + Math.sin(this.t * 22) * this.bump * 0.02;
    const squash = 1 + this.bump * 0.05;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    if (this.opts.string) {
      ctx.translate(g.cx, 6); ctx.rotate(sway); ctx.translate(-g.cx, -6);
      const s = new Path2D(); s.moveTo(g.cx, 0); s.bezierCurveTo(g.cx + 2, g.top * 0.3, g.cx - 2, g.top * 0.7, g.cx, g.top - 4);
      this.pen(s, 2);
    }
    ctx.translate(g.cx, g.cy); ctx.scale(1 / squash, squash); ctx.translate(-g.cx, -g.cy);

    // legs behind the body
    for (const dx of [-0.55, -0.2, 0.2, 0.52]) {
      const lx = g.cx + dx * g.rx, ly = g.cy + g.ry * 0.78, lw2 = g.rx * 0.085;
      const leg = new Path2D();
      leg.moveTo(lx - lw2, ly); leg.lineTo(lx - lw2, ly + g.ry * 0.32); leg.quadraticCurveTo(lx, ly + g.ry * 0.4, lx + lw2, ly + g.ry * 0.32); leg.lineTo(lx + lw2, ly);
      ctx.fillStyle = PAPER; ctx.fill(leg); this.pen(leg, 2.3 * lw);
    }
    // ears behind
    for (const [ex, flip] of [[0.28, -1], [0.52, 1]] as const) {
      const ear = new Path2D();
      ear.moveTo(g.cx + (ex - 0.1) * g.rx, g.cy - g.ry * 0.86);
      ear.quadraticCurveTo(g.cx + (ex + 0.02 * flip) * g.rx, g.cy - g.ry * 1.42, g.cx + (ex + 0.14) * g.rx, g.cy - g.ry * 0.82);
      ctx.fillStyle = PAPER; ctx.fill(ear); this.pen(ear, 2.3 * lw);
    }

    // glass body with the coin pile inside
    const body = this.blob(g.cx, g.cy, g.rx, g.ry, 0.016);
    ctx.save(); ctx.clip(body);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill(body);
    const n = Math.floor(this.shown * this.pile.length), cw = g.rx * 0.085, ch = cw * 0.45;
    for (let i = 0; i < n; i++) { const c = this.pile[i]; this.coin(g.cx + c.x * g.rx, g.cy + c.y * g.ry, cw, ch, c.tilt, c.tone); }
    if (n > 0) {
      const sy = this.surfaceY(g, this.shown * 1.02);
      ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1.6 * lw; ctx.beginPath();
      for (let x = g.cx - g.rx; x <= g.cx + g.rx; x += 8) { const y = sy + Math.sin(x * 0.11 + this.t) * 2; if (x === g.cx - g.rx) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(29,51,184,0.1)'; ctx.lineWidth = 1.2;
    for (let k = -g.rx * 2; k < g.rx * 2; k += 13) { ctx.beginPath(); ctx.moveTo(g.cx + k, g.cy - g.ry); ctx.lineTo(g.cx + k - g.ry * 0.9, g.cy - g.ry * 0.1); ctx.stroke(); }
    ctx.restore();
    this.pen(body, 2.8 * lw);

    // level marks on the glass: what each height is worth
    if (this.opts.marks) {
      ctx.font = `700 ${Math.max(14, g.rx * 0.11)}px Caveat, cursive`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const sol of MARKS) {
        const f = this.fillFor(sol);
        if (f > 0.9 || f < 0.1) continue;
        // a measuring-cup tick inside the glass, labelled on a little paper tag
        const y = this.surfaceY(g, f), dy = (y - g.cy) / g.ry, half = Math.sqrt(Math.max(0, 1 - dy * dy)) * g.rx;
        const x0 = g.cx - half * 0.96, reached = this.shown >= f, label = `${sol} ◎`;
        ctx.strokeStyle = reached ? RED : INK_SOFT; ctx.lineWidth = reached ? 2.2 : 1.4;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + g.rx * 0.14, y); ctx.stroke();
        const tw = ctx.measureText(label).width + 8, lx = x0 + g.rx * 0.17;
        ctx.fillStyle = 'rgba(246,242,228,0.92)'; ctx.fillRect(lx, y - 9, tw, 18);
        ctx.fillStyle = reached ? RED : INK_SOFT; ctx.textAlign = 'left'; ctx.fillText(label, lx + 4, y);
      }
    }

    // face: snout with nostrils, eye with a glint (it blinks), a blush and a smile
    const sx = g.cx + g.rx * 0.95, sy = g.cy + g.ry * 0.08;
    const snout = this.blob(sx, sy, g.rx * 0.15, g.ry * 0.27, 0.03, 9);
    ctx.fillStyle = PAPER; ctx.fill(snout); ctx.fillStyle = PINK; ctx.fill(snout); this.pen(snout, 2.4 * lw);
    ctx.fillStyle = INK;
    for (const oy of [-0.09, 0.09]) { ctx.beginPath(); ctx.ellipse(sx + g.rx * 0.02, sy + oy * g.ry, 2.6 * lw + 0.5, 4.2 * lw + 0.5, 0, 0, Math.PI * 2); ctx.fill(); }
    const ex = g.cx + g.rx * 0.6, ey = g.cy - g.ry * 0.3;
    if (this.blink > 0) { ctx.strokeStyle = INK; ctx.lineWidth = 2.4 * lw; ctx.beginPath(); ctx.moveTo(ex - 5, ey); ctx.lineTo(ex + 5, ey); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(ex, ey, g.rx * 0.045 + 1, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + 1.6, ey - 1.6, g.rx * 0.014 + 0.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = PINK; ctx.beginPath(); ctx.ellipse(g.cx + g.rx * 0.66, g.cy + g.ry * 0.06, g.rx * 0.09, g.ry * 0.07, 0, 0, Math.PI * 2); ctx.fill();
    const smile = new Path2D(); smile.moveTo(g.cx + g.rx * 0.7, g.cy + g.ry * 0.32); smile.quadraticCurveTo(g.cx + g.rx * 0.8, g.cy + g.ry * 0.42, g.cx + g.rx * 0.88, g.cy + g.ry * 0.34); this.pen(smile, 2 * lw);
    // curly tail
    const tail = new Path2D(), tx = g.cx - g.rx * 0.99, ty = g.cy - g.ry * 0.05;
    tail.moveTo(tx, ty);
    for (let a = 0; a < Math.PI * 3.4; a += 0.2) { const rr = 3 + a * 2; tail.lineTo(tx - 8 - Math.cos(a) * rr * 0.6 - a * 2, ty - Math.sin(a) * rr * 0.6); }
    this.pen(tail, 2.2 * lw);
    // slot with a coin halfway in
    const slot = new Path2D(); slot.moveTo(g.cx - g.rx * 0.14, g.top + 4); slot.lineTo(g.cx + g.rx * 0.14, g.top + 3);
    this.coin(g.cx, g.top - cw * 0.3 + Math.sin(this.t * 3) * 1.5, cw * 0.95, cw * 0.95, 0, 0.8);
    this.pen(slot, 4.5 * lw);
    // glare
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 5 * lw; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(g.cx - g.rx * 0.25, g.cy - g.ry * 0.1, g.rx * 0.62, g.ry * 0.6, 0, Math.PI * 1.1, Math.PI * 1.36); ctx.stroke();
    ctx.restore();

    // falling coins with motion lines
    const surf = this.surfaceY(g, this.shown);
    this.falling = this.falling.filter((c) => {
      c.vy += 1700 * dt; c.y += c.vy * dt; c.spin += dt * 10;
      if (c.y > g.top) c.x += (c.tx - c.x) * Math.min(1, dt * 6);
      if (c.y >= Math.max(surf, g.top + g.ry * 0.25)) return false;
      if (c.y > -20) {
        this.coin(c.x, c.y, Math.abs(Math.cos(c.spin)) * cw + 2, cw * 0.9, 0, 0.5);
        if (c.vy > 300) { ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(c.x - 4, c.y - cw - 6); ctx.lineTo(c.x - 4, c.y - cw - 16); ctx.moveTo(c.x + 4, c.y - cw - 4); ctx.lineTo(c.x + 4, c.y - cw - 12); ctx.stroke(); }
      }
      return true;
    });
  }

  private coin(x: number, y: number, w: number, h: number, tilt: number, tone: number) {
    const { ctx } = this;
    ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
    ctx.fillStyle = tone > 0.55 ? COIN : COIN_DEEP; ctx.strokeStyle = INK; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(0, 0, Math.max(0.5, w), Math.max(0.5, h), 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (w > 6) { ctx.strokeStyle = 'rgba(29,51,184,0.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.55, h * 0.5, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
}
