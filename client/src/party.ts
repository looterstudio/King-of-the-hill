// Play with a friend. "Invite a friend" makes a party with a code and an invite link (?party=CODE joins
// it straight away); the lobby's friend panel then shows the code, the link and every slot live, and
// your friends land next to you on the lobby's stage (lobby.ts listens to 'party:view'). The leader
// picks duos or squads with the lobby's mode buttons and hits Play; everyone else readies up with the
// same button. The whole party drops into one room on one team.
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
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

export class PartyUI {
  view: PartyView | null = null;
  private pending: { code: string; token?: string } | null = null;
  private wantCreate = false;  // "Invite a friend" before signing in: make the party once the name lands
  private box: HTMLElement;
  private start: HTMLElement;
  private live: HTMLElement;
  private invite: HTMLElement;
  private nameRow: HTMLElement;
  private flashTimer = 0;
  private note = '';           // a short message in the panel (copied, errors), cleared after a moment
  private waitPics = false;

  constructor(private net: Transport, private host: PartyHost) {
    this.box = byId('partyBox') ?? document.body;
    this.start = byId('partyStart') ?? this.box;
    this.live = byId('partyLive') ?? this.box;
    this.invite = byId('partyInvited') ?? this.box;
    this.nameRow = byId('partyName') ?? this.box;
    byId('partyCreate')?.addEventListener('click', () => this.create());
    byId('partyJoin')?.addEventListener('click', () => this.joinTyped());
    byId('party')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); this.joinTyped(); } });
    // the name row's button signs you in (main.ts); remember why we asked
    byId('guestBtn')?.addEventListener('click', () => { if (!this.pending) this.wantCreate = true; });
    byId('guestName')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !this.pending) this.wantCreate = true; });
    this.live.addEventListener('click', (e) => this.click(e));
    // the stage's invite cards
    addEventListener('party:invite', () => { if (this.view) this.copy('link'); else this.create(); });
    // your character, picked in the character select
    addEventListener('skin:pick', (e) => { if (this.view) this.net.send({ t: 'party', op: 'skin', skin: (e as CustomEvent<number>).detail }); });
    // the lobby's mode buttons drive the party's mode (leader only; parties are duos or squads)
    document.querySelectorAll<HTMLElement>('.mode').forEach((b) => b.addEventListener('click', () => this.modeClicked(b.dataset.mode as Mode)));

    // an invite link, or the party this tab was in before a reload
    let saved: { code: string; token?: string } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { /* storage blocked */ }
    const fromUrl = cleanCode(new URLSearchParams(location.search).get('party') ?? '');
    if (fromUrl) this.pending = { code: fromUrl, token: saved?.code === fromUrl ? saved.token : undefined };
    else if (saved?.code) this.pending = saved;
    this.renderStart();

    net.on((m) => this.onMsg(m));
  }

  // main.ts calls this from show(): the party lives in the lobby's friend panel now
  onScreen(_s: string) { this.render(); }

  // the lobby's big button while you are in a party: Play for the leader, Ready for everyone else
  play() {
    const v = this.view;
    if (!v) return;
    const me = v.members.find((x) => x.id === v.you);
    if (v.state !== 'idle') return;
    if (v.leader === v.you) {
      const why = this.host.canPlay();
      if (why) return this.flash(why);
      const waiting = v.members.filter((x) => x.id !== v.leader && (!x.ready || x.away));
      if (waiting.length) return this.flash(`Waiting for ${waiting.map((x) => x.name).join(', ')} to ready up`);
      this.net.send({ t: 'party', op: 'play' });
    } else if (me) this.net.send({ t: 'party', op: 'ready', ready: !me.ready });
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'hello': // a new socket: the server held our slot, the sign-in that follows reclaims it
        if (this.view) { this.pending = { code: this.view.code, token: this.stored()?.token }; this.setView(null); }
        break;
      case 'authed':
        if (this.pending) this.net.send({ t: 'party', op: 'join', code: this.pending.code, token: this.pending.token, skin: this.host.skin() });
        else if (this.wantCreate) { this.wantCreate = false; this.create(); }
        queueMicrotask(() => this.renderStart()); // after the lobby has marked us signed in
        break;
      case 'party': {
        if (m.party) {
          const was = this.view, meNow = m.party.members.find((x) => x.id === m.party!.you);
          this.pending = null;
          try { sessionStorage.setItem(KEY, JSON.stringify({ code: m.party.code, token: m.token ?? this.stored()?.token })); } catch { /* storage blocked */ }
          this.setUrl(m.party.code);
          // the leader backed out of the room before it started: the party comes back to the lobby
          if (was && was.state !== 'idle' && !meNow?.busy && !document.getElementById('waiting')?.classList.contains('hidden')) { this.host.toLobby(); this.flash('The leader left the room'); }
          this.setView(m.party);
          if (m.party.mode !== this.host.mode()) document.querySelector<HTMLButtonElement>(`.mode[data-mode="${m.party.mode}"]`)?.click(); // the lobby follows the party's mode
        } else {
          const failed = !!this.pending;
          this.pending = null;
          try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
          this.setUrl('');
          this.setView(null);
          if (m.msg) this.host.err(failed ? `${m.msg}.` : m.msg);
        }
        this.renderStart();
        break;
      }
      case 'error': if (this.view) this.flash(m.msg); break;
    }
  }

  private setView(v: PartyView | null) {
    this.view = v;
    this.render();
    dispatchEvent(new CustomEvent('party:view', { detail: v }));
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
    if (!this.host.authed()) { this.wantCreate = true; this.askName(); return; }
    const mode = this.host.mode();
    this.net.send({ t: 'party', op: 'create', mode: mode === 'solo' ? 'duo' : mode, skin: this.host.skin() });
  }
  private joinTyped() {
    const code = cleanCode(byId<HTMLInputElement>('party')?.value ?? '');
    if (!code) { byId('party')?.focus(); return this.host.err('Type the party code your friend sent you.'); }
    this.pending = { code };
    if (!this.host.authed()) { this.renderStart(); this.askName(); return; }
    this.net.send({ t: 'party', op: 'join', code, skin: this.host.skin() });
  }
  // not signed in: a name first (or a wallet, top right); the party is made or joined right after
  private askName() {
    const guests = !byId('guestBtn')?.classList.contains('hidden');
    this.nameRow.classList.remove('hidden');
    const btn = byId('guestBtn');
    if (btn) btn.textContent = this.pending ? 'Join' : 'Create party';
    if (guests) byId('guestName')?.focus();
    else this.host.err('Connect a wallet first (top right), then make your party.');
  }
  private modeClicked(mode: Mode) {
    const v = this.view;
    if (!v) return;
    if (v.leader !== v.you) { if (mode !== v.mode) { this.flash('The leader picks the mode'); this.syncMode(); } return; }
    if (mode === 'solo') { this.flash('Parties play duos or squads. Leave the party to play solo.'); this.syncMode(); return; }
    if (v.members.length > MODES[mode].size) { this.flash('Too many in the party for duos'); this.syncMode(); return; }
    if (mode !== v.mode && v.state === 'idle') this.net.send({ t: 'party', op: 'mode', mode });
    this.render(); // the big button's label (the lobby just rewrote it)
  }
  private syncMode() { const v = this.view; if (v) setTimeout(() => document.querySelector<HTMLButtonElement>(`.mode[data-mode="${v.mode}"]`)?.click(), 0); }

  // invited and not signed in yet: say so in the friend panel
  private renderStart() {
    const invited = !!this.pending && !this.view && !this.host.authed();
    this.invite.classList.toggle('hidden', !invited);
    if (invited) this.invite.innerHTML = `<b>You're invited to party ${esc(this.pending!.code)}</b><span>Pick a name (or connect a wallet) and you join it.</span>`;
    if (invited) this.askName();
    if (this.host.authed() && !this.pending) this.nameRow.classList.add('hidden');
  }

  private flash(msg: string) { this.note = msg; this.render(); clearTimeout(this.flashTimer); this.flashTimer = window.setTimeout(() => { this.note = ''; this.render(); }, 3200); }

  private copy(what: 'link' | 'code') {
    const v = this.view;
    if (!v) return;
    const text = what === 'link' ? this.link(v.code) : v.code;
    const done = () => this.flash(what === 'link' ? 'Invite link copied. Send it to a friend.' : `Code ${v.code} copied`);
    const fallback = () => {
      const i = this.live.querySelector<HTMLInputElement>('.pty-link');
      if (!i) return;
      i.value = text; i.select();
      try { if (document.execCommand('copy')) done(); } catch { /* the text is selected: Ctrl+C */ }
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  private click(e: Event) {
    const t = e.target as HTMLElement, v = this.view;
    if (!v) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'link' || act === 'code') return this.copy(act);
    if (act === 'share' && navigator.share) { navigator.share({ title: 'King of the Hill Royale', text: `Join my party: ${v.code}`, url: this.link(v.code) }).catch(() => {}); return; }
    if (act === 'leave') { this.net.send({ t: 'party', op: 'leave' }); return; }
    const kick = t.closest<HTMLElement>('[data-kick]')?.dataset.kick;
    if (kick) this.net.send({ t: 'party', op: 'kick', id: Number(kick) });
  }

  private render() {
    const v = this.view;
    this.box.classList.toggle('in-party', !!v);
    this.start.classList.toggle('hidden', !!v);
    this.live.classList.toggle('hidden', !v);
    const play = byId<HTMLButtonElement>('playBtn');
    if (!v) {
      play?.classList.remove('ready', 'party');
      if (play && play.dataset.party) { delete play.dataset.party; play.querySelector('b')!.textContent = 'Play'; }
      return;
    }
    const lead = v.leader === v.you, me = v.members.find((x) => x.id === v.you);
    const waiting = v.members.filter((x) => x.id !== v.leader && (!x.ready || x.away));
    const open = v.size - v.members.length;

    // the slots: members first, then the open ones
    const rows = v.members.map((x) => {
      const pic = skinPics[x.skin], isMe = x.id === v.you, isLead = x.id === v.leader;
      const st = x.away ? '<i class="away">reconnecting</i>' : x.busy && v.state !== 'idle' ? '<i class="busy">in the room</i>'
        : isLead ? '<i class="lead">leader</i>' : x.ready ? '<i class="ok">ready</i>' : '<i class="no">not ready</i>';
      return `<li class="pty-m${isMe ? ' me' : ''}${x.away ? ' away' : ''}"><span class="pty-av">${pic ? `<img src="${pic}" alt="">` : ''}</span>`
        + `<span class="pty-who"><b>${isLead ? '<span class="pty-crown" aria-hidden="true">♛</span> ' : ''}${esc(x.name)}${isMe ? ' <small>you</small>' : ''}</b><span>${esc(SKINS[x.skin] ?? '')}</span></span>${st}`
        + (lead && !isMe ? `<button type="button" class="pty-kick" data-kick="${x.id}" title="Remove from party" aria-label="remove ${esc(x.name)}">✕</button>` : '') + '</li>';
    });
    for (let i = 0; i < open; i++) rows.push('<li class="pty-m open"><span class="pty-av"></span><span class="pty-who"><b>Open slot</b><span>send the link</span></span></li>');

    let status: string;
    if (v.state !== 'idle') status = v.state === 'playing' ? 'Your party is in a match. You come back here when it ends.' : 'Heading into a room…';
    else if (lead) status = waiting.length ? `Waiting for ${waiting.map((x) => x.name).join(', ')} to ready up` : open ? `${open === 1 ? 'One open slot' : `${open} open slots`}: filled when the match starts` : 'Everyone is ready. Hit Play!';
    else status = me?.ready ? 'Ready. Waiting for the leader to hit Play' : 'Hit Ready when you are set';

    const html = `<div class="pty-code-row"><span class="pty-label">Party code</span><b class="pty-code">${esc(v.code)}</b><span class="mode-tag ${v.mode}">${MODES[v.mode].name}</span></div>`
      + `<div class="pty-share"><button type="button" class="btn ink" data-act="link">Copy invite link</button><button type="button" class="btn ghost" data-act="code">Copy code</button>${'share' in navigator ? '<button type="button" class="btn ghost" data-act="share">Share</button>' : ''}</div>`
      + `<input class="pty-link" readonly tabindex="-1" aria-hidden="true" value="${esc(this.link(v.code))}" />`
      + `<ul class="pty-list">${rows.join('')}</ul>`
      + `<div class="pty-foot"><span class="pty-status${this.note ? ' note' : ''}" aria-live="polite">${esc(this.note || status)}</span><button type="button" class="pty-leave" data-act="leave">Leave party</button></div>`;
    if ((this.live as HTMLElement & { _h?: string })._h !== html) { (this.live as HTMLElement & { _h?: string })._h = html; this.live.innerHTML = html; }

    // the lobby's big button
    if (play) {
      play.dataset.party = '1';
      play.classList.add('party');
      const label = v.state !== 'idle' ? (v.state === 'playing' ? 'In a match' : 'Finding a room') : lead ? 'Play' : me?.ready ? 'Ready ✓' : 'Ready up';
      const b = play.querySelector('b'); if (b && b.textContent !== label) b.textContent = label;
      play.classList.toggle('ready', !lead && !!me?.ready);
    }
    if (!skinPics.length && !this.waitPics) { this.waitPics = true; addEventListener('skins:ready', () => { (this.live as HTMLElement & { _h?: string })._h = ''; this.render(); }, { once: true }); }
  }
}
