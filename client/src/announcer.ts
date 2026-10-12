// The announcer: First Blood, multi-kills (kills within 10 s of each other) and kill streaks, as big
// text across the top of the screen, a synthesized sting and a deep spoken line. The voice is the
// browser's own speech synthesis, slowed and pitched down; no recorded audio, nothing borrowed.
import { sfx } from './audio.ts';
import { settings } from './settings.ts';

export const MULTI_WINDOW = 10_000; // ms between kills that still chain into a multi-kill
const MULTI = ['', '', 'Double Kill', 'Triple Kill', 'Ultra Kill', 'Rampage'];
// kills without dying: from three on, every kill gets a line (the last one repeats)
const SPREE: Record<number, string> = { 3: 'Killing Spree', 4: 'Dominating', 5: 'Unstoppable', 6: 'Legendary', 7: 'Godlike', 8: 'King of the Hill' };
const SPREE_SUB: Record<number, string> = { 3: 'three without dying', 4: 'four without dying', 5: 'nobody can stop you', 6: 'they will talk about this one', 7: 'bow down', 8: 'the hill is yours' };

interface Line { big: string; sub: string; level: number; tone: 'red' | 'gold' | 'ink' }

export class Announcer {
  private multi = 0;
  private lastKill = -1e9;
  private spree = 0;
  private firstBlood = false;
  private streaks = new Map<number, number>(); // everyone's kills since their last death, for shutdowns
  private queue: Line[] = [];
  private showing = 0;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private el: HTMLElement) {
    try {
      const pick = () => {
        const all = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
        // a deep English voice if the system has one; any English voice otherwise
        this.voice = all.find((v) => /daniel|arthur|fred|ralph|bruce|alex|david|guy|george|male/i.test(v.name) && !/female/i.test(v.name))
          ?? all.find((v) => /en[-_]GB/i.test(v.lang)) ?? all[0] ?? null;
      };
      pick(); speechSynthesis.addEventListener('voiceschanged', pick);
    } catch { /* no speech synthesis: text and sting only */ }
  }

  // a new match: nothing carries over
  reset() {
    this.multi = 0; this.lastKill = -1e9; this.spree = 0; this.firstBlood = false; this.streaks.clear();
    this.queue = []; clearTimeout(this.showing); this.showing = 0;
    this.el.classList.remove('show'); this.el.innerHTML = '';
  }

  // every elimination in the match; you = your player id. Returns nothing: it speaks for itself
  onElim(victim: number, by: number | null, you: number) {
    const killer = by !== null && by !== victim ? by : null;
    const victimStreak = this.streaks.get(victim) ?? 0;
    this.streaks.delete(victim);
    if (victim === you) { this.spree = 0; this.multi = 0; }
    if (killer === null) return;
    this.streaks.set(killer, (this.streaks.get(killer) ?? 0) + 1);
    const first = !this.firstBlood;
    this.firstBlood = true;
    if (killer !== you) return;

    const now = performance.now();
    this.multi = now - this.lastKill <= MULTI_WINDOW ? this.multi + 1 : 1;
    this.lastKill = now;
    this.spree++;
    const multi = this.multi >= 2 ? MULTI[Math.min(this.multi, MULTI.length - 1)] : '';
    const spree = this.spree >= 3 ? SPREE[Math.min(this.spree, 8)] : '';
    if (first) this.say({ big: 'First Blood', sub: 'the first kill of the match', level: 2, tone: 'red' });
    if (multi) this.say({ big: multi, sub: spree ? spree : `${this.multi} kills in a row`, level: this.multi, tone: this.multi >= 5 ? 'gold' : 'red' });
    else if (spree) this.say({ big: spree, sub: SPREE_SUB[Math.min(this.spree, 8)], level: Math.min(6, this.spree - 1), tone: this.spree >= 6 ? 'gold' : 'ink' });
    if (multi && spree) this.speakOnly(spree);
    if (victimStreak >= 3) this.say({ big: 'Shut Down', sub: `you ended a ${victimStreak} kill streak`, level: 2, tone: 'ink' });
  }

  get streak() { return this.spree; }
  get multiKills() { return Math.max(1, this.multi); }

  private say(line: Line) {
    this.queue.push(line);
    if (!this.showing) this.next();
  }
  private next() {
    const line = this.queue.shift();
    if (!line) { this.showing = 0; return; }
    this.el.className = `announce ${line.tone} lv${Math.min(5, line.level)}`;
    this.el.innerHTML = `<b>${line.big}</b>${line.sub ? `<small>${line.sub}</small>` : ''}`;
    void this.el.offsetWidth; this.el.classList.add('show');
    sfx.sting(line.level);
    setTimeout(() => this.speak(line.big), 300); // the voice lands on the hit, after the swell
    this.showing = window.setTimeout(() => { this.el.classList.remove('show'); this.showing = window.setTimeout(() => this.next(), 220); }, this.queue.length ? 1500 : 2400);
  }
  private speakOnly(text: string) { setTimeout(() => this.speak(text), 1400); }

  private speak(text: string) {
    if (!settings.announcer) return;
    const vol = sfx.effectsLevel;
    if (vol <= 0.01) return;
    try {
      const u = new SpeechSynthesisUtterance(`${text}!`);
      if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-US';
      u.pitch = 0.3; u.rate = 0.78; u.volume = Math.min(1, vol * 1.1);
      speechSynthesis.speak(u);
    } catch { /* no speech: the text and the sting carry it */ }
  }
}
