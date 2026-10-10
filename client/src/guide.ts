// How to play: one set of drawn cards, shown in the lobby, in the waiting room and behind H in a
// match, plus the in-match training list that ticks itself off as you do each thing.
import { WEAPONS } from '../../shared/src/constants.ts';

const MG = WEAPONS.minigun;
const rps = Math.round(1 / MG.cd);

// small doodles: a mouse with the button that matters filled in, key caps, the pickaxe, a block
const mouse = (btn: 'l' | 'r' | 'move') => `<svg viewBox="0 0 60 46" aria-hidden="true"><rect x="18" y="4" width="24" height="38" rx="12"/><path d="M30 4 V18 M18 18 H42"/>${btn === 'l' ? '<path class="fill" d="M19 17 V15 A11 11 0 0 1 29 5 V17 Z"/>' : btn === 'r' ? '<path class="fill" d="M41 17 V15 A11 11 0 0 0 31 5 V17 Z"/>' : '<path d="M6 23 H12 M48 23 H54 M9 20 L6 23 L9 26 M51 20 L54 23 L51 26"/>'}</svg>`;
const key = (...k: string[]) => `<svg viewBox="0 0 ${k.length * 24 + 12} 46" aria-hidden="true">${k.map((c, i) => `<rect x="${6 + i * 24}" y="${c.length > 2 ? 10 : 8}" width="${20}" height="${c.length > 2 ? 26 : 30}" rx="4"/><text x="${16 + i * 24}" y="${c.length > 2 ? 28 : 29}" text-anchor="middle" font-size="${c.length > 2 ? 8 : 13}">${c}</text>`).join('')}</svg>`;
const pick = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M14 42 L40 16"/><path class="gem" d="M24 8 Q40 6 52 22 Q44 14 36 14 L44 22 L40 26 L32 18 Q32 10 24 8 Z"/></svg>';
const block = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M18 18 L32 11 L46 18 L46 34 L32 41 L18 34 Z M18 18 L32 25 L46 18 M32 25 V41"/><path class="dash" d="M8 30 L14 30 M4 22 L12 22"/></svg>';
const crack = '<svg viewBox="0 0 60 46" aria-hidden="true"><rect x="8" y="8" width="44" height="30"/><path d="M8 23 H52 M30 8 V23 M20 23 V38 M40 23 V38"/><path class="hit" d="M30 23 L26 30 L32 33 L28 40 M30 23 L36 18"/></svg>';
const slide = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="16" cy="22" r="4"/><path d="M19 25 L32 31 L50 34 M28 29 L34 22 M8 40 H54"/><path class="dash" d="M2 34 H10 M4 28 H10"/></svg>';
const jump = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M6 42 H54 M14 40 Q24 4 34 22 Q40 2 50 18"/><circle cx="50" cy="14" r="3"/></svg>';
const spin = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M6 20 H40 V30 H6 Z M40 22 H56 M40 25 H56 M40 28 H56 M14 30 L12 40 H20 L22 30"/><path class="dash" d="M46 10 Q52 14 56 10 M46 40 Q52 36 56 40"/></svg>';
const mag = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M8 14 H44 V22 H24 L20 32 H12 L14 22 H8 Z"/><path class="fill" d="M26 24 H34 L36 42 H28 Z"/><path class="dash" d="M42 30 L48 36 M48 30 L42 36"/></svg>';
const glide = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M14 18 C14 4, 46 4, 46 18 Z M14 18 L30 34 M46 18 L30 34 M30 18 V34"/><circle cx="30" cy="37" r="3"/></svg>';
const storm = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="30" cy="23" r="19"/><circle class="dash" cx="34" cy="25" r="10"/><path d="M30 2 V8 M30 38 V44"/></svg>';
const potion = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M24 6 H36 M26 6 V14 Q14 20 16 32 Q18 42 30 42 Q42 42 44 32 Q46 20 34 14 V6"/><path class="fill" d="M18 28 H42 Q42 40 30 40 Q18 40 18 28 Z"/></svg>';
const hand = '<svg viewBox="0 0 60 46" aria-hidden="true"><rect x="10" y="20" width="30" height="18" rx="5"/><path d="M10 28 H40 M22 20 V16 H28 V20"/><path d="M46 12 L52 6 M48 20 H56 M46 28 L52 34"/></svg>';
const hook = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M10 40 L44 10 M40 8 L46 10 L44 16"/><circle cx="10" cy="40" r="3"/></svg>';
const bomb = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="26" cy="28" r="13"/><path d="M34 18 L40 12 Q44 8 48 10 M50 6 L52 4 M52 12 L56 12"/></svg>';

