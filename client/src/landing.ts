// The landing page: what the game is, how to win, the hourly pot, the modes, the controls and a
// minute of real gameplay, then one big Play button that lifts the page off the lobby.
// Shown on every visit; #play (and #autotest) go straight to the lobby. Clicking the lobby's logo
// brings it back. The numbers on it come from the game's own rules (shared/src), nothing else.
import './landing.css';
import { MODES, POINTS, ROOM_MAX, topPlaces, type Mode } from '../../shared/src/constants.ts';
import { TOKEN } from '../../shared/src/token.ts';
import { PotJar } from './potjar.ts';

const VIDEO = { mp4: 'media/gameplay.mp4', webm: 'media/gameplay.webm', poster: 'media/gameplay.jpg' };

const LOGO = '<svg class="syms" viewBox="0 0 96 30" aria-hidden="true"><circle cx="14" cy="15" r="10.5"/><path d="M38 25 L48 5 L58 25 Z"/><rect x="72" y="5" width="20" height="20" rx="1"/></svg><span class="word">King of the Hill <em>Royale</em></span>';
const SCRIBBLE = '<svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true"><path d="M4 12 C 60 4, 120 16, 180 9 S 270 6, 296 11"/></svg>';

// four doodles, one per step
const STEP_ART = {
  drop: '<svg viewBox="0 0 72 54" aria-hidden="true"><path class="f" d="M6 14 L50 4 L36 26 L28 18 Z"/><path d="M6 14 L50 4 L36 26 L28 18 Z M28 18 L50 4"/><path class="r" d="M44 30 C 44 22, 62 22, 62 30 Z"/><path d="M44 30 L53 40 M62 30 L53 40 M53 40 V46 M53 46 L50 51 M53 46 L56 51"/></svg>',
  loot: '<svg viewBox="0 0 72 54" aria-hidden="true"><rect class="f" x="4" y="22" width="34" height="22" rx="5"/><path d="M4 30 H38 M16 22 V17 H26 V22"/><path d="M46 46 V22 H66 V46 M46 30 H56 M56 22 V30 M50 38 H66 M58 30 V38"/><path class="r" d="M44 12 L48 18 M56 8 V15 M66 12 L62 18"/></svg>',
  hill: '<svg viewBox="0 0 72 54" aria-hidden="true"><path class="r" d="M36 50 m-30 0 a30 9 0 1 0 60 0 a30 9 0 1 0 -60 0" stroke-dasharray="3 5"/><path d="M28 48 V18 H44 V48 M28 26 H44 M28 34 H44 M28 42 H44"/><path class="f" d="M27 16 L29 6 L33 11 L36 3 L39 11 L43 6 L45 16 Z"/><path d="M27 16 L29 6 L33 11 L36 3 L39 11 L43 6 L45 16 Z"/></svg>',
  win: '<svg viewBox="0 0 72 54" aria-hidden="true"><path class="f" d="M14 40 L10 14 L24 26 L36 8 L48 26 L62 14 L58 40 Z"/><path d="M14 40 L10 14 L24 26 L36 8 L48 26 L62 14 L58 40 Z M14 47 H58"/><circle class="r" cx="36" cy="30" r="3"/></svg>',
};

// stick figures under parachutes, n of them
function chutes(n: number, color: string) {
  const w = 100 / Math.max(n, 1), out: string[] = [];
  for (let i = 0; i < n; i++) {
    const cx = w * i + w / 2, s = Math.min(1, 1.6 / Math.max(n, 1.6)), r = 13 * s + 4;
    out.push(`<g transform="translate(${cx} 0)"><path d="M${-r} 24 C ${-r} 6, ${r} 6, ${r} 24 Z" fill="${color}"/><path d="M${-r} 24 L0 44 M${r} 24 L0 44 M0 24 V44"/><circle cx="0" cy="49" r="4"/><path d="M0 53 V66 M0 57 L-5 62 M0 57 L5 62 M0 66 L-4 74 M0 66 L4 74"/></g>`);
  }
  return `<svg viewBox="0 0 100 80" aria-hidden="true">${out.join('')}</svg>`;
}

