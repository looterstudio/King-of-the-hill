// How to play: one set of drawn cards, shown in the lobby, in the waiting room and behind H in a
// match, plus the in-match training list that ticks itself off as you do each thing.
import { WEAPONS } from '../../shared/src/constants.ts';
import { TOKEN } from '../../shared/src/token.ts';

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

export type Tab = 'basics' | 'build' | 'loot' | 'vehicles' | 'squad' | 'prize';

const car = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M4 30 H56 V24 L46 22 L38 13 H20 L12 22 H4 Z"/><circle cx="16" cy="31" r="5"/><circle cx="44" cy="31" r="5"/></svg>';
const moto = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="14" cy="32" r="7"/><circle cx="46" cy="32" r="7"/><path d="M14 32 L26 20 H38 L46 32 M34 20 L38 13 M24 20 L22 14"/><circle class="fill" cx="27" cy="11" r="4"/></svg>';
const heli = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M8 10 H52 M30 10 V15"/><ellipse cx="26" cy="23" rx="13" ry="8"/><path d="M39 23 H56 M52 18 V28 M18 33 H34"/></svg>';
const plane = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M6 23 H54 M24 8 L30 23 L24 38 M48 15 L52 23 L48 31"/><circle cx="56" cy="23" r="2"/></svg>';
const tank = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M6 32 H44 V22 H52 L56 32 V36 H6 Z M30 22 H58"/><path class="dash" d="M8 40 H52"/></svg>';
const radio = '<svg viewBox="0 0 60 46" aria-hidden="true"><rect x="10" y="16" width="40" height="24" rx="4"/><circle cx="22" cy="28" r="6"/><path d="M36 24 H44 M36 30 H44 M18 16 L40 6"/></svg>';
const knock = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M6 38 H54 M14 36 L22 30 H34 L40 36 M44 26 L50 20 M48 30 L54 28"/><circle cx="12" cy="31" r="4"/></svg>';
const mic = '<svg viewBox="0 0 60 46" aria-hidden="true"><rect x="24" y="6" width="12" height="22" rx="6"/><path d="M18 22 Q18 34 30 34 Q42 34 42 22 M30 34 V42 M22 42 H38"/></svg>';
const party = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="14" cy="14" r="5"/><circle cx="30" cy="12" r="5"/><circle cx="46" cy="14" r="5"/><path d="M6 36 Q14 22 22 36 M22 34 Q30 20 38 34 M38 36 Q46 22 54 36"/></svg>';
const eye = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M4 23 Q30 2 56 23 Q30 44 4 23 Z"/><circle class="fill" cx="30" cy="23" r="7"/></svg>';
const star = '<svg viewBox="0 0 60 46" aria-hidden="true"><path class="fill" d="M30 4 L36 18 L52 18 L39 27 L44 42 L30 33 L16 42 L21 27 L8 18 L24 18 Z"/></svg>';
const crate = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="30" cy="12" r="9"/><path d="M24 19 L26 26 M36 19 L34 26"/><rect class="fill" x="20" y="26" width="20" height="14"/></svg>';
const bench = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M8 30 H52 M12 30 V40 M48 30 V40 M20 30 L24 14 H36 L40 30"/><path class="fill" d="M28 6 L30 2 L32 6 L36 7 L33 10 L34 14 L30 12 L26 14 L27 10 L24 7 Z"/></svg>';
const tower = '<svg viewBox="0 0 60 46" aria-hidden="true"><path d="M24 44 V6 H36 V44 M30 6 V0 M24 14 H36 M24 22 H36 M24 30 H36 M24 38 H36"/><path class="dash" d="M30 44 V8"/></svg>';
const ghost = '<svg viewBox="0 0 60 46" aria-hidden="true"><path class="fill" d="M14 40 V20 Q14 6 30 6 Q46 6 46 20 V40 L40 35 L35 40 L30 35 L25 40 L20 35 Z"/><circle cx="24" cy="20" r="2.5"/><circle cx="36" cy="20" r="2.5"/></svg>';
const coins = '<svg viewBox="0 0 60 46" aria-hidden="true"><ellipse class="fill" cx="22" cy="34" rx="12" ry="5"/><ellipse class="fill" cx="22" cy="27" rx="12" ry="5"/><ellipse class="fill" cx="38" cy="20" rx="12" ry="5"/><path d="M48 8 L52 4 M50 14 H56"/></svg>';
const crownA = '<svg viewBox="0 0 60 46" aria-hidden="true"><path class="fill" d="M10 36 L8 12 L20 22 L30 6 L40 22 L52 12 L50 36 Z"/><path d="M10 40 H50"/></svg>';
const clock = '<svg viewBox="0 0 60 46" aria-hidden="true"><circle cx="30" cy="23" r="18"/><path d="M30 12 V23 L38 28"/><path class="hit" d="M44 8 L50 4"/></svg>';
const chain = '<svg viewBox="0 0 60 46" aria-hidden="true"><rect x="6" y="16" width="22" height="14" rx="7"/><rect x="32" y="16" width="22" height="14" rx="7"/><path d="M22 23 H38"/></svg>';

