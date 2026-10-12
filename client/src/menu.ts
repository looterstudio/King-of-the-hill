// The in-match menu behind Esc: Resume, Settings, Controls and Back to menu. The same card is the
// "click to drop in" screen at the start of a match. It always fits the window: the card scrolls
// inside itself when the screen is short.
import { controlsHTML, controlsStrip } from './keycaps.ts';
import { resetSettings, setSetting, settings, type Settings } from './settings.ts';

type Page = 'main' | 'settings' | 'controls' | 'inventory';
type Field =
  | { k: 'sens' | 'adsSens' | 'fov' | 'master' | 'music' | 'effects' | 'renderScale'; type: 'range'; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
  | { k: 'invert' | 'antialias' | 'announcer'; type: 'toggle'; label: string; note?: string }
  | { k: 'quality' | 'view'; type: 'choice'; label: string; options: [string, string][] };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const GROUPS: [string, Field[]][] = [
  ['Mouse', [
    { k: 'sens', type: 'range', label: 'Look sensitivity', min: 0.2, max: 3, step: 0.05, fmt: pct },
    { k: 'adsSens', type: 'range', label: 'Aiming sensitivity', min: 0.2, max: 1.5, step: 0.05, fmt: pct },
    { k: 'invert', type: 'toggle', label: 'Invert vertical look' },
  ]],
  ['View', [
    { k: 'view', type: 'choice', label: 'Camera', options: [['tp', 'Third person'], ['fp', 'First person']] },
    { k: 'fov', type: 'range', label: 'Field of view', min: 60, max: 110, step: 1, fmt: (v) => `${Math.round(v)}°` },
  ]],
  ['Audio', [
    { k: 'master', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'music', type: 'range', label: 'Music', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'effects', type: 'range', label: 'Effects', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'announcer', type: 'toggle', label: 'Announcer voice' },
  ]],
  ['Graphics', [
    { k: 'quality', type: 'choice', label: 'Quality', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
    { k: 'renderScale', type: 'range', label: 'Resolution', min: 0.55, max: 1, step: 0.05, fmt: pct },
    { k: 'antialias', type: 'toggle', label: 'Smooth edges', note: 'after a reload' },
  ]],
];

export class GameMenu {
  private page: Page = 'main';
  private mode: 'drop' | 'paused' = 'drop';
  private shownAt = 0;
  private leaveArmed = 0;
  visible = false;

  constructor(private root: HTMLElement, private card: HTMLElement, private on: { resume: () => void; leave: () => void; inventory: () => string }) {
    card.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'resume') this.on.resume();
      else if (act === 'settings' || act === 'controls' || act === 'inventory' || act === 'main') this.go(act);
      else if (act === 'reset') { resetSettings(); this.render(); }
      else if (act === 'leave') {
        // a second click within 3 s really leaves: a stray click shouldn't throw a match away
        if (performance.now() - this.leaveArmed < 3000) { this.leaveArmed = 0; this.on.leave(); return; }
        this.leaveArmed = performance.now();
        t.textContent = 'Click again to leave'; t.classList.add('armed');
        setTimeout(() => { if (this.leaveArmed && performance.now() - this.leaveArmed >= 2900) { this.leaveArmed = 0; this.render(); } }, 3000);
      } else if (act === 'choice') setSetting(t.dataset.k as 'quality' | 'view', t.dataset.v as never);
      if (act === 'choice') this.render();
    });
    card.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement, k = el.dataset.k as keyof Settings | undefined;
      if (!k) return;
      if (el.type === 'checkbox') setSetting(k, el.checked as never);
      else {
        setSetting(k, Number(el.value) as never);
        const out = el.parentElement?.querySelector('output');
        const f = GROUPS.flatMap((g) => g[1]).find((x) => x.k === k);
        if (out && f?.type === 'range') out.textContent = f.fmt(Number(el.value));
      }
    });
    addEventListener('keydown', (e) => {
      if (!this.visible || e.code !== 'Escape' || performance.now() - this.shownAt < 400) return; // (the Esc that opened it)
      if (this.page !== 'main') this.go('main');
      else if (this.mode === 'paused') this.on.resume();
    });
  }

  show(mode: 'drop' | 'paused') {
    if (!this.visible || this.mode !== mode) this.page = 'main';
    this.mode = mode; this.visible = true; this.shownAt = performance.now(); this.leaveArmed = 0;
    this.root.classList.remove('hidden');
    this.render();
  }
  hide() { this.visible = false; this.root.classList.add('hidden'); }
  private go(p: Page) { this.page = p; this.render(); this.card.scrollTop = 0; }

  private render() {
    const drop = this.mode === 'drop';
    const back = '<button class="mn-back" data-act="main" type="button">← Back</button>';
    if (this.page === 'settings') {
      this.card.innerHTML = `<div class="mn-head">${back}<h2>Settings</h2><button class="mn-link" data-act="reset" type="button">Reset</button></div>`
        + `<div class="mn-settings">${GROUPS.map(([title, fields]) => `<fieldset><legend>${title}</legend>${fields.map(field).join('')}</fieldset>`).join('')}</div>`
        + '<p class="mn-foot">Saved on this device. Changes apply right away.</p>';
      return;
    }
    if (this.page === 'inventory') {
      this.card.innerHTML = `<div class="mn-head">${back}<h2>Inventory</h2><span></span></div><div class="inventory in-menu">${this.on.inventory()}</div>`
        + '<p class="mn-foot">In a match: hold <b>Tab</b> (or press <b>I</b>) for this list, hold <b>Z</b> for the item wheel.</p>';
      return;
    }
    if (this.page === 'controls') {
      this.card.innerHTML = `<div class="mn-head">${back}<h2>Controls</h2><span></span></div>${controlsHTML()}`
        + '<p class="mn-foot">In a vehicle: <b>W S</b> drive, <b>A D</b> steer, <b>E</b> get out. Knocked teammate? Hold <b>E</b> next to them.</p>';
      return;
    }
    this.card.innerHTML = drop
      ? '<h2 class="mn-title">Click to drop in</h2><p class="mn-sub">Jump when you like, glide down, loot fast. Last one standing wins.</p>'
        + '<button class="btn play mn-big" data-act="resume" type="button">Drop in</button>'
        + controlsStrip()
        + '<nav class="mn-nav small"><button data-act="settings" type="button">Settings</button><button data-act="controls" type="button">All controls</button><button data-act="leave" type="button" class="quiet">Back to menu</button></nav>'
      : '<h2 class="mn-title">Paused</h2><p class="mn-sub">The match keeps going. Your character stands still.</p>'
        + '<nav class="mn-nav"><button class="btn play mn-big" data-act="resume" type="button">Resume</button>'
        + '<button data-act="inventory" type="button">Inventory</button><button data-act="settings" type="button">Settings</button><button data-act="controls" type="button">Controls</button>'
        + '<button data-act="leave" type="button" class="quiet">Back to menu</button></nav>';
  }
}

function field(f: Field): string {
  if (f.type === 'range') {
    const v = settings[f.k];
    return `<label class="mn-field"><span>${f.label}</span><input type="range" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}"><output>${f.fmt(v)}</output></label>`;
  }
  if (f.type === 'toggle') {
    return `<label class="mn-field toggle"><span>${f.label}${f.note ? ` <small>${f.note}</small>` : ''}</span><input type="checkbox" data-k="${f.k}" ${settings[f.k] ? 'checked' : ''}><i class="sw" aria-hidden="true"></i></label>`;
  }
  const cur = settings[f.k];
  return `<div class="mn-field"><span>${f.label}</span><div class="seg" role="radiogroup">${f.options.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === cur}" class="${v === cur ? 'on' : ''}" data-act="choice" data-k="${f.k}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
}

