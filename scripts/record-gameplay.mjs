#!/usr/bin/env node
// One minute of gameplay for the landing page, recorded headlessly from the offline demo.
//
//   node scripts/record-gameplay.mjs            (or: npm run record:gameplay)
//
// Builds the demo (skip with --no-build), serves it, joins as a guest, and lets the bots' own brain
// play your seat (client/src/autopilot.ts) through the normal input path: the paper plane, the drop,
// looting, fights, all in third person. The page runs on a virtual clock the recorder steps one frame
// at a time (so the clip is smooth however slow the machine), each frame is screenshotted at 1280x720
// and the frames are encoded with ffmpeg into client/public/media/:
//   gameplay.mp4 (H.264), gameplay.webm (VP9), gameplay.jpg (poster)
// Without ffmpeg it stops with a message (the frames need an encoder either way).
//
// Options (flags or env):
//   --seconds 60        length of the final clip              (SECONDS)
//   --max-mb 8          size budget per video file            (MAX_MB)
//   --no-build          reuse dist-demo as it is
//   --headed            watch it play
//   --keep              keep the raw capture in the temp folder
// Browser: CHROME_PATH, else Playwright's own Chromium, else a Puppeteer Chrome in ~/.cache/puppeteer,
// else the system Chrome. Playwright: the project's playwright / playwright-core, or PLAYWRIGHT_CORE
// (a path to a playwright-core folder), or a global install.
import { spawn, execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-demo');
const OUT = path.join(ROOT, 'client', 'public', 'media');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, env, d) => { const i = args.indexOf(`--${n}`); return Number(i >= 0 ? args[i + 1] : process.env[env] ?? d); };
const SECONDS = opt('seconds', 'SECONDS', 60);
const MAX_MB = opt('max-mb', 'MAX_MB', 8);
const FPS = 30, W = 1280, H = 720;
const log = (...a) => console.log('[record]', ...a);

// ---------- tools ----------
function has(cmd) { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0; }
if (!has('ffmpeg')) { console.error('[record] ffmpeg not found: install it (brew install ffmpeg / apt install ffmpeg) and run again'); process.exit(1); }

function loadPlaywright() {
  const req = createRequire(path.join(ROOT, 'package.json'));
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright', 'playwright-core'];
  try {
    const g = execSync('npm root -g', { encoding: 'utf8' }).trim();
    tries.push(path.join(g, 'playwright'), path.join(g, 'playwright-core'));
    for (const d of fs.readdirSync(g)) tries.push(path.join(g, d, 'node_modules', 'playwright-core'));
  } catch { /* no npm on PATH */ }
  for (const dir of ['/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']) {
    try { for (const d of fs.readdirSync(dir)) tries.push(path.join(dir, d, 'node_modules', 'playwright-core')); } catch { /* not there */ }
  }
  for (const t of tries) { if (!t) continue; try { return req(t); } catch { /* next */ } }
  console.error('[record] Playwright not found: `npm i -D playwright-core` or set PLAYWRIGHT_CORE=/path/to/playwright-core');
  process.exit(1);
}

