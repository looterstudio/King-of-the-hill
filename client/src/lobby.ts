// The lobby's front: the live stage (lobbystage.ts) and everything laid over it. Name tags over the
// lineup, invite cards on the open spots, and the character select: a grid of portraits drawn by the
// game's own renderer, the character big on the plane, its name in big type, a cheer and a sound
// when you pick. main.ts owns the sign-in, the queue and the pot; party.ts owns the party; this file
// listens to both (window events) and draws.
import { MODES, SKINS, type Mode } from '../../shared/src/constants.ts';
import type { PartyView } from '../../shared/src/protocol.ts';
import type { Game3D } from './game3d.ts';
import { LobbyStage, type StageMember } from './lobbystage.ts';
import { setSkinPics } from './arsenal.ts';
import { sfx } from './audio.ts';
import './lobby.css';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Lobby { frame(dt: number): void; readonly caption: string; resize(): void }

export function initLobby(world: Game3D): Lobby {
  const stage = new LobbyStage(world);
  const canvas = world.ink.canvas, root = byId('lobby'), slotsEl = byId('lbSlots'), front = root.querySelector<HTMLElement>('.lb-front')!;
  const cs = byId('charSelect'), grid = byId('skinList'), csName = byId('csName'), csNum = byId('csNum'), stamp = byId('csStamp');

  let skin = 0;
  try { skin = Math.max(0, Math.min(SKINS.length - 1, Number(localStorage.getItem('skin')) || 0)); } catch { /* private window */ }
  let mode: Mode = (root.querySelector<HTMLElement>('.mode.on')?.dataset.mode as Mode) ?? 'solo';
  let party: PartyView | null = null;
  let hover = -1;           // the portrait under the cursor (or keyboard focus) in the select
  let selecting = false;

  // ---------- the lineup: you, your party, and open spots to invite into ----------
  const lineup = () => {
    const members: StageMember[] = [];
    if (party) {
      const me = party.members.find((m) => m.id === party!.you);
      members.push({ key: 'me', skin: selecting && hover >= 0 ? hover : me?.skin ?? skin, you: true });
      for (const m of party.members) if (m.id !== party.you) members.push({ key: `p${m.id}`, skin: m.skin, you: false });
    } else members.push({ key: 'me', skin: selecting && hover >= 0 ? hover : skin, you: true });
    // solo still shows one open spot: that's where a friend goes
    const size = party ? party.size : Math.max(2, MODES[mode].size);
    stage.setLineup(members, size);
    tags();
  };

  // the HTML laid over the lineup: a tag over each head, an invite card on each open spot
  let tagEls: HTMLElement[] = [];
  function tags() {
    const spots = party ? party.members.length : 1;
    const size = party ? party.size : Math.max(2, MODES[mode].size);
    const me = party?.members.find((m) => m.id === party!.you);
    const html: string[] = [];
    const yourSkin = selecting && hover >= 0 ? hover : me?.skin ?? skin;
    html.push(`<div class="lb-tag you" data-k="me"><span class="lb-badge">You</span><b>${esc(SKINS[yourSkin] ?? '')}</b>`
      + `<button type="button" class="lb-change" data-act="chars"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg>Characters <kbd>C</kbd></button></div>`);
    if (party) for (const m of party.members) {
      if (m.id === party.you) continue;
      const lead = m.id === party.leader;
      const st = m.away ? '<i class="away">reconnecting</i>' : lead ? '<i class="lead">leader</i>' : m.ready ? '<i class="ok">ready</i>' : '<i class="no">not ready</i>';
      html.push(`<div class="lb-tag mate" data-k="p${m.id}">${lead ? '<span class="lb-crown" aria-hidden="true">♛</span>' : ''}<b>${esc(m.name)}</b>${st}</div>`);
    }
    for (let i = spots; i < size; i++) html.push(`<button type="button" class="lb-ghost" data-k="ghost" data-act="invite"><span class="lb-plus" aria-hidden="true">+</span><b>${party ? 'Invite' : 'Play with a friend'}</b><small>${party ? 'copy the link' : 'make a party'}</small></button>`);
    const key = html.join('');
    if ((slotsEl as HTMLElement & { _h?: string })._h !== key) { (slotsEl as HTMLElement & { _h?: string })._h = key; slotsEl.innerHTML = key; }
    tagEls = Array.from(slotsEl.children) as HTMLElement[];
  }
  slotsEl.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'chars') openSelect();
    if (act === 'invite') { sfx.unlock(); dispatchEvent(new CustomEvent('party:invite')); }
  });

  addEventListener('party:view', (e) => {
    const v = (e as CustomEvent<PartyView | null>).detail, before = party;
    party = v;
    // a friend just landed: a little sound
    if (v && before && v.members.length > before.members.length) sfx.ui('join');
    lineup();
  });
  root.querySelectorAll<HTMLElement>('.mode').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode as Mode; sfx.unlock(); sfx.ui('tick'); lineup(); }));
  addEventListener('skin:pick', (e) => { skin = (e as CustomEvent<number>).detail; if (selecting) celebrate(skin); lineup(); });

  // ---------- character select ----------
  const showName = (i: number) => {
    const n = SKINS[i] ?? '';
    if (csName.textContent !== n) {
      csName.textContent = n;
      csName.classList.remove('in'); void csName.offsetWidth; csName.classList.add('in');
      csName.classList.toggle('long', n.length > 10);
    }
    csNum.textContent = `${String(i + 1).padStart(2, '0')} / ${SKINS.length}`;
  };
  const tiles = () => Array.from(grid.querySelectorAll<HTMLElement>('[data-skin]'));
  function preview(i: number) {
    if (i === hover) return;
    hover = i;
    tiles().forEach((t) => t.classList.toggle('hot', Number(t.dataset.skin) === i));
    showName(i);
    stage.setYou(i);
    sfx.ui('tick');
    tags();
  }
  function openSelect() {
    if (selecting) return;
    sfx.unlock(); sfx.ui('open');
    selecting = true; hover = -1;
    cs.classList.remove('hidden'); root.classList.add('selecting');
    stage.setView('select');
    const cur = currentSkin();
    preview(cur);
    tiles()[cur]?.focus({ preventScroll: true });
  }
  function closeSelect() {
    if (!selecting) return;
    selecting = false; hover = -1;
    cs.classList.add('hidden'); root.classList.remove('selecting');
    stage.setView('home');
    lineup(); // back to the character you picked
  }
  const currentSkin = () => party?.members.find((m) => m.id === party!.you)?.skin ?? skin;
  // picked (a click on a portrait, or Enter): the cheer, the sound, the stamp
  function celebrate(i: number) {
    const t = tiles()[i];
    stage.cheer();
    sfx.ui('pick');
    stamp.textContent = 'Locked in';
    stamp.classList.remove('on'); void stamp.offsetWidth; stamp.classList.add('on');
    tiles().forEach((x) => x.classList.remove('picked'));
    if (t) { void t.offsetWidth; t.classList.add('picked'); }
  }
  grid.addEventListener('pointerover', (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-skin]'); if (t && selecting) preview(Number(t.dataset.skin)); });
  grid.addEventListener('focusin', (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-skin]'); if (t && selecting) preview(Number(t.dataset.skin)); });
  // the one you already have, clicked again: done (a new one is saved by the grid itself, see skin:pick)
  grid.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-skin]');
    if (t && selecting && Number(t.dataset.skin) === currentSkin()) closeSelect(); // (this runs before the grid's own handler)
  });
  byId('csDone').addEventListener('click', closeSelect);
  cs.addEventListener('click', (e) => { if (e.target === cs) closeSelect(); });
  addEventListener('keydown', (e) => {
    if (root.classList.contains('hidden') || document.body.classList.contains('landing-on')) return;
    const typing = (e.target as HTMLElement)?.closest?.('input, textarea');
    if (!selecting) {
      if (!typing && !e.repeat && e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !document.querySelector('#prematch:not(.hidden)')) { e.preventDefault(); openSelect(); }
      return;
    }
    const n = SKINS.length, i = hover < 0 ? currentSkin() : hover;
    const cols = Math.max(1, Math.round(grid.clientWidth / Math.max(1, tiles()[0]?.offsetWidth ?? 1)));
    let to = -1;
    if (e.key === 'ArrowRight') to = (i + 1) % n;
    else if (e.key === 'ArrowLeft') to = (i - 1 + n) % n;
    else if (e.key === 'ArrowDown') to = Math.min(n - 1, i + cols);
    else if (e.key === 'ArrowUp') to = Math.max(0, i - cols);
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i === currentSkin()) closeSelect(); else tiles()[i]?.click(); return; }
    else if (e.key === 'Escape' || e.code === 'KeyC') { e.preventDefault(); closeSelect(); return; }
    if (to >= 0) { e.preventDefault(); tiles()[to]?.focus({ preventScroll: true }); preview(to); }
  });

  // ---------- drawing ----------
  world.ink.setQuality(1); // the first pass at full size: the lineup is close, its lines should be crisp
  let visible = true, pics = false, last = 0, quality = world.ink.quality, slow = 0, fast = 0;
  try { new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(front); } catch { /* always draw */ }
  lineup();

  return {
    get caption() { return stage.caption; },
    resize() { world.ink.resize(); },
    frame(dt: number) {
      if (!visible || document.body.classList.contains('landing-on')) return;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (W < 4 || H < 4) return;
      // the portraits, once: drawn by this renderer just before the first frame
      if (!pics) {
        pics = true;
        try {
          const big = Math.min(2, devicePixelRatio || 1) > 1 ? 1 : 1.5; // a 1x screen gets them drawn a bit larger, then shown smaller
          setSkinPics(stage.portraits(Math.round(220 * big), Math.round(290 * big), false), stage.portraits(Math.round(220 * big), Math.round(220 * big), true));
        } catch { /* no pictures: the names still work */ }
      }
      // frame-time governor: fewer pixels in the first pass when frames run long
      const now = performance.now(), ms = last ? now - last : 16; last = now;
      if (ms > 26) { slow++; fast = 0; } else if (ms < 18) { fast++; slow = 0; }
      if (slow > 30 && quality > 0.6) { quality -= 0.1; world.ink.setQuality(quality); slow = 0; }
      if (fast > 240 && quality < 1) { quality = Math.min(1, quality + 0.05); world.ink.setQuality(quality); fast = 0; }
      stage.frame(dt, W, H);
      // the tags follow the lineup
      const spots = stage.spots(W, H);
      let gi = 0;
      for (const el of tagEls) {
        const k = el.dataset.k;
        const s = k === 'ghost' ? spots.filter((p) => p.key === null)[gi++] : spots.find((p) => p.key === k);
        if (!s) { el.style.visibility = 'hidden'; continue; }
        el.style.visibility = '';
        if (k === 'ghost') el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, 0)`, el.style.height = `${Math.max(80, s.foot - s.y).toFixed(0)}px`;
        else if (k === 'me') el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.foot.toFixed(1)}px) translate(-50%, 6px)`;
        else el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
      }
    },
  };
}

