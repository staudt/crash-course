import type { DriveInput } from './types';

const KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
};

/** Keyboard (+ first gamepad) → DriveInput. One-shot actions are read with `consume`. */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** Mouse wheel travel since the last `takeWheel`, in notches (+ = toward the user). */
  private wheel = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
    target.addEventListener('wheel', (e) => {
      // Only over the game view: the tuning panel scrolls with the wheel too.
      if (!(e.target instanceof HTMLCanvasElement)) return;
      // deltaMode 1 = lines, 0 = pixels (~100 per notch; trackpads send small steps).
      this.wheel += e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
    });
  }

  /** True while any of the keys is held. */
  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Wheel notches since the last call (+ = scrolled toward the user). */
  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** True once per key press. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  /** Call at the end of each frame so stale presses don't linger. */
  endFrame(): void {
    this.pressed.clear();
  }

  read(out: DriveInput): DriveInput {
    const any = (codes: string[]) => codes.some((c) => this.down.has(c));
    let throttle = (any(KEYS.up) ? 1 : 0) - (any(KEYS.down) ? 1 : 0);
    let steer = (any(KEYS.right) ? 1 : 0) - (any(KEYS.left) ? 1 : 0);
    let handbrake = any(KEYS.handbrake);
    let boost = any(KEYS.boost);

    const pad = navigator.getGamepads?.()[0];
    if (pad) {
      const sx = pad.axes[0] ?? 0;
      if (Math.abs(sx) > 0.12) steer = sx;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05 || lt > 0.05) throttle = rt - lt;
      if (pad.buttons[0]?.pressed) handbrake = true;
      if (pad.buttons[5]?.pressed) boost = true; // RB
      if (pad.buttons[3]?.pressed) this.pressed.add('KeyR');
    }

    out.throttle = throttle;
    out.steer = steer;
    out.brake = 0;
    out.handbrake = handbrake;
    out.boost = boost;
    return out;
  }
}
