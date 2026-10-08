/// <reference types="vite/client" />
import bs58 from 'bs58';
import { RESULT_MS, ROOM_MAX, TICK_HZ, WEAPONS } from '../../shared/src/constants.ts';
import { loginMessage, type PotView, type RoomSeat, type ServerMsg } from '../../shared/src/protocol.ts';
import { Net } from './net.ts';
import { LocalNet } from './local.ts';
import { PotJar } from './potjar.ts';
import { Arena } from './arena.ts';
import { Input } from './input.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;
const fmtSol = (v: number) => `◎ ${v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LOOT_LABEL: Record<string, string> = { medkit: '+ botiquín', armor: '+ escudo', shotgun: 'escopeta', rifle: 'rifle', sniper: 'francotirador' };
// a hand-drawn loop around banner words
const CIRCLE = '<svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true"><path d="M150 8 C 250 6, 296 34, 290 62 C 284 98, 210 114, 140 112 C 60 110, 6 92, 8 58 C 10 26, 70 8, 168 12"/></svg>';

// `vite build --mode demo` runs the whole game in the browser with bots; otherwise talk to the server
const DEMO = import.meta.env.MODE === 'demo';
const net: Net | LocalNet = DEMO ? new LocalNet() : new Net();
const jar = new PotJar($<HTMLCanvasElement>('jar'));
const arenaCanvas = $<HTMLCanvasElement>('arena');
const arena = new Arena(arenaCanvas);
const input = new Input(arenaCanvas);

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
  seq: 0,
  alive: ROOM_MAX,
};

function show(s: Screen) {
  state.screen = s;
  $('lobby').classList.toggle('hidden', s !== 'lobby');
  $('waiting').classList.toggle('hidden', s !== 'waiting');
  $('hud').classList.toggle('hidden', s !== 'game');
  arenaCanvas.style.visibility = s === 'game' ? 'visible' : 'hidden';
  if (s === 'lobby') { jar.resize(); updatePlay(); }
}

function err(msg: string) { $('error').textContent = msg; if (msg) setTimeout(() => { if ($('error').textContent === msg) $('error').textContent = ''; }, 5000); }
function updatePlay() { $<HTMLButtonElement>('playBtn').disabled = !state.authed; }

// ---------- auth ----------
$('guestBtn').onclick = () => {
  const name = $<HTMLInputElement>('guestName').value.trim() || 'invitado';
  try { localStorage.setItem('pr_name', name); } catch { /* storage blocked */ }
  state.authMode = 'guest'; net.send({ t: 'guest', name });
};
$('guestName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('guestBtn').click(); });
try { $<HTMLInputElement>('guestName').value = localStorage.getItem('pr_name') ?? ''; } catch { /* storage blocked */ }

interface Phantom { connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, enc: 'utf8'): Promise<{ signature: Uint8Array }> }
$('connectBtn').onclick = async () => {
  if (DEMO) return err('En la demo entrá como invitado. La wallet se usa en la versión real.');
  const w = window as unknown as { phantom?: { solana?: Phantom }; solana?: Phantom };
  const prov = w.phantom?.solana ?? w.solana;
  if (!prov) return err('No encontramos Phantom. Instalalo desde phantom.app y recargá.');
  try {
    const { publicKey } = await prov.connect();
    const { signature } = await prov.signMessage(new TextEncoder().encode(loginMessage(state.nonce)), 'utf8');
    state.authMode = 'wallet';
    net.send({ t: 'auth', wallet: publicKey.toString(), sig: bs58.encode(signature) });
  } catch (e) { err((e as Error).message || 'Cancelaste la firma.'); }
};

$('playBtn').onclick = () => { net.send({ t: 'queue' }); $('queueInfo').textContent = 'Buscando una sala…'; };
$('leaveBtn').onclick = () => { net.send({ t: 'leave' }); show('lobby'); $('queueInfo').textContent = ''; };

// ---------- lobby ----------
const marks = (n: number) => '<i></i>'.repeat(Math.min(n, 15));
function renderPot(p: PotView) {
  state.pot = p;
  jar.setSol(sol(p.lamports));
  $('online').textContent = p.online.toLocaleString('es-AR');
  $('rooms').textContent = String(p.rooms);
  $('tickets').innerHTML = p.tickets.length
    ? p.tickets.map((t) => `<li class="${t.wallet === state.wallet ? 'me-row' : ''}"><span class="name"><span>${esc(t.name)}</span></span><span class="marks">${marks(t.wins)}<em>${t.wins}</em></span></li>`).join('')
    : '<li class="nobody">Nadie ganó una sala todavía. El primero aparece acá.</li>';
}

function toast(text: string) {
  const el = $('inflowToast'); el.textContent = text; el.classList.add('on');
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove('on'), 2200);
}

// ---------- room ----------
// only seats that just arrived animate; re-rendering the rest must not replay their entrance
let shownSeats = new Set<number>();
function renderSeats() {
  const fresh = new Set(state.seats.map((s) => s.id));
  const filled = state.seats.map((s) => `<div class="seat full ${s.id === state.you ? 'me' : ''} ${shownSeats.has(s.id) ? '' : 'new'}"><div class="suit">${s.num}</div><div class="nm">${s.id === state.you ? 'vos' : esc(s.name)}</div></div>`);
  const empty = Array.from({ length: ROOM_MAX - state.seats.length }, () => '<div class="seat">libre</div>');
  $('seats').innerHTML = [...filled, ...empty].join('');
  shownSeats = fresh;
  $('fillBar').style.width = `${(state.seats.length / ROOM_MAX) * 100}%`;
}

// ---------- hud ----------
const seatOf = (id: number | null) => (id === null ? null : state.seats.find((s) => s.id === id) ?? null);
const label = (id: number | null) => { const s = seatOf(id); return s ? (s.id === state.you ? 'vos' : s.num) : '???'; };

function feed(html: string, mine = false) {
  const el = document.createElement('div'); el.innerHTML = html; if (mine) el.className = 'mine';
  const f = $('feed'); f.prepend(el);
  while (f.children.length > 5) f.lastChild?.remove();
}
function banner(word: string, sub: string, ink = false, ms = 0) {
  const b = $('banner');
  b.innerHTML = `<span class="big ${ink ? 'ink' : ''}">${word}${CIRCLE}</span>${sub ? `<small>${sub}</small>` : ''}`;
  b.classList.remove('hidden');
  if (ms > 0) setTimeout(() => b.classList.add('hidden'), ms);
}
function pickup(text: string) {
  const el = $('pickup'); el.textContent = text; el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}

// ---------- messages ----------
net.on((m: ServerMsg) => {
  switch (m.t) {
    case 'hello':
      state.nonce = m.nonce; state.authed = false; updatePlay();
      $('holdReq').textContent = m.holdMinUsd > 0 ? `$${m.holdMinUsd} del token` : 'el token';
      $('guestBtn').classList.toggle('hidden', !m.allowGuests);
      $('guestName').classList.toggle('hidden', !m.allowGuests);
      // a reconnect loses the session; guests come back silently, wallets must sign again
      if (state.authMode === 'guest') net.send({ t: 'guest', name: state.name || 'invitado' });
      else if (state.authMode === 'wallet') { $('me').textContent = 'Se cortó la conexión. Volvé a conectar la wallet.'; $('me').classList.remove('on'); }
      if (state.screen !== 'lobby') show('lobby');
      break;
    case 'authed':
      state.authed = true; state.name = m.name; state.wallet = m.wallet;
      $('me').textContent = `Jugador ${m.num} · ${m.name}${state.authMode === 'guest' ? ' (invitado)' : ''}`;
      $('me').classList.add('on');
      updatePlay();
      break;
    case 'error': err(m.msg); $('queueInfo').textContent = ''; break;
    case 'pot': renderPot(m.pot); break;
    case 'inflow': {
      const v = sol(m.inflow.lamports);
      jar.inflow(v);
      toast(`+${v.toFixed(3)} SOL · ${m.inflow.source}`);
      break;
    }
    case 'settled': {
      const s = m.settled;
      $('lastDraw').className = 'draw-sum';
      $('lastDraw').innerHTML = s.winners.length
        ? `<div>Ronda #${s.epoch} · pote <b>${fmtSol(sol(s.potLamports))}</b></div><ol class="ledger">${s.winners.slice(0, 6).map((w) => `<li><span class="name"><span>${esc(w.name || w.wallet.slice(0, 6))}</span></span><span class="marks"><em>${fmtSol(sol(w.lamports))}</em></span></li>`).join('')}</ol><div class="root">merkle root ${s.merkleRoot}</div>`
        : `Ronda #${s.epoch}: nadie ganó una sala, así que ${fmtSol(sol(s.rollover))} pasan a la próxima.`;
      break;
    }
    case 'queued': $('queueInfo').textContent = `En cola, puesto ${m.position}`; break;
    case 'room': {
      state.seats = m.seats; state.you = m.you; state.startsAt = m.startsAt; state.phase = m.state;
      $('roomId').textContent = m.roomId.toUpperCase();
      $('queueInfo').textContent = '';
      if (m.state === 'waiting' || m.state === 'countdown') { if (state.screen !== 'waiting') shownSeats = new Set(); show('waiting'); renderSeats(); }
      if (m.state === 'live') {
        arena.reset(); arena.setRoom(m.seed, m.seats, m.you);
        state.alive = m.seats.length; $('feed').innerHTML = ''; $('tally').innerHTML = '';
        show('game'); banner('¡A jugar!', 'juntá armas y escapá de la tormenta', true, 1600);
      }
      break;
    }
    case 'snap': arena.pushSnap(m); break;
    case 'event': {
      if (m.kind === 'pickup') { if (m.player === state.you) pickup(LOOT_LABEL[m.loot] ?? m.loot); break; }
      state.alive = m.left;
      arena.markDeath(m.victim);
      $('tally').insertAdjacentHTML('beforeend', '<i></i>');
      const mine = m.victim === state.you || m.by === state.you;
      const how = m.cause === 'ring' ? 'la tormenta' : m.cause === 'left' ? 'se fue' : label(m.by);
      feed(`<s>${esc(label(m.victim))}</s> <span class="by">${m.cause === 'shot' ? 'por ' : ''}${esc(how)}</span>`, mine);
      if (m.victim === state.you) banner('Eliminado', `quedan ${m.left} · seguís mirando la partida`, false, 2600);
      break;
    }
    case 'result': {
      const won = m.winner === state.you;
      const word = m.winner === null ? 'Empate' : won ? '¡Ganaste!' : `Gana ${label(m.winner)}`;
      const sub = m.ticketAwarded ? (won ? '+1 ticket para el próximo sorteo' : 'se lleva 1 ticket del pote') : won ? 'sin ticket: faltaron wallets verificadas en la sala' : '';
      banner(word, sub, won);
      setTimeout(() => { $('banner').classList.add('hidden'); show('lobby'); }, RESULT_MS);
      break;
    }
  }
});

