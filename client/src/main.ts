import bs58 from 'bs58';
import { RESULT_MS, ROOM_MAX, TICK_HZ } from '../../shared/src/constants.ts';
import { loginMessage, type PotView, type RoomSeat, type ServerMsg } from '../../shared/src/protocol.ts';
import { Net } from './net.ts';
import { PotJar } from './potjar.ts';
import { Arena } from './arena.ts';
import { Input } from './input.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;
const fmtSol = (v: number) => `◎ ${v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const net = new Net();
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
  num: '',
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
  const name = $<HTMLInputElement>('guestName').value || 'guest';
  try { localStorage.setItem('pr_name', name); } catch { /* storage blocked */ }
  state.authMode = 'guest'; net.send({ t: 'guest', name });
};
try { $<HTMLInputElement>('guestName').value = localStorage.getItem('pr_name') ?? ''; } catch { /* storage blocked */ }

interface Phantom { connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, enc: 'utf8'): Promise<{ signature: Uint8Array }>; publicKey?: { toString(): string } }
$('connectBtn').onclick = async () => {
  const w = window as unknown as { phantom?: { solana?: Phantom }; solana?: Phantom };
  const prov = w.phantom?.solana ?? w.solana;
  if (!prov) { open('https://phantom.app/', '_blank'); return err('instalá Phantom para jugar con wallet'); }
  try {
    const { publicKey } = await prov.connect();
    const { signature } = await prov.signMessage(new TextEncoder().encode(loginMessage(state.nonce)), 'utf8');
    state.authMode = 'wallet';
    net.send({ t: 'auth', wallet: publicKey.toString(), sig: bs58.encode(signature) });
  } catch (e) { err((e as Error).message || 'firma cancelada'); }
};

$('playBtn').onclick = () => { net.send({ t: 'queue' }); $('queueInfo').textContent = 'buscando sala…'; };
$('leaveBtn').onclick = () => { net.send({ t: 'leave' }); show('lobby'); $('queueInfo').textContent = ''; };

// ---------- lobby rendering ----------
function renderPot(p: PotView) {
  state.pot = p;
  jar.setSol(sol(p.lamports));
  $('online').textContent = String(p.online);
  $('rooms').textContent = String(p.rooms);
  $('tickets').innerHTML = p.tickets.length
    ? p.tickets.map((t) => `<li><span>${esc(t.name)}</span><span>${t.wins} 🎟</span></li>`).join('')
    : '<li class="muted"><span>nadie ganó todavía</span><span></span></li>';
}

function toast(text: string) {
  const el = $('inflowToast'); el.textContent = text; el.classList.add('on');
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove('on'), 2200);
}

function renderSeats() {
  const filled = state.seats.map((s) => `<div class="seat full ${s.id === state.you ? 'me' : ''}"><div><div class="n">${s.num}</div><div class="nm">${esc(s.name)}</div></div></div>`);
  const empty = Array.from({ length: ROOM_MAX - state.seats.length }, () => '<div class="seat">vacío</div>');
  $('seats').innerHTML = [...filled, ...empty].join('');
}

function feed(text: string, red = false) {
  const el = document.createElement('div'); el.textContent = text; if (red) el.className = 'red';
  const f = $('feed'); f.prepend(el);
  while (f.children.length > 6) f.lastChild?.remove();
}

function banner(html: string, ms: number) {
  const b = $('banner'); b.innerHTML = html; b.classList.remove('hidden');
  if (ms > 0) setTimeout(() => b.classList.add('hidden'), ms);
}

const seatNum = (id: number | null) => (id === null ? '' : state.seats.find((s) => s.id === id)?.num ?? '???');

// ---------- messages ----------
net.on((m: ServerMsg) => {
  switch (m.t) {
    case 'hello':
      state.nonce = m.nonce; state.authed = false; updatePlay();
      $('connectBtn').classList.toggle('hidden', false);
      $('guestBtn').classList.toggle('hidden', !m.allowGuests);
      $('guestName').classList.toggle('hidden', !m.allowGuests);
      // a reconnect loses the session; guests come back silently, wallets must sign again
      if (state.authMode === 'guest') net.send({ t: 'guest', name: state.name || 'guest' });
      else if (state.authMode === 'wallet') $('me').textContent = 'reconectá la wallet';
      if (state.screen !== 'lobby') show('lobby');
      break;
    case 'authed':
      state.authed = true; state.name = m.name; state.num = m.num;
      $('me').textContent = `jugador ${m.num} · ${m.name}${m.wallet ? '' : ' (invitado)'}`;
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
      $('lastDraw').innerHTML = s.winners.length
        ? `<div>ronda #${s.epoch} · pote ${fmtSol(sol(s.potLamports))}</div><ol>${s.winners.slice(0, 8).map((w) => `<li><span>${esc(w.name || w.wallet.slice(0, 6))}</span><span>${fmtSol(sol(w.lamports))}</span></li>`).join('')}</ol><div class="small muted">root ${s.merkleRoot.slice(0, 16)}…</div>`
        : `ronda #${s.epoch}: sin ganadores, ${fmtSol(sol(s.rollover))} pasa a la próxima`;
      break;
    }
    case 'queued': $('queueInfo').textContent = `en cola (#${m.position})`; break;
    case 'room': {
      state.seats = m.seats; state.you = m.you; state.startsAt = m.startsAt; state.phase = m.state;
      $('roomId').textContent = m.roomId.toUpperCase();
      $('queueInfo').textContent = '';
      if (m.state === 'waiting' || m.state === 'countdown') { show('waiting'); renderSeats(); }
      if (m.state === 'live') {
        arena.reset(); arena.setRoom(m.seed, m.seats, m.you);
        state.alive = m.seats.length; $('feed').innerHTML = '';
        show('game'); banner('¡A JUGAR!', 1200);
      }
      break;
    }
    case 'snap': arena.pushSnap(m); break;
    case 'event': {
      state.alive = m.left;
      arena.markDeath(m.victim);
      const v = seatNum(m.victim);
      const how = m.cause === 'ring' ? 'quedó fuera del círculo' : m.cause === 'left' ? 'abandonó' : `por ${seatNum(m.by)}`;
      feed(`jugador ${v} eliminado ${how}`, m.victim === state.you);
      if (m.victim === state.you) banner(`ELIMINADO<small>quedan ${m.left} · mirando la partida</small>`, 2500);
      break;
    }
    case 'result': {
      const won = m.winner === state.you;
      const who = m.winner === null ? 'NADIE GANA' : won ? 'GANASTE' : `GANA ${seatNum(m.winner)}`;
      const sub = m.ticketAwarded ? (won ? '+1 ticket para el sorteo de las próximas horas' : 'se lleva 1 ticket del pote') : won ? 'sin ticket: faltaron wallets verificadas en la sala' : '';
      banner(`${who}<small>${sub}</small>`, 0);
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
    $('waitStatus').textContent = state.phase === 'countdown' && state.startsAt
      ? `empieza en ${Math.max(0, Math.ceil((state.startsAt - Date.now()) / 1000))}`
      : `esperando jugadores · ${n}/${ROOM_MAX}`;
  } else {
    arena.frame(dt);
    const me = arena.me();
    $('hpFill').style.width = `${me && me.alive ? me.hp : 0}%`;
    $('aliveCount').textContent = `${state.alive} / ${state.seats.length}`;
    if (state.pot) $('miniPot').textContent = fmtSol(sol(state.pot.lamports));
  }
  requestAnimationFrame(frame);
}

net.connect();
show('lobby');
requestAnimationFrame(frame);
