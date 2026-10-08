// Fills the server with bot players that queue, fight and re-queue, then reports tick cost.
//   npm run loadtest -- --bots 500 --url ws://localhost:8787/ws --seconds 60
import WebSocket from 'ws';
import type { ServerMsg } from '../../shared/src/protocol.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BOTS = Number(arg('bots', '200'));
const URL_ = arg('url', 'ws://localhost:8787/ws');
const SECONDS = Number(arg('seconds', '45'));
const health = URL_.replace(/^ws/, 'http').replace(/\/ws$/, '/health');

let snaps = 0, results = 0, open = 0, errors = 0;

function bot(i: number) {
  const ws = new WebSocket(URL_);
  let me = -1, players: { id: number; x: number; y: number; alive: boolean }[] = [];
  let live = false;
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  ws.on('open', () => { open++; });
  ws.on('error', () => { errors++; });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMsg;
    if (m.t === 'hello') send({ t: 'guest', name: `bot${i}` });
    else if (m.t === 'authed') send({ t: 'queue' });
    else if (m.t === 'room') { me = m.you; live = m.state === 'live'; }
    else if (m.t === 'snap') { snaps++; players = m.players; }
    else if (m.t === 'result') { results++; live = false; setTimeout(() => send({ t: 'queue' }), 6500 + Math.random() * 1500); }
  });
  let a = Math.random() * 6;
  const timer = setInterval(() => {
    if (!live) return;
    const self = players.find((p) => p.id === me);
    if (!self || !self.alive) return;
    let target = null, best = Infinity;
    for (const p of players) if (p.alive && p.id !== me) { const d = Math.hypot(p.x - self.x, p.y - self.y); if (d < best) { best = d; target = p; } }
    a += (Math.random() - 0.5) * 0.6;
    const toCenter = Math.atan2(-self.y, -self.x);
    const mv = Math.hypot(self.x, self.y) > 300 ? toCenter : a;
    const aim = target ? Math.atan2(target.y - self.y, target.x - self.x) : a;
    send({ t: 'in', seq: 0, mx: Math.cos(mv), my: Math.sin(mv), aim, fire: !!target && best < 700, dash: Math.random() < 0.02 });
  }, 1000 / 30);
  return () => { clearInterval(timer); ws.close(); };
}

const stops: (() => void)[] = [];
for (let i = 0; i < BOTS; i++) { stops.push(bot(i)); if (i % 50 === 49) await new Promise((r) => setTimeout(r, 100)); }

const t0 = Date.now();
const iv = setInterval(async () => {
  try {
    const h = (await (await fetch(health)).json()) as { clients: number; rooms: number; queued: number; tickMs: number };
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s open=${open} rooms=${h.rooms} queued=${h.queued} tickMs=${h.tickMs} snaps/s=${Math.round(snaps / 5)} rounds=${results} errors=${errors}`);
    snaps = 0;
  } catch (e) { console.log('health failed', (e as Error).message); }
}, 5000);

setTimeout(() => { clearInterval(iv); for (const s of stops) s(); setTimeout(() => process.exit(0), 300); }, SECONDS * 1000);
