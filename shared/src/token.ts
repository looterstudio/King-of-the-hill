// The game's coin, in one place. When it launches, paste its contract address (CA) into `mint`:
// the lobby shows it with buy links, the server checks holders' balances against it (TOKEN_MINT in
// the server's environment overrides it), and the demo build shows it too.
export const TOKEN = {
  mint: 'Fc89CovCoBCSgqnXGxyEPZpx5Tq8L3Kx6yChJgGLpump', // the CA
  symbol: 'KOTH',
  holdMinUsd: 25,       // hold at least this much of the token all hour to qualify for the hourly prize
  holdTokens: 0,        // optional cap in tokens (whichever is less); 0 = dollars only
};

export const buyLinks = (mint: string) => ({
  pump: `https://pump.fun/coin/${mint}`,
  jupiter: `https://jup.ag/swap/SOL-${mint}`,
  dexscreener: `https://dexscreener.com/solana/${mint}`,
});
