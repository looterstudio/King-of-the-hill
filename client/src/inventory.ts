// Everything you carry, explained: the inventory (hold Tab, or I to keep it open), the item wheel
// (hold Z or the mouse wheel button, point, let go) and a short note the first few times you pick
// something up.
import { AMMO_IDS, PERKS, WEAPONS, type ItemId, type WeaponId } from '../../shared/src/constants.ts';
import type { SnapSelf } from '../../shared/src/protocol.ts';
import { RARITY_CSS } from './game3d.ts';
import type { FpsInput } from './fpsinput.ts';
import { AXE_DOC, ITEM_DOCS, MATS_DOC, PERK_DOCS, ammoDoc, gunDoc, type Doc } from './itemdocs.ts';

// what the wheel can pick, clockwise from the top
type Pick = 'big' | 'med' | 'perk' | 'mini';
const WHEEL: Pick[] = ['big', 'med', 'perk', 'mini'];
const ITEM_CODE: Record<ItemId, number> = { med: 2, mini: 3, big: 4 }; // the sim's input.item codes
const TOAST_TIMES = 3; // matches in which a pickup still gets its note

export class Inventory {
  private me: SnapSelf | null = null;
  private held = false;    // Tab down
  private pinned = false;  // I toggled it open
  private wheelOn = false;
  private aim = { x: 0, y: 0 };
  private pick: Pick | null = null;
  private seen = new Set<string>();
  private primed = false;
  private count: Record<string, number> = {};

