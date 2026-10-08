/// <reference types="vite/client" />
import bs58 from 'bs58';
import { ITEMS, MAP_HALF, PERKS, PLAYER_HP, RESULT_MS, ROOM_MAX, SHIELD_MAX, TICK_HZ, WEAPONS } from '../../shared/src/constants.ts';
import { loginMessage, type PotView, type RoomSeat, type ServerMsg } from '../../shared/src/protocol.ts';
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
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// a hand-drawn loop around banner words
const CIRCLE = '<svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true"><path d="M150 8 C 250 6, 296 34, 290 62 C 284 98, 210 114, 140 112 C 60 110, 6 92, 8 58 C 10 26, 70 8, 168 12"/></svg>';

// `vite build --mode demo` runs the whole game in the browser with bots; otherwise talk to the server
const DEMO = import.meta.env.MODE === 'demo';
const net: Net | LocalNet = DEMO ? new LocalNet() : new Net();
const jar = new PotJar($<HTMLCanvasElement>('jar'), { string: true, marks: false });
const miniJar = new PotJar($<HTMLCanvasElement>('miniPig'), { string: false, marks: false });
const canvas = $<HTMLCanvasElement>('arena');
const game = new Game3D(canvas, $<HTMLDivElement>('tags'));
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
  if (locked && !state.dropped) { state.dropped = true; banner('Drop!', `${state.seats.length} players · the hill is in the middle`, true, 2200); }
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
function drawMinimap() {
  const S = 170, k = S / (MAP_HALF * 2), toX = (x: number) => (x + MAP_HALF) * k, toY = (z: number) => (z + MAP_HALF) * k;
  mini.clearRect(0, 0, S, S);
  if (game.world) drawIsland(mini, game.world, S, false);
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
    case 'inflow': { const v = sol(m.inflow.lamports); jar.inflow(v); miniJar.inflow(v); toast(`+${v.toFixed(3)} SOL · ${m.inflow.source}`); break; }
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
      if (m.state === 'waiting' || m.state === 'countdown') { if (state.screen !== 'waiting') shownSeats = new Set(); show('waiting'); renderSeats(); drawPreview(m.seed); }
      if (m.state === 'live') {
        state.over = false; state.aimed = false; state.dropped = false;
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
      if (m.by === state.you && m.victim !== state.you) { hint(m.head ? `headshot · ${label(m.victim)} eliminated` : `${label(m.victim)} eliminated`, 1800); sfx.elim(); hitmarker(m.head, true); }
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
      const w = me.slots[me.cur], def = w ? WEAPONS[w] : null, mag = me.mags[me.cur] ?? 0;
      $('hpFill').style.width = `${(me.hp / PLAYER_HP) * 100}%`;
      $('hpNum').textContent = String(me.hp);
      $('shFill').style.width = `${(me.shield / SHIELD_MAX) * 100}%`;
      $('shNum').textContent = String(me.shield);
      document.querySelector('.hud-bl')!.classList.toggle('low', me.hp <= 30);
      for (const sel of ['.hud-bl', '.hud-br']) (document.querySelector(sel) as HTMLElement).style.visibility = me.alive ? 'visible' : 'hidden';
      $('ammo').textContent = def ? String(mag) : '–';
      $('ammoMax').textContent = def ? `/${def.mag}` : '';
      $('reloading').classList.toggle('hidden', me.reloadT <= 0);
      $('magTally').innerHTML = def ? Array.from({ length: Math.min(def.mag, 30) }, (_, i) => `<i class="${i < mag ? '' : 'spent'}"></i>`).join('') : '';
      $('weapon').textContent = def ? def.name : 'unarmed';
      $('weapon').style.color = def ? RARITY_CSS[def.rarity] : '';
      $('weapons').innerHTML = me.slots.map((s, i) => s
        ? `<li class="${i === me.cur ? 'on' : ''}" style="color:${RARITY_CSS[WEAPONS[s].rarity]}"><span>${WEAPONS[s].name}</span><em>${me.mags[i]}/${WEAPONS[s].mag}</em></li>`
        : `<li class="empty"><span>empty</span><em></em></li>`).join('');
      const shields = me.items.big + me.items.mini;
      $('items').innerHTML = `<span class="${shields ? '' : 'empty'}"><kbd>5</kbd> shield ×${me.items.big}<small>+${me.items.mini} mini</small></span>`
        + `<span class="${me.items.med ? '' : 'empty'}"><kbd>6</kbd> medkit ×${me.items.med}</span>`
        + `<span class="${me.perk ? '' : 'empty'}" style="${me.perk ? `color:${RARITY_CSS[PERKS[me.perk.kind].rarity]}` : ''}"><kbd>G</kbd> ${me.perk ? `${PERKS[me.perk.kind].name} ×${me.perk.n}` : 'no perk'}</span>`;
      $('useBar').classList.toggle('hidden', !me.use);
      if (me.use) { const total = ITEMS[me.use.item].use; $('useLabel').textContent = ITEMS[me.use.item].name; $('useFill').style.width = `${(1 - me.use.t / total) * 100}%`; }
      $('prompt').innerHTML = game.prompt;
      $('killCount').textContent = String(me.kills);
      const body = game.me;
      const scoped = input.aim && (w === 'heavy' || w === 'hunting') && me.alive;
      const spread = body && w ? spreadFor(body, w, input.aim) : 0.02;
      $('crosshair').style.setProperty('--s', `${Math.round(6 + spread * 900)}px`);
      $('crosshair').style.visibility = me.alive && !scoped ? 'visible' : 'hidden';
      $('scope').classList.toggle('hidden', !scoped);
      if (body?.gliding && me.alive) hint('gliding · look down to dive, look up to float', 400);
    }
    const nk = game.nukes[0];
    $('nukeWarn').classList.toggle('hidden', !nk);
    if (nk) $('nukeWarn').textContent = `☢ ATOMIC BOMB INCOMING · ${Math.ceil(nk.t)}s · get out of the red zone`;
    $('aliveCount').textContent = String(game.alive);
    const L = game.leader;
    $('leader').innerHTML = L ? `<span class="crown">♛</span> kill leader <b>${L[0] === state.you ? 'you' : esc(label(L[0]))}</b> · ${L[1]}` : '';
    const g = game.ring, st = $('storm');
    st.textContent = g.nr <= 0 && g.r <= 1 ? 'final storm' : g.closing ? `storm closing · ${g.nextIn}s` : `storm moves in ${g.nextIn}s`;
    st.classList.toggle('calm', !g.closing);
    if (state.pot) $('miniPot').textContent = fmtSol(sol(state.pot.lamports));
    if ((miniT += dt) > 0.1) { miniT = 0; drawMinimap(); }
    miniJar.frame(dt);
  }
  requestAnimationFrame(frame);
}

net.connect();
show('lobby');
requestAnimationFrame(frame);
