/// <reference types="vite/client" />
import bs58 from 'bs58';
import { podiumOf, BUILD, BUS, EPOCH_MS, epochEnd, ITEMS, KNOCK, MAP_HALF, MODES, POINTS, topPlaces, PERKS, PLAYER_HP, RESULT_MS, ROOM_MAX, SHIELD_MAX, SKINS, TICK_HZ, VEHICLES, VEHICLE_KINDS, WEAPONS, type Mode } from '../../shared/src/constants.ts';
import { OTHER_DOWN, loginMessage, type LobbyRoom, type PotView, type ProfileView, type RoomSeat, type ServerMsg } from '../../shared/src/protocol.ts';
import { busLine, spreadFor } from '../../shared/src/sim.ts';
import { Net } from './net.ts';
import { LocalNet } from './local.ts';
import { PotJar } from './potjar.ts';
import { Game3D, RARITY_CSS } from './game3d.ts';
import { renderArsenal, renderSkins, skinPics } from './arsenal.ts';
import { PartyUI } from './party.ts';
import { initLobby } from './lobby.ts';
import { lobbyMusic } from './music.ts';
import { STATIONS, radio } from './radio.ts';
import { voice } from './voice.ts';
import { World } from '../../shared/src/world.ts';
import { FpsInput } from './fpsinput.ts';
import { sfx } from './audio.ts';
import { Training, bindManual, guideHTML, manualHTML, tipCardHTML } from './guide.ts';
import { TOKEN, buyLinks } from '../../shared/src/token.ts';
import { onSettings, setSetting, settings, type Settings } from './settings.ts';
import { GameMenu } from './menu.ts';
import { PreMatch } from './prematch.ts';
import { Inventory } from './inventory.ts';
import { Announcer } from './announcer.ts';
import { hotbarHTML } from './hotbar.ts';
import { renderIcons } from './icons.ts';
import './hud.css';
import { initLanding } from './landing.ts';