  constructor(private panel: HTMLElement, private wheel: HTMLElement, private toasts: HTMLElement, private input: FpsInput, private active: () => boolean) {
    try { this.count = JSON.parse(localStorage.getItem('pr_seen') ?? '{}') as Record<string, number>; } catch { /* storage blocked */ }
    addEventListener('keydown', (e) => {
      if (!this.active()) return;
      if (e.code === 'Tab') { e.preventDefault(); if (!e.repeat) { this.held = true; this.render(); } }
      if (e.code === 'KeyI' && !e.repeat) { this.pinned = !this.pinned; this.render(); }
      if (e.code === 'KeyZ' && !e.repeat && this.input.locked) this.openWheel();
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'Tab') { this.held = false; this.render(); }
      if (e.code === 'KeyZ') this.closeWheel(true);
    });
    // the mouse wheel button holds the wheel too; while it is open a left click picks
    addEventListener('mousedown', (e) => {
      if (this.wheelOn && e.button === 0) { e.stopPropagation(); e.preventDefault(); this.closeWheel(true); return; }
      if (e.button === 1 && this.active() && this.input.locked) { e.preventDefault(); this.openWheel(); }
    }, true);
    addEventListener('mouseup', (e) => { if (e.button === 1) this.closeWheel(true); }, true);
    addEventListener('blur', () => { this.held = false; this.closeWheel(false); this.render(); });
  }

  // a new match: forget what was picked up, close everything
  reset() { this.seen.clear(); this.primed = false; this.held = false; this.pinned = false; this.closeWheel(false); this.render(); }
  get open() { return this.held || this.pinned; }

  // every frame with your own state
  update(me: SnapSelf | null) {
    this.me = me;
    if (!me || !me.alive) { if (this.wheelOn) this.closeWheel(false); if (this.open) { this.held = false; this.pinned = false; this.render(); } return; }
    this.pickups(me);
    if (this.open) this.render();
    if (this.wheelOn) this.drawWheel();
  }

  // ---------- picked up ----------
  private pickups(me: SnapSelf) {
    const now: [string, Doc, string][] = [];
    for (const s of me.slots) if (s) now.push([`gun:${s}`, gunDoc(s), `ico ico-gun-${s}`]);
    for (const k of ['big', 'mini', 'med'] as ItemId[]) if (me.items[k] > 0) now.push([`item:${k}`, ITEM_DOCS[k], `pic ico-item-${k}`]);
    if (me.perk) now.push([`perk:${me.perk.kind}`, PERK_DOCS[me.perk.kind], `pic ico-item-${me.perk.kind}`]);
    for (const a of AMMO_IDS) if (me.ammo?.[a] > 0) now.push([`ammo:${a}`, ammoDoc(a), `pic ammo-${a}`]);
    for (const [key, doc, icon] of now) {
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (!this.primed) continue; // what you spawn with is not a pickup
      const n = this.count[key] ?? 0;
      if (n >= TOAST_TIMES) continue;
      this.count[key] = n + 1;
      try { localStorage.setItem('pr_seen', JSON.stringify(this.count)); } catch { /* storage blocked */ }
      this.toast(doc, icon, key.startsWith('gun:') ? RARITY_CSS[WEAPONS[key.slice(4) as WeaponId].rarity] : '');
    }
    this.primed = true;
  }
  private toast(doc: Doc, icon: string, color: string) {
    const el = document.createElement('div');
    el.className = 'pick-toast';
    if (color) el.style.setProperty('--rc', color);
    el.innerHTML = `<i class="${icon}"></i><div><small>Picked up</small><b>${doc.name}</b><span>${doc.what}</span><em>${keys(doc.how)}</em></div>`;
    this.toasts.prepend(el);
    while (this.toasts.children.length > 2) this.toasts.lastChild?.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 5200);
  }

  // ---------- the inventory ----------
  private render() {
    const me = this.me;
    this.panel.classList.toggle('hidden', !this.open || !me);
    if (!this.open || !me) return;
    const html = `<header><h3>Inventory</h3><span><kbd>Tab</kbd> hold · <kbd>I</kbd> ${this.pinned ? 'close' : 'keep open'} · <kbd>Z</kbd> item wheel</span></header>${this.html()}`;
    if ((this.panel as HTMLElement & { _h?: string })._h !== html) { (this.panel as HTMLElement & { _h?: string })._h = html; this.panel.innerHTML = html; }
  }
  // the two columns: weapons on one side, shields, healing, perk and material on the other (the Esc menu shows them too)
  html(): string {
    const me = this.me;
    if (!me) return '<p class="inv-none">Nothing yet: you carry what you pick up in a match.</p>';
    const row = (icon: string, doc: Doc, side: string, cls = '', color = '') =>
      `<div class="inv-row ${cls}" ${color ? `style="--rc:${color}"` : ''}><i class="${icon}"></i><div><b>${doc.name}</b><span>${doc.what}</span><em>${keys(doc.how)}</em></div><strong>${side}</strong></div>`;
    const guns = [row('ico ico-axe', AXE_DOC, `▦ ${me.mats}`, me.axe ? 'on' : '', '#0fa3c4')];
    me.slots.forEach((s, i) => {
      if (!s) { guns.push(`<div class="inv-row empty"><i></i><div><b>Slot ${i + 1}</b><span>Empty. Walk over a gun or press E to take it.</span></div><strong></strong></div>`); return; }
      const d = WEAPONS[s], ups = me.ups?.[i] ?? 0;
      guns.push(row(`ico ico-gun-${s}`, { ...gunDoc(s), name: `<kbd>${i + 1}</kbd> ${d.name}${ups ? ` <small class="stars">${'★'.repeat(ups)}</small>` : ''} <small class="rar">${d.rarity}</small>` }, d.melee ? '∞' : `${me.mags[i]}/${d.ammo ? me.ammo?.[d.ammo] ?? 0 : d.mag}`, i === me.cur && !me.axe ? 'on' : '', RARITY_CSS[d.rarity]));
    });
    const items = (['big', 'mini', 'med'] as ItemId[]).map((k) => row(`pic ico-item-${k}`, ITEM_DOCS[k], `×${me.items[k]}`, me.items[k] ? '' : 'none'));
    const perk = me.perk ? row(`pic ico-item-${me.perk.kind}`, PERK_DOCS[me.perk.kind], `×${me.perk.n}`, '', RARITY_CSS[PERKS[me.perk.kind].rarity])
      : `<div class="inv-row none"><i class="pic"></i><div><b>No perk</b><span>Pencil cases drop grenades, C4, launch pads, forts and more. One kind at a time.</span></div><strong></strong></div>`;
    return `<div class="inv-cols"><section><h4>Weapons</h4>${guns.join('')}</section>`
      + `<section><h4>Shields and healing</h4>${items.join('')}<h4>Perk</h4>${perk}<h4>Building</h4>${row('pic mats', MATS_DOC, `▦ ${me.mats}`)}<h4>Ammo</h4>${AMMO_IDS.map((a) => row(`pic ammo-${a}`, ammoDoc(a), `${me.ammo?.[a] ?? 0}`, me.ammo?.[a] ? '' : 'none')).join('')}</section></div>`;
  }

  // ---------- the item wheel ----------
  private openWheel() {
    const me = this.me;
    if (this.wheelOn || !me || !me.alive || me.down > 0) return;
    this.wheelOn = true; this.aim = { x: 0, y: 0 }; this.pick = null;
    this.input.capture = (dx, dy) => {
      this.aim.x += dx; this.aim.y += dy;
      const len = Math.hypot(this.aim.x, this.aim.y);
      if (len > 140) { this.aim.x *= 140 / len; this.aim.y *= 140 / len; } // past the rim it keeps the direction
      if (len > 24) {
        const a = Math.atan2(this.aim.x, -this.aim.y); // 0 = up, clockwise
        this.pick = WHEEL[((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4];
      }
      this.drawWheel();
    };
    this.wheel.classList.remove('hidden');
    this.drawWheel();
  }
  private closeWheel(use: boolean) {
    if (!this.wheelOn) return;
    this.wheelOn = false;
    this.input.capture = null;
    this.wheel.classList.add('hidden');
    const me = this.me, p = this.pick;
    if (!use || !p || !me) return;
    if (p === 'perk') { if (me.perk) this.input.press({ perk: true }); }
    else if (me.items[p] > 0) this.input.press({ item: ITEM_CODE[p] });
  }
  private drawWheel() {
    const me = this.me;
    if (!me) return;
    const seg = (p: Pick, i: number) => {
      const doc = p === 'perk' ? (me.perk ? PERK_DOCS[me.perk.kind] : { name: 'No perk', what: 'Find one in a pencil case', how: '' }) : ITEM_DOCS[p];
      const n = p === 'perk' ? me.perk?.n ?? 0 : me.items[p];
      const icon = p === 'perk' ? (me.perk ? `ico-item-${me.perk.kind}` : '') : `ico-item-${p}`;
      return `<div class="wh-seg s${i} ${p === this.pick ? 'on' : ''} ${n ? '' : 'none'}"><i class="pic ${icon}"></i><b>${doc.name}</b><small>${n ? `×${n}` : 'none'}</small></div>`;
    };
    const k = Math.min(1, Math.hypot(this.aim.x, this.aim.y) / 140), a = Math.atan2(this.aim.x, -this.aim.y);
    const sel = this.pick ? WHEEL.indexOf(this.pick) : -1;
    const desc = this.pick ? (this.pick === 'perk' ? (me.perk ? PERK_DOCS[me.perk.kind] : null) : ITEM_DOCS[this.pick]) : null;
    const html = `<svg viewBox="-160 -160 320 320" aria-hidden="true"><circle class="wh-rim" r="150"/><circle class="wh-hub" r="52"/>`
      + WHEEL.map((_, i) => `<path class="wh-arc ${i === sel ? 'on' : ''}" d="${arc(i)}"/>`).join('')
      + (k > 0.17 ? `<path class="wh-ptr" transform="rotate(${(a * 180 / Math.PI).toFixed(1)})" d="M0 -64 L-9 -51 L9 -51 Z"/>` : '') + '</svg>'
      + WHEEL.map(seg).join('')
      + `<div class="wh-mid">${desc ? `<b>${desc.name}</b><span>${desc.what}</span>` : '<b>Item wheel</b><span>Move the mouse to a slice, let go of Z to use it</span>'}</div>`;
    if ((this.wheel as HTMLElement & { _h?: string })._h !== html) { (this.wheel as HTMLElement & { _h?: string })._h = html; this.wheel.innerHTML = html; }
  }
}

// an annular slice of the wheel, 90 degrees wide, centred on up / right / down / left
function arc(i: number) {
  const a0 = (i - 0.5) * (Math.PI / 2) + 0.03, a1 = (i + 0.5) * (Math.PI / 2) - 0.03, R = 146, r = 58;
  const p = (a: number, rad: number) => `${(Math.sin(a) * rad).toFixed(1)} ${(-Math.cos(a) * rad).toFixed(1)}`;
  return `M${p(a0, R)} A${R} ${R} 0 0 1 ${p(a1, R)} L${p(a1, r)} A${r} ${r} 0 0 0 ${p(a0, r)} Z`;
}
// "G to throw" -> the keys drawn as keycaps
function keys(how: string) {
  return how.replace(/\b(Tab|Esc|[A-Z]|[1-6])\b(?=[ ,·)]|$)/g, '<kbd>$1</kbd>');
}
