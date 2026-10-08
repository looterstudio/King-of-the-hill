/// <reference types="vite/client" />
import bs58 from 'bs58';
import { MAP_HALF, PLAYER_HP, RESULT_MS, ROOM_MAX, TICK_HZ, WEAPONS, WEAPON_ORDER } from '../../shared/src/constants.ts';
import { loginMessage, type PotView, type RoomSeat, type ServerMsg } from '../../shared/src/protocol.ts';
import { spreadFor } from '../../shared/src/sim.ts';
import { Net } from './net.ts';
import { LocalNet } from './local.ts';
import { PotJar } from './potjar.ts';
import { Game3D } from './game3d.ts';
import { FpsInput } from './fpsinput.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;
const fmtSol = (v: number) => `◎ ${v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// a hand-drawn loop around banner words
const CIRCLE = '<svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true"><path d="M150 8 C 250 6, 296 34, 290 62 C 284 98, 210 114, 140 112 C 60 110, 6 92, 8 58 C 10 26, 70 8, 168 12"/></svg>';

// `vite build --mode demo` runs the whole game in the browser with bots; otherwise talk to the server
const DEMO = import.meta.env.MODE === 'demo';
const net: Net | LocalNet = DEMO ? new LocalNet() : new Net();
const jar = new PotJar($<HTMLCanvasElement>('jar'));
const canvas = $<HTMLCanvasElement>('arena');
const game = new Game3D(canvas, $<HTMLDivElement>('tags'));
const input = new FpsInput(canvas);
// headless test runs can't take pointer lock; #autotest pretends it was granted (demo build only)
if (DEMO && location.hash === '#autotest') { input.locked = true; input.lock = () => {}; }

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
};

function show(s: Screen) {
  state.screen = s;
  $('lobby').classList.toggle('hidden', s !== 'lobby');
  $('waiting').classList.toggle('hidden', s !== 'waiting');
  $('hud').classList.toggle('hidden', s !== 'game');
  canvas.style.visibility = s === 'game' ? 'visible' : 'hidden';
  if (s !== 'game') { input.unlock(); $('pause').classList.add('hidden'); }
  if (s === 'lobby') { jar.resize(); updatePlay(); }
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

$('playBtn').onclick = () => {
  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) return err('Pot Royale needs a mouse and keyboard. Open it on a computer.');
  net.send({ t: 'queue' }); $('queueInfo').textContent = 'Finding a room…';
};
$('leaveBtn').onclick = () => { net.send({ t: 'leave' }); show('lobby'); $('queueInfo').textContent = ''; };

// ---------- lobby ----------
const marks = (n: number) => '<i></i>'.repeat(Math.min(n, 15));
function renderPot(p: PotView) {
  state.pot = p;
  jar.setSol(sol(p.lamports));
  $('online').textContent = p.online.toLocaleString('en-US');
  $('rooms').textContent = String(p.rooms);
  $('tickets').innerHTML = p.tickets.length
    ? p.tickets.map((t) => `<li class="${t.wallet === state.wallet ? 'me-row' : ''}"><span class="name"><span>${esc(t.name)}</span></span><span class="marks">${marks(t.wins)}<em>${t.wins}</em></span></li>`).join('')
    : '<li class="nobody">Nobody has won a match yet. The first winner shows up here.</li>';
}
function toast(text: string) {
  const el = $('inflowToast'); el.textContent = text; el.classList.add('on');
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove('on'), 2200);
}

// ---------- room ----------
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
function hitmarker(head: boolean) {
  const el = $('hitmarker'); el.classList.toggle('head', head); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
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
$('resumeBtn').onclick = () => input.lock();
$('quitBtn').onclick = () => { net.send({ t: 'leave' }); show('lobby'); };
input.onLockChange = (locked) => {
  if (state.screen !== 'game' || state.over) return;
  $('pause').classList.toggle('hidden', locked);
  $('pauseTitle').textContent = game.self ? 'Paused' : 'Click to drop in';
};

// ---------- minimap ----------
const mini = $<HTMLCanvasElement>('minimap').getContext('2d')!;
function drawMinimap() {
  const S = 170, k = S / (MAP_HALF * 2), toX = (x: number) => (x + MAP_HALF) * k, toY = (z: number) => (z + MAP_HALF) * k;
  mini.clearRect(0, 0, S, S);
  mini.strokeStyle = 'rgba(29,51,184,0.15)'; mini.lineWidth = 1;
  for (let i = 0; i <= S; i += S / 10) { mini.beginPath(); mini.moveTo(i, 0); mini.lineTo(i, S); mini.moveTo(0, i); mini.lineTo(S, i); mini.stroke(); }
  if (game.world) {
    mini.fillStyle = 'rgba(29,51,184,0.35)';
    for (const r of game.world.roofs) mini.fillRect(toX(r.x0), toY(r.z0), (r.x1 - r.x0) * k, (r.z1 - r.z0) * k);
  }
  const g = game.ring;
  mini.strokeStyle = '#d32336'; mini.lineWidth = 2;
  mini.beginPath(); mini.arc(toX(g.x), toY(g.y), Math.max(0.5, g.r * k), 0, Math.PI * 2); mini.stroke();
  if (g.nr > 0) { mini.strokeStyle = '#1d33b8'; mini.setLineDash([4, 4]); mini.beginPath(); mini.arc(toX(g.nx), toY(g.ny), g.nr * k, 0, Math.PI * 2); mini.stroke(); mini.setLineDash([]); }
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
    case 'inflow': { const v = sol(m.inflow.lamports); jar.inflow(v); toast(`+${v.toFixed(3)} SOL · ${m.inflow.source}`); break; }
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
      if (m.state === 'waiting' || m.state === 'countdown') { if (state.screen !== 'waiting') shownSeats = new Set(); show('waiting'); renderSeats(); }
      if (m.state === 'live') {
        state.over = false; state.aimed = false;
        game.setRoom(m.seed, m.seats, m.you);
        $('feed').innerHTML = '';
        show('game');
        input.yaw = 0; input.pitch = -0.5;
        $('pause').classList.remove('hidden');
        $('pauseTitle').textContent = 'Click to drop in';
        input.lock();
        if (input.locked) $('pause').classList.add('hidden');
      }
      break;
    }
    case 'snap':
      game.onSnap(m);
      if (m.self && !state.aimed) { input.yaw = m.self.yaw; input.pitch = m.self.pitch; state.aimed = true; }
      break;
    case 'event': {
      if (m.kind === 'hit') {
        if (m.by === state.you) hitmarker(m.head);
        if (m.victim === state.you) damageFrom(m.by);
        break;
      }
      if (m.by === state.you) hint(m.head ? `headshot · ${label(m.victim)} eliminated` : `${label(m.victim)} eliminated`, 1800);
      const mine = m.victim === state.you || m.by === state.you;
      const how = m.cause === 'ring' ? 'the storm' : m.cause === 'left' ? 'left' : label(m.by);
      feed(`<s>${esc(label(m.victim))}</s> <span class="by">${m.cause === 'shot' ? (m.head ? 'headshot by ' : 'by ') : m.cause === 'ring' ? 'to ' : ''}${esc(how)}</span>`, mine);
      if (m.victim === state.you) { game.watch = m.by; banner('Eliminated', `#${m.left + 1} of ${state.seats.length} · spectating`, false, 3000); }
      break;
    }
    case 'result': {
      state.over = true;
      input.unlock(); $('pause').classList.add('hidden');
      const won = m.winner === state.you;
      const word = m.winner === null ? 'Draw' : won ? 'Victory!' : `${label(m.winner)} wins`;
      const sub = m.ticketAwarded ? (won ? '+1 ticket for the next payout' : 'takes 1 ticket for the pot') : won ? 'no ticket: not enough verified wallets in this match' : '';
      banner(word, sub, won);
      setTimeout(() => { $('banner').classList.add('hidden'); show('lobby'); }, RESULT_MS);
      break;
    }
  }
});