// ---------- input upload ----------
setInterval(() => {
  if (state.screen !== 'game') return;
  const { mx, my } = input.move();
  const me = arena.myScreen();
  const aim = Math.atan2(input.mouse.y - me.y, input.mouse.x - me.x);
  net.send({ t: 'in', seq: ++state.seq, mx, my, aim, fire: input.mouse.down, dash: input.takeDash() });
}, 1000 / TICK_HZ);

// ---------- frame loop ----------
let last = performance.now();
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
    const n = state.seats.length;
    const counting = state.phase === 'countdown' && state.startsAt;
    $('waitStatus').innerHTML = counting
      ? `<small>arranca en</small>${Math.max(0, Math.ceil((state.startsAt! - Date.now()) / 1000))}`
      : `<small>esperando jugadores</small>${n}<span class="of">/${ROOM_MAX}</span>`;
  } else {
    arena.frame(dt);
    const me = arena.me();
    const alive = !!me && me.alive;
    $('hpFill').style.width = `${alive ? me!.hp : 0}%`;
    $('hpNum').textContent = String(alive ? me!.hp : 0);
    $('armorFill').style.width = `${alive ? (me!.armor / 50) * 100 : 0}%`;
    $('armorNum').textContent = String(alive ? me!.armor : 0);
    $('weapon').textContent = me ? WEAPONS[me.weapon].name : '';
    $('ammo').textContent = me ? (me.ammo < 0 ? '∞' : String(me.ammo)) : '';
    $('aliveCount').textContent = String(state.alive);
    const g = arena.ring, st = $('storm');
    st.textContent = g.nr <= 0 && g.r <= 1 ? 'tormenta final' : g.closing ? `la tormenta se cierra · ${g.nextIn}s` : `la tormenta avanza en ${g.nextIn}s`;
    st.classList.toggle('calm', !g.closing);
    if (state.pot) $('miniPot').textContent = fmtSol(sol(state.pot.lamports));
  }
  requestAnimationFrame(frame);
}

net.connect();
show('lobby');
requestAnimationFrame(frame);
