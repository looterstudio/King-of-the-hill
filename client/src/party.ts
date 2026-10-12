// The party pre-lobby: "Create party" gives a code and an invite link (?party=CODE joins it
// straight away), and this screen shows every slot live: who is in, their character, who is ready.
// The leader picks duos or squads and hits Play; the whole party drops into one room on one team.
// The server owns the state (server/src/party.ts); in the demo, LocalNet fills the slots with bots.
import './party.css';
import { MODES, SKINS, type Mode } from '../../shared/src/constants.ts';
import type { ClientMsg, PartyView, ServerMsg } from '../../shared/src/protocol.ts';
import { skinPics } from './arsenal.ts';

interface Transport { on(h: (m: ServerMsg) => void): void; send(m: ClientMsg): void }
export interface PartyHost {
  skin(): number;
  setSkin(i: number): void;
  mode(): Mode;          // what the lobby has picked (a new party starts in it)
  authed(): boolean;
  err(msg: string): void;
  toLobby(): void;       // back to the lobby screen (which shows the party while you are in one)
  canPlay(): string | null; // why this device can't play (touch only), or null
}

const KEY = 'koth.party'; // { code, token } for this tab: a reload or a dropped socket gets the slot back
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

export class PartyUI {
  view: PartyView | null = null;
  private screen = 'lobby';
  private pending: { code: string; token?: string } | null = null;
  private el: HTMLElement;
  private invite: HTMLElement;
  private shownPics = -1;
  private errTimer = 0;

  constructor(private net: Transport, private host: PartyHost) {
    this.el = document.createElement('section');
    this.el.id = 'partyScreen';
    this.el.className = 'screen paper hidden';
    this.el.setAttribute('aria-label', 'your party');
    this.el.innerHTML = `<div class="wrap pty">
      <div class="pty-head">
        <div class="eyebrow">party <b class="pty-code"></b> <span class="mode-tag pty-mode"></span></div>
        <h1 class="pty-title"></h1>
        <div class="pty-invite">
          <input class="pty-link" readonly aria-label="invite link" />
          <button type="button" class="btn ink small" data-act="link">Copy invite link</button>
          <button type="button" class="btn ghost small" data-act="code">Copy code</button>
        </div>
      </div>
      <div class="pty-modes" role="radiogroup" aria-label="party mode">
        <button type="button" class="pty-mbtn" data-mode="duo" role="radio">Duos <small>2 slots</small></button>
        <button type="button" class="pty-mbtn" data-mode="squad" role="radio">Squads <small>4 slots</small></button>
        <span class="pty-mnote"></span>
      </div>
      <div class="pty-slots"></div>
      <div class="pty-skins skins"><div class="skins-label">your character <small>looks only</small></div><div class="skin-list pty-skinlist"></div></div>
      <div class="pty-actions">
        <button type="button" class="btn play pty-go">Play</button>
        <div class="pty-status" aria-live="polite"></div>
        <div class="error pty-error" role="alert"></div>
        <button type="button" class="btn ghost small pty-leave">Leave party</button>
      </div>
    </div>`;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.click(e));

