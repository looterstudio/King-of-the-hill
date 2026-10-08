// Game server entry: HTTP (static client + small JSON API) and one WebSocket endpoint.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { playerNumber } from '../../shared/src/constants.ts';
import { loginMessage, type ClientMsg, type PotView, type ServerMsg } from '../../shared/src/protocol.ts';
import { sanitizeInput } from '../../shared/src/sim.ts';
import { config } from './config.ts';
import { fromRaw, makePot } from './pot.ts';
import { PriceFeed, rawNeeded } from './price.ts';
import { Epochs } from './epoch.ts';
import { Client, Matchmaker } from './room.ts';
import { InProcessHost, WorkerHost } from './host.ts';

const MIN_VERIFIED = Number(process.env.MIN_VERIFIED_FOR_TICKET ?? (config.requireWallet ? 4 : 1));

const pot = makePot(config);
const price = new PriceFeed(config);
const epochs = new Epochs(config, pot);
const clients = new Set<Client>();
const byWallet = new Map<string, Client>();
let nextId = 1;

// anti-cheat flags: the player keeps playing but earns nothing; reviewers read data/flags.jsonl
const flags: { at: number; room: string; mode: string; wallet: string | null; name: string; reason: string }[] = [];
mkdirSync(config.dataDir, { recursive: true });
const mm = new Matchmaker({
  minVerifiedForTicket: MIN_VERIFIED,
  onWin: (_room, winner, tickets) => ({ awarded: true, epoch: epochs.recordWin(winner.wallet!, winner.name, tickets) }),
  onFlag: (room, c, f) => {
    const row = { at: Date.now(), room: room.id, mode: room.mode, wallet: c?.wallet ?? null, name: c?.name ?? `#${f.id}`, reason: f.reason };
    flags.push(row); if (flags.length > 500) flags.shift();
    appendFileSync(join(config.dataDir, 'flags.jsonl'), JSON.stringify(row) + '\n');
    console.warn('[anticheat]', row.name, row.reason);
  },
}, config.maxRooms, config.openRooms);

const everyone = (msg: ServerMsg) => { const s = JSON.stringify(msg); for (const c of clients) c.sendRaw(s, true); };

function potView(): PotView {
  return {
    epoch: epochs.current, epochEndMs: epochs.endsAt, lamports: pot.balance().toString(),
    rolloverLamports: epochs.rolloverIn.toString(), commit: epochs.commitFor(epochs.current),
    online: clients.size, rooms: mm.rooms.size, tickets: epochs.leaderboard(10),
  };
}

pot.on('inflow', (f: { lamports: bigint; source: string }) => everyone({ t: 'inflow', inflow: { lamports: f.lamports.toString(), at: Date.now(), source: f.source } }));
epochs.on('settled', (s) => everyone({ t: 'settled', settled: s }));
setInterval(() => everyone({ t: 'pot', pot: potView() }), 2000);
// the room list, for players in the lobby
setInterval(() => { const s = JSON.stringify({ t: 'lobby', rooms: mm.lobby(Date.now()) } satisfies ServerMsg); for (const c of clients) if (!c.room) c.sendRaw(s, true); }, 1000);

// ---------- http ----------
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const staticRoot = resolve(config.staticDir);
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') { const h = mm.host.stats(); return json(res, 200, { ok: true, clients: clients.size, rooms: mm.rooms.size, queued: mm.queued, tickMs: +h.tickMs.toFixed(2), lobbyMs: +mm.lastTickMs.toFixed(2), workers: h.workers }); }
  if (url.pathname === '/api/pot') return json(res, 200, potView());
  if (url.pathname === '/api/rooms') return json(res, 200, mm.lobby(Date.now()));
  if (url.pathname === '/api/admin/flags') {
    if (!config.adminToken || req.headers.authorization !== `Bearer ${config.adminToken}`) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, flags);
  }
  const m = /^\/api\/epochs\/(\d+)$/.exec(url.pathname);
  if (m) {
    // public audit trail: anyone can recompute the root from the claims list
    const f = join(config.dataDir, 'epochs', `${Number(m[1])}.json`);
    if (!existsSync(f)) return json(res, 404, { error: 'not settled' });
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(readFileSync(f));
  }
  let path = normalize(join(staticRoot, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(staticRoot)) { res.writeHead(403); return res.end(); }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(staticRoot, 'index.html');
  if (!existsSync(path)) { res.writeHead(404); return res.end('client not built: run npm run build, or use npm run dev:client'); }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
}

const http = createServer(handleHttp);
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 2048, perMessageDeflate: false });

