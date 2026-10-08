// Procedural sound: every effect is synthesised with WebAudio, no files. Starts muted until the
// player clicks (browsers only allow audio after a gesture).
import type { WeaponId } from '../../shared/src/constants.ts';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  enabled = true;

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.6, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    } catch { this.ctx = null; }
  }

  private env(g: GainNode, t: number, peak: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  }

  private burst(freq: number, q: number, peak: number, decay: number, type: BiquadFilterType = 'lowpass') {
    const c = this.ctx!, t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(); this.env(g, t, peak, decay);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t); src.stop(t + decay + 0.05);
  }

  private tone(freq: number, to: number, peak: number, decay: number, type: OscillatorType = 'sine', delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(to, t + decay);
    const g = c.createGain(); this.env(g, t, peak, decay);
    o.connect(g).connect(this.master!);
    o.start(t); o.stop(t + decay + 0.05);
  }

  // distance 0 = our own gun
  shot(w: WeaponId, distance = 0) {
    if (!this.ctx || !this.enabled) return;
    const v = distance === 0 ? 1 : Math.max(0, 0.5 - distance / 220);
    if (v <= 0.01) return;
    if (w === 'heavy' || w === 'hunting') { this.burst(900, 0.7, 0.9 * v, w === 'heavy' ? 0.8 : 0.5); this.tone(w === 'heavy' ? 80 : 120, 35, 0.55 * v, 0.45, 'triangle'); }
    else if (w === 'tac' || w === 'pump') { this.burst(1400, 0.5, 0.85 * v, 0.35); this.tone(90, 45, 0.35 * v, 0.25, 'triangle'); }
    else if (w === 'minigun') { this.burst(2600, 1, 0.35 * v, 0.06); }
    else if (w === 'pistol') { this.burst(2600, 0.9, 0.45 * v, 0.1); this.tone(220, 90, 0.15 * v, 0.07, 'square'); }
    else { this.burst(w === 'scar' ? 1900 : 2200, 0.8, 0.5 * v, 0.12); this.tone(w === 'scar' ? 130 : 160, 70, 0.22 * v, 0.08, 'square'); }
  }
  hit(head: boolean) {
    if (!this.ctx || !this.enabled) return;
    if (head) { this.tone(1700, 1700, 0.35, 0.12, 'sine'); this.tone(2550, 2550, 0.25, 0.18, 'sine', 0.05); }
    else this.tone(1200, 900, 0.22, 0.06, 'triangle');
  }
  hurt() { if (this.ctx && this.enabled) { this.burst(500, 1, 0.4, 0.15); this.tone(180, 90, 0.25, 0.15, 'sawtooth'); } }
  elim() { if (this.ctx && this.enabled) { this.tone(880, 880, 0.3, 0.1, 'square'); this.tone(1320, 1320, 0.3, 0.16, 'square', 0.09); } }
  reload() { if (this.ctx && this.enabled) { this.burst(3000, 3, 0.25, 0.04, 'bandpass'); setTimeout(() => this.ctx && this.burst(2400, 3, 0.25, 0.05, 'bandpass'), 180); } }
  boom(nuke: boolean, distance: number) {
    if (!this.ctx || !this.enabled) return;
    const v = Math.max(0.05, 1 - distance / (nuke ? 500 : 160));
    this.burst(nuke ? 300 : 700, 0.6, (nuke ? 1 : 0.8) * v, nuke ? 2.2 : 0.7);
    this.tone(nuke ? 70 : 110, 30, 0.6 * v, nuke ? 2 : 0.6, 'triangle');
  }
  siren() { if (!this.ctx || !this.enabled) return; for (let i = 0; i < 3; i++) this.tone(660, 880, 0.18, 0.5, 'sawtooth', i * 0.6); }
  open(golden: boolean) { if (!this.ctx || !this.enabled) return; this.burst(3000, 2, 0.2, 0.15, 'bandpass'); this.tone(golden ? 880 : 660, golden ? 1760 : 990, 0.2, 0.35, 'triangle', 0.05); }
  jump() { if (this.ctx && this.enabled) this.tone(300, 520, 0.08, 0.12, 'sine'); }
}

export const sfx = new Sfx();
