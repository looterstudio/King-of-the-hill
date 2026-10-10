// The game's coin, in one place. When it launches, paste its contract address (CA) into `mint`:
// the lobby shows it with buy links, the server checks holders' balances against it (TOKEN_MINT in
// the server's environment overrides it), and the demo build shows it too.
export const TOKEN = {
  mint: '',             // the CA, e.g. 'So1aNa...pump'
  symbol: 'KING',
  holdMinUsd: 50,       // hold at least this much of the token all hour to qualify for the hourly prize
  holdTokens: 50_000,   // ...or this many tokens, whichever is less (a price crash never locks holders out)
};

export const buyLinks = (mint: string) => ({
  pump: `https://pump.fun/coin/${mint}`,
  jupiter: `https://jup.ag/swap/SOL-${mint}`,
  dexscreener: `https://dexscreener.com/solana/${mint}`,
});
