// The prize piggy bank, drawn in ballpoint. It hangs from a string; coins (highlighter yellow)
// drop through the slot on every fee inflow and the pile inside rises with the pot. Level marks
// on the glass show how much SOL each height means. Fill is 1 - e^(-sol/scale): it always moves,
// never quite tops out.
import { rng } from '../../shared/src/rng.ts';

const COINS = 700;
const INK = '#1d33b8', INK_SOFT = 'rgba(29,51,184,0.55)', RED = '#d32336', COIN = '#ffd23f', COIN_DEEP = '#f2b51c', PAPER = '#f6f2e4', PINK = 'rgba(232,96,140,0.5)';
const MARKS = [1, 5, 10, 25, 50, 100, 250];

interface Falling { x: number; y: number; vy: number; tx: number; spin: number }
interface Sparkle { x: number; y: number; life: number; max: number; size: number }
interface Floater { text: string; x: number; y: number; life: number; big: boolean }
// crown: the King Pig wears one. rays: a slow sunburst behind it (the lobby's big pig). pipe: the fee
// pipe coming in from the left, every trade's coins rolling down it into the slot
export interface JarOptions { string?: boolean; marks?: boolean; crown?: boolean; rays?: boolean; pipe?: boolean }
interface Piped { t: number; v: number; tone: number }
interface Burst { x: number; y: number; vx: number; vy: number; spin: number; life: number }

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
  private sparkles: Sparkle[] = [];
  private floaters: Floater[] = [];
  private crownY = 0; private crownV = 0;
  private piping: Piped[] = [];
  private bursts: Burst[] = [];
  private flow = 0; // how busy the pipe has been lately: it glows with it
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
    // through the fee pipe when there is one (the coins arrive in the slot a moment later), else from above
    if (this.opts.pipe) for (let i = 0; i < n; i++) this.piping.push({ t: -i * 0.06, v: 0.55 + Math.random() * 0.25, tone: Math.random() });
    else for (let i = 0; i < n; i++) this.falling.push({ x: g.cx + (Math.random() - 0.5) * 6, y: g.top - 50 - i * 22, vy: 0, tx: g.cx + (Math.random() - 0.5) * g.rx * 1.1, spin: Math.random() * 6 });
    this.flow = Math.min(1, this.flow + 0.25 + sol);
    // a whale: coins spray out of the slot and rain back down
    if (sol >= 0.3 && this.opts.rays) for (let i = 0; i < Math.min(60, 12 + sol * 25); i++) { const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, s = 260 + Math.random() * 420; this.bursts.push({ x: g.cx, y: g.top, vx: Math.cos(a) * s, vy: Math.sin(a) * s, spin: Math.random() * 6, life: 0 }); }
    this.bump = Math.min(1, 0.25 + sol * 0.4);
    // the crown hops, sparkles burst out of the slot, and the amount floats up
    this.crownV -= 120 + Math.min(400, sol * 500);
    for (let i = 0; i < Math.min(14, 4 + sol * 20); i++) this.sparkles.push({ x: g.cx + (Math.random() - 0.5) * g.rx * 0.9, y: g.top - Math.random() * g.ry * 0.6, life: 0, max: 0.5 + Math.random() * 0.6, size: 4 + Math.random() * 6 });
    if (this.opts.rays) this.floaters.push({ text: `+${sol < 0.1 ? sol.toFixed(3) : sol.toFixed(2)} ◎`, x: g.cx + g.rx * (0.3 + Math.random() * 0.4), y: g.top - 8, life: 0, big: sol >= 0.3 });
  }

  private geom() {
    const compact = !this.opts.string;
    const rx = compact ? Math.min(this.w * 0.33, this.h * 0.5) : Math.min(this.w * (this.opts.pipe ? 0.24 : 0.25), this.h * 0.34);
    const ry = rx * 0.76, cy = compact ? this.h * 0.52 : this.h * (this.opts.pipe ? 0.56 : 0.52);
    return { cx: this.w / 2 + (this.opts.pipe ? rx * 0.18 : -rx * 0.06), cy, rx, ry, top: cy - ry };
  }
  // the fee pipe: a bezier from the funnel up on the left down into the slot
  private pipePts(g: ReturnType<PotJar['geom']>) {
    return [g.cx - g.rx * 1.75, g.top - g.ry * 0.55, g.cx - g.rx * 1.25, g.top - g.ry * 1.05, g.cx - g.rx * 0.25, g.top - g.ry * 0.95, g.cx, g.top - 10];
  }
  private bez(p: number[], t: number) {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
  }
  private drawPipe(g: ReturnType<PotJar['geom']>, cw: number, dt: number) {
    const { ctx } = this, p = this.pipePts(g), w = cw * 2.6;
    this.flow = Math.max(0, this.flow - dt * 0.25);
    const path = new Path2D(); path.moveTo(p[0], p[1]); path.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
    // a glass tube: ink outline, paper inside, a gold glow while coins run through it
    ctx.save(); ctx.lineCap = 'round';
    if (this.flow > 0.02) { ctx.strokeStyle = `rgba(255,210,63,${0.35 * this.flow})`; ctx.lineWidth = w + 14; ctx.stroke(path); }
    ctx.strokeStyle = INK; ctx.lineWidth = w + 5; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(255,253,245,0.96)'; ctx.lineWidth = w; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(29,51,184,0.12)'; ctx.lineWidth = w * 0.25; ctx.setLineDash([3, 9]); ctx.stroke(path); ctx.setLineDash([]);
    ctx.restore();
    // the coins in it
    this.piping = this.piping.filter((c) => {
      c.t += dt * c.v * (0.8 + c.t);
      if (c.t >= 1) { this.falling.push({ x: p[6], y: p[7], vy: 120, tx: g.cx + (Math.random() - 0.5) * g.rx * 1.1, spin: Math.random() * 6 }); return false; }
      if (c.t > 0) { const q = this.bez(p, c.t); this.coin(q.x, q.y, cw * 0.95, cw * 0.95, 0, c.tone); }
      return true;
    });
    // the funnel it starts from, with its label
    const fx = p[0], fy = p[1], fw = w * 1.7;
    const fun = new Path2D(); fun.moveTo(fx - fw, fy - fw * 0.95); fun.lineTo(fx + fw * 0.7, fy - fw * 1.25); fun.lineTo(fx + w * 0.45, fy + 2); fun.lineTo(fx - w * 0.5, fy + 4); fun.closePath();
    ctx.fillStyle = '#fffdf5'; ctx.fill(fun); ctx.fillStyle = `rgba(255,210,63,${0.25 + this.flow * 0.5})`; ctx.fill(fun); this.pen(fun, 2.6);
    ctx.font = `700 ${Math.max(16, g.rx * 0.15)}px Caveat, cursive`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const half = ctx.measureText('every trade pays in').width / 2 + 6; // kept inside the canvas on a narrow screen
    ctx.save(); ctx.translate(Math.max(half, fx - fw * 0.05), fy + fw * 1.05); ctx.rotate(-0.08); // under the funnel's mouth
    ctx.lineWidth = 5; ctx.strokeStyle = PAPER; ctx.strokeText('every trade pays in', 0, 0);
    ctx.fillStyle = RED; ctx.fillText('every trade pays in', 0, 0);
    ctx.restore();
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
    if (this.opts.rays) {
      // a golden aura that grows with the pot and pulses on every inflow
      const aura = ctx.createRadialGradient(g.cx, g.cy, g.rx * 0.4, g.cx, g.cy, g.rx * (1.5 + this.shown * 0.9 + this.bump * 0.4));
      aura.addColorStop(0, `rgba(255,210,63,${0.35 + this.shown * 0.35 + this.bump * 0.25})`); aura.addColorStop(1, 'rgba(255,210,63,0)');
      ctx.fillStyle = aura; ctx.fillRect(0, 0, this.w, this.h);
      // highlighter sunburst, slowly turning, fading out at the edges
      ctx.save(); ctx.translate(g.cx, g.cy); ctx.rotate(this.t * 0.06);
      const R = Math.max(this.w, this.h) * 0.75, n = 16;
      const grad = ctx.createRadialGradient(0, 0, g.rx * 0.5, 0, 0, R);
      grad.addColorStop(0, `rgba(255,222,70,${0.5 + this.bump * 0.3})`); grad.addColorStop(1, 'rgba(255,222,70,0)');
      ctx.fillStyle = grad;
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, a, a + Math.PI / n * 0.9); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      // hatched shadow on the paper
      const shY = g.cy + g.ry * 1.24;
      ctx.save(); ctx.beginPath(); ctx.ellipse(g.cx, shY, g.rx * 0.95, g.ry * 0.12, 0, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = 'rgba(29,51,184,0.28)'; ctx.lineWidth = 1.3;
      for (let x = g.cx - g.rx; x < g.cx + g.rx; x += 6) { ctx.beginPath(); ctx.moveTo(x, shY + g.ry * 0.14); ctx.lineTo(x + 10, shY - g.ry * 0.14); ctx.stroke(); }
      ctx.restore();
    }
    if (this.opts.pipe) this.drawPipe(g, g.rx * 0.085, dt);
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
    // a glint sweeping across the glass every few seconds
    const sweep = (this.t * 0.35) % 1.6 - 0.3;
    if (sweep > 0 && sweep < 1) {
      ctx.save(); ctx.clip(body);
      const gx = g.cx - g.rx * 1.2 + sweep * g.rx * 2.4;
      const lg = ctx.createLinearGradient(gx - 30, 0, gx + 30, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,0.55)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg; ctx.translate(gx, g.cy); ctx.rotate(0.35); ctx.fillRect(-30, -g.ry * 1.5, 60, g.ry * 3);
      ctx.restore();
    }
    if (this.opts.crown) this.crown(g, lw, dt);
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

    // a whale's coin spray
    this.bursts = this.bursts.filter((b) => {
      b.life += dt; b.vy += 1100 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.spin += dt * 9;
      if (b.life > 2.2 || b.y > this.h + 20) return false;
      this.coin(b.x, b.y, Math.abs(Math.cos(b.spin)) * cw + 2, cw * 0.9, 0, 0.7);
      return true;
    });

    // twinkles around a full pig, plus the bursts from inflows
    if (this.opts.rays && Math.random() < dt * (1.5 + this.shown * 6)) {
      const a = Math.random() * Math.PI * 2, d = 1.05 + Math.random() * 0.45;
      this.sparkles.push({ x: g.cx + Math.cos(a) * g.rx * d, y: g.cy + Math.sin(a) * g.ry * d, life: 0, max: 0.7 + Math.random() * 0.6, size: 3 + Math.random() * 5 });
    }
    this.sparkles = this.sparkles.filter((s) => {
      s.life += dt; if (s.life >= s.max) return false;
      const k = Math.sin((s.life / s.max) * Math.PI), r = s.size * k * (this.opts.string ? 1 : 0.6);
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.life * 2);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const rr = i % 2 ? r * 0.28 : r, a = (i / 8) * Math.PI * 2; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.closePath(); ctx.fillStyle = COIN; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      return true;
    });
    this.floaters = this.floaters.filter((f) => {
      f.life += dt; if (f.life > 1.6) return false;
      const k = f.life / 1.6;
      ctx.save(); ctx.globalAlpha = 1 - k * k;
      ctx.font = `700 ${f.big ? 34 : 26}px Caveat, cursive`; ctx.textAlign = 'center';
      ctx.lineWidth = 5; ctx.strokeStyle = PAPER; ctx.strokeText(f.text, f.x, f.y - k * 70);
      ctx.fillStyle = f.big ? '#c98a00' : '#13897f'; ctx.fillText(f.text, f.x, f.y - k * 70);
      ctx.restore();
      return true;
    });
  }

  // the King Pig's crown: gold, three points, red gems; hops on every inflow and settles on a spring
  private crown(g: ReturnType<PotJar['geom']>, lw: number, dt: number) {
    const { ctx } = this;
    this.crownV += (-this.crownY * 260 - this.crownV * 14) * dt; this.crownY += this.crownV * dt;
    const w = g.rx * 0.46, h = g.rx * 0.3, x = g.cx - g.rx * 0.36, y = g.cy - g.ry * 0.9 + Math.min(0, this.crownY);
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.2 + Math.sin(this.t * 1.3) * 0.03 + this.crownY * 0.004);
    const c = new Path2D();
    c.moveTo(-w / 2, 0); c.lineTo(-w / 2 - w * 0.04, -h); c.lineTo(-w / 4, -h * 0.5); c.lineTo(0, -h * 1.18); c.lineTo(w / 4, -h * 0.5); c.lineTo(w / 2 + w * 0.04, -h); c.lineTo(w / 2, 0); c.closePath();
    ctx.fillStyle = COIN; ctx.fill(c);
    ctx.save(); ctx.clip(c); ctx.strokeStyle = 'rgba(242,181,28,0.9)'; ctx.lineWidth = 2;
    for (let k = -w; k < w; k += 6) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + h, -h * 1.2); ctx.stroke(); }
    ctx.restore();
    this.pen(c, 2.6 * lw);
    const band = new Path2D(); band.moveTo(-w / 2, -h * 0.18); band.lineTo(w / 2, -h * 0.18); this.pen(band, 1.6 * lw);
    for (const [gx, gy, r] of [[-w / 2 - w * 0.04, -h, 0.07], [0, -h * 1.18, 0.09], [w / 2 + w * 0.04, -h, 0.07]] as const) {
      ctx.beginPath(); ctx.arc(gx, gy, w * r, 0, Math.PI * 2); ctx.fillStyle = RED; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1.4 * lw; ctx.stroke();
      ctx.beginPath(); ctx.arc(gx - w * r * 0.3, gy - w * r * 0.3, w * r * 0.3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fill();
    }
    ctx.restore();
  }

  private coin(x: number, y: number, w: number, h: number, tilt: number, tone: number) {
    const { ctx } = this;
    ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
    ctx.fillStyle = tone > 0.55 ? COIN : COIN_DEEP; ctx.strokeStyle = INK; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(0, 0, Math.max(0.5, w), Math.max(0.5, h), 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (w > 6) { ctx.strokeStyle = 'rgba(29,51,184,0.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.55, h * 0.5, 0, 0, Math.PI * 2); ctx.stroke(); }
    if (w > 9 && h > 7) { ctx.fillStyle = 'rgba(29,51,184,0.55)'; ctx.font = `700 ${h * 0.9}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('◎', 0, 0.5); }
    ctx.restore();
  }
}