initLanding(); // the landing page over the lobby, until Play

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const fmtSol = (v: number) => `◎ ${v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
// only touch the DOM when the markup really changed (the HUD rebuilds strings every frame)
const setHTML = (el: HTMLElement, html: string) => { if ((el as HTMLElement & { _h?: string })._h !== html) { (el as HTMLElement & { _h?: string })._h = html; el.innerHTML = html; } };
const setText = (el: HTMLElement, t: string) => { if (el.textContent !== t) el.textContent = t; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// a hand-drawn loop around banner words
const CIRCLE = '<svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true"><path d="M150 8 C 250 6, 296 34, 290 62 C 284 98, 210 114, 140 112 C 60 110, 6 92, 8 58 C 10 26, 70 8, 168 12"/></svg>';

// `vite build --mode demo` runs the whole game in the browser with bots; otherwise talk to the server
const DEMO = import.meta.env.MODE === 'demo';
const net: Net | LocalNet = DEMO ? new LocalNet() : new Net();
const jar = new PotJar($<HTMLCanvasElement>('jar'), { string: true, marks: true, crown: true, rays: true, pipe: true, stage: true });
jar.scaleSol = 12; // an hour's pot: a few SOL already fills the glass a good way
const miniJar = new PotJar($<HTMLCanvasElement>('miniPig'), { string: false, marks: false, crown: true });
const canvas = $<HTMLCanvasElement>('arena');
const game = new Game3D(canvas, $<HTMLDivElement>('tags'));
// the lobby's live view of the island (its own renderer, drawn only while the lobby is open)
const flyCanvas = $<HTMLCanvasElement>('flyCanvas');
const flyover = new Game3D(flyCanvas, $<HTMLDivElement>('flyTags'), true);
flyover.setRoom(20261008, [], -1);
flyover.ink.setQuality(1); // full resolution; the lobby stage steps it down only if frames run long
const lobby = initLobby(flyover); // the lobby's live stage: your party on the paper plane over the island
// the arsenal pictures are drawn once, when the page is idle
const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
idle(() => renderArsenal($('arsenal')));
idle(() => renderIcons()); // the hotbar's gun silhouettes and item pictures
// how to play: drawn cards in the lobby and the waiting room, a checklist in your first matches
$('guideCards').innerHTML = manualHTML(); bindManual($('guideCards'));
$('roomGuide').innerHTML = guideHTML(true);
$('howtoLink').onclick = (e) => { e.preventDefault(); $('guide').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('roomTip').onclick = (e) => { if ((e.target as HTMLElement).closest('[data-all]')) { e.preventDefault(); $('roomGuideSec').scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
let roomTipAt = 0, roomTipI = 0;
const training = new Training($('training'));
// tips that teach as you play: each shows once a match and stops after a few matches
let tipsSeen = new Set<string>();
function tipOnce(key: string, text: string, ms: number, times = 3) {
  if (tipsSeen.has(key)) return;
  tipsSeen.add(key);
  let n = 0;
  try { n = Number(localStorage.getItem(`tip:${key}`)) || 0; localStorage.setItem(`tip:${key}`, String(n + 1)); } catch { /* private window */ }
  if (n < times) hint(text, ms);
}
// what the training list watches between frames
const learn = { yaw: 0, pitch: 0, look: 0, walk: 0, sprint: 0, x: 0, z: 0, grounded: false, glided: false, mats: 0, combat: 0 };
// the radio: off -> station 1 -> 2 -> 3 -> off in the lobby; in a vehicle it comes on by itself
radio.onChange = (name, tag) => {
  setHTML($('radioBtn'), `📻 <span>${esc(name)}</span>`);
  if (state.screen === 'game') hint(`📻 ${name} · ${tag}   (N next · M off)`, 3200);
};
$('radioBtn').onclick = () => {
  sfx.unlock();
  if (!radio.on) { radio.muted = false; radio.play(0); }
  else if (radio.station < STATIONS.length - 1) radio.nextStation();
  else { radio.stop(); radio.muted = true; setHTML($('radioBtn'), '📻 <span>radio off</span>'); }
};
addEventListener('keyup', (e) => { if (e.code === 'KeyV') void voice.talk(false); });
addEventListener('blur', () => { void voice.talk(false); }); // V let go in another window
// mid-match, Ctrl is slide: Ctrl+W (or a stray Ctrl+R) would close or reload the tab and lose the match
addEventListener('beforeunload', (e) => { if (state.screen === 'game' && !state.over && game.self?.alive) { e.preventDefault(); e.returnValue = ''; } });
let howtoDone = false, howtoAt = 0;
function closeHowto() { howtoAt = 0; $('howto').classList.add('hidden'); }
function openHowto() { $('howto').classList.remove('hidden'); howtoAt = performance.now(); }
addEventListener('keydown', (e) => {
  if (state.screen === 'game' && !e.repeat && e.code === 'KeyH') { if (howtoAt) closeHowto(); else openHowto(); return; } // H: the controls card
  if (state.screen === 'game' && !e.repeat && e.code === 'KeyT') training.toggle();                                    // T: the training list
  if (howtoAt && performance.now() - howtoAt > 1200) closeHowto();
});
addEventListener('mousedown', () => { if (howtoAt && performance.now() - howtoAt > 1200) closeHowto(); });
addEventListener('keydown', (e) => {
  if (state.screen !== 'game') return;
  if (e.code === 'KeyV' && !e.repeat) void voice.talk(true);
  if (e.code === 'KeyU' && voice.active) { voice.setDeaf(!voice.deaf); hint(voice.deaf ? 'squad voice muted (U)' : 'squad voice on', 1500); }
  if (e.code === 'KeyN' && radio.on) radio.nextStation();
  if (e.code === 'KeyM' && !e.repeat) { toggleMap(); return; } // M: the map, any time (the radio's on/off is the button at the top)
  if (e.code === 'Escape' && state.mapOpen) { toggleMap(false); return; }
  if (e.code === 'KeyP' && !e.repeat) { // third person (over the shoulder) or first person, remembered
    setSetting('view', game.thirdPerson ? 'fp' : 'tp');
    hint(game.thirdPerson ? 'third person · P for first person' : 'first person · P for third person', 1500);
  }
});
// the character you drop in as (remembered between visits)
let mySkin = 0;
try { mySkin = Math.max(0, Math.min(SKINS.length - 1, Number(localStorage.getItem('skin')) || 0)); } catch { /* private window */ }
setTimeout(() => renderSkins($('skinList'), mySkin, (i) => { mySkin = i; try { localStorage.setItem('skin', String(i)); } catch { /* ignore */ } renderProfile(); }), 50);
let flyVisible = true;
try { new IntersectionObserver((e) => { flyVisible = e[0].isIntersecting; }).observe(flyCanvas); } catch { /* old browser: always draw */ }
const input = new FpsInput(canvas);
// settings (Esc menu): look, view, volumes, graphics, applied the moment they change
function applySettings(_: Settings, key: keyof Settings | null) {
  input.sens = settings.sens; input.adsSens = settings.adsSens; input.invert = settings.invert;
  sfx.setVolume(settings.master, settings.effects, settings.music);
  game.fov = settings.fov;
  if (key === null || key === 'view') game.thirdPerson = settings.view === 'tp';
  if (key === null || key === 'quality' || key === 'renderScale') game.ink.setQuality(settings.renderScale);
}
onSettings(applySettings);
applySettings(settings, null);
// the inventory (Tab / I), the item wheel (hold Z) and the notes on what you just picked up
const inventory = new Inventory($('inventory'), $('wheel'), $('pickToasts'), input, () => state.screen === 'game' && !state.over && !!game.self?.alive);
// headless test runs can't take pointer lock; #autotest pretends it was granted (demo build only)
if (DEMO && location.hash === '#autotest') { input.locked = true; input.lock = () => {}; (window as unknown as Record<string, unknown>).__pr = { game, net, input, autopilot: () => import('./autopilot.ts') }; }

type Screen = 'lobby' | 'waiting' | 'game';
const state = {
  screen: 'lobby' as Screen,
  nonce: '',
  authed: false,
  authMode: null as null | 'guest' | 'wallet',
  name: '',
  wallet: null as string | null,
  pot: null as PotView | null,
  potShown: 0,
  seats: [] as RoomSeat[],
  you: -1,
  startsAt: null as number | null,
  phase: '',
  over: false,
  aimed: false, // camera takes the server's spawn heading once per match
  dropped: false,
  previewSeed: -1,
  mode: 'solo' as Mode,       // what the play button queues for
  party: '',
  roomMode: 'solo' as Mode,   // the room we are in
  dead: new Set<number>(),    // eliminated this match
  specFire: false, specAim: false, freeSendT: 0,
  connected: false, guests: true,  // the server said hello; whether it lets guests play
  sentName: '',                    // the guest name we last sent (the server tidies it up)
  after: null as null | { mode: Mode; room?: string }, // queue for this once the sign-in lands
  marker: null as [number, number] | null,   // where you want to land (click the map): yours, and your teammates'
  marks: new Map<number, [number, number]>(),
  mapOpen: false,                            // the flight map is open on screen, with the cursor (M aboard the plane)
};
try { const m = localStorage.getItem('pr_mode') as Mode | null; if (m && m in MODES) state.mode = m; state.party = localStorage.getItem('pr_party') ?? ''; } catch { /* storage blocked */ }

function show(s: Screen) {
  const prev = state.screen;
  state.screen = s;
  $('lobby').classList.toggle('hidden', s !== 'lobby');
  $('waiting').classList.toggle('hidden', s !== 'waiting');
  $('hud').classList.toggle('hidden', s !== 'game');
  canvas.style.visibility = s === 'game' ? 'visible' : 'hidden';
  if (s !== 'game') {
    input.unlock(); menu.hide(); prematch.close(); sfx.engine(0, 0); sfx.spin(0);
    voice.stop(); if (prev === 'game' && radio.on) radio.stop(); // the vehicle radio doesn't follow you out of the match
    document.body.classList.remove('knocked');
  }
  if (s === 'lobby') { jar.resize(); flyover.ink.resize(); updatePlay(); }
  party.onScreen(s); lobbyMusic.setScreen(s);
}

function err(msg: string) { $('error').textContent = msg; if (msg) setTimeout(() => { if ($('error').textContent === msg) $('error').textContent = ''; }, 5000); }
function updatePlay() { $<HTMLButtonElement>('playBtn').disabled = !state.connected; }

// ---------- auth ----------
$('guestBtn').onclick = () => {
  const name = $<HTMLInputElement>('guestName').value.trim() || 'guest';
  try { localStorage.setItem('pr_name', name); } catch { /* storage blocked */ }
  state.authMode = 'guest'; state.sentName = name; net.send({ t: 'guest', name });
};
$('guestName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('guestBtn').click(); });
try { $<HTMLInputElement>('guestName').value = localStorage.getItem('pr_name') ?? ''; } catch { /* storage blocked */ }

// Solana wallets: Phantom first, Solflare and Backpack too. Each proves the wallet by signing the
// login message (free, no transaction); the server checks the signature and reads the token balance
interface SolWallet { connect(): Promise<unknown>; signMessage(m: Uint8Array, enc?: 'utf8'): Promise<unknown>; publicKey?: { toString(): string } | null }
type WalletId = 'phantom' | 'solflare' | 'backpack';
function wallets(): { id: WalletId; name: string; w: SolWallet }[] {
  const g = window as unknown as { phantom?: { solana?: SolWallet }; solana?: SolWallet & { isPhantom?: boolean }; solflare?: SolWallet & { isSolflare?: boolean }; backpack?: { solana?: SolWallet } & SolWallet };
  const out: { id: WalletId; name: string; w: SolWallet }[] = [];
  const ph = g.phantom?.solana ?? (g.solana?.isPhantom ? g.solana : undefined);
  if (ph) out.push({ id: 'phantom', name: 'Phantom', w: ph });
  if (g.solflare) out.push({ id: 'solflare', name: 'Solflare', w: g.solflare });
  const bp = g.backpack?.solana ?? (g.backpack?.connect ? g.backpack : undefined);
  if (bp) out.push({ id: 'backpack', name: 'Backpack', w: bp });
  return out;
}
let walletName = 'Wallet'; // which one signed in (the button says so)
async function signInWith(w: SolWallet, name: string) {
  try {
    walletName = name;
    const r = await w.connect() as { publicKey?: { toString(): string } } | undefined;
    const pk = (r?.publicKey ?? w.publicKey)?.toString();
    if (!pk) throw new Error('the wallet did not share its address');
    const s = await w.signMessage(new TextEncoder().encode(loginMessage(state.nonce)), 'utf8') as Uint8Array | { signature: Uint8Array };
    const sig = s instanceof Uint8Array ? s : s.signature;
    state.authMode = 'wallet';
    net.send({ t: 'auth', wallet: pk, sig: bs58.encode(sig) });
    $('walletPick').classList.add('hidden');
  } catch (e) { err((e as Error).message || 'Signature cancelled.'); }
}
$('connectBtn').onclick = async () => {
  const list = wallets();
  if (!list.length) return err('No Solana wallet found. Install Phantom (phantom.app) and reload.');
  if (list.length === 1) return signInWith(list[0].w, list[0].name);
  // several installed: pick one
  const pick = $('walletPick');
  pick.innerHTML = list.map((x) => `<button type="button" class="btn ghost small" data-wallet="${x.id}">${x.name}</button>`).join('');
  pick.classList.remove('hidden');
  pick.onclick = (e) => { const id = (e.target as HTMLElement).closest<HTMLElement>('[data-wallet]')?.dataset.wallet; const w = list.find((x) => x.id === id); if (w) void signInWith(w.w, w.name); };
};

const touchOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
$('playBtn').onclick = () => (party.view ? party.play() : openPrematch(state.mode)); // in a party: Play (leader) or Ready

// ---------- before the match: controls, your name, one big button ----------
const prematch = new PreMatch($('prematch'), {
  enter: (name) => {
    const t = state.after ?? { mode: state.mode };
    if (state.authed && state.authMode === 'wallet') {
      // a wallet may rename itself before the match; the name is remembered for this wallet
      if (name && name !== state.name) { net.send({ t: 'name', name }); try { localStorage.setItem(`pr_wname:${state.wallet}`, name); } catch { /* storage blocked */ } }
      return queueFor(t);
    }
    if (state.authed && name === state.sentName) return queueFor(t);
    // not signed in yet (or a new name): sign in as a guest, then queue when the server answers
    try { localStorage.setItem('pr_name', name); } catch { /* storage blocked */ }
    $<HTMLInputElement>('guestName').value = name;
    state.authMode = 'guest'; state.sentName = name; state.after = t;
    net.send({ t: 'guest', name });
    prematch.busy('Signing in…');
  },
  cancel: () => { state.after = null; },
});
function openPrematch(mode: Mode, room?: string) {
  if (touchOnly()) return err('King of the Hill Royale needs a mouse and keyboard. Open it on a computer.');
  if (!state.authed && !state.guests) return err('Connect a wallet first.');
  sfx.unlock();
  state.after = { mode, room };
  const stored = $<HTMLInputElement>('guestName').value.trim();
  prematch.open({ mode, name: state.authed ? (state.authMode === 'wallet' ? state.name : state.sentName || state.name) : stored, wallet: state.authed && state.authMode === 'wallet' ? state.wallet : null, guests: state.guests });
}
function queueFor(t: { mode: Mode; room?: string }) {
  state.after = null;
  const party = t.mode === 'solo' && !t.room ? undefined : state.party || undefined;
  net.send(t.room ? { t: 'queue', room: t.room, party, skin: mySkin } : { t: 'queue', mode: t.mode, party, skin: mySkin });
  $('queueInfo').textContent = t.room ? 'Joining that room…' : `Finding a ${MODES[t.mode].name.toLowerCase()} room…`;
  prematch.busy(t.room ? 'Joining…' : 'Finding a room…');
}

// ---------- modes / party ----------
function renderMode() {
  document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => { const on = b.dataset.mode === state.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $<HTMLInputElement>('party').value = state.party;
  $('playBtn').innerHTML = `<b>Play</b><small>${MODES[state.mode].name}</small>`;
}
document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => b.onclick = () => {
  state.mode = b.dataset.mode as Mode; renderMode();
  try { localStorage.setItem('pr_mode', state.mode); } catch { /* storage blocked */ }
});
const saveParty = () => { try { localStorage.setItem('pr_party', state.party); } catch { /* storage blocked */ } };
$<HTMLInputElement>('party').oninput = (e) => {
  const el = e.target as HTMLInputElement; el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); state.party = el.value; saveParty();
};
renderMode();
// the party pre-lobby (party.ts): Create party / Join, and the slots screen over the lobby
const party = new PartyUI(net, {
  skin: () => mySkin,
  setSkin: (i) => { mySkin = i; try { localStorage.setItem('skin', String(i)); } catch { /* ignore */ } document.querySelectorAll('#skinList .skin').forEach((b, k) => b.classList.toggle('on', k === i)); },
  mode: () => state.mode, authed: () => state.authed, err, toLobby: () => show('lobby'),
  canPlay: () => (touchOnly() ? 'King of the Hill Royale needs a mouse and keyboard. Open it on a computer.' : null),
});

// ---------- pot odometer: each digit is a rolling column ----------
function odometer(el: HTMLElement, text: string, sym = '◎') {
  if (el.dataset.v === text + sym) return;
  el.dataset.v = text + sym;
  const cells = el.querySelectorAll<HTMLElement>('.dg, .pt');
  if (el.dataset.sym !== sym || cells.length !== text.length || [...text].some((ch, i) => (ch >= '0' && ch <= '9') !== cells[i].classList.contains('dg'))) {
    el.dataset.sym = sym;
    el.innerHTML = `<span class="sym">${sym}</span>` + [...text].map((ch) => ch >= '0' && ch <= '9'
      ? `<span class="dg"><span class="col">${'0123456789'.split('').map((d) => `<span>${d}</span>`).join('')}</span></span>`
      : `<span class="pt">${ch}</span>`).join('');
  }
  const cols = el.querySelectorAll<HTMLElement>('.dg .col');
  let k = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') cols[k++].style.transform = `translateY(-${Number(ch) * 10}%)`;
}

// ---------- stats strip: count up when it scrolls into view ----------
{
  const nums = Array.from(document.querySelectorAll<HTMLElement>('[data-count]'));
  const run = () => nums.forEach((el) => {
    const to = Number(el.dataset.count), suffix = el.dataset.suffix ?? '', t0 = performance.now();
    const tick = (now: number) => { const k = Math.min(1, (now - t0) / 1200), e = 1 - (1 - k) ** 3; el.textContent = `${Math.round(to * e)}${suffix}`; if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  try { const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { run(); io.disconnect(); } }); if (nums[0]) io.observe(nums[0]); } catch { run(); }
}

// ---------- live rooms ----------
function renderRooms(rooms: LobbyRoom[]) {
  // how busy each mode is, on its card
  for (const mode of ['solo', 'duo', 'squad'] as Mode[]) {
    const rs = rooms.filter((r) => r.mode === mode), n = rs.reduce((s, r) => s + r.n, 0);
    const el = document.querySelector<HTMLElement>(`[data-live="${mode}"]`);
    if (el) el.textContent = rs.length ? `● ${n} in ${rs.length} room${rs.length > 1 ? 's' : ''}` : 'open a room';
  }
  const list = $('roomList');
  if (!rooms.length) { list.innerHTML = '<li class="nobody">No rooms yet. Hit drop in and you open the first one.</li>'; return; }
  list.innerHTML = rooms.slice(0, 7).map((r) => {
    const live = r.state === 'live' || r.state === 'over';
    const when = live ? 'in game' : r.state === 'countdown' ? `dropping in ${r.startsIn}s` : r.n < 2 ? 'waiting for players' : r.startsIn !== null ? `starts in ${r.startsIn}s` : 'filling';
    return `<li class="${live ? 'live' : ''}"><span class="mode-tag ${r.mode}">${MODES[r.mode].name}</span>`
      + `<div class="room-mid"><div class="top"><span>${when}</span><b>${r.n}/${ROOM_MAX}</b></div><div class="room-bar"><i style="width:${(r.n / ROOM_MAX) * 100}%"></i></div></div>`
      + (live ? '<span class="live-pill">live</span>' : `<button class="btn ghost small" data-room="${esc(r.id)}">Join</button>`) + '</li>';
  }).join('');
}
$('roomList').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-room]')?.dataset.room;
  if (!id) return;
  openPrematch(lobbyRooms.find((r) => r.id === id)?.mode ?? state.mode, id);
});

// ---------- ticker: fees coming in, wins, rooms starting ----------
const tickerItems: string[] = [];
function ticker(html: string) {
  tickerItems.unshift(html); if (tickerItems.length > 10) tickerItems.pop();
  const row = tickerItems.join('');
  $('ticker').innerHTML = row + row; // twice, so the loop is seamless
}
ticker('<span>the hill is open · <b>solo, duos & squads</b></span>');
ticker('<span class="gold">golden pencil cases hold <b>the SCAR & the Heavy Sniper</b></span>');
$('leaveBtn').onclick = () => { voice.stop(); net.send({ t: 'leave' }); show('lobby'); $('queueInfo').textContent = ''; };

// ---------- lobby ----------
const marks = (n: number) => '<i></i>'.repeat(Math.min(Math.ceil(n / 50), 15));
function renderPot(p: PotView) {
  state.pot = p;
  $('holdReq').textContent = `$${p.holdMinUsd ?? TOKEN.holdMinUsd} of $${p.symbol}`;
  setText($('qualUsd'), `$${p.holdMinUsd ?? TOKEN.holdMinUsd}`);
  document.querySelectorAll('.sym-tok').forEach((e) => { e.textContent = `$${p.symbol}`; });
  renderCa(p.mint || TOKEN.mint, p.symbol);
  // who's on top this round: they take the pot unless someone passes them before :00
  const top = p.tickets[0], at = new Date(p.epochEndMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lead = $('potLeader');
  lead.classList.toggle('you', !!top && top.wallet === state.wallet);
  setHTML(lead, top ? (top.wallet === state.wallet ? `<span class="crown">♛</span> <b>You</b> lead with <b>${top.wins} pts</b> · hold on until ${at}` : `<span class="crown">♛</span> <b>${esc(top.name)}</b> leads with <b>${top.wins} pts</b> · beat them before ${at}`)
    : `Nobody has scored this round yet: the first win puts you on top.`);
  jar.setSol(sol(p.lamports)); miniJar.setSol(sol(p.lamports));
  $('online').textContent = p.online.toLocaleString('en-US');
  $('rooms').textContent = String(p.rooms);
  $('tickets').innerHTML = p.tickets.length
    ? p.tickets.map((t, i) => `<li class="${t.wallet === state.wallet ? 'me-row' : ''} ${i === 0 ? 'top' : ''}"><span class="name"><span>${i === 0 ? '<i class="crown">♛</i> ' : ''}${esc(t.name)}${i === 0 ? ' <small class="takes">takes the pot</small>' : ''}</span></span><span class="marks">${marks(t.wins)}<em>${t.wins}</em></span></li>`).join('')
    : '<li class="nobody">Nobody has scored this round. Win, place top 10 or get kills: the top 3 at the close share the round prize.</li>';
}
// the token's contract address with buy links, or a note until it launches
let caShown = '';
function renderCa(mint: string, symbol: string) {
  if (caShown === mint + symbol) return;
  caShown = mint + symbol;
  if (!mint) { $('tokenCa').innerHTML = `<span>$${esc(symbol)} contract address:</span> <span class="soon">revealed at launch</span>`; return; }
  const l = buyLinks(mint);
  $('tokenCa').innerHTML = `<span>CA</span> <code>${esc(mint)}</code> <button type="button" data-copy>copy</button> <a href="${l.pump}" target="_blank" rel="noopener">pump.fun</a> <a href="${l.jupiter}" target="_blank" rel="noopener">Jupiter</a> <a href="${l.dexscreener}" target="_blank" rel="noopener">chart</a>`;
}
$('tokenCa').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-copy]');
  if (!b) return;
  const mint = state.pot?.mint || TOKEN.mint;
  void navigator.clipboard?.writeText(mint).then(() => { b.textContent = 'copied ✓'; setTimeout(() => { b.textContent = 'copy'; }, 1500); });
});

// ---------- profile: a connected wallet's chip and card ----------
let profile: ProfileView | null = null;
const fmtNum = (s: string | null) => (s === null ? '–' : Number(s).toLocaleString('en-US', { maximumFractionDigits: 2 }));
function renderProfile() {
  const chip = $('profileChip'), pop = $('profilePop');
  chip.classList.toggle('hidden', !profile);
  if (!profile) { pop.classList.add('hidden'); return; }
  const p = profile, short = `${p.wallet.slice(0, 4)}…${p.wallet.slice(-4)}`, hue = parseInt(p.wallet.slice(0, 6), 36) % 360;
  setHTML(chip, `<span class="pf-av" style="background:hsl(${hue} 70% 45%)">${p.wallet[0]}</span>${short}${p.wins ? `<span class="pf-w">♛ ${p.wins}</span>` : ''}<span class="pf-q ${p.qualified ? 'ok' : 'no'}">${p.qualified ? 'qualified' : 'not qualified'}</span>`);
  chip.setAttribute('aria-expanded', String(!pop.classList.contains('hidden')));
  const won = sol(p.prizeLamports);
  setHTML(pop, `<h4>Your profile <button type="button" data-close aria-label="close">✕</button></h4><div class="pf-wallet">${esc(p.wallet)}</div>`
    + (skinPics[mySkin] ? `<div class="pf-skin"><img src="${skinPics[mySkin]}" alt=""><span>playing as <b>${esc(SKINS[mySkin])}</b></span></div>` : '')
    + `<div class="pf-status ${p.qualified ? 'ok' : 'no'}">${p.qualified ? `✓ Qualified for this round prize` : '✗ Not qualified this round'}`
    + `<small>${p.balance !== null ? `You hold ${fmtNum(p.balance)} $${esc(p.symbol)}${p.need ? ` · need ${fmtNum(p.need)} (≈ $${p.holdMinUsd})` : ''}` : esc(p.why ?? '')}${p.qualified || p.balance === null ? '' : `<br>${esc(p.why ?? '')}`}</small></div>`
    + `<div class="pf-grid"><div class="gold"><b>${p.points}</b><span>points this round</span></div><div class="gold"><b>${p.rank ? `#${p.rank}` : '–'}</b><span>rank this round</span></div><div class="gold"><b>${p.prizes}</b><span>prizes won</span></div>`
    + `<div><b>${p.matches}</b><span>matches</span></div><div><b>${p.wins}</b><span>wins</span></div><div><b>${p.kills}</b><span>kills</span></div></div>`
    + `<div class="pf-foot"><span>${won > 0 ? `won ${fmtSol(won)} in total` : p.best ? `best finish #${p.best}` : 'no matches yet: drop in!'}</span><button type="button" data-refresh>refresh</button></div>`);
  // the "who can win" checklist ticks itself off
  const steps = document.querySelectorAll('#qualify li');
  steps[0]?.classList.toggle('ok', true);
  steps[1]?.classList.toggle('ok', p.qualified);
  steps[2]?.classList.toggle('ok', p.rank === 1);
}
$('profileChip').onclick = () => { const pop = $('profilePop'); pop.classList.toggle('hidden'); if (!pop.classList.contains('hidden')) net.send({ t: 'me' }); renderProfile(); };
$('profilePop').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-close]')) { $('profilePop').classList.add('hidden'); renderProfile(); }
  if (t.closest('[data-refresh]')) net.send({ t: 'me' });
});
addEventListener('mousedown', (e) => { const pop = $('profilePop'); if (!pop.classList.contains('hidden') && !(e.target as HTMLElement).closest('#profilePop, #profileChip')) { pop.classList.add('hidden'); renderProfile(); } });

function toast(text: string) {
  const el = $('inflowToast'); el.textContent = text; el.classList.add('on');
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove('on'), 2200);
}

// ---------- room ----------
let lobbyRooms: LobbyRoom[] = [];
let shownSeats = new Set<number>();
function renderSeats() {
  const fresh = new Set(state.seats.map((s) => s.id));
  const cap = ROOM_MAX;
  $('seats').classList.toggle('many', cap > 12);
  const filled = state.seats.map((s) => `<div class="seat full ${s.id === state.you ? 'me' : ''} ${shownSeats.has(s.id) ? '' : 'new'}"><div class="pic">${skinPics[s.skin ?? -1] ? `<img src="${skinPics[s.skin ?? -1]}" alt="">` : ''}</div><div class="nm">${s.id === state.you ? 'you' : esc(s.name)}</div></div>`);
  const empty = Array.from({ length: cap - state.seats.length }, () => '<div class="seat"></div>');
  $('seats').innerHTML = [...filled, ...empty].join('');
  shownSeats = fresh;
  $('fillBar').style.width = `${(state.seats.length / cap) * 100}%`;
}

// ---------- hud ----------
const seatOf = (id: number | null) => (id === null ? null : state.seats.find((s) => s.id === id) ?? null);
const label = (id: number | null) => { const s = seatOf(id); return s ? (s.id === state.you ? 'you' : s.num) : '???'; };
function feed(html: string, mine = false) {
  const el = document.createElement('div'); el.innerHTML = html; if (mine) el.className = 'mine';
  const f = $('feed'); f.prepend(el);
  while (f.children.length > 6) f.lastChild?.remove();
}
let bannerTimer = 0;
function banner(word: string, sub: string, ink = false, ms = 0) {
  const b = $('banner');
  b.innerHTML = `<span class="big ${ink ? 'ink' : ''}">${word}${CIRCLE}</span>${sub ? `<small>${sub}</small>` : ''}`;
  b.classList.remove('hidden');
  clearTimeout(bannerTimer); // an earlier banner's timer must not hide this one (Knocked, then Victory)
  if (ms > 0) bannerTimer = window.setTimeout(() => b.classList.add('hidden'), ms);
}
let hintTimer = 0;
function hint(text: string, ms = 2500) {
  const el = $('hint'); el.textContent = text; el.classList.add('on');
  clearTimeout(hintTimer); hintTimer = window.setTimeout(() => el.classList.remove('on'), ms);
}
// Fortnite-style damage numbers: pellets that land together add up into one number
const pendingHits = new Map<number, { dmg: number; head: boolean; shield: boolean; t: number }>();
function damageNumber(victim: number, dmg: number, head: boolean, shield = false) {
  const cur = pendingHits.get(victim);
  if (cur) { cur.dmg += dmg; cur.head ||= head; cur.shield ||= shield; return; }
  const entry = { dmg, head, shield, t: 0 };
  pendingHits.set(victim, entry);
  entry.t = window.setTimeout(() => {
    pendingHits.delete(victim);
    const at = game.screenOf(victim, entry.head) ?? { x: innerWidth / 2 + 40, y: innerHeight / 2 - 40 };
    const el = document.createElement('div');
    el.className = `dmgnum ${entry.head ? 'head' : entry.shield ? 'shield' : ''} ${entry.dmg >= 120 ? 'big' : ''}`;
    el.textContent = String(entry.dmg);
    el.style.left = `${at.x + (Math.random() - 0.5) * 30}px`; el.style.top = `${at.y}px`;
    el.style.setProperty('--dx', `${(Math.random() < 0.5 ? -1 : 1) * (22 + Math.random() * 34)}px`);
    $('tags').appendChild(el);
    setTimeout(() => el.remove(), 900);
  }, 40);
}
function vehicleNumber(v: number[] | undefined, dmg: number) {
  const at = v ? game.screenAt(v[2], v[3] + 2, v[4]) : null;
  const el = document.createElement('div');
  el.className = 'dmgnum vehicle';
  el.textContent = String(dmg);
  el.style.left = `${(at?.x ?? innerWidth / 2 + 40) + (Math.random() - 0.5) * 30}px`; el.style.top = `${at?.y ?? innerHeight / 2 - 40}px`;
  $('tags').appendChild(el);
  setTimeout(() => el.remove(), 900);
}
function hitmarker(head: boolean, kill = false) {
  const el = $('hitmarker'); el.classList.toggle('head', head); el.classList.toggle('kill', kill); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  if (head || kill) { const c = $('crosshair'); c.classList.remove('kick'); void c.offsetWidth; c.classList.add('kick'); }
}
// you eliminated someone: the pop in the middle of the screen, the sound (a step higher for each kill
// in a multi-kill), the kill counter, a kick of the camera. The announcer calls the multi-kills and streaks
const announcer = new Announcer($('announce'));
function eliminated(victim: number, head: boolean) {
  const el = $('elimPop');
  el.classList.toggle('head', head);
  setHTML(el, `<div class="ep-icon">${head ? '🎯' : '☠'}</div><div class="ep-title">${head ? 'HEADSHOT' : 'ELIMINATED'}</div><div class="ep-name">${esc(label(victim))}</div>`);
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  const k = $('killCount'); k.classList.remove('pop'); void k.offsetWidth; k.classList.add('pop');
  sfx.elim(head, announcer.multiKills); hitmarker(head, true); game.kick(head ? 1.3 : 1);
}
// your own shield just broke: a crunch you can't miss and a crack across the screen edges
function armorLost() {
  sfx.armorLost();
  const el = $('armorLost'); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
// blood across the edges of the screen, as strong as the hit was
function bloodHit(dmg: number) {
  const el = $('blood');
  el.classList.add('on'); el.style.opacity = String(Math.min(0.95, 0.3 + dmg / 70));
  void el.offsetWidth; el.classList.remove('on'); el.style.opacity = '0';
}
let lastWarn = -1, stormClosing = false;
function damageFrom(by: number | null) {
  const pos = by !== null ? game.positionOf(by) : null;
  if (!pos) return;
  const i = document.createElement('i');
  i.style.transform = `rotate(${game.bearingTo(pos.x, pos.z, input.yaw)}rad)`;
  $('dmg').appendChild(i);
  setTimeout(() => i.remove(), 1000);
}

// ---------- pause / pointer lock: the Esc menu ----------
// browsers refuse to take the mouse again for about a second after Esc; Resume waits that out
let unlockedAt = 0;
const menu = new GameMenu($('pause'), $('menuCard'), {
  resume: () => { sfx.unlock(); const wait = unlockedAt + 1100 - performance.now(); if (wait > 0) setTimeout(() => input.lock(), wait); else input.lock(); },
  leave: () => leaveMatch(),
  inventory: () => inventory.html(),
});
$('pause').addEventListener('mousedown', (e) => { if (e.target === $('pause')) { sfx.unlock(); input.lock(); } }); // a click beside the card plays too
function leaveMatch() {
  net.send({ t: 'leave' });
  $('banner').classList.add('hidden'); $('victory').classList.add('hidden'); stopConfetti();
  show('lobby'); $('queueInfo').textContent = '';
}
input.onLockChange = (locked) => {
  if (!locked) unlockedAt = performance.now();
  if (state.screen !== 'game' || state.over || ((state.mapOpen || inventory.kept) && !locked)) return; // the map or the inventory took the cursor: no pause card
  if (locked && !state.dropped) { state.dropped = true; banner('Drop!', `${MODES[state.roomMode].name} · ${state.seats.length} players${game.mates.size ? ` · ${game.mates.size} teammate${game.mates.size > 1 ? 's' : ''} with you` : ''} · the hill is in the middle`, true, 2400); }
  if (locked) menu.hide(); else menu.show(state.dropped ? 'paused' : 'drop');
  if (locked && input.free) hint('mouse capture is blocked here: look with the mouse + arrow keys, Esc to pause', 4500);
};

// ---------- maps ----------
// the island drawn as a notebook sketch: roads, buildings, place names, golden cases
function drawIsland(ctx: CanvasRenderingContext2D, w: World, S: number, labels: boolean) {
  const k = S / (MAP_HALF * 2), X = (x: number) => (x + MAP_HALF) * k, Y = (z: number) => (z + MAP_HALF) * k;
  ctx.strokeStyle = 'rgba(29,51,184,0.12)'; ctx.lineWidth = 1;
  for (let i = 0; i <= S; i += S / 10) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke(); }
  for (const b of w.biomes) { ctx.fillStyle = b.kind === 'desert' ? 'rgba(240,170,60,0.22)' : 'rgba(150,180,240,0.25)'; ctx.fillRect(X(b.x0), Y(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k); }
  ctx.fillStyle = 'rgba(29,51,184,0.18)';
  for (const l of w.lakes) { ctx.beginPath(); ctx.arc(X(l.x), Y(l.z), l.r * k, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(43,47,58,0.45)'; ctx.lineWidth = Math.max(1.5, 6 * k);
  for (const r of w.roads) { ctx.beginPath(); ctx.moveTo(X(r.x0), Y(r.z0)); ctx.lineTo(X(r.x1), Y(r.z1)); ctx.stroke(); }
  ctx.fillStyle = 'rgba(29,51,184,0.45)';
  for (const r of w.roofs) ctx.fillRect(X(r.x0), Y(r.z0), Math.max(1, (r.x1 - r.x0) * k), Math.max(1, (r.z1 - r.z0) * k));
  ctx.fillStyle = 'rgba(19,137,127,0.45)';
  for (const t of w.trees) ctx.fillRect(X(t.x) - 1, Y(t.z) - 1, 2, 2);
  ctx.fillStyle = '#e8a317';
  ctx.font = `${Math.max(8, S * 0.04)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const c of w.caseSpots) if (c.golden) ctx.fillText('★', X(c.x), Y(c.z));
  if (!labels) return;
  ctx.font = `700 ${Math.max(12, S * 0.05)}px Caveat, cursive`;
  for (const p of w.pois) {
    const isTower = p.x === 0 && p.z === 0;
    ctx.fillStyle = isTower ? '#d32336' : '#1d33b8';
    ctx.strokeStyle = 'rgba(255,253,245,0.9)'; ctx.lineWidth = 4;
    const label = isTower ? `♛ ${p.name}` : p.name;
    ctx.strokeText(label, X(p.x), Y(p.z) - (isTower ? 0 : 10)); ctx.fillText(label, X(p.x), Y(p.z) - (isTower ? 0 : 10));
  }
}
function drawPreview(seed: number) {
  if (state.previewSeed === seed) return paintPreview();
  state.previewSeed = seed; state.marker = null;
  const c = $<HTMLCanvasElement>('mapPreview');
  preWorld = new World(seed);
  previewBase.width = c.width; previewBase.height = c.height;
  drawIsland(previewBase.getContext('2d')!, preWorld, c.width, true);
  previewLine = busLine(preWorld);
  paintPreview();
}
let preWorld: World | null = null; // generated for the preview, reused at the drop (it costs 100-300 ms)
const previewBase = document.createElement('canvas');
let previewLine: ReturnType<typeof busLine> | null = null;
function paintPreview() {
  const c = $<HTMLCanvasElement>('mapPreview'), ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(previewBase, 0, 0);
  drawDrop(ctx, c.width, previewLine, null, true);
}
// a click on a map: your landing marker goes there (a second click on it takes it off), and your teammates see it
function markAt(canvas: HTMLCanvasElement, e: MouseEvent) {
  const r = canvas.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * MAP_HALF * 2 - MAP_HALF, z = ((e.clientY - r.top) / r.height) * MAP_HALF * 2 - MAP_HALF;
  const m = state.marker, off = m && Math.hypot(m[0] - x, m[1] - z) < 18;
  state.marker = off ? null : [Math.round(x), Math.round(z)];
  if (state.screen === 'game') net.send({ t: 'mark', at: state.marker });
}
$('mapPreview').addEventListener('click', (e) => { markAt($<HTMLCanvasElement>('mapPreview'), e); paintPreview(); });
// the plane's flight over a map (S px across), where the plane is now, and the landing markers
function drawDrop(ctx: CanvasRenderingContext2D, S: number, line: ReturnType<typeof busLine> | null, plane: { x: number; z: number; dx: number; dz: number } | null, big: boolean) {
  const k = S / (MAP_HALF * 2), X = (x: number) => (x + MAP_HALF) * k, Y = (z: number) => (z + MAP_HALF) * k;
  if (line) {
    const x1 = line.x + line.dx * BUS.len, z1 = line.z + line.dz * BUS.len;
    ctx.save();
    ctx.strokeStyle = '#d32336'; ctx.lineWidth = big ? 3 : 2; ctx.setLineDash(big ? [10, 7] : [6, 5]);
    ctx.beginPath(); ctx.moveTo(X(line.x), Y(line.z)); ctx.lineTo(X(x1), Y(z1)); ctx.stroke(); ctx.setLineDash([]);
    // arrowheads: which way it flies
    for (const f of [0.3, 0.55, 0.8]) {
      const ax = X(line.x + line.dx * BUS.len * f), ay = Y(line.z + line.dz * BUS.len * f), a = Math.atan2(line.dz, line.dx), h = big ? 9 : 6;
      ctx.fillStyle = '#d32336'; ctx.beginPath(); ctx.moveTo(ax + Math.cos(a) * h, ay + Math.sin(a) * h);
      ctx.lineTo(ax + Math.cos(a + 2.5) * h, ay + Math.sin(a + 2.5) * h); ctx.lineTo(ax + Math.cos(a - 2.5) * h, ay + Math.sin(a - 2.5) * h); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  if (plane) { // a little paper plane
    const a = Math.atan2(plane.dz, plane.dx), h = big ? 13 : 8;
    ctx.save(); ctx.translate(X(plane.x), Y(plane.z)); ctx.rotate(a);
    ctx.fillStyle = '#fffdf5'; ctx.strokeStyle = '#1d33b8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(h, 0); ctx.lineTo(-h * 0.8, -h * 0.7); ctx.lineTo(-h * 0.45, 0); ctx.lineTo(-h * 0.8, h * 0.7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  const pin = (at: [number, number], color: string, label: string) => {
    const x = X(at[0]), y = Y(at[1]), r = big ? 7 : 5;
    ctx.fillStyle = color; ctx.strokeStyle = '#fffdf5'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - r * 0.8, y - r * 1.6); ctx.arc(x, y - r * 1.9, r, Math.PI * 0.8, Math.PI * 0.2); ctx.closePath(); ctx.fill(); ctx.stroke();
    if (big && label) { ctx.font = '700 12px sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeText(label, x, y - r * 3.4); ctx.fillText(label, x, y - r * 3.4); }
  };
  for (const [id, at] of state.marks) if (!state.dead.has(id)) pin(at, '#13897f', label(id));
  if (state.marker) pin(state.marker, '#d32336', 'you');
}

// ---------- the drop: the flight map aboard the plane, the panel that says what to press ----------
// aboard, the map sits at the side with the plane's line; M opens it big with the cursor, a click marks where
// you want to land (and gives the mouse back to the game), M or Esc closes it
const dropMap = $<HTMLCanvasElement>('dropMap'), dropLayer = document.createElement('canvas');
let dropFor: World | null = null, lineFor: World | null = null, line: ReturnType<typeof busLine> | null = null;
function toggleMap(gesture = true) {
  state.mapOpen = !state.mapOpen;
  dropMap.classList.toggle('open', state.mapOpen);
  $('tags').style.visibility = state.mapOpen ? 'hidden' : ''; // names and tags over the world, not over the map
  if (state.mapOpen) input.unlock(); else input.lock(gesture);
}
dropMap.addEventListener('mousedown', (e) => { if (!state.mapOpen) return; e.stopPropagation(); markAt(dropMap, e); toggleMap(); });
addEventListener('mousedown', () => { if (state.mapOpen) toggleMap(); }); // a click off the map closes it
function drawDropMap() {
  const w = game.world, ctx = dropMap.getContext('2d')!, S = dropMap.width;
  if (!w) return;
  if (dropFor !== w) { dropFor = w; dropLayer.width = S; dropLayer.height = S; drawIsland(dropLayer.getContext('2d')!, w, S, true); }
  ctx.clearRect(0, 0, S, S); ctx.drawImage(dropLayer, 0, 0);
  drawDrop(ctx, S, line, game.busNow, true);
  if (!game.me?.bus) { // on the ground: the storm, your mates and you
    const k = S / (MAP_HALF * 2), X = (x: number) => (x + MAP_HALF) * k, Y = (z: number) => (z + MAP_HALF) * k, g = game.ring;
    ctx.lineWidth = 3; ctx.strokeStyle = '#d32336'; ctx.beginPath(); ctx.arc(X(g.x), Y(g.y), Math.max(0.5, g.r * k), 0, Math.PI * 2); ctx.stroke();
    if (g.nr > 0) { ctx.strokeStyle = '#1d33b8'; ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.arc(X(g.nx), Y(g.ny), g.nr * k, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    for (const id of game.mates) { const o = game.infoOf(id); if (!o || state.dead.has(id)) continue; ctx.fillStyle = '#13897f'; ctx.strokeStyle = '#fffdf5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(o[1]), Y(o[3]), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    const me = game.me;
    if (me && game.self?.alive) { ctx.save(); ctx.translate(clamp(X(me.x), 12, S - 12), clamp(Y(me.z), 12, S - 12)); ctx.rotate(-input.yaw); ctx.fillStyle = '#d32336'; ctx.strokeStyle = '#fffdf5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 8); ctx.lineTo(0, 3); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); }
  }
  if (!state.marker) { ctx.font = '700 22px Caveat, cursive'; ctx.textAlign = 'center'; ctx.fillStyle = '#1d33b8'; ctx.fillText(!game.me?.bus ? 'click to mark a spot for your squad · M closes' : state.mapOpen ? 'click where you want to land' : 'M · mark where you want to land', S / 2, S - 16); }
}
// what to press right now, aboard and on the way down, with the countdown and how high you are
function dropFrame() {
  const me = game.me, w = game.world, alive = !!game.self?.alive;
  if (w && lineFor !== w) { lineFor = w; line = busLine(w); }
  const aboard = alive && !!me?.bus, falling = alive && !!me && !me.bus && me.gliding && !me.ride;
  $('dropHud').classList.toggle('hidden', (!aboard && !falling) || state.mapOpen);
  dropMap.classList.toggle('hidden', !aboard && !state.mapOpen);
  if (state.mapOpen && !alive) { state.mapOpen = false; dropMap.classList.remove('open'); $('tags').style.visibility = ''; $('pause').classList.remove('hidden'); } // died with the map open: click to carry on
  if (aboard && line && me) {
    const left = Math.max(0, (BUS.len - ((me.x - line.x) * line.dx + (me.z - line.z) * line.dz)) / BUS.speed);
    setHTML($('dropHud'), `<div class="big"><kbd>CLICK</kbd> ANYWHERE or <kbd>SPACE</kbd> to jump</div>`
      + `<div class="sub">the plane throws you out in <b>${Math.ceil(left)} s</b> · <kbd>M</kbd> map${state.marker ? ` · your mark ${Math.round(Math.hypot(state.marker[0] - me.x, state.marker[1] - me.z))} m away` : ': mark where you want to land'}</div>`);
  } else if (falling && me && w) {
    const h = Math.max(0, Math.round(me.y - w.groundAt(me.x, me.z, me.y)));
    setHTML($('dropHud'), me.fall
      ? `<div class="big"><kbd>SPACE</kbd> to open your glider</div><div class="sub">it opens by itself low down · look down to fall faster</div><div class="alt">${h} m</div>`
      : `<div class="sub">gliding · <kbd>W</kbd> faster · <kbd>S</kbd> brake · <kbd>A</kbd><kbd>D</kbd> turn · look down to dive</div><div class="alt">${h} m</div>`);
  }
  // your marker in the world: a pin over the spot while you're on the way down
  const tag = $('markTag'), m = state.marker, show = !!m && !!me && alive && (!!me.bus || me.gliding) && !!w;
  tag.classList.toggle('hidden', !show);
  if (show && m && me && w) {
    const at = game.screenAt(m[0], w.groundAt(m[0], m[1], 400) + 2, m[1]);
    if (!at) tag.classList.add('hidden');
    else { tag.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`; setText(tag, `▼ ${Math.round(Math.hypot(m[0] - me.x, m[1] - me.z))} m`); }
  }
}

// ---------- minimap ----------
const mini = $<HTMLCanvasElement>('minimap').getContext('2d')!;
const islandLayer = document.createElement('canvas');
let islandFor: World | null = null;
function drawMinimap() {
  const S = 170, k = S / (MAP_HALF * 2), toX = (x: number) => (x + MAP_HALF) * k, toY = (z: number) => (z + MAP_HALF) * k;
  mini.clearRect(0, 0, S, S);
  // the island itself never changes during a match: draw it once, then just copy it
  if (game.world && islandFor !== game.world) {
    islandFor = game.world;
    islandLayer.width = S; islandLayer.height = S;
    drawIsland(islandLayer.getContext('2d')!, game.world, S, false);
  }
  if (game.world) mini.drawImage(islandLayer, 0, 0);
  const g = game.ring;
  mini.strokeStyle = '#d32336'; mini.lineWidth = 2;
  mini.beginPath(); mini.arc(toX(g.x), toY(g.y), Math.max(0.5, g.r * k), 0, Math.PI * 2); mini.stroke();
  if (g.nr > 0) { mini.strokeStyle = '#1d33b8'; mini.setLineDash([4, 4]); mini.beginPath(); mini.arc(toX(g.nx), toY(g.ny), g.nr * k, 0, Math.PI * 2); mini.stroke(); mini.setLineDash([]); }
  for (const id of game.mates) {
    const o = game.infoOf(id);
    if (!o || state.dead.has(id)) continue;
    mini.fillStyle = '#13897f'; mini.strokeStyle = '#fffdf5'; mini.lineWidth = 1.5;
    mini.beginPath(); mini.arc(toX(o[1]), toY(o[3]), 4, 0, Math.PI * 2); mini.fill(); mini.stroke();
  }
  // vehicles near you, and supply drops anywhere
  for (const v of game.vehiclesNow) {
    mini.fillStyle = v[8] ? '#d32336' : '#2b2f3a';
    const s = v[1] === 0 || v[1] === 3 ? 2.5 : 3.5; // aircraft are crosses, ground vehicles bars, a tank a fat block
    mini.fillRect(toX(v[2]) - s, toY(v[4]) - s / 2, s * 2, v[1] === 4 ? s * 1.6 : s);
    if (v[1] === 1 || v[1] === 2) mini.fillRect(toX(v[2]) - s / 2, toY(v[4]) - s, s, s * 2);
  }
  if (game.busNow || state.marker || state.marks.size) drawDrop(mini, S, game.busNow ? line : null, game.busNow, false); // the plane's line while it flies, the landing marks
  for (const d of game.drops) { mini.fillStyle = '#e8a317'; mini.strokeStyle = '#2b2f3a'; mini.lineWidth = 1.5; mini.beginPath(); mini.arc(toX(d.x), toY(d.z), 5, 0, Math.PI * 2); mini.fill(); mini.stroke(); }
  if (game.self && !game.self.alive) {
    const cam = game.ink.camera.position;
    mini.strokeStyle = '#d32336'; mini.lineWidth = 2; mini.beginPath(); mini.arc(toX(cam.x), toY(cam.z), 5, 0, Math.PI * 2); mini.stroke();
  }
  const me = game.me;
  if (me && game.self?.alive) {
    mini.save(); mini.translate(clamp(toX(me.x), 8, S - 8), clamp(toY(me.z), 8, S - 8)); mini.rotate(-input.yaw); // (kept inside the frame: at the island's edge the arrow was cut off)
    mini.fillStyle = '#d32336'; mini.beginPath(); mini.moveTo(0, -7); mini.lineTo(5, 5); mini.lineTo(0, 2); mini.lineTo(-5, 5); mini.closePath(); mini.fill();
    mini.restore();
  }
}

// ---------- messages ----------
// the socket dropped: say so (a frozen match with no word was all you got); the reconnect's hello
// brings you back to the lobby
let lostAt = 0;
net.onClose = () => {
  if (!lostAt) lostAt = Date.now();
  state.authed = false; state.connected = false; updatePlay();
  if (prematch.isOpen) { prematch.close(); state.after = null; }
  if (state.screen === 'game' && !state.over) { input.unlock(); banner('Connection lost', 'reconnecting to the game server…'); }
  else $('me').textContent = 'Connection to the game server lost · reconnecting…';
};
net.on((m: ServerMsg) => {
  if (m.t === 'hello' && lostAt) {
    if (state.screen !== 'lobby') { $('banner').classList.add('hidden'); err('The connection dropped, so you left that match. You are back in the lobby.'); }
    lostAt = 0;
  }
  switch (m.t) {
    case 'hello':
      state.nonce = m.nonce; state.authed = false; state.connected = true; state.guests = m.allowGuests; updatePlay();
      $('guestBtn').classList.toggle('hidden', !m.allowGuests);
      $('guestName').classList.toggle('hidden', !m.allowGuests);
      if (state.authMode === 'guest') net.send({ t: 'guest', name: state.sentName || state.name || 'guest' });
      else if (state.authMode === 'wallet') { $('me').textContent = 'Connection lost. Connect your wallet again.'; $('me').classList.remove('on'); }
      if (state.screen !== 'lobby') show('lobby');
      break;
    case 'authed':
      state.authed = true; state.name = m.name; state.wallet = m.wallet;
      $('me').textContent = `${m.name}${state.authMode === 'guest' ? ' (guest)' : ''}${m.eligible ? ` · ${m.eligible}` : m.wallet && state.authMode !== 'guest' ? ' · scoring points for the pot' : ''}`;
      $('me').classList.add('on');
      // signed in with Phantom: the button says so (the profile chip up top has the details)
      if (state.authMode === 'wallet') {
        $('connectBtn').textContent = `${walletName} connected ✓`; $<HTMLButtonElement>('connectBtn').disabled = true;
        // signed in under the short wallet address: put back the name this wallet chose last time
        if (m.wallet && m.name.includes('…')) { try { const saved = localStorage.getItem(`pr_wname:${m.wallet}`); if (saved) net.send({ t: 'name', name: saved }); } catch { /* storage blocked */ } }
      }
      updatePlay();
      if (state.after && prematch.isOpen) queueFor(state.after); // signed in from the pre-match screen: straight into the queue
      break;
    case 'error': err(m.msg); $('queueInfo').textContent = ''; if (prematch.isOpen) { prematch.close(); state.after = null; } break;
    case 'pot': renderPot(m.pot); break;
    case 'profile': profile = m.profile; renderProfile(); if (!$('victory').classList.contains('hidden')) victoryStats(); break;
    case 'inflow': {
      const v = sol(m.inflow.lamports); jar.inflow(v); miniJar.inflow(v); toast(`+${v.toFixed(3)} SOL · ${m.inflow.source}`);
      if (v >= 0.3) ticker(`<span class="gold">🐷 <b>+${v.toFixed(2)} SOL</b> ${esc(m.inflow.source)}</span>`);
      break;
    }
    case 'lobby': {
      const before = new Map(lobbyRooms.map((r) => [r.id, r.state]));
      for (const r of m.rooms) if (r.state === 'live' && before.get(r.id) && before.get(r.id) !== 'live') ticker(`<span class="red">a ${MODES[r.mode].name.toLowerCase()} room just dropped · <b>${r.n} players</b></span>`);
      lobbyRooms = m.rooms; renderRooms(m.rooms);
      break;
    }
    case 'settled': {
      if (state.pot?.live === false) break; // nothing was paid: no pot before launch
      const s = m.settled;
      $('lastDraw').className = 'draw-sum';
      // which hour it was: the pot that closed at HH:00, your local time
      const hour = new Date(epochEnd(s.epoch)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('lastDraw').innerHTML = s.winners.length
        ? `<div>The ${hour} pot · <b>${fmtSol(sol(s.potLamports))}</b></div><ol class="ledger">${s.winners.slice(0, 6).map((w) => `<li><span class="name"><span><i class="crown">♛</i> ${esc(w.name || w.wallet.slice(0, 6))}</span></span><span class="marks"><em>${fmtSol(sol(w.lamports))}</em></span></li>`).join('')}</ol><div class="root">merkle root ${s.merkleRoot}</div>`
        : `The ${hour} pot: nobody scored, so ${fmtSol(sol(s.rollover))} rolls into the next one.`;
      if (s.winners.length) ticker(`<span class="gold">♛ <b>${esc(s.winners.map((w) => w.name || w.wallet.slice(0, 6)).join(' + '))}</b> took the ${hour} pot · ${fmtSol(sol(s.winners.reduce((t, w) => t + BigInt(w.lamports), 0n)))}</span>`);
      break;
    }
    case 'queued': $('queueInfo').textContent = `In queue, position ${m.position}`; prematch.busy(`In queue · #${m.position}`); break;
    case 'room': {
      state.seats = m.seats; state.you = m.you; state.startsAt = m.startsAt; state.phase = m.state;
      $('roomId').textContent = m.roomId.toUpperCase();
      $('queueInfo').textContent = '';
      state.roomMode = m.mode;
      $('roomMode').textContent = MODES[m.mode].name; $('roomMode').className = `mode-tag ${m.mode}`;
      $('roomFoot').textContent = m.mode === 'solo' ? `100 drop in every match: empty spots are filled with bots (they never score). A win is ${POINTS.win.solo} points, top ${topPlaces('solo')} +${POINTS.top}, every kill +${POINTS.kill}.`
        : `100 drop in every match (bots fill the empty spots), in ${m.mode === 'duo' ? 'teams of 2' : 'squads of 4'}. A win is ${POINTS.win[m.mode]} points each, top ${topPlaces(m.mode)} teams +${POINTS.top}, every kill +${POINTS.kill}. Knocked teammates can be picked up.`;
      if (m.state === 'waiting' || m.state === 'countdown') { if (state.screen !== 'waiting') shownSeats = new Set(); show('waiting'); renderSeats(); drawPreview(m.seed); }
      if (m.state === 'live') {
        state.over = false; state.aimed = false; state.dropped = false; state.dead = new Set(); howtoDone = false;
        tipsSeen = new Set(); training.reset(); Object.assign(learn, { look: 0, walk: 0, sprint: 0, glided: false, mats: 0, combat: 0 });
        inventory.reset(); announcer.reset();
        game.setRoom(m.seed, m.seats, m.you, preWorld ?? undefined); preWorld = null;
        state.marks = new Map(); state.mapOpen = false; dropMap.classList.remove('open');
        if (state.marker) net.send({ t: 'mark', at: state.marker }); // marked on the waiting room's map
        $('feed').innerHTML = '';
        // squad voice with your teammates (online matches; the demo's teammates are bots)
        if (!DEMO && m.mode !== 'solo') { voice.start(m.you, [...game.mates], (to, data) => net.send({ t: 'rtc', to, data })); setTimeout(() => hint('hold V to talk to your squad · U mutes them', 3500), 4000); }
        show('game');
        input.yaw = 0; input.pitch = -0.5;
        if (input.locked) menu.hide(); else menu.show('drop'); // the Drop in button takes the mouse (needs a click)
      }
      break;
    }
    case 'rtc': void voice.onSignal(m.from, m.data); break;
    case 'mark': if (m.at) state.marks.set(m.from, m.at); else state.marks.delete(m.from); break;
    case 'snap':
      game.onSnap(m);
      if (m.self && !state.aimed) { input.yaw = m.self.yaw; input.pitch = m.self.pitch; state.aimed = true; }
      break;
    case 'event': {
      if (m.kind === 'hit') {
        if (m.by === state.you || m.victim === state.you) learn.combat = performance.now();
        if (m.by === state.you) {
          hitmarker(m.head); damageNumber(m.victim, m.dmg, m.head, m.shield); sfx.hit(m.head); game.markHit(m.victim);
          if (m.head) game.kick(0.45);
          if (m.broke) { const el = $('shieldbreak'); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); sfx.shieldBreak(); hint('shield broken · push now', 1200); }
        }
        if (m.victim === state.you) { damageFrom(m.by); bloodHit(m.dmg); sfx.hurt(); if (m.broke) armorLost(); }
        break;
      }
      if (m.kind === 'boom') {
        game.onBoom(m.x, m.y, m.z, m.r, m.nuke);
        const cam = game.ink.camera.position, d = Math.hypot(m.x - cam.x, m.z - cam.z);
        sfx.boom(m.nuke, d);
        if (m.nuke && d < 220) { const f = $('flash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60); }
        break;
      }
      if (m.kind === 'zap') { // a spell went off: a purple burst, a crackle
        game.onZap(m.x, m.y, m.z);
        const cam = game.ink.camera.position; sfx.zap(Math.hypot(m.x - cam.x, m.z - cam.z));
        break;
      }
      if (m.kind === 'slash') { // someone else's blade (ours was heard when we swung)
        if (m.by !== state.you) { const at = game.positionOf(m.by), cam = game.ink.camera.position; if (at) sfx.shot('blade', Math.max(1, Math.hypot(at.x - cam.x, at.z - cam.z))); }
        break;
      }
      if (m.kind === 'build') { game.onBuild(m.id, m.boxes); break; }
      if (m.kind === 'unbuild') { game.onUnbuild(m.id); break; }
      if (m.kind === 'nuke') { sfx.siren(); feed(`<b style="color:var(--red)">☢ ${esc(label(m.by))} launched an atomic bomb</b>`, m.by === state.you); break; }
      if (m.kind === 'open') { if (m.by === state.you) sfx.open(m.golden); break; }
      if (m.kind === 'vhit') { hitmarker(false); sfx.hit(false); const v = game.vehiclesNow.find((x) => x[0] === m.vehicle); vehicleNumber(v, m.dmg); break; }
      if (m.kind === 'upgrade') { if (m.by === state.you) { hint(`weapon upgraded ${'★'.repeat(m.level)} · +${Math.round(m.level * 22)}% damage`, 2200); sfx.open(true); } break; }
      if (m.kind === 'wreck') { game.onWreck(m.add, m.kill, m.falls, m.drop); break; }
      if (m.kind === 'chop') {
        const cam = game.ink.camera.position;
        if (m.by === state.you || Math.hypot(m.x - cam.x, m.z - cam.z) < 40) sfx.chop(m.broke);
        game.onChop(m.b, m.left);
        if (m.by === state.you && m.broke) training.tick('break');
        break;
      }
      if (m.kind === 'knock') {
        const mineK = m.victim === state.you || m.by === state.you || game.mates.has(m.victim);
        feed(`<span style="color:#c98a00">⬇ ${esc(label(m.victim))}</span> <span class="by">knocked${m.by !== null ? ` by ${esc(label(m.by))}` : ''}</span>`, mineK);
        if (m.by === state.you) { hint(`${label(m.victim)} knocked · finish them or they get picked up`, 1800); sfx.hit(true); hitmarker(m.head, true); }
        if (m.victim === state.you) banner('Knocked', 'crawl to cover · a teammate can pick you up (hold E, 5 s)', false, 2200);
        else if (game.mates.has(m.victim)) hint(`teammate ${label(m.victim)} is knocked · get to them and hold E`, 2600);
        break;
      }
      if (m.kind === 'revive') {
        feed(`<span style="color:#2f9e44">⬆ ${esc(label(m.victim))}</span> <span class="by">picked up by ${esc(label(m.by))}</span>`, m.victim === state.you || m.by === state.you || game.mates.has(m.victim));
        if (m.victim === state.you) hint('back on your feet · heal up', 2000);
        if (m.by === state.you) { hint(`${label(m.victim)} is back up`, 1600); sfx.open(false); }
        break;
      }
      if (m.kind === 'drop') {
        if (!m.landed) { feed('<b style="color:#c98a00">📦 supply drop incoming</b> · legendary inside', false); hint('supply drop incoming: legendary loot, find the balloon', 2600); sfx.siren(); }
        break;
      }
      if (m.cause !== 'left') announcer.onElim(m.victim, m.by, state.you); // first blood, multi-kills, streaks
      if (m.by === state.you && m.victim !== state.you) eliminated(m.victim, !!m.head);
      state.dead.add(m.victim);
      if (m.cause !== 'left') game.onElim(m.victim, m.by);
      const mine = m.victim === state.you || m.by === state.you || game.mates.has(m.victim) || (m.by !== null && game.mates.has(m.by));
      const how = m.cause === 'ring' ? 'the storm' : m.cause === 'left' ? 'left' : m.by === null ? 'a wreck' : label(m.by);
      feed(`<s>${esc(label(m.victim))}</s> <span class="by">${m.cause === 'shot' ? (m.head ? 'headshot by ' : 'by ') : m.cause === 'ring' ? 'to ' : m.cause === 'ram' ? 'run over by ' : m.cause === 'boom' ? 'blown up by ' : ''}${esc(how)}</span>`, mine);
      if (m.victim === state.you) {
        const mates = matesAlive();
        game.watch = mates[0] ?? m.by;
        banner('Eliminated', mates.length ? `your team is still in it · watching ${label(mates[0])}` : `#${m.left + 1} of ${state.seats.length} · spectating`, false, 3000);
      } else if (game.mates.has(m.victim)) hint(`teammate ${label(m.victim)} was eliminated`, 2200);
      break;
    }
    case 'result': {
      state.over = true;
      input.unlock(); menu.hide();
      const winners = m.winners ?? (m.winner === null ? [] : [m.winner]);
      const won = winners.includes(state.you), team = winners.length > 1, mine = m.points?.[state.you] ?? 0;
      const word = !winners.length ? 'Draw' : won ? 'Victory!' : team ? `Team ${label(winners[0])} wins` : `${label(winners[0])} wins`;
      const sub = !m.awarded ? (mine ? `${mine} points · not counted: not enough verified wallets in this match` : '')
        : mine ? `+${mine} points this round · the top 3 share the round prize${state.authMode === 'guest' ? ' (connect a wallet to keep them)' : ''}` : 'no points this time: place top 10 or get a kill';
      if (winners.length) ticker(`<span class="gold">♛ <b>${esc(winners.map((w) => seatOf(w)?.name ?? label(w)).join(' + '))}</b> won a ${MODES[state.roomMode].name.toLowerCase()} match</span>`);
      if (won) victory(team, mine, sub); else banner(word, sub, won);
      voice.stop();
      setTimeout(() => { $('banner').classList.add('hidden'); $('victory').classList.add('hidden'); stopConfetti(); show('lobby'); }, RESULT_MS);
      break;
    }
  }
});

// ---------- KING OF THE HILL · VICTORY ----------
// the win: a full-screen card, gold and crowns raining down, a fanfare, and your running total of wins
// when a wallet is connected (the server's updated profile lands a moment after the result)
let vPoints = 0, vKills = 0;
function victory(team: boolean, points: number, sub: string) {
  vPoints = points; vKills = game.self?.kills ?? 0;
  setHTML($('vSub'), `${team ? 'Your squad holds the hill' : 'You hold the hill'} · last ${team ? 'team' : 'one'} standing of ${state.seats.length}`);
  victoryStats(sub);
  $('victory').classList.remove('hidden');
  startConfetti();
  sfx.fanfare();
}
function victoryStats(sub?: string) {
  const wins = profile ? profile.wins : null;
  setHTML($('vStats'), `<div><b>${vKills}</b><span>kills</span></div><div><b>+${vPoints}</b><span>points this round</span></div>`
    + (wins !== null ? `<div class="gold"><b>${wins}</b><span>wins on your wallet</span></div>` : `<div><b>♛</b><span>connect Phantom to keep your wins</span></div>`)
    + (sub ? `<p>${esc(sub)}</p>` : ''));
}
let confettiRaf = 0;
function startConfetti() {
  const c = $<HTMLCanvasElement>('confetti'), ctx = c.getContext('2d')!;
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  const COLORS = ['#ffd23f', '#f2b51c', '#d32336', '#1d33b8', '#fff6c8', '#13897f'];
  const bits = Array.from({ length: 220 }, () => ({ x: Math.random() * innerWidth, y: -Math.random() * innerHeight, vx: (Math.random() - 0.5) * 60, vy: 80 + Math.random() * 160, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 8, s: 6 + Math.random() * 9, k: Math.random() < 0.18 ? 2 : Math.random() < 0.5 ? 1 : 0, col: COLORS[Math.floor(Math.random() * COLORS.length)] }));
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.x += b.vx * dt + Math.sin(now / 400 + b.r) * 0.6; b.y += b.vy * dt; b.r += b.vr * dt;
      if (b.y > innerHeight + 20) { b.y = -20; b.x = Math.random() * innerWidth; }
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r);
      if (b.k === 2) { ctx.font = `${b.s * 2.2}px serif`; ctx.fillStyle = '#e8a317'; ctx.fillText('♛', -b.s, b.s); } // crowns
      else if (b.k === 1) { ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#1d33b8'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(0, 0, b.s * 0.7, b.s * 0.7 * Math.abs(Math.cos(b.r * 2)) + 1, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } // coins
      else { ctx.fillStyle = b.col; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); } // paper strips
      ctx.restore();
    }
    confettiRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(confettiRaf); confettiRaf = requestAnimationFrame(tick);
}
function stopConfetti() { cancelAnimationFrame(confettiRaf); confettiRaf = 0; }

// ---------- teaching while you play ----------
// the training list ticks itself off from what you actually do; the ammo line under the crosshair
// says when to reload and how the minigun winds up
function learnFrame(me: NonNullable<typeof game.self>, dt: number, w: string | null, mag: number) {
  const body = game.me, def = w ? WEAPONS[w as keyof typeof WEAPONS] : null;
  let tip = '';
  training.setAlive(me.alive);
  if (me.alive && body) {
    learn.look += Math.min(0.3, Math.abs(input.yaw - learn.yaw) + Math.abs(input.pitch - learn.pitch)); // (the spawn heading snapping in is not you looking)
    learn.yaw = input.yaw; learn.pitch = input.pitch;
    if (learn.look > 2.5) training.tick('look');
    if (body.gliding) learn.glided = true;
    else if (learn.glided && body.grounded) training.tick('glide');
    const step = Math.hypot(body.x - learn.x, body.z - learn.z);
    learn.x = body.x; learn.z = body.z;
    if (body.grounded && !body.ride && step < 2) learn.walk += step;
    if (learn.walk > 8) training.tick('move');
    if (body.grounded && !body.ride && Math.hypot(body.vx, body.vz) > 7.4) learn.sprint += dt;
    if (learn.sprint > 1) training.tick('sprint');
    if (learn.grounded && !body.grounded && body.vy > 3 && !body.ride && !body.gliding) training.tick('jump');
    learn.grounded = body.grounded;
    if (body.slideT > 0) training.tick('slide');
    if (def && input.fire && mag > 0 && !body.gliding) training.tick('shoot');
    if (def && input.aim) training.tick('ads');
    if (me.reloadT > 0) training.tick('reload');
    if (me.axe) training.tick('pick');
    if (me.axe && me.mats < learn.mats) training.tick('build');
    learn.mats = me.mats;
    if (me.use) training.tick('heal');
    training.update();
    // first time with a gun, and with the minigun: how it works
    if (def && w !== 'minigun') tipOnce('gun', 'left click shoot · right click aim · R reload', 3500);
    if (w === 'guided') tipOnce('guided', 'guided missile · fire it, then steer it with your crosshair: it flies to whatever you point at while you hold the launcher', 6500, 4);
    if (w === 'blade') tipOnce('blade', 'plasma blade · get close and left click: it cuts everyone in front of you, and through walls', 6000, 4);
    if (w === 'wand') tipOnce('wand', 'magic wand · the spell hurts and throws whoever it hits back through the air', 6000, 4);
    if (w === 'minigun') tipOnce('minigun', `minigun · hold left click: it spins up, then shreds · ${def!.reload} s reload: do it in cover`, 6000, 4);
    // a quiet moment with a half-empty gun: that is when to reload
    if (def && def.mag > 4 && mag < def.mag / 2 && me.reloadT === 0 && performance.now() - learn.combat > 3500 && !body.gliding) tipOnce('calm', 'quiet moment · reload now (R) so the next fight starts full', 3500, 4);
    // under the crosshair: reloading, empty, spinning up, low
    if (def && !body.gliding && (!body.ride || body.seat > 0)) {
      if (me.reloadT > 0) tip = `<span class="soft">reloading ${me.reloadT.toFixed(1)} s</span><div class="meter"><i style="width:${Math.round(Math.max(0, 1 - me.reloadT / def.reload) * 100)}%"></i></div>`;
      else if (mag === 0) tip = '<span class="red">EMPTY</span><span class="soft">press <kbd>R</kbd> to reload</span>';
      else if (def.spinUp && game.spinK > 0 && game.spinK < 1) tip = `<span class="soft">spinning up…</span><div class="meter spin"><i style="width:${Math.round(game.spinK * 100)}%"></i></div>`;
      else if (def.mag > 4 && mag <= Math.floor(def.mag * 0.25)) tip = '<span class="soft">low ammo · <kbd>R</kbd> reload</span>';
    }
  }
  setHTML($('ammoTip'), tip);
}

// ---------- input upload, 30 Hz ----------
// 30 inputs per second of real time, whatever the timer does: a busy main thread (a heavy frame, a slow
// machine) delays setInterval, and a client sending fewer inputs than the server runs ticks fell out
// of step with it (rubber-banding, or a frozen player). Missed ticks are caught up, a few at a time.
let inputClock = performance.now();
const STILL = { fwd: 0, strafe: 0, sprint: false, grapple: false, jump: false, slide: false, reload: false, slot: 0, up: 0, interact: false, perk: false, item: 0, hold: false, build: false, fire: false, aim: false };
setInterval(() => {
  const now = performance.now();
  let due = Math.floor((now - inputClock) / (1000 / TICK_HZ));
  if (due <= 0) return;
  if (due > 6) { inputClock = now - 1000 / TICK_HZ; due = 1; } // a long freeze: the server resyncs, don't flood it
  inputClock += due * (1000 / TICK_HZ);
  if (state.screen !== 'game') return;
  for (let k = 0; k < due; k++) {
    // paused (Esc, alt-tab, a permission prompt): keep the server fed with standing still, so the
    // character doesn't keep running and shooting on the last keys held
    const s = input.locked ? input.sample() : { ...STILL, yaw: input.yaw, pitch: input.pitch };
    if (game.self && !game.self.alive && !state.over) { spectatorTick(s); return; }
    const inp = game.tick(s);
    if (inp) net.send({ t: 'in', ...inp });
  }
}, 1000 / TICK_HZ / 2);

// ---------- spectating ----------
function matesAlive() { return [...game.mates].filter((id) => !state.dead.has(id)); }
function spectatorTick(s: ReturnType<FpsInput['sample']>) {
  // click = next player, right click = previous (teammates only while one is alive)
  if (s.fire && !state.specFire) { game.free = null; net.send({ t: 'spec', dir: 1 }); }
  if (s.aim && !state.specAim) { game.free = null; net.send({ t: 'spec', dir: -1 }); }
  state.specFire = s.fire; state.specAim = s.aim;
  if (game.free) {
    game.fly({ ...s, jump: input.isDown('Space'), slide: input.isDown('KeyC') || input.isDown('ControlLeft') }, input.yaw, input.pitch, 1 / TICK_HZ);
    if ((state.freeSendT += 1) >= 8) { state.freeSendT = 0; net.send({ t: 'spec', at: [Math.round(game.free.x), Math.round(game.free.z)] }); }
  }
}
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || state.screen !== 'game' || state.over || !game.self || game.self.alive) return;
  if (game.free) { game.free = null; net.send({ t: 'spec', at: null }); return; }
  if (matesAlive().length) return hint('free camera unlocks when your whole team is out', 2200);
  game.startFree(); state.freeSendT = 8;
});

// ---------- frame loop ----------
let last = performance.now();
let miniT = 0;
// frame-time governor: if frames run long, render fewer pixels; win them back when it is smooth
let perfT = 0, perfN = 0;
function govern(dt: number) {
  perfT += dt; perfN++;
  if (perfT < 1.5) return;
  const avg = (perfT / perfN) * 1000;
  perfT = 0; perfN = 0;
  if (avg > 21) game.ink.setQuality(game.ink.quality - 0.1);
  else if (avg < 14) game.ink.setQuality(Math.min(settings.renderScale, game.ink.quality + 0.05)); // never above the resolution setting
}
function frame(now: number) {
  const raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
  if (state.screen === 'game') govern(raw);
  if (state.screen === 'lobby') {
    const onLanding = document.body.classList.contains('landing-on');
    if (!onLanding) jar.frame(dt);
    // (under the landing page the lobby scene is hidden: drawing it anyway took the frames the video needed, ~1 fps)
    if (flyVisible && !onLanding) { lobby.frame(dt); setText($('flyCaption'), lobby.caption); }
    if (state.pot) {
      const target = sol(state.pot.lamports);
      state.potShown += (target - state.potShown) * Math.min(1, dt * 3);
      if (Math.abs(target - state.potShown) < 0.0005) state.potShown = target;
      // dollars big (people think in dollars), SOL small underneath
      const usd = state.pot.solUsd;
      if (usd) {
        const d = target * usd;
        odometer($('potAmount'), d.toLocaleString('en-US', { minimumFractionDigits: d < 1000 ? 2 : 0, maximumFractionDigits: d < 1000 ? 2 : 0 }), '$');
        setText($('potSol'), `${target.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} SOL`);
      } else { odometer($('potAmount'), target.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })); setText($('potSol'), ''); }
      // what this round's top three would take from the pig as it stands (4% of it, 60/25/15)
      const places = podiumOf(target * (usd || 1)), fmt = (v: number) => usd ? `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 2 : 0 })}` : `${v.toFixed(3)} SOL`;
      setHTML($('podium'), `<span>🥇 ${fmt(places[0])}</span><span>🥈 ${fmt(places[1])}</span><span>🥉 ${fmt(places[2])}</span>`);
      const closing = Date.now() >= state.pot.closeFrom;
      setText($('candle'), closing ? 'scoring can close any minute now' : 'scoring closes at a random minute in the last 10');
      $('candle').classList.toggle('hot', closing);
      const [hh, mm, ss] = hms(state.pot.epochEndMs - Date.now()).split(':');
      const cd = $('countdown').querySelectorAll('b');
      if (cd[0].textContent !== hh) cd[0].textContent = hh;
      if (cd[1].textContent !== mm) cd[1].textContent = mm;
      if (cd[2].textContent !== ss) { cd[2].textContent = ss; cd[2].classList.remove('tick'); void cd[2].offsetWidth; cd[2].classList.add('tick'); }
      // the 4-hour round as a bar filling toward the payout
      const left = Math.max(0, state.pot.epochEndMs - Date.now()), k = 1 - left / EPOCH_MS;
      $('hourFill').style.width = `${(Math.max(0, Math.min(1, k)) * 100).toFixed(1)}%`;
      const mins = Math.ceil(left / 60_000);
      setText($('hourLabel'), left < 60_000 ? 'PAYING OUT…' : mins >= 60 ? `${Math.floor(mins / 60)}H ${String(mins % 60).padStart(2, '0')}M TO THE PAYOUT` : `${mins} MIN TO THE PAYOUT`);
    }
  } else if (state.screen === 'waiting') {
    // the bottom card: a new lesson every 6 s while you wait
    if (performance.now() - roomTipAt > 6000) { roomTipAt = performance.now(); setHTML($('roomTip'), tipCardHTML(roomTipI++)); }
    const n = state.seats.length, counting = state.phase === 'countdown' && state.startsAt;
    $('waitStatus').innerHTML = lostAt ? '<small>connection lost</small>reconnecting…' : counting
      ? `<small>dropping in</small>${Math.max(0, Math.ceil((state.startsAt! - Date.now()) / 1000))}`
      : `<small>waiting for players</small>${n}<span class="of">/${ROOM_MAX}</span>`;
  } else {
    game.frame(dt, { yaw: input.yaw, pitch: input.pitch, aim: input.aim });
    const me = game.self;
    if (me) {
      const w = me.axe ? null : me.slots[me.cur], def = w ? WEAPONS[w] : null, mag = me.mags[me.cur] ?? 0;
      $('hpFill').style.width = `${(me.hp / PLAYER_HP) * 100}%`;
      setText($('hpNum'), String(me.hp));
      $('shFill').style.width = `${(me.shield / SHIELD_MAX) * 100}%`;
      setText($('shNum'), String(me.shield));
      document.querySelector('.hud-bl')!.classList.toggle('low', me.hp <= PLAYER_HP * 0.3);
      for (const sel of ['.hud-bl', '#hotbar']) { const el = document.querySelector(sel) as HTMLElement | null; if (el) el.style.visibility = me.alive ? 'visible' : 'hidden'; }
      setText($('ammo'), def ? (def.melee ? '∞' : String(mag)) : '–'); // a blade has no ammo
      setText($('ammoMax'), def && !def.melee ? `/${def.ammo ? me.ammo?.[def.ammo] ?? 0 : def.mag}` : ''); // what's left to reload with
      $('reloading').classList.toggle('hidden', me.reloadT <= 0);
      setHTML($('magTally'), def && !def.melee ? Array.from({ length: Math.min(def.mag, 30) }, (_, i) => `<i class="${i < mag ? '' : 'spent'}"></i>`).join('') : '');
      // the hotbar (hidden in a vehicle, where the vehicle card takes the bottom of the screen)
      const hb = $('hotbar');
      hb.classList.toggle('hidden', !me.alive || !!game.me?.ride);
      if (me.alive && !game.me?.ride) setHTML(hb, hotbarHTML(me));
      inventory.update(me);
      // one bar for anything that takes time: healing, bleeding out, being picked up, picking up
      const bar = me.use ? { label: ITEMS[me.use.item].name, k: 1 - me.use.t / ITEMS[me.use.item].use, cls: '' }
        : me.reviving > 0 ? { label: 'reviving teammate…', k: me.reviving / KNOCK.revive, cls: 'revive' }
        : me.down > 0 && me.reviveT > 0 ? { label: 'being picked up…', k: me.reviveT / KNOCK.revive, cls: 'revive' }
        : me.down > 0 ? { label: `KNOCKED · bleeding out ${Math.ceil(me.down)}s`, k: me.down / KNOCK.bleed, cls: 'bleed' } : null;
      // how to play: once you land, point at the controls card (the training list is already up)
      if (!howtoDone && me.alive && game.me && !game.me.gliding) { howtoDone = true; tipOnce('controls', 'H · all the controls  ·  T · hide the training list', 3500); }
      if (howtoAt && performance.now() - howtoAt > 20000) closeHowto();
      learnFrame(me, dt, w, mag);
      // the pickaxe: say what the buttons do and what you're aiming at
      const axeOn = me.alive && me.axe && !game.me?.ride && !me.bus && !me.gliding; // (not aboard the plane or in the air: nothing to break there)
      $('axeHint').classList.toggle('hidden', !axeOn);
      $('blockHits').classList.toggle('hidden', !axeOn || !game.axeAim);
      if (axeOn && (input.aim || input.isDown('KeyB')) && me.mats < BUILD.cost) hint('not enough material ▦ · break something with left click first', 1200);
      if (axeOn) {
        const aim = game.axeAim;
        // under the crosshair: the hits this block still takes (or that it can't be broken)
        setHTML($('blockHits'), !aim ? '' : aim.hard ? '<b class="no">⛔ unbreakable</b>' : `<span class="pips">${Array.from({ length: aim.total }, (_, i) => `<i class="${i < aim.hits ? 'on' : ''}"></i>`).join('')}</span><small>${aim.hits} hit${aim.hits > 1 ? 's' : ''} · ${aim.mat}</small>`);
        // short: it sits between your health and the hotbar
        setHTML($('axeHint'), `<span class="red"><kbd>left click</kbd> break${aim ? ` ${aim.hard ? '<span class="dim">(rock)</span>' : aim.mat}` : ''}</span>`
          + `<span class="blue ${me.mats < BUILD.cost ? 'dim' : ''}"><kbd>right click</kbd> build ▦${BUILD.cost}</span><span><b>▦ ${me.mats}</b></span>${me.slots.some(Boolean) ? '<span class="dim"><kbd>1</kbd> gun</span>' : ''}`);
      }
      $('useBar').classList.toggle('hidden', !bar || !me.alive);
      if (bar) { setText($('useLabel'), bar.label); $('useFill').style.width = `${bar.k * 100}%`; $('useBar').dataset.kind = bar.cls; }
      document.body.classList.toggle('knocked', me.alive && me.down > 0);
      setHTML($('prompt'), game.prompt);
      setText($('killCount'), String(me.kills));
      const body = game.me;
      const scoped = input.aim && !!w && WEAPONS[w].sight === 'scope' && me.alive;
      // aiming down sights in first person: the gun's own sight over the middle of the screen (irons and red
      // dots replace the crosshair; a launcher's ring sits around it and hides nothing)
      const sight = me.alive && w && !scoped && game.aimK > 0.7 ? WEAPONS[w].sight : null, overlay = sight === 'iron' || sight === 'dot' || sight === 'ring';
      $('sight').className = `sight ${overlay ? sight : 'hidden'}`;
      const tank = body?.ride === 5 && !body.seat; // a tank's gunner sight: a steady crosshair (the cannon has no spread)
      const spread = tank ? 0.006 : body && w ? spreadFor(body, w, input.aim) : 0.02;
      $('crosshair').style.setProperty('--s', `${Math.round(6 + spread * 900)}px`);
      $('crosshair').style.visibility = me.alive && !scoped && sight !== 'iron' && sight !== 'dot' ? 'visible' : 'hidden';
      $('scope').classList.toggle('hidden', !scoped);
      if (body?.gliding && me.alive) tipOnce('glide', 'gliding · look down to dive, look up to float · land anywhere', 5000, 5);
    }
    // teammates: name + health, struck out when they go down
    const sq = $('squad');
    if (game.mates.size) {
      setHTML(sq, [...game.mates].map((id) => {
        const down = state.dead.has(id), o = game.infoOf(id), hp = down ? 0 : o ? Math.round((o[6] / PLAYER_HP) * 100) : 100;
        const knocked = !down && !!o && !!(o[7] & OTHER_DOWN);
        return `<div class="mate ${down ? 'down' : knocked ? 'knocked' : ''}"><span>${voice.speaking(id) ? '🔊 ' : ''}${esc(seatOf(id)?.name ?? label(id))}</span><div class="bar"><i style="width:${hp}%"></i></div></div>`;
      }).join('') + (voice.active ? `<div class="mic ${voice.talking ? 'on' : ''}">${voice.talking ? '🎙 talking' : voice.deaf ? '🔇 squad muted (U)' : '<kbd>V</kbd> talk'}</div>` : ''));
    } else setHTML(sq, '');
    const spec = !!me && !me.alive && !state.over;
    $('specBar').classList.toggle('hidden', !spec);
    if (spec) {
      const solo = !matesAlive().length;
      const who = game.free ? 'free camera' : game.watch !== null ? `${esc(label(game.watch))}${seatOf(game.watch)?.name ? ` <span style="font-weight:600">${esc(seatOf(game.watch)!.name)}</span>` : ''}` : '…';
      setHTML($('specBar'), `<div class="who-watch"><small>${game.free ? 'flying' : 'spectating'}</small>${who}</div>`
        + `<div class="keys"><kbd>LMB</kbd> next · <kbd>RMB</kbd> previous${solo ? ` · <kbd>F</kbd> ${game.free ? 'back to players' : 'free camera'}${game.free ? ' · <kbd>WASD</kbd> fly · <kbd>Space</kbd>/<kbd>C</kbd> up/down' : ''}` : ' · teammates only while one is alive'}</div>`);
    }
    // driving / flying: vehicle health, speed and what the keys do
    const ride = game.me?.ride ?? 0;
    if (ride && me?.alive && !radio.muted && !radio.on) radio.play();
    else if ((!ride || !me?.alive) && radio.on) radio.stop();
    sfx.engine(me?.alive ? ride : 0, Math.hypot(game.me?.vx ?? 0, game.me?.vz ?? 0));
    $('vehHud').classList.toggle('hidden', !ride || !me?.alive);
    if (ride && me) {
      const kind = VEHICLE_KINDS[ride - 1], def = VEHICLES[kind], hpPct = Math.max(0, Math.min(100, (me.vhp / def.hp) * 100));
      const kmh = Math.round(Math.hypot(game.me!.vx, game.me!.vy, game.me!.vz) * 3.6);
      setHTML($('vehHud'), `<div class="veh-name">${def.name}<b>${kmh}<small> km/h</small></b></div><div class="bar veh"><div style="width:${hpPct}%" class="${hpPct < 30 ? 'low' : ''}"></div></div>`
        + `<div class="veh-keys">${game.me!.seat ? '<b>passenger</b> · <kbd>LMB</kbd> shoot out of it · <kbd>G</kbd> throw · <kbd>E</kbd> hop off' : kind === 'car' || kind === 'moto' ? '<kbd>W</kbd><kbd>S</kbd> gas / brake · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Shift</kbd> boost · <kbd>Space</kbd> hop · <kbd>LMB</kbd> drive-by'
          : kind === 'tank' ? `<span class="cannon ${game.tankCd > 0 ? 'wait' : 'ready'}">${game.tankCd > 0 ? `cannon reloading ${game.tankCd.toFixed(1)}s` : 'cannon ready'}</span> · <kbd>Mouse</kbd> aim the turret · <kbd>LMB</kbd> cannon · <kbd>RMB</kbd> machine gun · <kbd>W</kbd><kbd>S</kbd> tracks · <kbd>A</kbd><kbd>D</kbd> turn`
          : kind === 'heli' ? '<kbd>WASD</kbd> fly · <kbd>Space</kbd>/<kbd>C</kbd> up / down · <kbd>Shift</kbd> fast · <kbd>LMB</kbd> nose gun'
          : '<kbd>Mouse</kbd> steer · <kbd>W</kbd><kbd>S</kbd> throttle · <kbd>Shift</kbd> afterburner · <kbd>LMB</kbd> guns · <kbd>RMB</kbd> bomb'}${game.me!.seat ? '' : ' · <kbd>E</kbd> get out'}</div>`);
    }
    const nk = game.nukes[0];
    $('nukeWarn').classList.toggle('hidden', !nk);
    if (nk) setText($('nukeWarn'), `☢ ATOMIC BOMB INCOMING · ${Math.ceil(nk.t)}s · get out of the red zone`);
    setText($('aliveCount'), String(game.alive));
    const L = game.leader;
    // kill board: the top teams by kills; your own team always shows
    const myTeam = seatOf(state.you)?.team ?? state.you, solo = state.roomMode === 'solo';
    const rows = game.board.slice(0, 5);
    if (!rows.some((r) => r[0] === myTeam) && me && me.kills > 0) rows.push([myTeam, me.kills, me.alive ? 1 : 0, state.you]);
    setHTML($('board'), rows.length ? `<h4>kill board</h4>${rows.map((r, i) => {
      const mine = r[0] === myTeam, who = mine ? (solo ? 'you' : 'your squad') : solo ? label(r[3]) : `team ${label(r[3])}`;
      return `<div class="${mine ? 'me' : ''} ${r[2] === 0 ? 'out' : ''}"><em>${i + 1}</em><span>${esc(who)}</span><b>${r[1]}</b>${solo ? '' : `<small>${r[2]} in</small>`}</div>`;
    }).join('')}` : '');
    setHTML($('leader'), L ? `<span class="crown">♛</span> kill leader <b>${L[0] === state.you ? 'you' : esc(label(L[0]))}</b> · ${L[1]}` : '');
    const g = game.ring, st = $('storm');
    st.textContent = g.nr <= 0 && g.r <= 1 ? 'final storm' : g.closing ? `storm closing · ${g.nextIn}s` : `storm moves in ${g.nextIn}s`;
    st.classList.toggle('calm', !g.closing);
    // the alarm: a beep and a note when the storm is about to move (30 s, 10 s, the last five), and when it starts closing
    const warnAt = !g.closing && [30, 15, 10, 5, 4, 3, 2, 1].includes(g.nextIn) ? g.nextIn : g.closing && !stormClosing ? 0 : -1;
    st.classList.toggle('warn', !g.closing && g.nextIn <= 10 && g.nextIn > 0);
    if (me?.alive && warnAt >= 0 && warnAt !== lastWarn) { sfx.alarm(warnAt <= 5); hint(warnAt ? `⚠ the storm moves in ${warnAt} s` : '⚠ the storm is closing in: get inside the circle', 1600); }
    lastWarn = warnAt; stormClosing = g.closing;
    // in the storm: the purple edges
    $('stormfx').classList.toggle('on', !!me?.alive && Math.hypot(me.x - g.x, me.z - g.y) > g.r);
    if (state.pot) { const s = sol(state.pot.lamports), u = state.pot.solUsd; setText($('miniPot'), u ? `$${Math.round(s * u).toLocaleString('en-US')}` : fmtSol(s)); }
    dropFrame();
    if ((miniT += dt) > 0.1) { miniT = 0; drawMinimap(); if (!dropMap.classList.contains('hidden')) drawDropMap(); }
    miniJar.frame(dt);
  }
  requestAnimationFrame(frame);
}

net.connect();
show('lobby');
requestAnimationFrame(frame);
