// The radio: three 80s stations composed live in the browser (no recordings, nothing licensed).
// Synthwave, disco and a slow dark one, each a four-bar chord loop with a drum machine, a bass line,
// pads, an arpeggio or disco stabs, and a lead that plays a new phrase every few bars. It comes on
// in vehicles (N changes station, M switches it off), and a DJ says which station you're on.
import { sfx } from './audio.ts';

interface Station { name: string; tag: string; bpm: number; prog: number[][]; style: 'synth' | 'disco' | 'dark'; lines: string[] }
export const STATIONS: Station[] = [
  { name: 'Neon Drive FM', tag: 'all synth, all night', bpm: 104, style: 'synth', prog: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
    lines: ['Neon Drive FM. Keep your foot down and your shields up.', 'You are cruising with Neon Drive FM. The storm waits for nobody.', 'Neon Drive. If you can hear this, you are still alive. Congratulations.'] },
  { name: 'Disco Doodle 88', tag: 'four on the floor till the storm closes', bpm: 122, style: 'disco', prog: [[50, 53, 57], [55, 59, 62], [52, 55, 59], [57, 61, 64]],
    lines: ['Disco Doodle eighty eight! Dance first, loot later.', 'This is Disco Doodle. Mirror ball on, safety off.', 'Disco Doodle eighty eight, playing the hits while the island burns.'] },
  { name: 'Midnight Pencil', tag: 'slow, low and dangerous', bpm: 92, style: 'dark', prog: [[52, 55, 59], [48, 52, 55], [50, 53, 57], [47, 50, 54]],
    lines: ['Midnight Pencil. Stay low. Stay quiet.', 'You are listening to Midnight Pencil. Somebody is watching you from the tower.', 'Midnight Pencil. The King is on the hill, and the hill is on fire.'] },
];

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

class Radio {
  station = 0;
  on = false;          // playing right now
  muted = false;       // the player switched it off
  private out: GainNode | null = null;
  private delay: DelayNode | null = null;
  private timer = 0;
  private next = 0;
  private step = 0;
  private noise: AudioBuffer | null = null;
  private seed = 1;
  private lastDj = 0;
  onChange: ((name: string, tag: string) => void) | null = null;

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  private setup(c: AudioContext) {
    if (this.out) return;
    this.out = c.createGain(); this.out.gain.value = 0;
    // a touch of echo, synthwave style
    this.delay = c.createDelay(1); const fb = c.createGain(), wet = c.createGain();
    fb.gain.value = 0.28; wet.gain.value = 0.22;
    this.delay.connect(fb); fb.connect(this.delay); this.delay.connect(wet); wet.connect(this.out);
    this.out.connect(c.destination);
    const len = c.sampleRate * 0.5, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  play(station = this.station) {
    const c = sfx.context;
    if (!c) return;
    this.setup(c);
    const changed = station !== this.station || !this.on;
    this.station = station;
    if (!this.on) { this.on = true; this.next = c.currentTime + 0.05; this.step = 0; this.timer = window.setInterval(() => this.pump(), 25); }
    this.out!.gain.setTargetAtTime(0.16, c.currentTime, 0.4);
    this.delay!.delayTime.value = (60 / STATIONS[station].bpm) * 0.75;
    if (changed) { this.seed = 7 + station * 131; this.dj(true); }
  }
  stop() {
    const c = sfx.context;
    if (!this.on || !c || !this.out) return;
    this.on = false;
    this.out.gain.setTargetAtTime(0, c.currentTime, 0.25);
    window.clearInterval(this.timer);
  }
  nextStation() { this.play((this.station + 1) % STATIONS.length); }

  // the DJ: a line when you tune in, and now and then between songs
  private dj(tuned: boolean) {
    const s = STATIONS[this.station];
    this.onChange?.(s.name, s.tag);
    this.lastDj = performance.now();
    try {
      const say = window.speechSynthesis;
      if (!say) return;
      say.cancel();
      const u = new SpeechSynthesisUtterance(tuned ? `${s.name}. ${s.tag}.` : s.lines[Math.floor(Math.random() * s.lines.length)]);
      u.rate = 1.05; u.pitch = this.station === 2 ? 0.7 : 1.1; u.volume = 0.8; u.lang = 'en-US';
      say.speak(u);
    } catch { /* no speech: the toast is enough */ }
  }

  private pump() {
    const c = sfx.context;
    if (!c || !this.on) return;
    const st = STATIONS[this.station], dur = 60 / st.bpm / 4;
    while (this.next < c.currentTime + 0.12) { this.play16(c, st, this.step, this.next, dur); this.next += dur; this.step++; }
    if (performance.now() - this.lastDj > 150_000 && this.step % 64 === 0) this.dj(false);
  }

  private env(c: AudioContext, node: AudioNode, t: number, peak: number, a: number, d: number, dest: AudioNode = this.out!) {
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0008, t + a + d);
    node.connect(g); g.connect(dest);
    return g;
  }
  private osc(c: AudioContext, type: OscillatorType, f: number, t: number, len: number, peak: number, a: number, d: number, cutoff = 0, echo = false) {
    const o = c.createOscillator(); o.type = type; o.frequency.value = f;
    let node: AudioNode = o;
    if (cutoff) { const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; o.connect(lp); node = lp; }
    this.env(c, node, t, peak, a, d);
    if (echo) this.env(c, node, t, peak * 0.8, a, d, this.delay!);
    o.start(t); o.stop(t + len + 0.05);
  }
  private hit(c: AudioContext, t: number, type: BiquadFilterType, f: number, peak: number, d: number) {
    const s = c.createBufferSource(); s.buffer = this.noise;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; s.connect(fl);
    this.env(c, fl, t, peak, 0.002, d);
    s.start(t); s.stop(t + d + 0.05);
  }
  private kick(c: AudioContext, t: number) {
    const o = c.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    this.env(c, o, t, 0.9, 0.002, 0.28); o.start(t); o.stop(t + 0.35);
  }