export interface Card { art: string; title: string; keys: string; text: string; tone: string }
export const GUIDE: Card[] = [
  { art: mouse('move'), title: 'Aim', keys: '<kbd>Mouse</kbd>', tone: 'blue', text: 'Move the mouse to look. The crosshair opens up when you run or jump: stop for accurate shots.' },
  { art: mouse('l'), title: 'Shoot', keys: '<kbd>Left click</kbd>', tone: 'red', text: 'Hold it for automatic guns. Headshots hit a lot harder.' },
  { art: mouse('r'), title: 'Aim down sights', keys: '<kbd>Right click</kbd>', tone: 'blue', text: 'Zoom in and tighten your spread. Snipers get a scope.' },
  { art: mag, title: 'Reload', keys: '<kbd>R</kbd>', tone: 'orange', text: 'Reload between fights, not in the middle of one. An empty gun reloads when you click. The bar under the crosshair shows how long.' },
  { art: key('W', 'A', 'S', 'D'), title: 'Move and sprint', keys: '<kbd>WASD</kbd> <kbd>Shift</kbd>', tone: 'green', text: 'Hold Shift to sprint. Walking keeps your aim steadier.' },
  { art: slide, title: 'Slide', keys: '<kbd>Shift</kbd> then <kbd>C</kbd>', tone: 'green', text: 'While sprinting press C (or Ctrl): you drop low and fast. Jump out of the slide to keep the speed.' },
  { art: jump, title: 'Jump, double jump, wall jump', keys: '<kbd>Space</kbd>', tone: 'teal', text: 'Space again in the air jumps twice. Jump against a wall to kick off it. C in the air dashes.' },
  { art: hook, title: 'Grapple', keys: '<kbd>Q</kbd> hold', tone: 'teal', text: 'Hold Q to hook what you look at and reel yourself in. Let go to drop.' },
  { art: pick, title: 'Diamond pickaxe', keys: '<kbd>X</kbd>', tone: 'diamond', text: 'Always in your pocket. 1-4 back to your guns.' },
  { art: crack, title: 'Break', keys: 'pickaxe + <kbd>Left click</kbd>', tone: 'red', text: 'Breaks walls, cars and people. Every block you break gives you ▦ material. Rock is unbreakable.' },
  { art: block, title: 'Build', keys: 'pickaxe + <kbd>Right click</kbd> or <kbd>B</kbd>', tone: 'diamond', text: 'Places a block where the blue cube shows. Wall yourself in, make stairs, block a door.' },
  { art: spin, title: 'Minigun', keys: 'hold <kbd>Left click</kbd>', tone: 'pink', text: `The barrels spin up first (${MG.spinUp} s, you hear the whine climb), then ${rps} shots a second. ${MG.mag}-round drum, ${MG.reload} s reload: do it behind cover.` },
  { art: potion, title: 'Heal', keys: '<kbd>5</kbd> shield · <kbd>6</kbd> medkit', tone: 'blue', text: 'Takes a few seconds; getting hit stops it. Shields soak bullets before your health.' },
  { art: hand, title: 'Loot, vehicles, revive', keys: '<kbd>E</kbd>', tone: 'orange', text: 'Open pencil cases, pick up or swap guns, get in and out of cars, helis and planes. Hold E by a knocked teammate to pick them up.' },
  { art: bomb, title: 'Perks', keys: '<kbd>G</kbd>', tone: 'red', text: 'Grenades, C4, molotovs, launch pads, instant forts, the atomic bomb.' },
  { art: glide, title: 'Glide in', keys: '<kbd>Mouse</kbd>', tone: 'teal', text: 'Everyone drops from the sky. Look down to dive fast, up to float far. Land anywhere.' },
  { art: storm, title: 'The storm', keys: 'minimap', tone: 'red', text: 'Stay inside the circle. The dashed ring is the next one; the last always closes on the King\'s Tower.' },
];

