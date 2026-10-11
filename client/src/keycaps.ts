// The controls, drawn as keys you can recognise at a glance: the movement cluster, a mouse with
// its buttons, and a short list of keycaps per job. Used before a match, in the Esc menu and on the
// landing page.

// a keycap; wide ones for Shift, Space, Tab
export const kc = (k: string, wide = false) => `<span class="kc ${wide || k.length > 2 ? 'wide' : ''}">${k}</span>`;
const row = (caps: string, label: string) => `<div class="kc-row"><span class="kc-keys">${caps}</span><span>${label}</span></div>`;
const mouse = `<svg class="kc-mouse" viewBox="0 0 44 64" aria-hidden="true"><rect x="3" y="3" width="38" height="58" rx="19"/><path d="M22 3 V24 M3 24 H41"/><path class="l" d="M4 23 V20 A18 18 0 0 1 21 4 V23 Z"/><path class="r" d="M40 23 V20 A18 18 0 0 0 23 4 V23 Z"/><rect class="w" x="19.5" y="9" width="5" height="10" rx="2.5"/></svg>`;

// the movement cluster: W over A S D, with labels under it
const wasd = `<div class="kc-wasd"><span></span>${kc('W')}<span></span>${kc('A')}${kc('S')}${kc('D')}</div>`;

export function controlsHTML(compact = false): string {
  const move = `<section class="kc-group"><h4>Move</h4><div class="kc-hero">${wasd}<span class="kc-cap">walk</span></div>`
    + row(kc('Shift', true), 'sprint') + row(kc('Space', true), 'jump, again for a double jump')
    + row(kc('C'), 'slide while sprinting') + row(kc('Q'), 'hold to grapple') + '</section>';
  const fight = `<section class="kc-group"><h4>Fight</h4><div class="kc-hero">${mouse}<span class="kc-cap"><b class="l">left</b> shoot · <b class="r">right</b> aim</span></div>`
    + row(kc('R'), 'reload') + row(`${kc('1')}${kc('2')}${kc('3')}${kc('4')}`, 'guns, or the mouse wheel')
    + row(kc('X'), 'pickaxe: break and build') + '</section>';
  const use = `<section class="kc-group"><h4>Use</h4>`
    + row(kc('E'), 'open cases, pick up, drive, revive') + row(`${kc('5')}${kc('6')}`, 'shield · medkit')
    + row(kc('G'), 'throw or use your perk') + row(kc('Z'), 'hold for the item wheel')
    + row(kc('Tab', true), 'inventory: what everything does')
    + (compact ? '' : row(kc('P'), 'first or third person') + row(kc('V'), 'hold to talk to your squad'))
    + row(kc('Esc', true), 'menu and settings') + '</section>';
  return `<div class="kc-board ${compact ? 'compact' : ''}">${move}${fight}${use}</div>`;
}

// one line of the essentials, for tight spots
export function controlsStrip(): string {
  const l = (t: string) => `<span class="kc-lbl">${t}</span>`;
  return `<div class="kc-strip">${kc('W')}${kc('A')}${kc('S')}${kc('D')}${l('move')}${mouse}${l('aim · shoot')}${kc('Space', true)}${l('jump')}${kc('E')}${l('use')}${kc('Tab', true)}${l('inventory')}${kc('Esc', true)}${l('menu')}</div>`;
}