export interface Card { art: string; title: string; keys: string; text: string; tone: string; tab?: Tab }
export const GUIDE: Card[] = [
  { art: mouse('move'), title: 'Aim', tab: 'basics', keys: '<kbd>Mouse</kbd>', tone: 'blue', text: 'Move the mouse to look. The crosshair opens up when you run or jump: stop for accurate shots.' },
  { art: mouse('l'), title: 'Shoot', tab: 'basics', keys: '<kbd>Left click</kbd>', tone: 'red', text: 'Hold it for automatic guns. Headshots hit a lot harder.' },
  { art: mouse('r'), title: 'Aim down sights', tab: 'basics', keys: '<kbd>Right click</kbd>', tone: 'blue', text: 'Zoom in and tighten your spread. Snipers get a scope.' },
  { art: mag, title: 'Reload', tab: 'basics', keys: '<kbd>R</kbd>', tone: 'orange', text: 'Reload between fights, not in the middle of one. An empty gun reloads when you click. The bar under the crosshair shows how long.' },
  { art: key('W', 'A', 'S', 'D'), title: 'Move and sprint', tab: 'basics', keys: '<kbd>WASD</kbd> <kbd>Shift</kbd>', tone: 'green', text: 'Hold Shift to sprint. Walking keeps your aim steadier.' },
  { art: slide, title: 'Slide', tab: 'basics', keys: '<kbd>Shift</kbd> then <kbd>C</kbd>', tone: 'green', text: 'While sprinting press C (or Ctrl): you drop low and fast. Jump out of the slide to keep the speed.' },
  { art: jump, title: 'Jump, double jump, wall jump', tab: 'basics', keys: '<kbd>Space</kbd>', tone: 'teal', text: 'Space again in the air jumps twice. Jump against a wall to kick off it. C in the air dashes.' },
  { art: hook, title: 'Grapple', tab: 'basics', keys: '<kbd>Q</kbd> hold', tone: 'teal', text: 'Hold Q to hook what you look at and reel yourself in. Let go to drop.' },
  { art: pick, title: 'Diamond pickaxe', tab: 'build', keys: '<kbd>X</kbd>', tone: 'diamond', text: 'Always in your pocket. 1-4 back to your guns.' },
  { art: crack, title: 'Break', tab: 'build', keys: 'pickaxe + <kbd>Left click</kbd>', tone: 'red', text: 'Breaks walls, cars and people. Every block you break gives you ▦ material. Rock is unbreakable.' },
  { art: block, title: 'Build', tab: 'build', keys: 'pickaxe + <kbd>Right click</kbd> or <kbd>B</kbd>', tone: 'diamond', text: 'Places a block where the blue cube shows. Wall yourself in, make stairs, block a door.' },
  { art: spin, title: 'Minigun', tab: 'loot', keys: 'hold <kbd>Left click</kbd>', tone: 'pink', text: `The barrels spin up first (${MG.spinUp} s, you hear the whine climb), then ${rps} shots a second. ${MG.mag}-round drum, ${MG.reload} s reload: do it behind cover.` },
  { art: potion, title: 'Heal', tab: 'basics', keys: '<kbd>5</kbd> shield · <kbd>6</kbd> medkit', tone: 'blue', text: 'Takes a few seconds; getting hit stops it. Shields soak bullets before your health.' },
  { art: hand, title: 'Loot, vehicles, revive', tab: 'loot', keys: '<kbd>E</kbd>', tone: 'orange', text: 'Open pencil cases, pick up or swap guns, get in and out of cars, helis and planes. Hold E by a knocked teammate to pick them up.' },
  { art: bomb, title: 'Perks', tab: 'loot', keys: '<kbd>G</kbd>', tone: 'red', text: 'Grenades, C4, molotovs, launch pads, instant forts, the atomic bomb.' },
  { art: glide, title: 'Glide in', tab: 'basics', keys: '<kbd>Mouse</kbd>', tone: 'teal', text: 'Everyone drops from the sky. Look down to dive fast, up to float far. Land anywhere.' },
  { art: storm, title: 'The storm', tab: 'basics', keys: 'minimap', tone: 'red', text: 'Stay inside the circle. The dashed ring is the next one; the last always closes on the King\'s Tower.' },
  // vehicles
  { tab: 'vehicles', art: car, title: 'Cars', keys: '<kbd>E</kbd> in/out · <kbd>W</kbd><kbd>S</kbd> gas, brake · <kbd>A</kbd><kbd>D</kbd> steer', tone: 'red', text: 'Shift boosts, Space hops. Run people over. Teammates ride along and shoot out of the windows.' },
  { tab: 'vehicles', art: moto, title: 'Motorbikes', keys: 'same keys as a car', tone: 'orange', text: 'The fastest thing on wheels, with a friend on the back. You can see yourself riding it.' },
  { tab: 'vehicles', art: heli, title: 'Helicopters', keys: '<kbd>WASD</kbd> fly · <kbd>Space</kbd>/<kbd>C</kbd> up, down · <kbd>Shift</kbd> fast · <kbd>Left click</kbd> nose gun', tone: 'blue', text: 'Land on any roof. Fly one into a building at speed and the building goes up with it.' },
  { tab: 'vehicles', art: plane, title: 'Planes', keys: '<kbd>Mouse</kbd> steer · <kbd>W</kbd><kbd>S</kbd> throttle · <kbd>Shift</kbd> afterburner · <kbd>Left click</kbd> guns · <kbd>Right click</kbd> bomb', tone: 'teal', text: 'Take off from the runway at Paper Plane Field. A plane flown into a tower brings the tower down.' },
  { tab: 'vehicles', art: tank, title: 'Tanks', keys: '<kbd>W</kbd><kbd>S</kbd> tracks · <kbd>A</kbd><kbd>D</kbd> turn · <kbd>Mouse</kbd> turret · <kbd>Left click</kbd> cannon', tone: 'green', text: 'Drives straight through walls. The cannon flattens houses.' },
  { tab: 'vehicles', art: radio, title: '80s radio', keys: '<kbd>N</kbd> next station · <kbd>M</kbd> radio off', tone: 'pink', text: 'It comes on by itself in every vehicle.' },
  // weapons and loot
  { tab: 'loot', art: star, title: 'Rarity and golden cases', keys: 'grey → green → blue → purple → gold', tone: 'orange', text: 'Golden pencil cases (★ on the map) hold the legendaries: the SCAR, the Heavy Sniper. A Heavy Sniper headshot drops anyone.' },
  { tab: 'loot', art: crate, title: 'Supply drops', keys: 'a balloon in every new circle', tone: 'red', text: 'A crate falls into each new circle: a guaranteed legendary, C4 or a nuke, full shields. Everyone sees it coming.' },
  { tab: 'loot', art: bench, title: 'Upgrades', keys: '<kbd>E</kbd> at a bench · kit perk', tone: 'teal', text: 'Upgrade benches and kits add stars to the gun in your hand: up to +66% damage.' },
  { tab: 'loot', art: potion, title: '250 health + 250 shield', keys: 'shields first', tone: 'blue', text: 'Fights last: shields soak bullets before your health. The storm hits health directly.' },
  { tab: 'loot', art: tower, title: 'The Needle', keys: 'the blue updraft in its core', tone: 'diamond', text: 'Step into the updraft to fly up 80 floors of loot. Jump out of any window and your glider opens.' },
  // squads
  { tab: 'squad', art: knock, title: 'Knocked, not out', keys: 'hold <kbd>E</kbd> 5 s by a teammate', tone: 'pink', text: 'In duos and squads you go down first: crawl to cover. A teammate holding E next to you picks you up; 30 s to bleed out.' },
  { tab: 'squad', art: mic, title: 'Squad voice', keys: '<kbd>V</kbd> hold to talk · <kbd>U</kbd> mute them', tone: 'blue', text: 'Talk to your team, peer to peer. The microphone is only asked for the first time you press V.' },
  { tab: 'squad', art: party, title: 'Party codes', keys: 'duos or squads · same code', tone: 'green', text: 'Friends who type the same party code drop on your team; empty spots get filled.' },
  { tab: 'squad', art: eye, title: 'Spectating', keys: '<kbd>Left</kbd>/<kbd>Right click</kbd> switch · <kbd>F</kbd> free camera', tone: 'teal', text: 'Out? Watch your teammates while one is alive, then anyone. A team win scores for everyone on it.' },
  // the hourly prize
  { tab: 'prize', art: crownA, title: 'Top of the hour wins', keys: 'every hour, on the hour', tone: 'orange', text: 'The player with the most points when the hour closes takes the whole pot (a tie splits it). 10% stays to start the next one.' },
  { tab: 'prize', art: coins, title: 'Score points', keys: 'win <b>100</b> · top 10 <b>+20</b> · kill <b>+5</b>', tone: 'red', text: 'Duos win 50 each, squads 25 each. Up to 10 kills count per match. Every match this hour adds up.' },
  { tab: 'prize', art: ghost, title: 'Connect Phantom', keys: 'top right: Connect Phantom', tone: 'pink', text: 'Your wallet is how we check you hold the token and where the prize goes. Signing in costs nothing.' },
  { tab: 'prize', art: chain, title: 'Hold $50 all hour', keys: `at least $${TOKEN.holdMinUsd} of $${TOKEN.symbol}`, tone: 'green', text: 'Balances are checked at secret moments through the hour. Dip under and your points for that hour don\'t count.' },
  { tab: 'prize', art: clock, title: 'The close', keys: 'a random minute in the last 10', tone: 'blue', text: 'Scoring closes at a random minute so nobody can time it; later points count for the next hour.' },
  { tab: 'prize', art: hand, title: 'Paid on-chain', keys: 'claim with your wallet', tone: 'teal', text: 'Every payout is a merkle root on Solana: the winner claims it to their wallet, and anyone can verify it.' },
];