const MODE_COPY: Record<Mode, string> = {
  solo: 'Every player for themselves.',
  duo: 'You and a friend, one team.',
  squad: 'Bring your crew. A party code puts you together.',
};
const MODE_COLOR: Record<Mode, string> = { solo: '#ffe45c', duo: '#9fe3d6', squad: '#ffb3c0' };

const MOUSE = (part: 'l' | 'r' | 'both') => `<svg class="lp-mouse" viewBox="0 0 44 62" aria-hidden="true">
  <path d="M22 3 C 10 3, 4 11, 4 24 V40 C 4 52, 12 59, 22 59 C 32 59, 40 52, 40 40 V24 C 40 11, 34 3, 22 3 Z"/>
  <path class="${part !== 'r' ? 'on' : ''}" d="M21 3.4 C 10 4, 4.6 11.5, 4.6 24 V26 H21 Z"/>
  <path class="${part !== 'l' ? 'on red' : ''}" d="M23 3.4 C 34 4, 39.4 11.5, 39.4 24 V26 H23 Z"/>
  <rect x="19.5" y="10" width="5" height="10" rx="2.5"/></svg>`;

function html() {
  const winSolo = POINTS.win.solo, top = topPlaces('solo');
  const modes = (['solo', 'duo', 'squad'] as Mode[]).map((m) => `
    <article class="lp-mode lp-in">${chutes(MODES[m].size, MODE_COLOR[m])}<h3>${MODES[m].name}</h3><p>${MODES[m].size > 1 ? `Teams of ${MODES[m].size}. ` : ''}${MODE_COPY[m]}</p></article>`).join('');
  return `
<div class="lp">
  <header class="lp-top">
    <div class="logo">${LOGO}</div>
    <nav class="lp-nav" aria-label="landing">
      <a href="#lp-how">How to win</a><a href="#lp-film">Watch</a><a href="#lp-pot">The pot</a><a href="#lp-keys">Controls</a>
      <button class="btn" type="button" data-play>Play</button>
    </nav>
  </header>

  <section class="lp-hero">
    <div>
      <span class="lp-kicker">a battle royale drawn in ballpoint</span>
      <h1>${ROOM_MAX} players. One island. <span class="lp-break">Every wall breaks.${SCRIBBLE}</span></h1>
      <p class="lp-lede">Jump from the paper plane, loot pencil cases and fight your way to the <b>King's Tower</b>. Last one standing wins, and every hour the <b>top scorer takes the pot</b>.</p>
      <div class="lp-cta">
        <button class="btn play lp-play" type="button" data-play>Play free<span class="arrow" aria-hidden="true">→</span></button>
        <a class="lp-watch" href="#lp-film"><i aria-hidden="true">▶</i>Watch a match</a>
      </div>
      <p class="lp-fine"><span>Plays in your browser</span><span>No download</span><span>Solo, duos and squads</span></p>
    </div>
    <div class="lp-pig">
      <span class="tape tape-l"></span><span class="tape tape-r"></span>
      <canvas id="lpJar" aria-hidden="true"></canvas>
      <svg class="lp-stamp" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46"/><circle cx="50" cy="50" r="38" stroke-dasharray="2 4"/><text x="50" y="50" font-size="26">1h</text><text x="50" y="70" font-size="12">payout</text></svg>
      <div class="lp-pig-cap"><b>The King Pig</b><span>fills all hour, empties at :00</span></div>
    </div>
  </section>

  <section id="lp-how" class="lp-sec">
    <div class="lp-h lp-in"><h2>How to win</h2><span class="lp-note">in four moves</span></div>
    <ol class="lp-steps">
      <li class="lp-step lp-in"><span class="lp-num">1</span>${STEP_ART.drop}<h3>Drop in</h3><p>Jump from the paper plane and glide down anywhere on the island.</p></li>
      <li class="lp-step lp-in"><span class="lp-num">2</span>${STEP_ART.loot}<h3>Loot and break</h3><p>Guns, shields and perks hide in pencil cases. Any wall can come down.</p></li>
      <li class="lp-step lp-in"><span class="lp-num">3</span>${STEP_ART.hill}<h3>Take the hill</h3><p>The storm always closes on the <b>King's Tower</b>, right in the center.</p></li>
      <li class="lp-step lp-in"><span class="lp-num">4</span>${STEP_ART.win}<h3>Last one standing</h3><p>Outlast everyone else and the crown is yours.</p></li>
    </ol>
  </section>

  <section id="lp-film" class="lp-sec">
    <div class="lp-h lp-in"><h2>One minute of a match</h2><span class="lp-note">recorded in the browser demo</span></div>
    <div class="lp-film lp-in">
      <span class="tape tape-l"></span><span class="tape tape-r"></span>
      <video muted loop playsinline preload="none" poster="${VIDEO.poster}" aria-label="a minute of gameplay: the drop, looting and a fight, in third person">
        <source data-src="${VIDEO.webm}" type="video/webm" />
        <source data-src="${VIDEO.mp4}" type="video/mp4" />
      </video>
      <div class="lp-film-cap"><span><span class="rec">REC</span> third person, over the shoulder</span><button type="button" data-film>Pause</button></div>
    </div>
  </section>

  <section id="lp-pot" class="lp-sec lp-pot">
    <div class="lp-in">
      <div class="lp-h"><h2>The hourly pot</h2><span class="lp-note">every hour, on the hour</span></div>
      <p class="lp-pot-big">The player with the <span class="lp-hl">most points</span> each hour takes the whole pot.</p>
      <p class="lp-pot-sub">Trading fees from <b>$${TOKEN.symbol}</b> fill the pig all hour long. Every match you play scores points toward it.</p>
    </div>
    <div class="lp-in">
      <div class="lp-points">
        <div class="lp-pt win"><b>${winSolo}</b><span>a solo win</span></div>
        <div class="lp-pt"><b><small>+</small>${POINTS.top}</b><span>a top ${top} finish</span></div>
        <div class="lp-pt"><b><small>+</small>${POINTS.kill}</b><span>every kill</span></div>
      </div>
      <div class="lp-who"><b>Who plays for it:</b> holders of $${TOKEN.symbol} with a connected Solana wallet, holding at least $${TOKEN.holdMinUsd} through the hour. Guests play free, just not for the pot.
        <span class="lp-wallets">Phantom, Solflare or Backpack. Signing in is free, no transaction. Duos win ${POINTS.win.duo} each, squads ${POINTS.win.squad} each.</span></div>
    </div>
  </section>

  <section id="lp-modes" class="lp-sec">
    <div class="lp-h lp-in"><h2>Pick your drop</h2><span class="lp-note">same island, same rules</span></div>
    <div class="lp-modes">${modes}</div>
  </section>

  <section id="lp-keys" class="lp-sec">
    <div class="lp-h lp-in"><h2>Controls</h2><span class="lp-note">mouse and keyboard</span></div>
    <div class="lp-keys">
      <div class="lp-key lp-in"><div class="lp-caps"><div class="row"><kbd class="cap hl">W</kbd></div><div class="row"><kbd class="cap hl">A</kbd><kbd class="cap hl">S</kbd><kbd class="cap hl">D</kbd></div></div><span>Move<small>hold Shift to sprint</small></span></div>
      <div class="lp-key lp-in">${MOUSE('both')}<span>Aim and shoot<small>left click fires, right click aims</small></span></div>
      <div class="lp-key lp-in"><div class="lp-caps"><kbd class="cap wide">Space</kbd></div><span>Jump<small>again in the air, or climb a ledge</small></span></div>
      <div class="lp-key lp-in"><div class="lp-caps"><kbd class="cap hl">E</kbd></div><span>Open and grab<small>pencil cases, guns, vehicles</small></span></div>
      <div class="lp-key lp-in"><div class="lp-caps"><kbd class="cap">X</kbd></div><span>Pickaxe<small>break anything, right click builds</small></span></div>
      <div class="lp-key lp-in"><div class="lp-caps"><kbd class="cap">R</kbd></div><span>Reload<small>between fights</small></span></div>
      <div class="lp-key lp-in"><div class="lp-caps"><kbd class="cap">G</kbd></div><span>Perk<small>grenades, C4, launch pads</small></span></div>
      <div class="lp-key lp-in"><div class="lp-caps"><div class="row"><kbd class="cap">5</kbd><kbd class="cap">6</kbd></div></div><span>Heal up<small>shield, medkit</small></span></div>
    </div>
    <p class="lp-keys-more lp-in">Also: <b>Q</b> grapple, <b>C</b> slide, <b>P</b> first person. Press <b>H</b> in a match for every control.</p>
  </section>

  <section class="lp-end lp-in">
    <h2>The hill is waiting.</h2>
    <p>Free to play. Pick a name and drop in.</p>
    <button class="btn play lp-play" type="button" data-play>Play free<span class="arrow" aria-hidden="true">→</span></button>
    <span class="lp-touch">Best on a computer with a mouse and keyboard.</span>
  </section>

  <footer class="lp-foot"><span>King of the Hill Royale</span><span>Drawn in ballpoint on graph paper.</span></footer>
</div>`;
}

