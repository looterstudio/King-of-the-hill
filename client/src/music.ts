// Lobby music: a soft lo-fi loop composed live in the browser while you're in the lobby, the party
// screen or a room filling up (not the vehicle radio). Warm pads over a Fmaj7 / Dm7 / Bbmaj7 / C7
// turnaround, a mellow electric piano, a round bass, brushed drums that come in after the intro, a
// bell melody now and then, and a little vinyl crackle. Nothing recorded, nothing licensed.
// Browsers only allow sound after a gesture, so it starts on the first click or key, fades out when
// the match goes live, and the ♪ button in the corner mutes it (remembered). Its level follows
// musicVolume and masterVolume in localStorage 'koth.settings' when the settings menu has set them.
import './music.css';
import { sfx } from './audio.ts';
import { radio } from './radio.ts';

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const BPM = 72;
// two bars per chord; the second time round the turnaround goes Am7 and Gm7 instead
const PROGS = [
  [[53, 57, 60, 64], [50, 53, 57, 60], [46, 50, 53, 57], [48, 52, 55, 58]],
  [[53, 57, 60, 64], [45, 48, 52, 55], [46, 50, 53, 57], [43, 46, 50, 53]],
];
const PENTA = [65, 67, 69, 72, 74, 77, 79, 81]; // F major pentatonic, for the bell
const BASE = 0.55;
const MUTE_KEY = 'koth.musicMuted';

// 0..1 from the settings menu (it may store 0..100); missing means full
function settingsLevel(): number {
  try {
    const s = JSON.parse(localStorage.getItem('koth.settings') ?? 'null') as { musicVolume?: unknown; masterVolume?: unknown } | null;
    const norm = (v: unknown) => { const n = Number(v); if (v === undefined || v === null || !Number.isFinite(n)) return 1; return Math.max(0, Math.min(1, n > 1 ? n / 100 : n)); };
    return s ? norm(s.musicVolume) * norm(s.masterVolume) : 1;
  } catch { return 1; }
}

