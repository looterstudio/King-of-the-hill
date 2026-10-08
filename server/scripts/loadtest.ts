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
  let me = -1, self: { x: number; z: number; alive: boolean } | null = null, others: number[][] = [];
  let live = false;
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  ws.on('open', () => { open++; });
  ws.on('error', () => { errors++; });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMsg;
    if (m.t === 'hello') send({ t: 'guest', name: `bot${i}` });
    else if (m.t === 'authed') send({ t: 'queue' });
    else if (m.t === 'room') { me = m.you; live = m.state === 'live'; }
    else if (m.t === 'snap') { snaps++; self = m.self; others = m.others; }
    else if (m.t === 'result') { results++; live = false; setTimeout(() => send({ t: 'queue' }), 6500 + Math.random() * 1500); }
  });
  let yaw = Math.random() * 6, seq = 0;
  const timer = setInterval(() => {
    if (!live || !self || !self.alive) return;
    let target: number[] | null = null, best = Infinity;
    for (const o of others) { const d = Math.hypot(o[1] - self.x, o[3] - self.z); if (d < best) { best = d; target = o; } }
    if (target) yaw = Math.atan2(-(target[1] - self.x), -(target[3] - self.z));
    else yaw += (Math.random() - 0.5) * 0.3;
    send({ t: 'in', seq: ++seq, fwd: 1, strafe: Math.sin(seq / 20), yaw, pitch: 0, jump: Math.random() < 0.01, sprint: true, slide: false, grapple: false, fire: !!target && best < 120, aim: false, reload: false, slot: 0, view: 0 });
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