export function initLanding() {
  const root = document.getElementById('landing');
  if (!root) return;
  const skip = location.hash === '#play' || location.hash === '#autotest';
  root.innerHTML = html();
  const video = root.querySelector('video')!;
  const filmBtn = root.querySelector<HTMLButtonElement>('[data-film]')!;
  let open = false, raf = 0, last = 0, nextCoin = 0, userPaused = false, filmSeen = false;

  // the pig: same drawing as the lobby's, no numbers, coins dropping in now and then
  const jar = new PotJar(root.querySelector<HTMLCanvasElement>('#lpJar')!, { string: true, marks: false, crown: true });
  jar.scaleSol = 10; jar.setSol(9);
  const draw = (now: number) => {
    raf = 0;
    if (!open) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    if (now > nextCoin) { jar.inflow(0.01 + Math.random() * 0.03); nextCoin = now + 1600 + Math.random() * 2600; }
    jar.frame(dt);
    raf = requestAnimationFrame(draw);
  };

  // the film loads only when it scrolls near, and pauses out of view
  const loadFilm = () => {
    if (filmSeen) return;
    filmSeen = true;
    video.querySelectorAll('source').forEach((s) => { s.src = s.dataset.src ?? ''; });
    video.preload = 'auto';
    video.load();
  };
  const setFilm = (play: boolean) => {
    if (play) { loadFilm(); video.play().catch(() => {}); } else video.pause();
    filmBtn.textContent = play ? 'Pause' : 'Play';
  };
  filmBtn.onclick = () => { userPaused = !video.paused; setFilm(!userPaused); };
  try {
    new IntersectionObserver((es) => { for (const e of es) if (open) setFilm(e.isIntersecting && !userPaused); }, { rootMargin: '200px 0px' }).observe(video);
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } }, { threshold: 0.12 });
    root.querySelectorAll('.lp-in').forEach((el) => io.observe(el));
  } catch { root.querySelectorAll('.lp-in').forEach((el) => el.classList.add('seen')); }

  const show = () => {
    open = true;
    root.classList.remove('gone', 'leaving');
    document.body.classList.add('landing-on');
    root.scrollTop = 0;
    jar.resize();
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const play = () => {
    open = false;
    video.pause();
    root.classList.add('leaving');
    document.body.classList.remove('landing-on');
    setTimeout(() => { if (!open) root.classList.add('gone'); }, 550);
    // the lobby: on a narrow screen jump to the join card, where the name and the drop button are
    const join = document.querySelector<HTMLElement>('#lobby .join');
    if (join && innerWidth < 980) join.scrollIntoView({ block: 'start' });
    dispatchEvent(new CustomEvent('landing:play'));
  };
  root.querySelectorAll<HTMLElement>('[data-play]').forEach((b) => b.addEventListener('click', play));
  // in-page links scroll the landing itself
  root.querySelectorAll<HTMLAnchorElement>('a[href^="#lp-"]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    root.querySelector(a.getAttribute('href')!)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  // the lobby's logo takes you back here
  const logo = document.querySelector<HTMLElement>('#lobby .logo');
  if (logo) { logo.style.cursor = 'pointer'; logo.title = 'about the game'; logo.addEventListener('click', show); }

  if (skip) { root.classList.add('gone'); return; }
  show();
}