const cardHTML = (c: Card) => `<article class="guide-card ${c.tone}">${c.art}<div><h4>${c.title}</h4><div class="g-keys">${c.keys}</div><p>${c.text}</p></div></article>`;
const TABS: { id: Tab | 'keys'; name: string }[] = [
  { id: 'basics', name: 'Basics' }, { id: 'build', name: 'Break & build' }, { id: 'loot', name: 'Weapons & loot' },
  { id: 'vehicles', name: 'Vehicles' }, { id: 'squad', name: 'Squads' }, { id: 'prize', name: '♛ Hourly prize' }, { id: 'keys', name: 'All controls' },
];
const KEYS: [string, string][] = [
  ['W A S D', 'move'], ['Mouse', 'look and aim'], ['Shift', 'sprint'], ['Space', 'jump · again in the air: double jump · against a wall: wall jump'],
  ['C / Ctrl', 'slide while sprinting · air dash in the air'], ['Q (hold)', 'grapple and reel in'], ['Left click', 'shoot (hold for automatics)'],
  ['Right click', 'aim down sights · with the pickaxe: build'], ['R', 'reload'], ['1 – 4 / wheel', 'switch gun'], ['X', 'diamond pickaxe'],
  ['B', 'build a block (pickaxe out)'], ['E / F', 'open cases · pick up · swap · get in and out of vehicles · upgrade at a bench'],
  ['E (hold)', 'pick up a knocked teammate'], ['5', 'drink a shield'], ['6', 'use a medkit'], ['G', 'use your perk / throw'],
  ['V (hold)', 'talk to your squad'], ['U', 'mute your squad'], ['N / M', 'next radio station / radio off'], ['H', 'controls card in a match'],
  ['T', 'hide the training list'], ['F (out)', 'free camera when your team is out'], ['Esc', 'pause'],
];
// the lobby's manual: every card and every key, by topic
export function manualHTML() {
  const tabs = TABS.map((t, i) => `<button type="button" class="man-tab ${i ? '' : 'on'}" data-tab="${t.id}" role="tab" aria-selected="${!i}">${t.name}</button>`).join('');
  const panes = TABS.map((t, i) => `<div class="man-pane ${i ? '' : 'on'}" data-pane="${t.id}" role="tabpanel">${t.id === 'keys'
    ? `<div class="keys-table">${KEYS.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>`
    : `<div class="guide-grid">${GUIDE.filter((c) => c.tab === t.id).map(cardHTML).join('')}</div>`}</div>`).join('');
  return `<div class="man-tabs" role="tablist">${tabs}</div>${panes}`;
}
export function bindManual(el: HTMLElement) {
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
    if (!b) return;
    el.querySelectorAll('.man-tab').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    el.querySelectorAll<HTMLElement>('.man-pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
  });
}

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