function findChrome(pw) {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { const p = pw.chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* not downloaded */ }
  const pup = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  try {
    for (const v of fs.readdirSync(pup).sort().reverse()) {
      for (const sub of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome', 'chrome-win64/chrome.exe']) {
        const p = path.join(pup, v, sub); if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* no puppeteer cache */ }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (fs.existsSync(p)) return p;
  console.error('[record] no Chrome found: set CHROME_PATH or run `npx playwright install chromium`');
  process.exit(1);
}

// ---------- build + serve ----------
if (!flag('no-build')) { log('building the demo'); execSync('npm run build:demo', { cwd: ROOT, stdio: 'inherit' }); }
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('[record] dist-demo is missing: run without --no-build'); process.exit(1); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = path.join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const URL_ = `http://127.0.0.1:${server.address().port}/#autotest`;

// ---------- play ----------
const pw = loadPlaywright();
const exe = findChrome(pw);
log('chrome:', exe);
const browser = await pw.chromium.launch({
  executablePath: exe, headless: !flag('headed'),
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=' + (process.platform === 'darwin' ? 'metal' : 'default'), '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  try { localStorage.setItem('trainingOff', '1'); localStorage.setItem('pr_view', 'tp'); localStorage.setItem('pr_mode', 'solo'); } catch { /* ignore */ }
  // a virtual clock: the page's time only moves when the recorder steps it, one video frame at a
  // time, so the clip plays at full speed however slowly this machine renders it
  let t = 0, seq = 1, rseq = 1;
  const base = Date.now(), timers = new Map(), rafs = new Map();
  performance.now = () => t;
  Date.now = () => base + Math.round(t);
  window.setTimeout = (fn, ms, ...a) => { const id = seq++; timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, a, every: 0 }); return id; };
  window.setInterval = (fn, ms, ...a) => { const id = seq++, every = Math.max(1, Number(ms) || 0); timers.set(id, { at: t + every, fn, a, every }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = rseq++; rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  window.__vt = {
    now: () => t,
    step(ms) {
      const end = t + ms;
      for (let guard = 0; guard < 20000; guard++) {
        let id = 0, x = null;
        for (const [k, v] of timers) if (v.at <= end && (!x || v.at < x.at)) { id = k; x = v; }
        if (!x) break;
        t = Math.max(t, x.at);
        if (x.every) x.at += x.every; else timers.delete(id);
        try { if (typeof x.fn === 'function') x.fn(...x.a); } catch (e) { console.error(e); }
      }
      t = end;
      const cbs = [...rafs.values()]; rafs.clear();
      for (const f of cbs) { try { f(t); } catch (e) { console.error(e); } }
    },
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => log('page error:', e.message));
await page.goto(URL_);
// until the match starts, time runs on its own (about real time) while we click through the lobby
let pumping = true;
const pump = (async () => { while (pumping) { await page.evaluate(() => window.__vt.step(50)).catch(() => {}); await new Promise((r) => setTimeout(r, 30)); } })();
await page.waitForSelector('#guestBtn', { state: 'visible' });
await page.fill('#guestName', 'you');
await page.click('#guestBtn');
await page.waitForFunction(() => !document.querySelector('#playBtn')?.hasAttribute('disabled'));
await page.click('#playBtn');
log('queued; waiting for the match');
for (let i = 0; i < 600 && !(await page.evaluate(() => !!window.__pr?.net?.room?.sim)); i++) await new Promise((r) => setTimeout(r, 100));
pumping = false; await pump;
await page.evaluate(async () => {
  const m = await window.__pr.autopilot();
  window.__ap = m.autopilot(window.__pr.net, window.__pr.input, { skill: 0.95, smooth: 0.35, tough: 90 });
});
log('match on, autopilot flying');

// ---------- capture: step one frame, screenshot, pipe to ffmpeg ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koth-rec-'));
const raw = path.join(tmp, 'raw.mp4');
const enc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-vf', `scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', raw], { stdio: ['pipe', 'inherit', 'inherit'] });
const write = (buf) => new Promise((r) => { if (!enc.stdin.write(buf)) enc.stdin.once('drain', r); else r(); });
const cdp = await ctx.newCDPSession(page);
const total = SECONDS * FPS, started = Date.now(), timeline = [];
for (let f = 0; f < total; f++) {
  await page.evaluate((ms) => window.__vt.step(ms), 1000 / FPS);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  await write(Buffer.from(shot.data, 'base64'));
  if (f % FPS === 0) {
    const st = await page.evaluate(() => window.__ap && { ...window.__ap });
    timeline.push({ at: f / FPS, ...st });
    if (f % (FPS * 5) === 0) log(`${f / FPS} s · ${st?.mode} · kills ${st?.kills} · ${st?.alive ? 'alive' : 'out'} · ${((f + 1) / ((Date.now() - started) / 1000)).toFixed(1)} frames/s rendered`);
  }
}
enc.stdin.end();
await new Promise((r) => enc.on('close', r));
await browser.close();
server.close();
log(`captured ${total} frames in ${((Date.now() - started) / 1000).toFixed(0)} s`);

// ---------- encode for the web ----------
fs.mkdirSync(OUT, { recursive: true });
const mb = (p) => fs.statSync(p).size / 1e6;
const ff = (a) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' }); if (r.status !== 0) throw new Error('ffmpeg failed: ' + a.join(' ')); };
const mp4 = path.join(OUT, 'gameplay.mp4'), webm = path.join(OUT, 'gameplay.webm'), jpg = path.join(OUT, 'gameplay.jpg');
for (const crf of [27, 30, 33, 36]) {
  ff(['-i', raw, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  log(`mp4 crf ${crf}: ${mb(mp4).toFixed(2)} MB`);
  if (mb(mp4) <= MAX_MB) break;
}
for (const crf of [38, 42, 46, 50]) {
  ff(['-i', raw, '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', webm]);
  log(`webm crf ${crf}: ${mb(webm).toFixed(2)} MB`);
  if (mb(webm) <= MAX_MB) break;
}
// the poster: the first moment the pilot was fighting, else a third of the way in
const fight = timeline.find((s) => s.mode === 'fight' && s.alive);
const posterAt = Math.min(SECONDS - 1, fight ? fight.at + 0.5 : SECONDS / 3);
ff(['-ss', posterAt.toFixed(2), '-i', raw, '-frames:v', '1', '-q:v', '4', jpg]);
if (!flag('keep')) fs.rmSync(tmp, { recursive: true, force: true }); else log('raw capture kept at', raw);
log(`done: ${path.relative(ROOT, mp4)} ${mb(mp4).toFixed(2)} MB · ${path.relative(ROOT, webm)} ${mb(webm).toFixed(2)} MB · ${path.relative(ROOT, jpg)} (poster at ${posterAt.toFixed(1)} s)`);