// ---------- input upload, 30 Hz ----------
setInterval(() => {
  if (state.screen !== 'game' || !input.locked) return;
  const inp = game.tick(input.sample());
  if (inp) net.send({ t: 'in', ...inp });
}, 1000 / TICK_HZ);

// ---------- frame loop ----------
let last = performance.now();
let miniT = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (state.screen === 'lobby') {
    jar.frame(dt);
    if (state.pot) {
      const target = sol(state.pot.lamports);
      state.potShown += (target - state.potShown) * Math.min(1, dt * 3);
      if (Math.abs(target - state.potShown) < 0.0005) state.potShown = target;
      $('potAmount').textContent = fmtSol(state.potShown);
      $('countdown').textContent = hms(state.pot.epochEndMs - Date.now());
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
      const wi = WEAPON_ORDER.indexOf(me.weapon), def = WEAPONS[me.weapon], mag = me.mag[wi];
      $('hpFill').style.width = `${(me.hp / PLAYER_HP) * 100}%`;
      $('hpNum').textContent = String(me.hp);
      document.querySelector('.hud-bl')!.classList.toggle('low', me.hp <= 30);
      for (const sel of ['.hud-bl', '.hud-br']) (document.querySelector(sel) as HTMLElement).style.visibility = me.alive ? 'visible' : 'hidden';
      $('ammo').textContent = String(mag);
      $('ammoMax').textContent = `/${def.mag}`;
      $('reloading').classList.toggle('hidden', me.reloadT <= 0);
      $('magTally').innerHTML = Array.from({ length: Math.min(def.mag, 30) }, (_, i) => `<i class="${i < mag ? '' : 'spent'}"></i>`).join('');
      $('weapon').textContent = def.name;
      $('weapons').innerHTML = WEAPON_ORDER.map((w, i) => `<li class="${w === me.weapon ? 'on' : ''}"><span>${WEAPONS[w].name}</span><em>${me.mag[i]}/${WEAPONS[w].mag}</em></li>`).join('');
      $('killCount').textContent = String(me.kills);
      // crosshair opens with movement and closes when aiming
      const body = game.me;
      const spread = body ? spreadFor(body, me.weapon, input.aim) : def.spread;
      $('crosshair').style.setProperty('--s', `${Math.round(6 + spread * 900)}px`);
      $('crosshair').style.visibility = me.alive && !(input.aim && me.weapon === 'sniper') ? 'visible' : 'hidden';
      $('scope').classList.toggle('hidden', !(input.aim && me.weapon === 'sniper' && me.alive));
      if (body?.gliding && me.alive) hint('gliding · steer with the mouse, land anywhere', 400);
    }
    $('aliveCount').textContent = String(game.alive);
    const g = game.ring, st = $('storm');
    st.textContent = g.nr <= 0 && g.r <= 1 ? 'final storm' : g.closing ? `storm closing · ${g.nextIn}s` : `storm moves in ${g.nextIn}s`;
    st.classList.toggle('calm', !g.closing);
    if (state.pot) $('miniPot').textContent = fmtSol(sol(state.pot.lamports));
    if ((miniT += dt) > 0.1) { miniT = 0; drawMinimap(); }
  }
  requestAnimationFrame(frame);
}

net.connect();
show('lobby');
requestAnimationFrame(frame);
