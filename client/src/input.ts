// Keyboard + mouse, and a twin-stick layout on touch screens (left half moves, right half aims and fires).
export class Input {
  private keys = new Set<string>();
  mouse = { x: 0, y: 0, down: false };
  private touchMove: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private touchAim: { id: number; x: number; y: number } | null = null;
  dashQueued = false;

  constructor(el: HTMLElement) {
    addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code === 'Space' || e.code === 'ShiftLeft') { this.dashQueued = true; e.preventDefault(); } });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; });
    el.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    el.addEventListener('mousedown', (e) => { if (e.button === 0) this.mouse.down = true; if (e.button === 2) this.dashQueued = true; });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.down = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < innerWidth / 2 && !this.touchMove) this.touchMove = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
        else if (!this.touchAim) { this.touchAim = { id: t.identifier, x: t.clientX, y: t.clientY }; this.mouse.x = t.clientX; this.mouse.y = t.clientY; this.mouse.down = true; }
      }
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.touchMove?.id === t.identifier) { this.touchMove.x = t.clientX; this.touchMove.y = t.clientY; }
        if (this.touchAim?.id === t.identifier) { this.mouse.x = t.clientX; this.mouse.y = t.clientY; }
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.touchMove?.id === t.identifier) this.touchMove = null;
        if (this.touchAim?.id === t.identifier) { this.touchAim = null; this.mouse.down = false; }
      }
    };
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
  }

  move(): { mx: number; my: number } {
    if (this.touchMove) {
      const dx = this.touchMove.x - this.touchMove.ox, dy = this.touchMove.y - this.touchMove.oy, d = Math.hypot(dx, dy);
      return d < 8 ? { mx: 0, my: 0 } : { mx: dx / Math.max(d, 60), my: dy / Math.max(d, 60) };
    }
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    let mx = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
    let my = k('KeyS') + k('ArrowDown') - k('KeyW') - k('ArrowUp');
    const d = Math.hypot(mx, my);
    if (d > 1) { mx /= d; my /= d; }
    return { mx, my };
  }
  takeDash() { const d = this.dashQueued; this.dashQueued = false; return d; }
}
