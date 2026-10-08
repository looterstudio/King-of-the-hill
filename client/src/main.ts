/// <reference types="vite/client" />
import bs58 from 'bs58';
import { ITEMS, MAP_HALF, MODES, PERKS, PLAYER_HP, RESULT_MS, ROOM_MAX, SHIELD_MAX, TICK_HZ, VEHICLES, VEHICLE_KINDS, WEAPONS, type Mode } from '../../shared/src/constants.ts';
import { loginMessage, type LobbyRoom, type PotView, type RoomSeat, type ServerMsg } from '../../shared/src/protocol.ts';
import { spreadFor } from '../../shared/src/sim.ts';
import { Net } from './net.ts';
import { LocalNet } from './local.ts';
import { PotJar } from './potjar.ts';
import { Game3D, RARITY_CSS } from './game3d.ts';
import { World } from '../../shared/src/world.ts';
import { FpsInput } from './fpsinput.ts';
import { sfx } from './audio.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;
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
const jar = new PotJar($<HTMLCanvasElement>('jar'), { string: true, marks: false, crown: true, rays: true });
const miniJar = new PotJar($<HTMLCanvasElement>('miniPig'), { string: false, marks: false, crown: true });
const canvas = $<HTMLCanvasElement>('arena');
const game = new Game3D(canvas, $<HTMLDivElement>('tags'));
// the lobby's live view of the island (its own renderer, drawn only while the lobby is open)
const flyCanvas = $<HTMLCanvasElement>('flyCanvas');
const flyover = new Game3D(flyCanvas, $<HTMLDivElement>('flyTags'), true);
flyover.setRoom(20261008, [], -1);
flyover.ink.setQuality(0.75);
let flyVisible = true;
try { new IntersectionObserver((e) => { flyVisible = e[0].isIntersecting; }).observe(flyCanvas); } catch { /* old browser: always draw */ }
const input = new FpsInput(canvas);
// headless test runs can't take pointer lock; #autotest pretends it was granted (demo build only)
if (DEMO && location.hash === '#autotest') { input.locked = true; input.lock = () => {}; (window as unknown as Record<string, unknown>).__pr = { game, net, input }; }

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
};
try { const m = localStorage.getItem('pr_mode') as Mode | null; if (m && m in MODES) state.mode = m; state.party = localStorage.getItem('pr_party') ?? ''; } catch { /* storage blocked */ }

function show(s: Screen) {
  state.screen = s;
  $('lobby').classList.toggle('hidden', s !== 'lobby');
  $('waiting').classList.toggle('hidden', s !== 'waiting');
  $('hud').classList.toggle('hidden', s !== 'game');
  canvas.style.visibility = s === 'game' ? 'visible' : 'hidden';
  if (s !== 'game') { input.unlock(); $('pause').classList.add('hidden'); sfx.engine(0, 0); }
  if (s === 'lobby') { jar.resize(); flyover.ink.resize(); updatePlay(); }
}

function err(msg: string) { $('error').textContent = msg; if (msg) setTimeout(() => { if ($('error').textContent === msg) $('error').textContent = ''; }, 5000); }
function updatePlay() { $<HTMLButtonElement>('playBtn').disabled = !state.authed; }

// ---------- auth ----------
$('guestBtn').onclick = () => {
  const name = $<HTMLInputElement>('guestName').value.trim() || 'guest';
  try { localStorage.setItem('pr_name', name); } catch { /* storage blocked */ }
  state.authMode = 'guest'; net.send({ t: 'guest', name });
};
$('guestName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('guestBtn').click(); });
try { $<HTMLInputElement>('guestName').value = localStorage.getItem('pr_name') ?? ''; } catch { /* storage blocked */ }

interface Phantom { connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, enc: 'utf8'): Promise<{ signature: Uint8Array }> }
$('connectBtn').onclick = async () => {
  if (DEMO) return err('This demo runs on guest accounts. Wallets are used in the live game.');
  const w = window as unknown as { phantom?: { solana?: Phantom }; solana?: Phantom };
  const prov = w.phantom?.solana ?? w.solana;
  if (!prov) return err('Phantom not found. Install it from phantom.app and reload.');
  try {
    const { publicKey } = await prov.connect();
    const { signature } = await prov.signMessage(new TextEncoder().encode(loginMessage(state.nonce)), 'utf8');
    state.authMode = 'wallet';
    net.send({ t: 'auth', wallet: publicKey.toString(), sig: bs58.encode(signature) });
  } catch (e) { err((e as Error).message || 'Signature cancelled.'); }
};

const touchOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
$('playBtn').onclick = () => {
  if (touchOnly()) return err('King of the Hill Royale needs a mouse and keyboard. Open it on a computer.');
  net.send({ t: 'queue', mode: state.mode, party: state.mode === 'solo' ? undefined : state.party || undefined });
  $('queueInfo').textContent = `Finding a ${MODES[state.mode].name.toLowerCase()} room…`;
};

// ---------- modes / party ----------
function renderMode() {
  document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => { const on = b.dataset.mode === state.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $('partyRow').classList.toggle('hidden', state.mode === 'solo');
  $<HTMLInputElement>('party').value = state.party;
  $('playBtn').textContent = `Drop in · ${MODES[state.mode].name}`;
}
document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => b.onclick = () => {
  state.mode = b.dataset.mode as Mode; renderMode();
  try { localStorage.setItem('pr_mode', state.mode); } catch { /* storage blocked */ }
});
const saveParty = () => { try { localStorage.setItem('pr_party', state.party); } catch { /* storage blocked */ } };
$<HTMLInputElement>('party').oninput = (e) => {
  const el = e.target as HTMLInputElement; el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); state.party = el.value; saveParty();
};
$('partyNew').onclick = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  state.party = Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); saveParty(); renderMode();
  navigator.clipboard?.writeText(state.party).then(() => toast(`party code ${state.party} copied`), () => {});
};
renderMode();