    // the lobby's entry points: Create party, or Join with a code
    this.invite = document.createElement('div');
    this.invite.className = 'pty-invited hidden';
    const card = document.querySelector('.card.join .modes') ?? document.getElementById('partyRow');
    card?.parentElement?.insertBefore(this.invite, card);
    document.getElementById('partyCreate')?.addEventListener('click', () => this.create());
    document.getElementById('partyJoin')?.addEventListener('click', () => this.joinTyped());
    document.getElementById('party')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); this.joinTyped(); } });

    // an invite link, or the party this tab was in before a reload
    let saved: { code: string; token?: string } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { /* storage blocked */ }
    const fromUrl = cleanCode(new URLSearchParams(location.search).get('party') ?? '');
    if (fromUrl) this.pending = { code: fromUrl, token: saved?.code === fromUrl ? saved.token : undefined };
    else if (saved?.code) this.pending = saved;
    this.renderInvite();

    net.on((m) => this.onMsg(m));
  }

  // main.ts calls this from show(): the party screen covers the lobby while you are in a party
  onScreen(s: string) { this.screen = s; this.apply(); }

  private apply() {
    const on = this.screen === 'lobby' && !!this.view;
    this.el.classList.toggle('hidden', !on);
    document.getElementById('lobby')?.classList.toggle('hidden', this.screen !== 'lobby' || on);
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'hello': // a new socket: the server held our slot, the sign-in that follows reclaims it
        if (this.view) { this.pending = { code: this.view.code, token: this.stored()?.token }; this.view = null; this.apply(); }
        break;
      case 'authed':
        if (this.pending) this.net.send({ t: 'party', op: 'join', code: this.pending.code, token: this.pending.token, skin: this.host.skin() });
        queueMicrotask(() => this.renderInvite()); // after the lobby has marked us signed in
        break;
      case 'party': {
        if (m.party) {
          const was = this.view, meNow = m.party.members.find((x) => x.id === m.party!.you);
          this.view = m.party; this.pending = null;
          try { sessionStorage.setItem(KEY, JSON.stringify({ code: m.party.code, token: m.token ?? this.stored()?.token })); } catch { /* storage blocked */ }
          this.setUrl(m.party.code);
          // the leader backed out of the room before it started: the party comes back here
          if (was && was.state !== 'idle' && !meNow?.busy && this.screen === 'waiting') { this.host.toLobby(); this.flash('The leader left the room'); }
          if (m.party.mode !== this.host.mode()) document.querySelector<HTMLButtonElement>(`.mode[data-mode="${m.party.mode}"]`)?.click(); // the lobby follows the party's mode
        } else {
          const failed = !!this.pending;
          this.view = null; this.pending = null;
          try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
          this.setUrl('');
          if (m.msg) this.host.err(failed ? `${m.msg}.` : m.msg);
          if (this.screen === 'lobby') this.host.toLobby();
        }
        this.renderInvite();
        this.apply();
        this.render();
        break;
      }
      case 'error': if (this.view && this.screen === 'lobby') this.flash(m.msg); break;
    }
  }

  private stored(): { code: string; token?: string } | null { try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; } }
  private setUrl(code: string) {
    try {
      const u = new URL(location.href);
      if (code) u.searchParams.set('party', code); else u.searchParams.delete('party');
      if (u.href !== location.href) history.replaceState(history.state, '', u.href);
    } catch { /* sandboxed */ }
  }
  private link(code: string) { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('party', code); return u.href; }

  private create() {
    if (!this.host.authed()) return this.host.err('Pick a nickname or connect a wallet first.');
    const mode = this.host.mode();
    this.net.send({ t: 'party', op: 'create', mode: mode === 'solo' ? 'duo' : mode, skin: this.host.skin() });
  }
  private joinTyped() {
    const code = cleanCode(document.querySelector<HTMLInputElement>('#party')?.value ?? '');
    if (!code) return this.host.err('Type the party code your friend sent you.');
    if (!this.host.authed()) { this.pending = { code }; this.renderInvite(); return this.host.err('Pick a nickname or connect a wallet, and you join right after.'); }
    this.pending = { code };
    this.net.send({ t: 'party', op: 'join', code, skin: this.host.skin() });
  }

  // invited and not signed in yet: say so where you sign in
  private renderInvite() {
    const show = !!this.pending && !this.view && !this.host.authed();
    this.invite.classList.toggle('hidden', !show);
    if (show) this.invite.innerHTML = `<b>You're invited to party ${esc(this.pending!.code)}</b><span>Pick a nickname or connect a wallet below and you join it.</span>`;
  }

  private flash(msg: string) {
    const e = $(this.el, '.pty-error'); e.textContent = msg;
    clearTimeout(this.errTimer); this.errTimer = window.setTimeout(() => { e.textContent = ''; }, 4000);
  }

  private click(e: Event) {
    const t = e.target as HTMLElement, v = this.view;
    if (!v) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act) {
      const text = act === 'link' ? this.link(v.code) : v.code;
      const done = () => this.flashOk(act === 'link' ? 'Invite link copied' : `Code ${v.code} copied`);
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => this.copyFallback(text, done));
      else this.copyFallback(text, done);
      return;
    }
    const mode = t.closest<HTMLElement>('[data-mode]')?.dataset.mode as Mode | undefined;
    if (mode) { if (v.leader === v.you && mode !== v.mode) this.net.send({ t: 'party', op: 'mode', mode }); return; }
    const kick = t.closest<HTMLElement>('[data-kick]')?.dataset.kick;
    if (kick) { this.net.send({ t: 'party', op: 'kick', id: Number(kick) }); return; }
    const skin = t.closest<HTMLElement>('[data-skin]')?.dataset.skin;
    if (skin !== undefined) { const i = Number(skin); this.host.setSkin(i); this.net.send({ t: 'party', op: 'skin', skin: i }); return; }
    if (t.closest('.pty-leave')) { this.net.send({ t: 'party', op: 'leave' }); return; }
    if (t.closest('.pty-go')) {
      const me = v.members.find((x) => x.id === v.you);
      if (v.leader === v.you) {
        const why = this.host.canPlay();
        if (why) return this.flash(why);
        this.net.send({ t: 'party', op: 'play' });
      } else if (me) this.net.send({ t: 'party', op: 'ready', ready: !me.ready });
    }
  }
  private copyFallback(text: string, done: () => void) {
    const i = $<HTMLInputElement>(this.el, '.pty-link'); i.value = text; i.select();
    try { if (document.execCommand('copy')) done(); } catch { /* the link is selected: Ctrl+C */ }
    i.value = this.view ? this.link(this.view.code) : '';
  }
  private flashOk(msg: string) {
    const s = $(this.el, '.pty-status'); s.classList.add('ok'); s.textContent = msg;
    setTimeout(() => { s.classList.remove('ok'); this.render(); }, 1600);
  }

  private render() {
    const v = this.view;
    if (!v) return;
    const lead = v.leader === v.you, me = v.members.find((x) => x.id === v.you);
    $(this.el, '.pty-code').textContent = v.code;
    const tag = $(this.el, '.pty-mode'); tag.textContent = MODES[v.mode].name; tag.className = `mode-tag pty-mode ${v.mode}`;
    $(this.el, '.pty-title').textContent = v.mode === 'duo' ? 'Your duo' : 'Your squad';
    const link = $<HTMLInputElement>(this.el, '.pty-link'), url = this.link(v.code);
    if (link.value !== url) link.value = url;
    this.el.querySelectorAll<HTMLButtonElement>('.pty-mbtn').forEach((b) => {
      const on = b.dataset.mode === v.mode, tooMany = v.members.length > MODES[b.dataset.mode as Mode].size;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
      b.disabled = !lead || v.state !== 'idle' || (!on && tooMany);
    });
    $(this.el, '.pty-mnote').textContent = lead ? 'you pick the mode' : 'the leader picks the mode';

    // the slots: members first, then the open ones
    const slots = v.members.map((x) => {
      const pic = skinPics[x.skin], isMe = x.id === v.you, isLead = x.id === v.leader;
      const st = x.away ? '<span class="pty-rd away">reconnecting…</span>' : x.busy && v.state !== 'idle' ? '<span class="pty-rd busy">in the room</span>'
        : x.ready ? '<span class="pty-rd ok">✓ ready</span>' : '<span class="pty-rd no">not ready</span>';
      return `<div class="pty-slot full${isMe ? ' me' : ''}${x.ready && !x.away ? ' ready' : ''}${x.away ? ' away' : ''}">`
        + `<span class="pty-tag">${isLead ? '♛ leader' : x.bot ? 'bot' : ''}</span>`
        + (lead && !isMe ? `<button type="button" class="pty-kick" data-kick="${x.id}" title="Remove from party" aria-label="remove ${esc(x.name)}">✕</button>` : '')
        + `<div class="pty-pic">${pic ? `<img src="${pic}" alt="">` : `<span class="suit">${esc(x.num)}</span>`}</div>`
        + `<b class="pty-nm">${esc(x.name)}${isMe ? ' <small>(you)</small>' : ''}</b><span class="pty-ch">${esc(SKINS[x.skin] ?? '')}</span>${st}</div>`;
    });
    for (let i = v.members.length; i < v.size; i++) slots.push('<div class="pty-slot empty"><span class="pty-plus">+</span><b>Open slot</b><small>send the link · a random fills it if nobody comes</small></div>');
    const box = $(this.el, '.pty-slots');
    box.classList.toggle('squad', v.size > 2);
    if ((box as HTMLElement & { _h?: string })._h !== slots.join('')) { (box as HTMLElement & { _h?: string })._h = slots.join(''); box.innerHTML = slots.join(''); }

    // your character (the pictures are drawn a moment after the page loads)
    if (!skinPics.length) window.setTimeout(() => this.render(), 500);
    const list = $(this.el, '.pty-skinlist');
    if (this.shownPics !== skinPics.length) {
      this.shownPics = skinPics.length;
      list.innerHTML = SKINS.map((n, i) => `<button type="button" class="skin" data-skin="${i}" aria-label="${esc(n)}">${skinPics[i] ? `<img src="${skinPics[i]}" alt="">` : ''}<span>${esc(n)}</span></button>`).join('');
    }
    list.querySelectorAll<HTMLElement>('.skin').forEach((b) => b.classList.toggle('on', Number(b.dataset.skin) === me?.skin));

    // Play for the leader, Ready for everyone else
    const go = $<HTMLButtonElement>(this.el, '.pty-go'), status = $(this.el, '.pty-status');
    const waiting = v.members.filter((x) => x.id !== v.leader && (!x.ready || x.away));
    const open = v.size - v.members.length;
    let text: string;
    if (v.state !== 'idle') {
      go.disabled = true; go.textContent = v.state === 'playing' ? 'Match in progress' : 'Finding a room…';
      text = v.state === 'playing' ? 'Your party is in a match. You come back here when it ends.' : 'The party is heading into a room.';
    } else if (lead) {
      go.disabled = waiting.length > 0; go.textContent = `Play · ${MODES[v.mode].name}`;
      text = waiting.length ? `Waiting for ${waiting.map((x) => x.name).join(', ')} to be ready`
        : open ? `${open === 1 ? 'One open slot' : `${open} open slots`} get filled when the match starts` : 'Everyone is ready. Drop in!';
    } else {
      go.disabled = !me || !!me.away; go.textContent = me?.ready ? 'Ready ✓' : 'Ready up';
      go.classList.toggle('ready', !!me?.ready);
      text = me?.ready ? 'Waiting for the leader to hit Play' : 'Pick your character and ready up';
    }
    if (!lead) go.title = me?.ready ? 'Click to unready' : ''; else go.classList.remove('ready');
    if (!status.classList.contains('ok')) status.textContent = text;
  }

}
