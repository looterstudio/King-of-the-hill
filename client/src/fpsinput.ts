// First-person controls. Held keys are sampled every tick; one-shot keys (jump, slide, reload,
// weapon slots) are latched until the next tick reads them, so a quick tap is never lost
// between 30 Hz input frames.
export class FpsInput {
  private keys = new Set<string>();
  private latched = { jump: false, slide: false, reload: false, slot: 0, interact: false, perk: false, item: 0 };
  yaw = 0;
  pitch = 0;
  fire = false;
  aim = false;
  sens = 1;
  invert = false;
  locked = false;   // playing: mouse captured, or free mode below
  free = false;     // pointer lock refused (some embeds/apps): look with the mouse and arrow keys, cursor stays visible
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private el: HTMLElement) {
    try { this.sens = Number(localStorage.getItem('pr_sens') ?? 1) || 1; this.invert = localStorage.getItem('pr_invert') === '1'; } catch { /* storage blocked */ }
    addEventListener('keydown', (e) => {
      if (this.free && e.code === 'Escape') { this.stop(); return; }
      if (!this.locked) return;
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code);
      if (e.code === 'Space') this.latched.jump = true;
      if (e.code === 'KeyC' || e.code === 'ControlLeft') this.latched.slide = true;
      if (e.code === 'KeyR') this.latched.reload = true;
      const n = /^Digit([1-4])$/.exec(e.code); if (n) this.latched.slot = Number(n[1]);
      if (e.code === 'KeyX') this.latched.slot = 5; // the axe
      if (e.code === 'KeyE' || e.code === 'KeyF') this.latched.interact = true;
      if (e.code === 'KeyG') this.latched.perk = true;
      if (e.code === 'Digit5') this.latched.item = 1;
      if (e.code === 'Digit6') this.latched.item = 2;
      if (['Space', 'Tab', 'KeyC', 'ControlLeft'].includes(e.code) || e.ctrlKey) e.preventDefault(); // Ctrl is slide: no Ctrl+S/D/F browser dialogs mid-fight
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.aim = false; });
    el.addEventListener('mousedown', (e) => {
      if (!this.locked) { this.lock(); return; }
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.fire = false; if (e.button === 2) this.aim = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // a trackpad sends dozens of tiny wheel events per swipe: step one weapon per notch's worth of scroll
    let acc = 0, last = 0, stepped = 0;
    addEventListener('wheel', (e) => {
      if (!this.locked) return;
      const now = performance.now();
      if (now - last > 250) acc = 0;
      last = now;
      acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(acc) >= 50 && now - stepped > 120) { this.latched.slot = acc > 0 ? -1 : -2; acc = 0; stepped = now; }
    }, { passive: true });
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = 0.0022 * this.sens * (this.aim ? 0.55 : 1);
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k * (this.invert ? -1 : 1);
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.free) return;
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) { this.keys.clear(); this.fire = false; this.aim = false; }
      this.onLockChange?.(this.locked);
    });
  }

  // call from a click. If the browser refuses pointer lock (or never answers), fall back to free mode
  lock() {
    if (this.locked) return;
    let answered = false;
    const onChange = () => { answered = true; };
    document.addEventListener('pointerlockchange', onChange, { once: true });
    const fallback = () => { if (!answered && !this.locked) { this.free = true; this.locked = true; this.el.style.cursor = 'crosshair'; this.onLockChange?.(true); } };
    try {
      const r = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (!this.el.requestPointerLock) return fallback();
      r?.catch?.(() => fallback());
    } catch { return fallback(); }
    setTimeout(fallback, 500);
  }
  isDown(code: string) { return this.keys.has(code); }
  private stop() { this.free = false; this.locked = false; this.keys.clear(); this.fire = false; this.aim = false; this.el.style.cursor = ''; this.onLockChange?.(false); }
  unlock() { if (this.free) this.stop(); else if (document.pointerLockElement) document.exitPointerLock(); }
  setSens(v: number) { this.sens = v; try { localStorage.setItem('pr_sens', String(v)); } catch { /* storage blocked */ } }
  setInvert(v: boolean) { this.invert = v; try { localStorage.setItem('pr_invert', v ? '1' : '0'); } catch { /* storage blocked */ } }

  // one tick of input; slot -1/-2 = next/previous (wheel), resolved by the caller
  sample() {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    if (this.free) { // arrows turn when the mouse can't be captured
      this.yaw += (k('ArrowLeft') - k('ArrowRight')) * 2.6 * this.sens / 30;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + (k('ArrowUp') - k('ArrowDown')) * 1.8 * this.sens / 30));
    }
    const arrows = this.free ? 0 : 1;
    const out = {
      fwd: k('KeyW') + k('ArrowUp') * arrows - k('KeyS') - k('ArrowDown') * arrows,
      strafe: k('KeyD') + k('ArrowRight') * arrows - k('KeyA') - k('ArrowLeft') * arrows,
      sprint: !!(k('ShiftLeft') || k('ShiftRight')),
      grapple: !!k('KeyQ'),
      jump: this.latched.jump, slide: this.latched.slide, reload: this.latched.reload, slot: this.latched.slot,
      up: k('Space') - (k('KeyC') || k('ControlLeft') ? 1 : 0), // held: helicopter climb / descend
      interact: this.latched.interact, perk: this.latched.perk, item: this.latched.item, hold: !!k('KeyE'), build: !!k('KeyB'),
      fire: this.fire, aim: this.aim, yaw: this.yaw, pitch: this.pitch,
    };
    this.latched = { jump: false, slide: false, reload: false, slot: 0, interact: false, perk: false, item: 0 };
    return out;
  }
}
