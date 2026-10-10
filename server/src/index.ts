// Game server entry: HTTP (static client + small JSON API) and one WebSocket endpoint.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { SKINS, playerNumber } from '../../shared/src/constants.ts';
import { loginMessage, type ClientMsg, type PotView, type ProfileView, type ServerMsg } from '../../shared/src/protocol.ts';
import { sanitizeInput } from '../../shared/src/sim.ts';
import { config } from './config.ts';
import { fromRaw, makePot } from './pot.ts';
import { PriceFeed } from './price.ts';
import { CANDLE_MS, Epochs } from './epoch.ts';
import { Client, Matchmaker } from './room.ts';
import { Profiles } from './profile.ts';
import { InProcessHost, WorkerHost } from './host.ts';

const MIN_VERIFIED = Number(process.env.MIN_VERIFIED_FOR_TICKET ?? (config.requireWallet ? 4 : 1));

const pot = makePot(config);
const price = new PriceFeed(config);
const epochs = new Epochs(config, pot, () => Date.now(), () => price.usd());
const profiles = new Profiles(config.dataDir);
const clients = new Set<Client>();
const byWallet = new Map<string, Client>();
let nextId = 1;

// anti-cheat flags: the player keeps playing but earns nothing; reviewers read data/flags.jsonl
const flags: { at: number; room: string; mode: string; wallet: string | null; name: string; reason: string }[] = [];
mkdirSync(config.dataDir, { recursive: true });
const mm = new Matchmaker({
  minVerifiedForTicket: MIN_VERIFIED,
  fillWithBots: config.botFill,
  onScore: (_room, c, points) => ({ awarded: true, epoch: epochs.recordWin(c.wallet!, c.name, points) }),
  onResult: (_room, c, place, kills) => { profiles.match(c.wallet!, place, kills); void sendProfile(c); },
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
    closeFrom: epochs.endsAt - CANDLE_MS, holdTokens: epochs.requirement(), symbol: config.tokenSymbol, solUsd: price.solUsd(),
    mint: config.tokenMint, holdMinUsd: config.holdMinUsd,
  };
}

pot.on('inflow', (f: { lamports: bigint; source: string }) => everyone({ t: 'inflow', inflow: { lamports: f.lamports.toString(), at: Date.now(), source: f.source } }));
epochs.on('settled', (s) => {
  everyone({ t: 'settled', settled: s });
  // the hour's winners: on their record, and told right away if they're here
  for (const w of s.winners) { profiles.prize(w.wallet, BigInt(w.lamports)); const c = byWallet.get(w.wallet); if (c) void sendProfile(c); }
});
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
  // one malformed request line (`GET // HTTP/1.1`) used to throw here and kill every match
  try { serveHttp(req, res); } catch (e) {
    console.error('[http]', (e as Error).message);
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
}

function serveHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL('http://x' + (req.url?.startsWith('/') ? req.url : '/'));
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
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024, perMessageDeflate: false });

// ---------- sockets ----------
const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const cleanName = (s: unknown) => String(s ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'guest';

// Anyone may play. Points for the pot need the epoch's hold requirement, which is checked again at
// hidden snapshots and at the close (epoch.ts): this answer is only what the player is told now.
// null = holding enough, otherwise why not.
async function holdStatus(wallet: string): Promise<string | null> {
  const need = epochs.requirement();
  if (need <= 0) return null;
  let h;
  try { h = await pot.holderTokens(wallet); } catch { return 'could not read your balance yet'; }
  const raw = epochs.rawRequirement(epochs.current, h.decimals);
  if (h.raw >= raw) return null;
  return `hold ${fromRaw(raw, h.decimals)} $${config.tokenSymbol} to score points for the pot (you have ${fromRaw(h.raw, h.decimals)})`;
}

// a connected wallet's lobby profile: balance, whether it qualifies this hour, standing, record
async function profileOf(wallet: string): Promise<ProfileView> {
  const need = epochs.requirement(), st = epochs.standing(wallet), rec = profiles.get(wallet);
  let balance: string | null = null, needS: string | null = null, holds = need <= 0, why: string | null = null;
  if (config.tokenMint || config.potSource === 'mock') { // (the mock pot answers for any wallet: dev runs see the whole flow)
    try {
      const h = await pot.holderTokens(wallet), raw = epochs.rawRequirement(epochs.current, h.decimals);
      balance = fromRaw(h.raw, h.decimals); needS = need > 0 ? fromRaw(raw, h.decimals) : null;
      holds = h.raw >= raw;
      if (!holds) why = `hold ${needS} $${config.tokenSymbol} (≈ $${config.holdMinUsd}) all hour to qualify`;
    } catch { why = 'could not read your balance yet'; holds = false; }
  } else if (need > 0) { holds = false; why = `$${config.tokenSymbol} isn't live yet`; }
  const voided = epochs.isVoid(epochs.scoringEpoch(), wallet);
  if (voided) why = 'your balance dipped under the requirement at a check this hour: points void until the next hour';
  return { wallet, symbol: config.tokenSymbol, balance, need: needS, holdMinUsd: config.holdMinUsd, qualified: holds && !voided, why, points: st.points, rank: st.rank, ...rec };
}
async function sendProfile(c: Client) {
  if (!c.wallet || !c.authed) return;
  try { c.send({ t: 'profile', profile: await profileOf(c.wallet) }); } catch (e) { console.warn('[profile]', (e as Error).message); }
}

async function signIn(c: Client, msg: Extract<ClientMsg, { t: 'auth' }>) {
  let pk: Uint8Array, sig: Uint8Array;
  try { pk = bs58.decode(String(msg.wallet)); sig = bs58.decode(String(msg.sig)); } catch { return c.send({ t: 'error', msg: 'bad signature encoding' }); }
  if (pk.length !== 32 || sig.length !== 64) return c.send({ t: 'error', msg: 'bad signature' });
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(loginMessage(c.nonce)), sig, pk);
  if (!ok) return c.send({ t: 'error', msg: 'signature does not match' });
  const wallet = bs58.encode(pk);
  const eligible = await holdStatus(wallet);
  // one live seat per wallet: a second tab replaces the first
  const prev = byWallet.get(wallet);
  if (prev && prev !== c) { prev.send({ t: 'error', msg: 'signed in somewhere else' }); prev.ws.close(); }
  byWallet.set(wallet, c);
  c.wallet = wallet; c.name = shortWallet(wallet); c.authed = true;
  c.send({ t: 'authed', name: c.name, wallet, num: c.num, eligible });
  return sendProfile(c);
}