const cardHTML = (c: Card) => `<article class="guide-card ${c.tone}">${c.art}<div><h4>${c.title}</h4><div class="g-keys">${c.keys}</div><p>${c.text}</p></div></article>`;
export function guideHTML(compact = false) {
  return `<div class="guide-grid ${compact ? 'compact' : ''}">${GUIDE.map(cardHTML).join('')}</div>`;
}
// one card at a time, for the bottom of the waiting room
export function tipCardHTML(i: number) {
  const n = GUIDE.length, k = ((i % n) + n) % n;
  return `<div class="tip-head"><b>How to play</b> <span>${k + 1}/${n}</span> <a href="#roomGuideSec" data-all>see all ↓</a></div>${cardHTML(GUIDE[k])}`;
}

// ---------------- training: the first matches walk you through the basics ----------------
export interface Drill { id: string; keys: string; text: string }
export const DRILLS: Drill[] = [
  { id: 'glide', keys: 'Mouse', text: 'glide down and land' },
  { id: 'look', keys: 'Mouse', text: 'look around' },
  { id: 'move', keys: 'W A S D', text: 'walk' },
  { id: 'sprint', keys: 'Shift', text: 'sprint' },
  { id: 'jump', keys: 'Space', text: 'jump' },
  { id: 'slide', keys: 'Shift + C', text: 'slide: sprint, then C' },
  { id: 'shoot', keys: 'Left click', text: 'shoot a gun' },
  { id: 'ads', keys: 'Right click', text: 'aim down sights' },
  { id: 'reload', keys: 'R', text: 'reload' },
  { id: 'pick', keys: 'X', text: 'take out the diamond pickaxe' },
  { id: 'break', keys: 'Left click', text: 'break a block with it (▦)' },
  { id: 'build', keys: 'Right click', text: 'build a block' },
  { id: 'heal', keys: '5 / 6', text: 'heal: shield or medkit' },
];

export class Training {
  done = new Set<string>();
  hidden = false;
  private finishedAt = 0;
  constructor(private el: HTMLElement) {
    try {
      for (const id of JSON.parse(localStorage.getItem('training') ?? '[]') as string[]) this.done.add(id);
      this.hidden = localStorage.getItem('trainingOff') === '1';
    } catch { /* private window: start over every visit */ }
  }
  get complete() { return DRILLS.every((d) => this.done.has(d.id)); }
  private alive = true;
  // a new match: show the list if there is anything left to learn
  reset() { this.finishedAt = 0; this.alive = true; this.render(); }
  // out of the match (spectating): nothing to practise
  setAlive(a: boolean) { if (a !== this.alive) { this.alive = a; this.render(); } }
  toggle() { this.hidden = !this.hidden; try { localStorage.setItem('trainingOff', this.hidden ? '1' : '0'); } catch { /* ignore */ } this.render(); }
  tick(id: string) {
    if (this.done.has(id)) return false;
    this.done.add(id);
    try { localStorage.setItem('training', JSON.stringify([...this.done])); } catch { /* ignore */ }
    if (this.complete) this.finishedAt = performance.now();
    this.render(id);
    return true;
  }
  next() { return DRILLS.find((d) => !this.done.has(d.id)) ?? null; }
  // finished: say so for a few seconds, then never show it again
  update() { if (this.finishedAt && performance.now() - this.finishedAt > 5000 && !this.el.classList.contains('hidden')) this.el.classList.add('hidden'); }
  private render(just?: string) {
    const show = this.alive && !this.hidden && (!this.complete || (this.finishedAt > 0 && performance.now() - this.finishedAt < 5000));
    this.el.classList.toggle('hidden', !show);
    if (!show) return;
    const nxt = this.next(), n = DRILLS.filter((d) => this.done.has(d.id)).length;
    this.el.innerHTML = `<h4>${this.complete ? 'Training complete ✓' : 'Basic training'} <small>${n}/${DRILLS.length} · T hide</small></h4>`
      + DRILLS.map((d) => `<div class="drill ${this.done.has(d.id) ? 'done' : ''} ${d === nxt ? 'next' : ''} ${d.id === just ? 'just' : ''}"><i></i><kbd>${d.keys}</kbd><span>${d.text}</span></div>`).join('');
  }
}