// ---------- sockets ----------
const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const cleanName = (s: unknown) => String(s ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'guest';

// null = may play. Uses the 15-min median price, and fails closed when the price feed is down.
async function checkHold(wallet: string): Promise<string | null> {
  if (config.holdMinUsd <= 0) return null;
  const usd = price.usd();
  if (usd === null) return 'token price unavailable, try again in a minute';
  let h;
  try { h = await pot.holderTokens(wallet); } catch { return 'could not read your balance, try again'; }
  const need = rawNeeded(config.holdMinUsd, usd, h.decimals);
  if (h.raw >= need) return null;
  return `you need $${config.holdMinUsd} of the token to play: ${fromRaw(need, h.decimals)} tokens (you have ${fromRaw(h.raw, h.decimals)})`;
}

async function onMessage(c: Client, msg: ClientMsg) {
  switch (msg.t) {
    case 'in': {
      c.room?.input(c, sanitizeInput(msg));
      return;
    }
    case 'auth': {
      if (c.authed) return;
      let pk: Uint8Array, sig: Uint8Array;
      try { pk = bs58.decode(String(msg.wallet)); sig = bs58.decode(String(msg.sig)); } catch { return c.send({ t: 'error', msg: 'bad signature encoding' }); }
      if (pk.length !== 32 || sig.length !== 64) return c.send({ t: 'error', msg: 'bad signature' });
      const ok = nacl.sign.detached.verify(new TextEncoder().encode(loginMessage(c.nonce)), sig, pk);
      if (!ok) return c.send({ t: 'error', msg: 'signature does not match' });
      const wallet = bs58.encode(pk);
      const holdErr = await checkHold(wallet);
      if (holdErr) return c.send({ t: 'error', msg: holdErr });
      // one live seat per wallet: a second tab replaces the first
      const prev = byWallet.get(wallet);
      if (prev && prev !== c) { prev.send({ t: 'error', msg: 'signed in somewhere else' }); prev.ws.close(); }
      byWallet.set(wallet, c);
      c.wallet = wallet; c.name = shortWallet(wallet); c.authed = true;
      return c.send({ t: 'authed', name: c.name, wallet, num: c.num });
    }
    case 'guest': {
      if (c.authed) return;
      if (!config.allowGuests) return c.send({ t: 'error', msg: 'connect a wallet to play' });
      if (config.potSource === 'solana' && config.holdMinUsd > 0) return c.send({ t: 'error', msg: `connect a wallet holding $${config.holdMinUsd} of the token to play` });
      c.name = cleanName(msg.name); c.authed = true;
      // mock pot only: give guests a throwaway key so the whole ticket -> payout path runs locally
      if (config.potSource === 'mock') c.wallet = bs58.encode(nacl.sign.keyPair().publicKey);
      return c.send({ t: 'authed', name: c.name, wallet: c.wallet, num: c.num });
    }
    case 'queue': {
      if (!c.authed) return c.send({ t: 'error', msg: 'sign in first' });
      if (c.room?.phase === 'over') c.room.remove(c);
      if (clients.size > config.maxConnections) return c.send({ t: 'error', msg: 'server full' });
      // checked again on every queue, not just at login: selling after signing in must not keep you in
      if (c.wallet) { const holdErr = await checkHold(c.wallet); if (holdErr) return c.send({ t: 'error', msg: holdErr }); }
      return mm.enqueue(c, { mode: msg.mode, party: msg.party, room: msg.room });
    }
    case 'spec': {
      const r = { dir: msg.dir === -1 ? -1 as const : msg.dir === 1 ? 1 as const : undefined, target: Number.isInteger(msg.target) ? msg.target : undefined,
        at: msg.at === null ? null : Array.isArray(msg.at) ? [Number(msg.at[0]), Number(msg.at[1])] as [number, number] : undefined };
      return c.room?.spectate(c, r);
    }
    case 'leave': return mm.leave(c);
  }
}

wss.on('connection', (ws) => {
  if (clients.size >= config.maxConnections) { ws.close(1013, 'server full'); return; }
  const id = nextId++;
  const c = new Client(id, ws, playerNumber(randomBytes(2).readUInt16LE()), randomBytes(16).toString('hex'), config.msgsPerSecond);
  clients.add(c);
  c.send({ t: 'hello', nonce: c.nonce, requireWallet: config.requireWallet, allowGuests: config.allowGuests, holdMinUsd: config.holdMinUsd });
  c.send({ t: 'pot', pot: potView() });
  c.send({ t: 'lobby', rooms: mm.lobby(Date.now()) });
  if (epochs.lastSettled) c.send({ t: 'settled', settled: epochs.lastSettled });

  let strikes = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (!c.allow()) { if (++strikes > 120) ws.close(1008, 'rate limit'); return; }
    let msg: ClientMsg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    onMessage(c, msg).catch((e) => console.error('[ws]', e));
  });
  ws.on('close', () => {
    clients.delete(c);
    mm.leave(c);
    if (c.wallet && byWallet.get(c.wallet) === c) byWallet.delete(c.wallet);
  });
});

// dead-connection sweep: browsers that vanish without a close frame
const alive = new WeakSet<object>();
wss.on('connection', (ws) => { alive.add(ws); ws.on('pong', () => alive.add(ws)); });
setInterval(() => { for (const ws of wss.clients) { if (!alive.has(ws)) { ws.terminate(); continue; } alive.delete(ws); ws.ping(); } }, 20_000);

pot.start();
price.start();
epochs.start();
mm.host = config.workers > 0 ? new WorkerHost(config.workers, mm.deliver) : new InProcessHost(mm.deliver);
mm.start();
http.listen({ port: config.port, backlog: 4096 }, () => {
  console.log(`[pot-royale] :${config.port} pot=${config.potSource} payout=${config.payoutMode} hold=$${config.holdMinUsd} workers=${config.workers} wallet=${config.requireWallet} guests=${config.allowGuests} minVerified=${MIN_VERIFIED}`);
});

const shutdown = () => { price.stop(); mm.stop(); epochs.stop(); pot.stop(); wss.close(); http.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