async function onMessage(c: Client, msg: ClientMsg) {
  switch (msg.t) {
    case 'in': {
      c.room?.input(c, sanitizeInput(msg));
      return;
    }
    case 'auth': {
      if (c.authed || c.authing) return; // a burst of auths with fresh keys used to queue one RPC read each
      c.authing = true;
      try { return await signIn(c, msg); } finally { c.authing = false; }
    }
    case 'guest': {
      if (c.authed) return;
      if (!config.allowGuests) return c.send({ t: 'error', msg: 'connect a wallet to play' });
      c.name = cleanName(msg.name); c.authed = true;
      // mock pot only: give guests a throwaway key so the whole ticket -> payout path runs locally
      if (config.potSource === 'mock') c.wallet = bs58.encode(nacl.sign.keyPair().publicKey);
      return c.send({ t: 'authed', name: c.name, wallet: c.wallet, num: c.num, eligible: c.wallet ? null : 'guests play for fun: connect a wallet to score points for the pot' });
    }
    case 'me': {
      if (!c.lobbyAction()) return;
      return sendProfile(c);
    }
    case 'queue': {
      if (!c.authed) return c.send({ t: 'error', msg: 'sign in first' });
      if (!c.lobbyAction()) return;
      if (c.room?.phase === 'over') c.room.remove(c);
      if (clients.size > config.maxConnections) return c.send({ t: 'error', msg: 'server full' });
      c.skin = Math.max(0, Math.min(SKINS.length - 1, Math.floor(Number(msg.skin)) || 0));
      return mm.enqueue(c, { mode: msg.mode, party: msg.party, room: msg.room });
    }
    case 'spec': {
      const r = { dir: msg.dir === -1 ? -1 as const : msg.dir === 1 ? 1 as const : undefined, target: Number.isInteger(msg.target) ? msg.target : undefined,
        at: msg.at === null ? null : Array.isArray(msg.at) ? [Number(msg.at[0]), Number(msg.at[1])] as [number, number] : undefined };
      return c.room?.spectate(c, r);
    }
    case 'leave': if (c.lobbyAction()) mm.leave(c); return;
    case 'rtc': {
      // squad voice: relay offers, answers and ICE candidates to a teammate in the same live match,
      // nobody else. Audio itself goes peer to peer and never touches the server.
      const room = c.room, to = Number(msg.to);
      if (!room || room.phase !== 'live' || room.mode === 'solo' || !Number.isInteger(to)) return;
      const peer = room.seats.find((s) => s.id === to);
      if (!peer || peer === c || peer.room !== room || peer.team !== c.team) return;
      const body = JSON.stringify({ t: 'rtc', from: c.id, data: msg.data });
      if (body.length > 12_000) return;
      return peer.sendRaw(body);
    }
  }
}

// behind a proxy (Fly, nginx) the socket address is the proxy's: trust its forwarded header only when told to
const ipOf = (req: IncomingMessage) => (config.trustProxy ? String(req.headers['fly-client-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]).trim() : '') || req.socket.remoteAddress || '?';
const perIp = new Map<string, number>();

wss.on('error', (e) => console.error('[wss]', e.message));
wss.on('connection', (ws, req) => {
  // a protocol error (frame over maxPayload, bad UTF-8, unmasked frame) is emitted on the socket:
  // without a listener Node throws and the whole server goes down with it
  ws.on('error', () => ws.terminate());
  if (clients.size >= config.maxConnections) { ws.close(1013, 'server full'); return; }
  const ip = ipOf(req), n = perIp.get(ip) ?? 0;
  if (n >= config.maxPerIp) { ws.close(1013, 'too many connections from this address'); return; }
  perIp.set(ip, n + 1);
  ws.on('close', () => { const k = (perIp.get(ip) ?? 1) - 1; if (k > 0) perIp.set(ip, k); else perIp.delete(ip); });
  // idle sockets that never sign in don't get to hold a slot
  const signInTimer = setTimeout(() => { if (!c.authed) ws.close(1008, 'sign in timeout'); }, 20_000);
  ws.on('close', () => clearTimeout(signInTimer));
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

const shutdown = () => { price.stop(); mm.stop(); epochs.stop(); pot.stop(); try { profiles.flush(); } catch { /* read-only disk */ } wss.close(); http.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown);
// last resort: a bug in one handler must not take every match down with it; the specific failure
// paths are handled where they happen, this only logs whatever slips through
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('SIGTERM', shutdown);
