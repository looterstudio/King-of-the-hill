// Procedural sound: every effect is synthesised with WebAudio, no files. Starts muted until the
// player clicks (browsers only allow audio after a gesture).
import type { WeaponId } from '../../shared/src/constants.ts';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private vol = { master: 1, effects: 1, music: 1 };
  enabled = true;
  get context() { return this.ctx; }
  // where music (the radio) plays into, so the music slider reaches it
  get music(): AudioNode | null { return this.musicBus; }
  // effects level 0..1 for things that don't go through WebAudio (the spoken announcer)
  get effectsLevel() { return this.vol.master * this.vol.effects; }
  get musicLevel() { return this.vol.master * this.vol.music; }

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain(); this.musicBus.connect(this.ctx.destination);
      this.applyVolume();
      const len = this.ctx.sampleRate * 0.6, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    } catch { this.ctx = null; }
  }
  // the settings sliders, 0..1 each
  setVolume(master: number, effects: number, music: number) { this.vol = { master, effects, music }; this.applyVolume(); }
  private applyVolume() {
    const c = this.ctx;
    if (!c || !this.master || !this.musicBus) return;
    this.master.gain.setTargetAtTime(0.5 * this.vol.master * this.vol.effects, c.currentTime, 0.03);
    this.musicBus.gain.setTargetAtTime(this.vol.master * this.vol.music, c.currentTime, 0.03);
  }

  // a continuous engine for whatever you drive: pitch follows speed, off when on foot (ride 0)
  private eng: { osc: OscillatorNode; sub: OscillatorNode; gain: GainNode } | null = null;
  engine(ride: number, speed: number) {
    const c = this.ctx;
    if (!c || !this.master) return;
    if (!ride) { if (this.eng) { this.eng.gain.gain.setTargetAtTime(0, c.currentTime, 0.1); } return; }
    if (!this.eng) {
      const osc = c.createOscillator(), sub = c.createOscillator(), gain = c.createGain(), lp = c.createBiquadFilter();
      osc.type = 'sawtooth'; sub.type = 'square'; lp.type = 'lowpass'; lp.frequency.value = 900; gain.gain.value = 0;
      osc.connect(lp); sub.connect(lp); lp.connect(gain); gain.connect(this.master); osc.start(); sub.start();
      this.eng = { osc, sub, gain };
    }
    const base = ride === 1 ? 45 : ride === 2 ? 28 : ride === 4 ? 90 : ride === 5 ? 24 : 70, t = c.currentTime;
    this.eng.osc.frequency.setTargetAtTime(base + speed * (ride === 3 ? 3 : 4), t, 0.08);
    this.eng.sub.frequency.setTargetAtTime((base + speed * 2) / 2 + (ride === 2 ? Math.sin(t * 40) * 6 : 0), t, 0.05);
    this.eng.gain.gain.setTargetAtTime(ride === 2 ? 0.06 : 0.045, t, 0.15);
  }

  // the minigun's barrels: a motor whine that climbs as they spin up and winds down when you let go,
  // so you hear when it is about to fire. k = 0 still, 1 full speed
  private whirr: { osc: OscillatorNode; buzz: OscillatorNode; gain: GainNode; bp: BiquadFilterNode } | null = null;
  spin(k: number) {
    const c = this.ctx;
    if (!c || !this.master) return;
    if (k <= 0.001 || !this.enabled) { if (this.whirr) this.whirr.gain.gain.setTargetAtTime(0, c.currentTime, 0.12); return; }
    if (!this.whirr) {
      const osc = c.createOscillator(), buzz = c.createOscillator(), gain = c.createGain(), bp = c.createBiquadFilter();
      osc.type = 'sawtooth'; buzz.type = 'square'; bp.type = 'bandpass'; bp.Q.value = 2.5; gain.gain.value = 0;
      osc.connect(bp); buzz.connect(bp); bp.connect(gain); gain.connect(this.master); osc.start(); buzz.start();
      this.whirr = { osc, buzz, gain, bp };
    }
    const t = c.currentTime;
    this.whirr.osc.frequency.setTargetAtTime(70 + k * 360, t, 0.05);
    this.whirr.buzz.frequency.setTargetAtTime(35 + k * 180, t, 0.05);
    this.whirr.bp.frequency.setTargetAtTime(500 + k * 1600, t, 0.05);
    this.whirr.gain.gain.setTargetAtTime(0.025 + k * 0.05, t, 0.04);
  }
  // wind past your ears while you fall, glide or ride the paper plane: a looped hiss, louder and brighter
  // the faster you go (k = 0 still, 1 a dive in free fall)
  private gust: { gain: GainNode; bp: BiquadFilterNode } | null = null;
  wind(k: number) {
    const c = this.ctx;
    if (!c || !this.master || !this.noise) return;
    if (k <= 0.001 || !this.enabled) { if (this.gust) this.gust.gain.gain.setTargetAtTime(0, c.currentTime, 0.25); return; }
    if (!this.gust) {
      const src = c.createBufferSource(), bp = c.createBiquadFilter(), gain = c.createGain();
      src.buffer = this.noise; src.loop = true; bp.type = 'bandpass'; bp.Q.value = 0.7; gain.gain.value = 0;
      src.connect(bp).connect(gain).connect(this.master); src.start();
      this.gust = { gain, bp };
    }
    const t = c.currentTime;
    this.gust.bp.frequency.setTargetAtTime(280 + k * 1100 + Math.sin(t * 1.7) * 60 * k, t, 0.15);
    this.gust.gain.gain.setTargetAtTime(0.04 + k * 0.16, t, 0.2);
  }
  // the glider snapping open: a paper flap and a short rush
  glider() { if (this.ctx && this.enabled) { this.burst(900, 1.2, 0.35, 0.22, 'bandpass'); this.burst(2600, 3, 0.12, 0.08, 'bandpass'); } }
  // full speed reached: a click as the bolt engages
  spunUp() { if (this.ctx && this.enabled) { this.burst(4200, 4, 0.18, 0.03, 'bandpass'); this.tone(900, 1400, 0.06, 0.06, 'square'); } }
  // pulling the trigger on an empty gun
  dry() { if (this.ctx && this.enabled) this.burst(3800, 6, 0.2, 0.025, 'bandpass'); }

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
    if (w === 'rocket' || w === 'stinger' || w === 'guided') { this.burst(500, 0.6, 0.8 * v, 0.6); this.tone(160, 50, 0.4 * v, 0.5, 'sawtooth'); return; }
    if (w === 'blade') { this.burst(1400, 1.5, 0.45 * v, 0.22, 'bandpass'); this.tone(110, 220, 0.3 * v, 0.24, 'sawtooth'); this.tone(330, 165, 0.12 * v, 0.2, 'square', 0.04); return; } // a humming swoosh
    if (w === 'wand') { this.tone(700, 2400, 0.3 * v, 0.18, 'sine'); this.tone(1400, 3800, 0.16 * v, 0.22, 'triangle', 0.03); this.burst(6000, 2, 0.15 * v, 0.12, 'highpass'); return; } // a rising sparkle
    if (w === 'heavy' || w === 'hunting') { this.burst(900, 0.7, 0.9 * v, w === 'heavy' ? 0.8 : 0.5); this.tone(w === 'heavy' ? 80 : 120, 35, 0.55 * v, 0.45, 'triangle'); }
    else if (w === 'tac' || w === 'pump') { this.burst(1400, 0.5, 0.85 * v, 0.35); this.tone(90, 45, 0.35 * v, 0.25, 'triangle'); }
    else if (w === 'minigun') { this.burst(1900, 0.8, 0.5 * v, 0.07); this.tone(150, 70, 0.16 * v, 0.05, 'square'); }
    else if (w === 'burst') { this.burst(2900, 1.2, 0.5 * v, 0.06); this.tone(260, 120, 0.2 * v, 0.045, 'square'); this.tone(1200, 600, 0.06 * v, 0.03, 'triangle'); } // short and clipped: three of them read as a burst
    else if (w === 'pistol') { this.burst(2600, 0.9, 0.45 * v, 0.1); this.tone(220, 90, 0.15 * v, 0.07, 'square'); }
    else { this.burst(w === 'scar' ? 1900 : 2200, 0.8, 0.5 * v, 0.12); this.tone(w === 'scar' ? 130 : 160, 70, 0.22 * v, 0.08, 'square'); }
  }
  // a hit you landed: a crisp tick; a headshot is a bright metallic "dink" you feel in your teeth
  hit(head: boolean) {
    if (!this.ctx || !this.enabled) return;
    if (head) {
      this.burst(7000, 2, 0.28, 0.03, 'highpass');
      this.tone(2400, 2650, 0.32, 0.09, 'sine'); this.tone(3600, 3900, 0.22, 0.17, 'sine', 0.03); this.tone(1200, 1260, 0.18, 0.22, 'triangle', 0.02);
    } else { this.burst(5200, 3, 0.13, 0.02, 'highpass'); this.tone(1300, 950, 0.22, 0.05, 'triangle'); }
  }
  hurt() { if (this.ctx && this.enabled) { this.burst(500, 1, 0.4, 0.15); this.tone(180, 90, 0.25, 0.15, 'sawtooth'); } }
  // you eliminated someone: a deep punch, then a rising three-note chime (brighter for a headshot,
  // a step higher for every kill in a streak)
  elim(head = false, streak = 1) {
    if (!this.ctx || !this.enabled) return;
    this.tone(150, 42, 0.6, 0.3, 'triangle'); this.burst(320, 0.8, 0.55, 0.22);
    const f = (head ? 1046 : 880) * Math.pow(1.122, Math.min(4, streak - 1));
    this.tone(f, f, 0.26, 0.12, 'square', 0.06); this.tone(f * 1.5, f * 1.5, 0.26, 0.2, 'square', 0.14); this.tone(f * 2, f * 2.03, 0.18, 0.4, 'sine', 0.22);
    if (head) this.tone(3300, 3500, 0.14, 0.25, 'sine', 0.02);
  }
  // a reload you can hear through: the mag (or drum) comes out, goes in, and the gun is racked when
  // it is ready to fire again (the last click lands as the reload ends)
  reload(secs = 1.5) {
    if (!this.ctx || !this.enabled) return;
    this.burst(3000, 3, 0.25, 0.04, 'bandpass');
    setTimeout(() => this.ctx && this.burst(2400, 3, 0.25, 0.05, 'bandpass'), Math.min(600, secs * 300));
    setTimeout(() => { if (this.ctx) { this.burst(1800, 2.5, 0.3, 0.06, 'bandpass'); this.tone(700, 500, 0.05, 0.05, 'square'); } }, Math.max(250, secs * 1000 - 120));
  }
  // a spell landing: a crackle and a falling chime
  zap(distance = 0) {
    if (!this.ctx || !this.enabled) return;
    const v = distance === 0 ? 1 : Math.max(0, 0.6 - distance / 160);
    if (v <= 0.01) return;
    this.burst(4500, 3, 0.35 * v, 0.14, 'bandpass'); this.tone(2600, 900, 0.22 * v, 0.25, 'sine'); this.tone(1800, 600, 0.14 * v, 0.3, 'triangle', 0.05);
  }
  boom(nuke: boolean, distance: number) {
    if (!this.ctx || !this.enabled) return;
    const v = Math.max(0.05, 1 - distance / (nuke ? 500 : 160));
    this.burst(nuke ? 300 : 700, 0.6, (nuke ? 1 : 0.8) * v, nuke ? 2.2 : 0.7);
    this.tone(nuke ? 70 : 110, 30, 0.6 * v, nuke ? 2 : 0.6, 'triangle');
  }
  siren() { if (!this.ctx || !this.enabled) return; for (let i = 0; i < 3; i++) this.tone(660, 880, 0.18, 0.5, 'sawtooth', i * 0.6); }
  open(golden: boolean) { if (!this.ctx || !this.enabled) return; this.burst(3000, 2, 0.2, 0.15, 'bandpass'); this.tone(golden ? 880 : 660, golden ? 1760 : 990, 0.2, 0.35, 'triangle', 0.05); }
  // you broke an enemy's shield: glass shattering, bright shards falling, a satisfying low thud under it
  shieldBreak() {
    if (!this.ctx || !this.enabled) return;
    this.burst(5200, 1.2, 0.42, 0.22, 'highpass'); this.burst(2600, 4, 0.25, 0.12, 'bandpass');
    this.tone(180, 70, 0.32, 0.22, 'triangle');
    [2900, 3700, 2300, 4400, 3300].forEach((f, i) => this.tone(f, f * 0.82, 0.09, 0.14, 'sine', 0.03 + i * 0.035));
  }
  // your own shield broke: a heavy crunch and a falling, hollow tone, so you know without looking
  armorLost() {
    if (!this.ctx || !this.enabled) return;
    this.burst(900, 1.5, 0.5, 0.3, 'bandpass'); this.burst(3800, 1, 0.22, 0.18, 'highpass');
    this.tone(620, 140, 0.3, 0.45, 'sawtooth'); this.tone(310, 70, 0.32, 0.55, 'triangle', 0.02);
    this.tone(1240, 1180, 0.08, 0.6, 'sine', 0.05);
  }
  // a long noise swell (reverse-cymbal feel) that rises into what follows it
  private swell(from: number, to: number, peak: number, dur: number) {
    const c = this.ctx!, t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.95); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t); src.stop(t + dur + 0.1);
  }
  // a brass-like stab: detuned saws through a filter that opens and closes, held for `hold` seconds
  private brass(freq: number, peak: number, hold: number, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.06); f.frequency.exponentialRampToValueAtTime(700, t + hold);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.025); g.gain.exponentialRampToValueAtTime(peak * 0.5, t + hold * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + hold);
    f.connect(g).connect(this.master!);
    for (const det of [-9, 0, 8]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + hold + 0.05);
    }
  }
  // the announcer's sting: a swell, then a sub hit and a minor brass chord that climbs with the
  // streak (level 1 first blood / double kill ... 5 rampage and up), a bell on top
  sting(level = 1) {
    if (!this.ctx || !this.enabled) return;
    const k = Math.max(1, Math.min(6, level)), root = 98 * Math.pow(1.122, k - 1), at = 0.32; // G2, a whole step higher each level
    this.swell(500, 5200, 0.16, at);
    setTimeout(() => {
      if (!this.ctx) return;
      this.tone(70, 30, 0.75, 0.9, 'sine'); this.burst(260, 0.8, 0.6, 0.5); this.burst(6500, 1, 0.18, 0.35, 'highpass');
      for (const r of [1, 1.189, 1.498, 2]) this.brass(root * r, 0.07, 1.1 + k * 0.12); // minor triad and the octave
      if (k >= 3) this.brass(root * 2.997, 0.04, 1.2, 0.18); // a high fifth answers on the big ones
      this.tone(root * 8, root * 8, 0.08, 1.4, 'sine', 0.05); this.tone(root * 12, root * 12.05, 0.05, 1.1, 'triangle', 0.08);
    }, at * 1000);
  }
  // the storm's warning: two square-wave beeps (higher and doubled when it is about to close)
  alarm(urgent = false) {
    if (!this.ctx || !this.enabled) return;
    const hi = urgent ? 1046 : 880, lo = urgent ? 784 : 660;
    this.tone(hi, hi, 0.1, 0.16, 'square'); this.tone(lo, lo, 0.1, 0.16, 'square', 0.2);
    if (urgent) { this.tone(hi, hi, 0.1, 0.16, 'square', 0.4); this.tone(lo, lo, 0.1, 0.16, 'square', 0.6); }
  }
  jump() { if (this.ctx && this.enabled) this.tone(300, 520, 0.08, 0.12, 'sine'); }
  swing() { if (this.ctx && this.enabled) this.burst(900, 0.8, 0.12, 0.12, 'bandpass'); }
  chop(broke: boolean) { if (!this.ctx || !this.enabled) return; this.burst(broke ? 500 : 1800, 2, broke ? 0.35 : 0.25, broke ? 0.3 : 0.08); if (broke) this.tone(160, 60, 0.18, 0.3, 'triangle'); }
  // you won: a short brass-ish fanfare, up a major arpeggio to a held chord
  // the lobby: a soft tick when browsing (characters, modes), a bright chord on a pick, a whoosh opening
  // the character select, a two-note chime when a friend lands in your party
  ui(kind: 'tick' | 'pick' | 'open' | 'join') {
    if (!this.ctx || !this.enabled) return;
    if (kind === 'tick') { this.tone(1320, 1180, 0.05, 0.05, 'triangle'); this.burst(5200, 6, 0.04, 0.02, 'bandpass'); }
    else if (kind === 'open') { this.burst(1400, 0.9, 0.16, 0.22, 'bandpass'); this.tone(392, 784, 0.08, 0.2, 'triangle'); }
    else if (kind === 'join') { this.tone(659, 659, 0.12, 0.18, 'triangle'); this.tone(988, 988, 0.12, 0.3, 'triangle', 0.11); }
    else {
      this.burst(900, 1.4, 0.3, 0.12, 'bandpass');
      for (const [f, d] of [[523, 0], [659, 0.04], [784, 0.08], [1047, 0.12]] as const) this.tone(f, f, 0.13, 0.55, 'triangle', d);
      this.tone(2093, 2637, 0.05, 0.4, 'sine', 0.14);
    }
  }
  fanfare() {
    if (!this.ctx || !this.enabled) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => { this.tone(f, f, 0.22, 0.32, 'sawtooth', i * 0.14); this.tone(f / 2, f / 2, 0.12, 0.32, 'square', i * 0.14); });
    for (const f of [523, 659, 784, 1047]) this.tone(f, f, 0.14, 1.6, 'triangle', 0.62);
    this.burst(5000, 1, 0.2, 0.6, 'highpass');
  }
  // a building coming down: a long low rumble
  crumble(distance: number) {
    if (!this.ctx || !this.enabled) return;
    const v = Math.max(0.15, 1 - distance / 500);
    this.burst(120, 0.7, 0.9 * v, 2.4); this.burst(300, 1, 0.5 * v, 1.6); this.tone(70, 30, 0.4 * v, 2.2, 'sawtooth');
  }
}

export const sfx = new Sfx();
