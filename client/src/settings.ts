// Player settings: one object, saved in localStorage and applied live. Anything can read
// `settings.x` at any time or subscribe with onSettings to hear about changes (the graphics code
// reads quality / renderScale / antialias from here; antialias only applies on the next load).
export type Quality = 'low' | 'medium' | 'high';
export interface Settings {
  sens: number;        // mouse look, 1 = default
  adsSens: number;     // multiplier while aiming down sights
  invert: boolean;     // invert vertical look
  master: number;      // volumes, 0..1
  music: number;       // the vehicle radio and its DJ
  effects: number;     // guns, hits, the announcer
  announcer: boolean;  // spoken multi-kill lines (the on-screen text always shows)
  fov: number;         // horizontal-ish field of view in degrees (camera vertical fov)
  quality: Quality;    // overall preset for the graphics code
  renderScale: number; // ceiling for the internal resolution, 0.55..1 (the frame governor works under it)
  antialias: boolean;  // smoother edges; costs frame time; applied on reload
  view: 'tp' | 'fp';   // third person (over the shoulder) or first person at the start of a match
}

export const DEFAULTS: Settings = {
  sens: 1, adsSens: 0.55, invert: false, master: 1, music: 1, effects: 1, announcer: true,
  fov: 78, quality: 'high', renderScale: 1, antialias: false, view: 'tp',
};
export const QUALITY_SCALE: Record<Quality, number> = { low: 0.6, medium: 0.8, high: 1 };
const KEY = 'pr_settings';

function load(): Settings {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(s, JSON.parse(raw) as Partial<Settings>);
    else { // the older single keys, from before there was a settings menu
      const sens = Number(localStorage.getItem('pr_sens'));
      if (sens > 0) s.sens = sens;
      s.invert = localStorage.getItem('pr_invert') === '1';
      if (localStorage.getItem('pr_view') === 'fp') s.view = 'fp';
    }
  } catch { /* storage blocked: defaults */ }
  // whatever was stored, keep it in range
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  s.sens = clamp(s.sens, 0.2, 3, DEFAULTS.sens); s.adsSens = clamp(s.adsSens, 0.2, 1.5, DEFAULTS.adsSens);
  s.master = clamp(s.master, 0, 1, DEFAULTS.master); s.music = clamp(s.music, 0, 1, DEFAULTS.music); s.effects = clamp(s.effects, 0, 1, DEFAULTS.effects);
  s.fov = clamp(s.fov, 60, 110, DEFAULTS.fov); s.renderScale = clamp(s.renderScale, 0.55, 1, DEFAULTS.renderScale);
  if (!(s.quality in QUALITY_SCALE)) s.quality = DEFAULTS.quality;
  if (s.view !== 'fp') s.view = 'tp';
  s.invert = !!s.invert; s.antialias = !!s.antialias; s.announcer = s.announcer !== false;
  return s;
}

export const settings: Settings = load();
const subs = new Set<(s: Settings, key: keyof Settings | null) => void>();

export function onSettings(fn: (s: Settings, key: keyof Settings | null) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ } }
function emit(key: keyof Settings | null) {
  for (const f of subs) f(settings, key);
  dispatchEvent(new CustomEvent('pr-settings', { detail: { key } })); // for code that would rather not import this module
}
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  if (settings[key] === value) return;
  settings[key] = value;
  if (key === 'quality') settings.renderScale = QUALITY_SCALE[value as Quality]; // a preset sets the scale; the slider can fine-tune it after
  save(); emit(key);
}
export function resetSettings() { Object.assign(settings, DEFAULTS); save(); emit(null); }
