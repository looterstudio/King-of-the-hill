// Vercel build: Vercel hosts static files, not the WebSocket game server. With VITE_SERVER_URL set
// (where the Docker game server runs, e.g. https://koth.fly.dev) the live client is built and talks
// to that server; without it the playable offline demo (bots, simulated pot) is built.
import { execSync } from 'node:child_process';
const live = !!process.env.VITE_SERVER_URL;
console.log(live ? `[vercel] live client -> ${process.env.VITE_SERVER_URL}` : '[vercel] no VITE_SERVER_URL: building the offline demo');
execSync(`npx vite build client ${live ? '' : '--mode demo '}--outDir ../dist-vercel --emptyOutDir`, { stdio: 'inherit' });