// ---------- pot odometer: each digit is a rolling column ----------
function odometer(el: HTMLElement, text: string) {
  if (el.dataset.v === text) return;
  el.dataset.v = text;
  const cells = el.querySelectorAll<HTMLElement>('.dg, .pt');
  if (cells.length !== text.length || [...text].some((ch, i) => (ch >= '0' && ch <= '9') !== cells[i].classList.contains('dg'))) {
    el.innerHTML = '<span class="sym">◎</span>' + [...text].map((ch) => ch >= '0' && ch <= '9'
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
  if (!state.authed) return err('Connect a wallet or join as a guest first.');
  if (touchOnly()) return err('King of the Hill Royale needs a mouse and keyboard. Open it on a computer.');
  net.send({ t: 'queue', room: id, party: state.party || undefined }); $('queueInfo').textContent = 'Joining that room…';
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
$('leaveBtn').onclick = () => { net.send({ t: 'leave' }); show('lobby'); $('queueInfo').textContent = ''; };

// ---------- lobby ----------
const marks = (n: number) => '<i></i>'.repeat(Math.min(n, 15));
function renderPot(p: PotView) {
  state.pot = p;
  jar.setSol(sol(p.lamports)); miniJar.setSol(sol(p.lamports));
  $('online').textContent = p.online.toLocaleString('en-US');
  $('rooms').textContent = String(p.rooms);
  $('tickets').innerHTML = p.tickets.length
    ? p.tickets.map((t, i) => `<li class="${t.wallet === state.wallet ? 'me-row' : ''} ${i === 0 ? 'top' : ''}"><span class="name"><span>${i === 0 ? '<i class="crown">♛</i> ' : ''}${esc(t.name)}</span></span><span class="marks">${marks(t.wins)}<em>${t.wins}</em></span></li>`).join('')
    : '<li class="nobody">Nobody has won a match yet. The first winner shows up here.</li>';
}
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
  const filled = state.seats.map((s) => `<div class="seat full ${s.id === state.you ? 'me' : ''} ${shownSeats.has(s.id) ? '' : 'new'}"><div class="suit">${s.num}</div><div class="nm">${s.id === state.you ? 'you' : esc(s.name)}</div></div>`);
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
function banner(word: string, sub: string, ink = false, ms = 0) {
  const b = $('banner');
  b.innerHTML = `<span class="big ${ink ? 'ink' : ''}">${word}${CIRCLE}</span>${sub ? `<small>${sub}</small>` : ''}`;
  b.classList.remove('hidden');
  if (ms > 0) setTimeout(() => b.classList.add('hidden'), ms);
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
    el.className = `dmgnum ${entry.head ? 'head' : entry.shield ? 'shield' : ''} ${entry.dmg >= 60 ? 'big' : ''}`;
    el.textContent = String(entry.dmg);
    el.style.left = `${at.x + (Math.random() - 0.5) * 30}px`; el.style.top = `${at.y}px`;
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
}
function damageFrom(by: number | null) {
  const pos = by !== null ? game.positionOf(by) : null;
  if (!pos) return;
  const i = document.createElement('i');
  i.style.transform = `rotate(${game.bearingTo(pos.x, pos.z, input.yaw)}rad)`;
  $('dmg').appendChild(i);
  setTimeout(() => i.remove(), 1000);
}

// ---------- pause / pointer lock ----------
const sens = $<HTMLInputElement>('sens'), invert = $<HTMLInputElement>('invert');
sens.value = String(input.sens); invert.checked = input.invert;
const showSens = () => { $('sensVal').textContent = `${Math.round(input.sens * 100)}%`; };
showSens();
sens.oninput = () => { input.setSens(Number(sens.value)); showSens(); };
invert.onchange = () => input.setInvert(invert.checked);
$('resumeBtn').onclick = () => { sfx.unlock(); input.lock(); };
$('quitBtn').onclick = () => { net.send({ t: 'leave' }); show('lobby'); };
input.onLockChange = (locked) => {
  if (state.screen !== 'game' || state.over) return;
  if (locked && !state.dropped) { state.dropped = true; banner('Drop!', `${MODES[state.roomMode].name} · ${state.seats.length} players${game.mates.size ? ` · ${game.mates.size} teammate${game.mates.size > 1 ? 's' : ''} with you` : ''} · the hill is in the middle`, true, 2400); }
  $('pause').classList.toggle('hidden', locked);
  if (locked && input.free) hint('mouse capture is blocked here: look with the mouse + arrow keys, Esc to pause', 4500);
  $('pauseTitle').textContent = game.self ? 'Paused' : 'Click to drop in';
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
  if (state.previewSeed === seed) return;
  state.previewSeed = seed;
  const c = $<HTMLCanvasElement>('mapPreview'), ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  drawIsland(ctx, new World(seed), c.width, true);
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
    const s = v[1] === 0 ? 2.5 : 3.5;
    mini.fillRect(toX(v[2]) - s, toY(v[4]) - s / 2, s * 2, s);
    if (v[1] > 0) mini.fillRect(toX(v[2]) - s / 2, toY(v[4]) - s, s, s * 2);
  }
  for (const d of game.drops) { mini.fillStyle = '#e8a317'; mini.strokeStyle = '#2b2f3a'; mini.lineWidth = 1.5; mini.beginPath(); mini.arc(toX(d.x), toY(d.z), 5, 0, Math.PI * 2); mini.fill(); mini.stroke(); }
  if (game.self && !game.self.alive) {
    const cam = game.ink.camera.position;
    mini.strokeStyle = '#d32336'; mini.lineWidth = 2; mini.beginPath(); mini.arc(toX(cam.x), toY(cam.z), 5, 0, Math.PI * 2); mini.stroke();
  }
  const me = game.me;
  if (me && game.self?.alive) {
    mini.save(); mini.translate(toX(me.x), toY(me.z)); mini.rotate(-input.yaw);
    mini.fillStyle = '#d32336'; mini.beginPath(); mini.moveTo(0, -7); mini.lineTo(5, 5); mini.lineTo(0, 2); mini.lineTo(-5, 5); mini.closePath(); mini.fill();
    mini.restore();
  }
}

// ---------- messages ----------
net.on((m: ServerMsg) => {
  switch (m.t) {
    case 'hello':
      state.nonce = m.nonce; state.authed = false; updatePlay();
      $('holdReq').textContent = m.holdMinUsd > 0 ? `$${m.holdMinUsd} of the token` : 'the token';
      $('guestBtn').classList.toggle('hidden', !m.allowGuests);
      $('guestName').classList.toggle('hidden', !m.allowGuests);
      if (state.authMode === 'guest') net.send({ t: 'guest', name: state.name || 'guest' });
      else if (state.authMode === 'wallet') { $('me').textContent = 'Connection lost. Connect your wallet again.'; $('me').classList.remove('on'); }
      if (state.screen !== 'lobby') show('lobby');
      break;
    case 'authed':
      state.authed = true; state.name = m.name; state.wallet = m.wallet;
      $('me').textContent = `Player ${m.num} · ${m.name}${state.authMode === 'guest' ? ' (guest)' : ''}`;
      $('me').classList.add('on');
      updatePlay();
      break;
    case 'error': err(m.msg); $('queueInfo').textContent = ''; break;
    case 'pot': renderPot(m.pot); break;
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
      const s = m.settled;
      $('lastDraw').className = 'draw-sum';
      $('lastDraw').innerHTML = s.winners.length
        ? `<div>Round #${s.epoch} · pot <b>${fmtSol(sol(s.potLamports))}</b></div><ol class="ledger">${s.winners.slice(0, 6).map((w) => `<li><span class="name"><span>${esc(w.name || w.wallet.slice(0, 6))}</span></span><span class="marks"><em>${fmtSol(sol(w.lamports))}</em></span></li>`).join('')}</ol><div class="root">merkle root ${s.merkleRoot}</div>`
        : `Round #${s.epoch}: nobody won a match, so ${fmtSol(sol(s.rollover))} rolls into the next one.`;
      break;
    }
    case 'queued': $('queueInfo').textContent = `In queue, position ${m.position}`; break;
    case 'room': {
      state.seats = m.seats; state.you = m.you; state.startsAt = m.startsAt; state.phase = m.state;
      $('roomId').textContent = m.roomId.toUpperCase();
      $('queueInfo').textContent = '';
      state.roomMode = m.mode;
      $('roomMode').textContent = MODES[m.mode].name; $('roomMode').className = `mode-tag ${m.mode}`;
      $('roomFoot').textContent = m.mode === 'solo' ? 'Up to 100 drop in. 1 walks out with 4 tickets.'
        : `Up to 100 drop in, in ${m.mode === 'duo' ? 'teams of 2' : 'squads of 4'}. The last team standing gets ${MODES[m.mode].tickets} ticket${MODES[m.mode].tickets > 1 ? 's' : ''} each.`;
      if (m.state === 'waiting' || m.state === 'countdown') { if (state.screen !== 'waiting') shownSeats = new Set(); show('waiting'); renderSeats(); drawPreview(m.seed); }
      if (m.state === 'live') {
        state.over = false; state.aimed = false; state.dropped = false; state.dead = new Set();
        game.setRoom(m.seed, m.seats, m.you);
        $('feed').innerHTML = '';
        show('game');
        input.yaw = 0; input.pitch = -0.5;
        $('pause').classList.remove('hidden');
        $('pauseTitle').textContent = 'Click to drop in';
        if (input.locked) $('pause').classList.add('hidden'); // the Play button takes the mouse (needs a click)
      }
      break;
    }
    case 'snap':
      game.onSnap(m);
      if (m.self && !state.aimed) { input.yaw = m.self.yaw; input.pitch = m.self.pitch; state.aimed = true; }
      break;
    case 'event': {
      if (m.kind === 'hit') {
        if (m.by === state.you) {
          hitmarker(m.head); damageNumber(m.victim, m.dmg, m.head, m.shield); sfx.hit(m.head);
          if (m.broke) { const el = $('shieldbreak'); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); sfx.shieldBreak(); }
        }
        if (m.victim === state.you) { damageFrom(m.by); sfx.hurt(); }
        break;
      }
      if (m.kind === 'boom') {
        game.onBoom(m.x, m.y, m.z, m.r, m.nuke);
        const cam = game.ink.camera.position, d = Math.hypot(m.x - cam.x, m.z - cam.z);
        sfx.boom(m.nuke, d);
        if (m.nuke && d < 220) { const f = $('flash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60); }
        break;
      }
      if (m.kind === 'build') { game.onBuild(m.id, m.boxes); break; }
      if (m.kind === 'unbuild') { game.onUnbuild(m.id); break; }
      if (m.kind === 'nuke') { sfx.siren(); feed(`<b style="color:var(--red)">☢ ${esc(label(m.by))} launched an atomic bomb</b>`, m.by === state.you); break; }
      if (m.kind === 'open') { if (m.by === state.you) sfx.open(m.golden); break; }
      if (m.kind === 'vhit') { hitmarker(false); sfx.hit(false); const v = game.vehiclesNow.find((x) => x[0] === m.vehicle); vehicleNumber(v, m.dmg); break; }
      if (m.kind === 'upgrade') { if (m.by === state.you) { hint(`weapon upgraded ${'★'.repeat(m.level)} · +${Math.round(m.level * 22)}% damage`, 2200); sfx.open(true); } break; }
      if (m.kind === 'drop') {
        if (!m.landed) { feed('<b style="color:#c98a00">📦 supply drop incoming</b> · legendary inside', false); hint('supply drop incoming: legendary loot, find the balloon', 2600); sfx.siren(); }
        break;
      }
      if (m.by === state.you && m.victim !== state.you) { hint(m.head ? `headshot · ${label(m.victim)} eliminated` : `${label(m.victim)} eliminated`, 1800); sfx.elim(); hitmarker(m.head, true); }
      state.dead.add(m.victim);
      const mine = m.victim === state.you || m.by === state.you || game.mates.has(m.victim) || (m.by !== null && game.mates.has(m.by));
      const how = m.cause === 'ring' ? 'the storm' : m.cause === 'left' ? 'left' : m.by === null ? 'a wreck' : label(m.by);
      feed(`<s>${esc(label(m.victim))}</s> <span class="by">${m.cause === 'shot' ? (m.head ? 'headshot by ' : 'by ') : m.cause === 'ring' ? 'to ' : m.cause === 'ram' ? 'run over by ' : m.cause === 'boom' ? 'blown up by ' : ''}${esc(how)}</span>`, mine);
      if (m.victim === state.you) {
        const mates = matesAlive();
        game.watch = mates[0] ?? m.by;
        banner('Eliminated', mates.length ? `your team is still in it · watching ${label(mates[0])}` : `#${m.left + 1} of ${state.seats.length} · spectating`, false, 3000);
      } else if (game.mates.has(m.victim)) hint(`teammate ${label(m.victim)} is down`, 2200);
      break;
    }
    case 'result': {
      state.over = true;
      input.unlock(); $('pause').classList.add('hidden');
      const winners = m.winners ?? (m.winner === null ? [] : [m.winner]);
      const won = winners.includes(state.you), team = winners.length > 1, t = m.tickets ?? 1;
      const word = !winners.length ? 'Draw' : won ? 'Victory!' : team ? `Team ${label(winners[0])} wins` : `${label(winners[0])} wins`;
      const tix = `${t} ticket${t > 1 ? 's' : ''}`;
      const sub = m.ticketAwarded ? (won ? `+${tix}${team ? ' each' : ''} for the next payout` : `take${team ? '' : 's'} ${tix}${team ? ' each' : ''} for the pot`) : won ? 'no ticket: not enough verified wallets in this match' : '';
      if (winners.length) ticker(`<span class="gold">♛ <b>${esc(winners.map((w) => seatOf(w)?.name ?? label(w)).join(' + '))}</b> won a ${MODES[state.roomMode].name.toLowerCase()} match</span>`);
      banner(word, sub, won);
      setTimeout(() => { $('banner').classList.add('hidden'); show('lobby'); }, RESULT_MS);
      break;
    }
  }
});

// ---------- input upload, 30 Hz ----------
setInterval(() => {
  if (state.screen !== 'game' || !input.locked) return;
  const s = input.sample();
  if (game.self && !game.self.alive && !state.over) { spectatorTick(s); return; }
  const inp = game.tick(s);
  if (inp) net.send({ t: 'in', ...inp });
}, 1000 / TICK_HZ);

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
  else if (avg < 14) game.ink.setQuality(game.ink.quality + 0.05);
}
function frame(now: number) {
  const raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
  if (state.screen === 'game') govern(raw);
  if (state.screen === 'lobby') {
    jar.frame(dt);
    if (flyVisible) flyover.showcase(dt, flyCanvas.clientWidth, flyCanvas.clientHeight);
    if (state.pot) {
      const target = sol(state.pot.lamports);
      state.potShown += (target - state.potShown) * Math.min(1, dt * 3);
      if (Math.abs(target - state.potShown) < 0.0005) state.potShown = target;
      odometer($('potAmount'), target.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
      const [hh, mm, ss] = hms(state.pot.epochEndMs - Date.now()).split(':');
      const cd = $('countdown').querySelectorAll('b');
      if (cd[0].textContent !== hh) cd[0].textContent = hh;
      if (cd[1].textContent !== mm) cd[1].textContent = mm;
      if (cd[2].textContent !== ss) { cd[2].textContent = ss; cd[2].classList.remove('tick'); void cd[2].offsetWidth; cd[2].classList.add('tick'); }
    }
  } else if (state.screen === 'waiting') {
    const n = state.seats.length, counting = state.phase === 'countdown' && state.startsAt;
    $('waitStatus').innerHTML = counting
      ? `<small>dropping in</small>${Math.max(0, Math.ceil((state.startsAt! - Date.now()) / 1000))}`
      : `<small>waiting for players</small>${n}<span class="of">/${ROOM_MAX}</span>`;
  } else {
    game.frame(dt, { yaw: input.yaw, pitch: input.pitch, aim: input.aim });
    const me = game.self;
    if (me) {
      const w = me.slots[me.cur], def = w ? WEAPONS[w] : null, mag = me.mags[me.cur] ?? 0;
      $('hpFill').style.width = `${(me.hp / PLAYER_HP) * 100}%`;
      setText($('hpNum'), String(me.hp));
      $('shFill').style.width = `${(me.shield / SHIELD_MAX) * 100}%`;
      setText($('shNum'), String(me.shield));
      document.querySelector('.hud-bl')!.classList.toggle('low', me.hp <= 30);
      for (const sel of ['.hud-bl', '.hud-br']) (document.querySelector(sel) as HTMLElement).style.visibility = me.alive ? 'visible' : 'hidden';
      setText($('ammo'), def ? String(mag) : '–');
      setText($('ammoMax'), def ? `/${def.mag}` : '');
      $('reloading').classList.toggle('hidden', me.reloadT <= 0);
      setHTML($('magTally'), def ? Array.from({ length: Math.min(def.mag, 30) }, (_, i) => `<i class="${i < mag ? '' : 'spent'}"></i>`).join('') : '');
      setText($('weapon'), def ? def.name : 'unarmed');
      $('weapon').style.color = def ? RARITY_CSS[def.rarity] : '';
      setHTML($('weapons'), me.slots.map((s, i) => s
        ? `<li class="${i === me.cur ? 'on' : ''}" style="color:${RARITY_CSS[WEAPONS[s].rarity]}"><span>${WEAPONS[s].name}${me.ups?.[i] ? `<b class="stars">${'★'.repeat(me.ups[i])}</b>` : ''}</span><em>${me.mags[i]}/${WEAPONS[s].mag}</em></li>`
        : `<li class="empty"><span>empty</span><em></em></li>`).join(''));
      const shields = me.items.big + me.items.mini;
      setHTML($('items'), `<span class="${shields ? '' : 'empty'}"><kbd>5</kbd> shield ×${me.items.big}<small>+${me.items.mini} mini</small></span>`
        + `<span class="${me.items.med ? '' : 'empty'}"><kbd>6</kbd> medkit ×${me.items.med}</span>`
        + `<span class="${me.perk ? '' : 'empty'}" style="${me.perk ? `color:${RARITY_CSS[PERKS[me.perk.kind].rarity]}` : ''}"><kbd>G</kbd> ${me.perk ? `${PERKS[me.perk.kind].name} ×${me.perk.n}` : 'no perk'}</span>`);
      $('useBar').classList.toggle('hidden', !me.use);
      if (me.use) { const total = ITEMS[me.use.item].use; setText($('useLabel'), ITEMS[me.use.item].name); $('useFill').style.width = `${(1 - me.use.t / total) * 100}%`; }
      setHTML($('prompt'), game.prompt);
      setText($('killCount'), String(me.kills));
      const body = game.me;
      const scoped = input.aim && (w === 'heavy' || w === 'hunting') && me.alive;
      const spread = body && w ? spreadFor(body, w, input.aim) : 0.02;
      $('crosshair').style.setProperty('--s', `${Math.round(6 + spread * 900)}px`);
      $('crosshair').style.visibility = me.alive && !scoped ? 'visible' : 'hidden';
      $('scope').classList.toggle('hidden', !scoped);
      if (body?.gliding && me.alive) hint('gliding · look down to dive, look up to float', 400);
    }
    // teammates: name + health, struck out when they go down
    const sq = $('squad');
    if (game.mates.size) {
      setHTML(sq, [...game.mates].map((id) => {
        const down = state.dead.has(id), o = game.infoOf(id), hp = down ? 0 : o ? o[6] : 100;
        return `<div class="mate ${down ? 'down' : ''}"><span>${esc(seatOf(id)?.name ?? label(id))}</span><div class="bar"><i style="width:${hp}%"></i></div></div>`;
      }).join(''));
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
    sfx.engine(me?.alive ? ride : 0, Math.hypot(game.me?.vx ?? 0, game.me?.vz ?? 0));
    $('vehHud').classList.toggle('hidden', !ride || !me?.alive);
    if (ride && me) {
      const kind = VEHICLE_KINDS[ride - 1], def = VEHICLES[kind], hpPct = Math.max(0, Math.min(100, (me.vhp / def.hp) * 100));
      const kmh = Math.round(Math.hypot(game.me!.vx, game.me!.vy, game.me!.vz) * 3.6);
      setHTML($('vehHud'), `<div class="veh-name">${def.name}<b>${kmh}<small> km/h</small></b></div><div class="bar veh"><div style="width:${hpPct}%" class="${hpPct < 30 ? 'low' : ''}"></div></div>`
        + `<div class="veh-keys">${game.me!.seat ? '<b>passenger</b> · <kbd>LMB</kbd> shoot out of it · <kbd>G</kbd> throw · <kbd>E</kbd> hop off' : kind === 'car' ? '<kbd>W</kbd><kbd>S</kbd> gas / brake · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Shift</kbd> boost · <kbd>Space</kbd> hop · <kbd>LMB</kbd> drive-by'
          : kind === 'heli' ? '<kbd>WASD</kbd> fly · <kbd>Space</kbd>/<kbd>C</kbd> up / down · <kbd>Shift</kbd> fast · <kbd>LMB</kbd> nose gun'
          : '<kbd>Mouse</kbd> steer · <kbd>W</kbd><kbd>S</kbd> throttle · <kbd>Shift</kbd> afterburner · <kbd>LMB</kbd> guns · <kbd>RMB</kbd> bomb'}${game.me!.seat ? '' : ' · <kbd>E</kbd> get out'}</div>`);
    }
    const nk = game.nukes[0];
    $('nukeWarn').classList.toggle('hidden', !nk);
    if (nk) setText($('nukeWarn'), `☢ ATOMIC BOMB INCOMING · ${Math.ceil(nk.t)}s · get out of the red zone`);
    setText($('aliveCount'), String(game.alive));
    const L = game.leader;
    setHTML($('leader'), L ? `<span class="crown">♛</span> kill leader <b>${L[0] === state.you ? 'you' : esc(label(L[0]))}</b> · ${L[1]}` : '');
    const g = game.ring, st = $('storm');
    st.textContent = g.nr <= 0 && g.r <= 1 ? 'final storm' : g.closing ? `storm closing · ${g.nextIn}s` : `storm moves in ${g.nextIn}s`;
    st.classList.toggle('calm', !g.closing);
    if (state.pot) setText($('miniPot'), fmtSol(sol(state.pot.lamports)));
    if ((miniT += dt) > 0.1) { miniT = 0; drawMinimap(); }
    miniJar.frame(dt);
  }
  requestAnimationFrame(frame);
}

net.connect();
show('lobby');
requestAnimationFrame(frame);
