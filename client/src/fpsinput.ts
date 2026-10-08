// First-person controls. Held keys are sampled every tick; one-shot keys (jump, slide, reload,
// weapon slots) are latched until the next tick reads them, so a quick tap is never lost
// between 30 Hz input frames.
export class FpsInput {
  private keys = new Set<string>();
  private latched = { jump: false, slide: false, reload: false, slot: 0 };
  yaw = 0;
  pitch = 0;
  fire = false;
  aim = false;
  sens = 1;
  invert = false;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private el: HTMLElement) {
    try { this.sens = Number(localStorage.getItem('pr_sens') ?? 1) || 1; this.invert = localStorage.getItem('pr_invert') === '1'; } catch { /* storage blocked */ }
    addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code);
      if (e.code === 'Space') this.latched.jump = true;
      if (e.code === 'KeyC' || e.code === 'ControlLeft') this.latched.slide = true;
      if (e.code === 'KeyR') this.latched.reload = true;
      const n = /^Digit([1-4])$/.exec(e.code); if (n) this.latched.slot = Number(n[1]);
      if (['Space', 'Tab', 'KeyC', 'ControlLeft'].includes(e.code)) e.preventDefault();
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
    addEventListener('wheel', (e) => { if (this.locked) this.latched.slot = e.deltaY > 0 ? -1 : -2; }, { passive: true });
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = 0.0022 * this.sens * (this.aim ? 0.55 : 1);
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k * (this.invert ? -1 : 1);
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) { this.keys.clear(); this.fire = false; this.aim = false; }
      this.onLockChange?.(this.locked);
    });
  }

  lock() { const r = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined; r?.catch?.(() => { /* user gesture needed */ }); }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  setSens(v: number) { this.sens = v; try { localStorage.setItem('pr_sens', String(v)); } catch { /* storage blocked */ } }
  setInvert(v: boolean) { this.invert = v; try { localStorage.setItem('pr_invert', v ? '1' : '0'); } catch { /* storage blocked */ } }

  // one tick of input; slot -1/-2 = next/previous (wheel), resolved by the caller
  sample() {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const out = {
      fwd: k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown'),
      strafe: k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft'),
      sprint: !!(k('ShiftLeft') || k('ShiftRight')),
      grapple: !!(k('KeyQ') || k('KeyE')),
      jump: this.latched.jump, slide: this.latched.slide, reload: this.latched.reload, slot: this.latched.slot,
      fire: this.fire, aim: this.aim, yaw: this.yaw, pitch: this.pitch,
    };
    this.latched = { jump: false, slide: false, reload: false, slot: 0 };
    return out;
  }
}