  private play16(c: AudioContext, st: Station, n: number, t: number, dur: number) {
    const s = n % 16, bar = Math.floor(n / 16), chord = st.prog[bar % st.prog.length], root = chord[0];
    // drums
    if (st.style === 'dark' ? s === 0 || s === 10 : s % 4 === 0) this.kick(c, t);
    if (s === 4 || s === 12) this.hit(c, t, 'bandpass', st.style === 'disco' ? 1400 : 1900, 0.5, st.style === 'dark' ? 0.3 : 0.16);
    if (st.style === 'disco' ? s % 4 === 2 : s % 2 === 0) this.hit(c, t, 'highpass', 8000, st.style === 'disco' ? 0.22 : 0.1, st.style === 'disco' ? 0.12 : 0.035);
    // bass: driving eighths (synth), octave bounce (disco), long low notes (dark)
    if (st.style === 'synth' && s % 2 === 0) this.osc(c, 'sawtooth', hz(root - 24), t, dur * 1.6, 0.32, 0.005, dur * 1.5, 520);
    if (st.style === 'disco' && s % 2 === 0) this.osc(c, 'sawtooth', hz(root - 24 + (s % 4 === 2 ? 12 : 0)), t, dur * 1.4, 0.34, 0.004, dur * 1.3, 700);
    if (st.style === 'dark' && (s === 0 || s === 6 || s === 11)) this.osc(c, 'sawtooth', hz(root - 24), t, dur * 5, 0.32, 0.01, dur * 4.5, 380);
    // pads: the chord held for the bar
    if (s === 0 && st.style !== 'disco') for (const m of chord) for (const det of [-6, 6]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = det;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = st.style === 'dark' ? 700 : 1300; o.connect(lp);
      const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.035, t + dur * 4); g.gain.linearRampToValueAtTime(0, t + dur * 16);
      lp.connect(g); g.connect(this.out!); o.start(t); o.stop(t + dur * 16 + 0.05);
    }
    // arpeggio (synth), chord stabs on the off-beats (disco), a slow bell (dark)
    if (st.style === 'synth') this.osc(c, 'square', hz(chord[s % 3] + 12 + (s % 8 >= 4 ? 12 : 0)), t, dur, 0.05, 0.003, dur * 0.9, 2400, true);
    if (st.style === 'disco' && (s % 4 === 2)) for (const m of chord) this.osc(c, 'triangle', hz(m + 12), t, dur * 1.2, 0.07, 0.003, dur * 1.1, 3000);
    if (st.style === 'dark' && s % 8 === 4) this.osc(c, 'sine', hz(chord[(bar + s) % 3] + 24), t, dur * 6, 0.08, 0.01, dur * 6, 0, true);
    // the lead: a new phrase every other four bars, notes from the chord's pentatonic
    if (bar % 8 >= 4 && s % 2 === 0 && this.rnd() < (st.style === 'dark' ? 0.25 : 0.55)) {
      const scale = [0, 3, 5, 7, 10, 12, 15], m = root + 12 + scale[Math.floor(this.rnd() * scale.length)];
      this.osc(c, st.style === 'disco' ? 'square' : 'sawtooth', hz(m), t, dur * 2, st.style === 'dark' ? 0.05 : 0.07, 0.01, dur * 1.8, 2200, true);
    }
  }
}

export const radio = new Radio();