class LobbyMusic {
  muted = false;
  private screen = 'lobby';
  private wanted = false;      // a gesture has happened: sound is allowed
  private playing = false;     // the scheduler is running
  private out: GainNode | null = null;
  private bus: GainNode | null = null;
  private pad: BiquadFilterNode | null = null;
  private verb: GainNode | null = null;
  private echo: DelayNode | null = null;
  private noise: AudioBuffer | null = null;
  private crackle: AudioBufferSourceNode | null = null;
  private timer = 0;
  private stopTimer = 0;
  private next = 0;
  private step = 0;
  private seed = 20261010;
  private mel = 3;             // where the bell melody is in the scale
  private level = 1;
  private levelAt = 0;
  private btn: HTMLButtonElement;

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage blocked */ }
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'music-btn';
    this.btn.innerHTML = '<span aria-hidden="true">♪</span>';
    this.btn.onclick = (e) => { e.stopPropagation(); this.toggle(); };
    document.body.appendChild(this.btn);
    this.paintBtn();
    // the first click or key anywhere unlocks audio
    const go = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.('.music-btn')) return;
      removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true);
      sfx.unlock(); this.wanted = true; this.sync();
    };
    addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
    // the lobby's radio button plays the stations instead: step aside, and come back when it's off
    let radioWas = radio.on;
    setInterval(() => { if (radio.on !== radioWas) { radioWas = radio.on; this.sync(); } }, 400);
  }

  setScreen(s: string) { this.screen = s; this.btn.classList.toggle('hidden', s === 'game'); this.sync(); }

  toggle() {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* storage blocked */ }
    if (!this.muted) { sfx.unlock(); this.wanted = true; }
    this.paintBtn(); this.sync();
  }

  private paintBtn() {
    this.btn.classList.toggle('muted', this.muted);
    const t = this.muted ? 'Lobby music off: click to play' : 'Lobby music on: click to mute';
    this.btn.title = t; this.btn.setAttribute('aria-label', t); this.btn.setAttribute('aria-pressed', String(!this.muted));
  }

  // play while out of a match, with sound allowed, not muted and the radio off
  private sync() {
    const want = this.wanted && !this.muted && this.screen !== 'game' && !radio.on;
    if (want) this.start(); else this.fade();
  }

  private setup(c: AudioContext) {
    if (this.out) return;
    this.out = c.createGain(); this.out.gain.value = 0; this.out.connect(c.destination);
    // a soft top end, then everything through it
    const warm = c.createBiquadFilter(); warm.type = 'lowpass'; warm.frequency.value = 5200; warm.connect(this.out);
    this.bus = c.createGain(); this.bus.connect(warm);
    // a room: a generated, slowly decaying impulse
    const len = Math.floor(c.sampleRate * 2.6), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
    const conv = c.createConvolver(); conv.buffer = ir; const wet = c.createGain(); wet.gain.value = 0.32;
    conv.connect(wet); wet.connect(warm);
    this.verb = c.createGain(); this.verb.connect(conv);
    // a dotted-eighth echo for the bell and the keys
    this.echo = c.createDelay(2); this.echo.delayTime.value = (60 / BPM) * 0.75;
    const fb = c.createGain(); fb.gain.value = 0.32; const ew = c.createGain(); ew.gain.value = 0.3;
    this.echo.connect(fb); fb.connect(this.echo); this.echo.connect(ew); ew.connect(this.bus); ew.connect(this.verb);
    // the pads breathe: a lowpass that opens and closes over about fifteen seconds
    this.pad = c.createBiquadFilter(); this.pad.type = 'lowpass'; this.pad.frequency.value = 950; this.pad.Q.value = 0.4;
    const lfo = c.createOscillator(), depth = c.createGain(); lfo.frequency.value = 0.065; depth.gain.value = 380;
    lfo.connect(depth); depth.connect(this.pad.frequency); lfo.start();
    this.pad.connect(this.bus); this.pad.connect(this.verb);
    const nlen = c.sampleRate, nb = c.createBuffer(1, nlen, c.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    this.noise = nb;
  }

  private start() {
    const c = sfx.context;
    if (!c) return;
    this.setup(c);
    clearTimeout(this.stopTimer);
    this.level = settingsLevel(); this.levelAt = performance.now();
    this.out!.gain.cancelScheduledValues(c.currentTime);
    this.out!.gain.setTargetAtTime(BASE * this.level, c.currentTime, 1.1);
    if (this.playing) return;
    this.playing = true;
    this.next = c.currentTime + 0.1;
    this.vinyl(c, true);
    this.timer = window.setInterval(() => this.pump(), 40);
  }

  // fade out (a match starting, the radio, mute) and stop composing once it's silent
  private fade() {
    const c = sfx.context;
    if (!c || !this.out || !this.playing) return;
    this.out.gain.cancelScheduledValues(c.currentTime);
    this.out.gain.setTargetAtTime(0, c.currentTime, this.screen === 'game' ? 0.5 : 0.25);
    clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => { if (this.out && this.out.gain.value < 0.01) this.halt(); }, 3200);
  }
  private halt() {
    this.playing = false;
    clearInterval(this.timer);
    this.vinyl(sfx.context!, false);
  }

  private vinyl(c: AudioContext, on: boolean) {
    if (!on) { try { this.crackle?.stop(); } catch { /* already stopped */ } this.crackle = null; return; }
    if (this.crackle) return;
    const len = c.sampleRate * 4, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() < 0.00035 ? (Math.random() * 2 - 1) * 0.7 : (Math.random() * 2 - 1) * 0.006;
    const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const g = c.createGain(); g.gain.value = 0.05;
    s.connect(hp); hp.connect(g); g.connect(this.bus!); s.start();
    this.crackle = s;
  }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  private pump() {
    const c = sfx.context;
    if (!c || !this.playing) return;
    if (performance.now() - this.levelAt > 2000) { // the settings menu may have moved the slider
      this.levelAt = performance.now();
      const lv = settingsLevel();
      if (lv !== this.level && this.screen !== 'game' && !this.muted) { this.level = lv; this.out!.gain.setTargetAtTime(BASE * lv, c.currentTime, 0.3); }
    }
    // a background tab runs this once a second: skip what was missed rather than pile it up
    if (this.next < c.currentTime) this.next = c.currentTime + 0.05;
    const dur = 60 / BPM / 4;
    while (this.next < c.currentTime + 0.3) { this.play16(c, this.step, this.next, dur); this.next += dur; this.step++; }
  }

  private env(c: AudioContext, node: AudioNode, t: number, peak: number, a: number, d: number, dest: AudioNode) {
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0005, t + a + d);
    node.connect(g); g.connect(dest);
    return g;
  }

  private play16(c: AudioContext, n: number, t: number, dur: number) {
    const s = n % 16, bar = Math.floor(n / 16), prog = PROGS[Math.floor(bar / 8) % 2], chord = prog[Math.floor(bar / 2) % 4];
    const human = () => (this.rnd() - 0.5) * 0.018;
    // pads: the chord held for two bars, slow in and slow out, overlapping the next one
    if (s === 0 && bar % 2 === 0) for (const m of chord) for (const det of [-7, 7]) {
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = det;
      const g = c.createGain(), len = dur * 32;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.022, t + 1.6); g.gain.setValueAtTime(0.022, t + len - 0.4); g.gain.linearRampToValueAtTime(0, t + len + 1.4);
      o.connect(g); g.connect(this.pad!); o.start(t); o.stop(t + len + 1.5);
    }
    // keys: a lazy broken chord an octave up, never quite on the grid
    const KEYS: Record<number, [number, number]> = { 0: [0, 1], 3: [2, 0.7], 6: [1, 0.8], 8: [3, 0.6], 10: [2, 0.75], 13: [1, 0.4] };
    const k = KEYS[s];
    if (k && this.rnd() < k[1]) this.keys(c, hz(chord[k[0]] + 12), t + human(), s === 0 ? 0.075 : 0.05);
    // bass: the root on one, a softer root or fifth before three
    if (s === 0) this.bass(c, hz(chord[0] - 12), t, dur * 9, 0.2);
    if (s === 10 && this.rnd() < 0.7) this.bass(c, hz(chord[0] - 12 + (this.rnd() < 0.4 ? 7 : 0)), t, dur * 5, 0.13);
    // brushed drums, after a four-bar intro: a round kick, a soft rim on three, swung shakers
    if (bar >= 4) {
      if (s === 0 || (s === 10 && this.rnd() < 0.6)) this.kick(c, t);
      if (s === 8) this.hit(c, t + human(), 'bandpass', 1900, 0.075, 0.09);
      if (s % 2 === 0 && s !== 8) this.hit(c, t + (s % 4 === 2 ? dur * 0.22 : 0), 'highpass', 7200, s % 4 === 2 ? 0.03 : 0.016, 0.05);
    }
    // the bell: a short phrase in the second half of every eight bars, walking the pentatonic
    if (bar % 8 >= 4 && s % 4 === 0 && this.rnd() < (s === 0 ? 0.7 : 0.4)) {
      this.mel = Math.max(0, Math.min(PENTA.length - 1, this.mel + Math.floor(this.rnd() * 5) - 2));
      this.bell(c, hz(PENTA[this.mel]), t + human(), 0.045);
    }
  }

  private keys(c: AudioContext, f: number, t: number, peak: number) {
    // a soft electric piano: a sine with a quick bright tine on top
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const tine = c.createOscillator(); tine.type = 'sine'; tine.frequency.value = f * 4;
    const tg = c.createGain(); tg.gain.setValueAtTime(0.25, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    tine.connect(tg);
    const g = this.env(c, o, t, peak, 0.006, 1.6, this.bus!);
    tg.connect(g);
    const send = c.createGain(); send.gain.value = 0.5; g.connect(send); send.connect(this.verb!);
    if (this.rnd() < 0.3) g.connect(this.echo!);
    o.start(t); tine.start(t); o.stop(t + 1.8); tine.stop(t + 0.2);
  }
  private bass(c: AudioContext, f: number, t: number, len: number, peak: number) {
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; o.connect(lp);
    this.env(c, lp, t, peak, 0.02, len, this.bus!);
    o.start(t); o.stop(t + len + 0.1);
  }
  private bell(c: AudioContext, f: number, t: number, peak: number) {
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.01;
    const g2 = c.createGain(); g2.gain.value = 0.3; o2.connect(g2);
    const g = this.env(c, o, t, peak, 0.01, 2.2, this.bus!);
    g2.connect(g); g.connect(this.echo!); g.connect(this.verb!);
    o.start(t); o2.start(t); o.stop(t + 2.4); o2.stop(t + 2.4);
  }
  private kick(c: AudioContext, t: number) {
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    this.env(c, o, t, 0.28, 0.004, 0.32, this.bus!); o.start(t); o.stop(t + 0.4);
  }
  private hit(c: AudioContext, t: number, type: BiquadFilterType, f: number, peak: number, d: number) {
    const s = c.createBufferSource(); s.buffer = this.noise;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; s.connect(fl);
    this.env(c, fl, t, peak, 0.003, d, this.bus!);
    s.start(t, this.rnd() * 0.8); s.stop(t + d + 0.05);
  }
}

export const lobbyMusic = new LobbyMusic();
