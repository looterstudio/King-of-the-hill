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
  maxRooms: int(env.MAX_ROOMS, 600),
  msgsPerSecond: int(env.MSGS_PER_SECOND, 60),

  requireWallet: bool(env.REQUIRE_WALLET, false),
  allowGuests: bool(env.ALLOW_GUESTS, true),

  // pot
  potSource: (env.POT_SOURCE ?? 'mock') as 'mock' | 'solana',
  rpcUrl: env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  vaultAddress: env.VAULT_ADDRESS ?? '',   // vault PDA: seeds ["vault"]
  configAddress: env.CONFIG_ADDRESS ?? '', // config PDA: seeds ["config"]
  tokenMint: env.TOKEN_MINT ?? '',
  holdMin: BigInt(env.HOLD_MIN_RAW ?? '0'), // min token balance (raw units) to enter a room
  vaultReserveLamports: BigInt(env.VAULT_RESERVE_LAMPORTS ?? '1000000'), // rent + fees buffer, never paid out

  // payout policy
  payoutMode: (env.PAYOUT_MODE ?? 'prorata') as 'prorata' | 'draw',
  rolloverBps: int(env.ROLLOVER_BPS, 1000), // 10% of every pot seeds the next one
  drawTiersBps: (env.DRAW_TIERS_BPS ?? '6000,2500,1500').split(',').map((s) => Number(s)),
};

export type Config = typeof config;
