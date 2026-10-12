// Before a match: the controls as keycaps, your name, and one big button that takes you in. Opens
// from "Drop in" (or a room's Join) in the lobby.
import { MODES, POINTS, type Mode } from '../../shared/src/constants.ts';
import { controlsHTML } from './keycaps.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface PreMatchOpts { mode: Mode; name: string; wallet: string | null; guests: boolean }

export class PreMatch {
  private opts: PreMatchOpts | null = null;
  constructor(private root: HTMLElement, private on: { enter: (name: string) => void; cancel: () => void }) {
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === root || t.closest('[data-pm="back"]')) { this.close(); this.on.cancel(); }
      else if (t.closest('[data-pm="go"]')) this.go();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.go(); }
      if (e.key === 'Escape') { this.close(); this.on.cancel(); }
    });
  }
  get isOpen() { return !this.root.classList.contains('hidden'); }

  open(o: PreMatchOpts) {
    this.opts = o;
    const m = MODES[o.mode], team = o.mode === 'solo' ? 'Last one standing wins' : `Last ${o.mode === 'duo' ? 'pair' : 'squad'} standing wins`;
    const who = o.wallet
      ? `<div class="pm-who"><span>Playing as</span><b>${esc(o.name)}</b><small>wallet connected · your points count for the hourly prize</small></div>`
      : `<label class="pm-name"><span>Your name</span><input id="pmName" maxlength="14" autocomplete="off" spellcheck="false" placeholder="pick a name" value="${esc(o.name)}" /></label>`;
    this.root.innerHTML = `<div class="pm-card" role="dialog" aria-modal="true" aria-label="ready to drop">`
      + `<div class="pm-top"><div><span class="pm-kicker">Ready to drop</span><h2>${m.name} <small>${o.mode === 'solo' ? `${POINTS.win.solo} points a win` : `${POINTS.win[o.mode]} points each a win`}</small></h2></div><button class="pm-x" data-pm="back" type="button" aria-label="back to the lobby">✕</button></div>`
      + `<ol class="pm-goal"><li><span><b>Jump</b> from the plane and glide down</span></li><li><span><b>Loot</b> guns, shields and perks</span></li><li><span><b>${team}</b>. The storm closes on the King's Tower</span></li></ol>`
      + controlsHTML(true)
      + `<div class="pm-go">${who}<button class="btn play pm-enter" data-pm="go" type="button">Enter the match</button></div>`
      + (o.wallet || o.guests ? '' : '<p class="pm-note">This server needs a wallet: connect one in the lobby first.</p>')
      + `</div>`;
    this.root.classList.remove('hidden');
    const input = this.root.querySelector<HTMLInputElement>('#pmName');
    if (input) setTimeout(() => { input.focus(); input.select(); }, 30);
    else this.root.querySelector<HTMLElement>('.pm-enter')?.focus();
  }
  close() { this.root.classList.add('hidden'); this.opts = null; }
  // after the click: the button says what is happening until the room answers
  busy(text: string) {
    const b = this.root.querySelector<HTMLButtonElement>('.pm-enter');
    if (b) { b.disabled = true; b.textContent = text; }
  }
  private go() {
    if (!this.opts) return;
    const input = this.root.querySelector<HTMLInputElement>('#pmName');
    const name = (input ? input.value : this.opts.name).trim().slice(0, 14);
    if (input && !name) { input.focus(); input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    this.on.enter(name);
  }
}
