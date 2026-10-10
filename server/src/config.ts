import { cpus } from 'node:os';
// Every knob comes from the environment so the same build runs locally (mock pot, guests on)
// and in production (real vault, wallets required, guests off).
const env = process.env;
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === '1' || v === 'true');
const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  port: int(env.PORT, 8787),
  dataDir: env.DATA_DIR ?? './data',
  staticDir: env.STATIC_DIR ?? './dist',

  // capacity guards for one process; scale out by running more processes behind a router
  maxConnections: int(env.MAX_CONNECTIONS, 5000),
  maxPerIp: int(env.MAX_PER_IP, 16),            // sockets per address (a household or a cafe shares one)
  trustProxy: env.TRUST_PROXY === '1',          // behind Fly/nginx: take the client address from the proxy's header
  maxRooms: int(env.MAX_ROOMS, 10),       // 10 x 100 players per process, tested
  openRooms: int(env.OPEN_ROOMS, 5),      // rooms filling at the same time
  adminToken: env.ADMIN_TOKEN ?? '',      // reads /api/admin/flags
  // live matches run on this many worker threads (0 = in the main thread); default: all cores but one
  workers: int(env.WORKERS, Math.max(0, cpus().length - 1)),
  msgsPerSecond: int(env.MSGS_PER_SECOND, 60),

  requireWallet: bool(env.REQUIRE_WALLET, false),
  allowGuests: bool(env.ALLOW_GUESTS, true),

  // pot
  potSource: (env.POT_SOURCE ?? 'mock') as 'mock' | 'solana',
  rpcUrl: env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  vaultAddress: env.VAULT_ADDRESS ?? '',   // vault PDA: seeds ["vault"]
  configAddress: env.CONFIG_ADDRESS ?? '', // config PDA: seeds ["config"]
  tokenMint: env.TOKEN_MINT ?? '',
  // to score points a wallet must hold min(HOLD_TOKENS, $HOLD_MIN_USD worth), fixed per epoch
  holdMinUsd: Number(env.HOLD_MIN_USD ?? '50'),
  holdTokens: Number(env.HOLD_TOKENS ?? '50000'),
  tokenSymbol: env.TOKEN_SYMBOL ?? 'KING',
  solMint: 'So11111111111111111111111111111111111111112',
  mockSolUsd: Number(env.MOCK_SOL_USD ?? '150'),
  priceUrl: env.PRICE_URL ?? 'https://lite-api.jup.ag/price/v3?ids=', // Jupiter price API, mint appended
  mockPriceUsd: Number(env.MOCK_PRICE_USD ?? '0.0001'),
  vaultReserveLamports: BigInt(env.VAULT_RESERVE_LAMPORTS ?? '1000000'), // rent + fees buffer, never paid out

  // payout policy
  payoutMode: (env.PAYOUT_MODE ?? 'prorata') as 'prorata' | 'draw',
  rolloverBps: int(env.ROLLOVER_BPS, 1000), // 10% of every pot seeds the next one
  drawTiersBps: (env.DRAW_TIERS_BPS ?? '6000,2500,1500').split(',').map((s) => Number(s)),
};

export type Config = typeof config;
