export interface HudState {
  speedKmh: number;
  /** 0..1 */
  health: number;
  partsLost: number;
  /** Boost bar 0..1 (the bar is hidden while undefined). */
  boost?: number;
  /** Boost held and active this frame. */
  boosting?: boolean;
  /** Ran dry: locked until it recharges a little. */
  boostEmpty?: boolean;
}

const HINT_SECONDS = 10;
const FONT = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SHADOW = '0 2px 0 rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.5)';

function el(parent: HTMLElement, css: string, text = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  d.textContent = text;
  parent.appendChild(d);
  return d;
}

function healthColor(h: number): string {
  // green (120) -> yellow (55) -> red (0)
  return `hsl(${Math.round(h * 120)}, 85%, 48%)`;
}

/** Boost bar look: cyan when ready, orange like the exhaust jet while boosting, grey while recharging after running dry. */
export function boostStyle(boosting: boolean, empty: boolean): { label: string; color: string; glow: boolean } {
  if (empty) return { label: 'BOOST · RECHARGING', color: '#7a8590', glow: false };
  if (boosting) return { label: 'BOOST', color: '#ff9a1f', glow: true };
  return { label: 'BOOST', color: '#3fc8ff', glow: false };
}

export class Hud {
  private readonly speed: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly parts: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private messageTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSpeed = -1;
  private lastHealth = -1;
  private lastParts = -1;
  private readonly gauge: HTMLDivElement;
  private readonly gaugeLabel: HTMLDivElement;
  private readonly gaugePct: HTMLDivElement;
  private readonly gaugeFill: HTMLDivElement;
  private lastBoost = -1;
  private lastLook = '';

  constructor(container: HTMLElement) {
    const root = el(
      container,
      `position:absolute;inset:0;pointer-events:none;overflow:hidden;color:#fff;font-family:${FONT};text-shadow:${SHADOW};user-select:none;`,
    );

    const box = el(root, 'position:absolute;left:16px;bottom:16px;width:min(220px,50vw);');
    const row = el(box, 'display:flex;align-items:baseline;gap:8px;');
    this.speed = el(row, 'font-size:clamp(36px,9vw,64px);line-height:1;font-weight:900;font-variant-numeric:tabular-nums;', '0');
    el(row, 'font-size:clamp(12px,3vw,18px);font-weight:700;opacity:0.9;', 'km/h');
    const track = el(box, 'margin-top:8px;height:12px;border-radius:6px;background:rgba(0,0,0,0.45);overflow:hidden;box-shadow:0 0 0 2px rgba(0,0,0,0.35);');
    this.bar = el(track, 'height:100%;width:100%;border-radius:6px;');
    this.parts = el(box, 'margin-top:6px;font-size:13px;font-weight:700;', 'parts lost: 0');

    this.hint = el(
      root,
      'position:absolute;right:16px;bottom:16px;max-width:min(340px,30vw);text-align:right;font-size:clamp(10px,2.4vw,14px);font-weight:700;transition:opacity 1.5s;',
      'WASD / arrows: drive · Space: handbrake · Shift: boost · R: back to checkpoint · Enter: restart · T: race / time trial · C: camera · `: tuning',
    );
    setTimeout(() => { this.hint.style.opacity = '0'; }, HINT_SECONDS * 1000);

    this.gauge = el(
      root,
      'position:absolute;left:50%;transform:translateX(-50%);bottom:clamp(16px,6vh,28px);width:min(340px,46vw);display:none;',
    );
    const labels = el(this.gauge, 'display:flex;justify-content:space-between;font-size:12px;font-weight:700;letter-spacing:0.08em;margin-bottom:4px;');
    this.gaugeLabel = el(labels, '', 'BOOST');
    this.gaugePct = el(labels, 'font-variant-numeric:tabular-nums;', '100%');
    const boostTrack = el(this.gauge, 'height:14px;border-radius:7px;background:rgba(0,0,0,0.45);overflow:hidden;box-shadow:0 0 0 2px rgba(0,0,0,0.35);');
    this.gaugeFill = el(boostTrack, 'height:100%;width:100%;border-radius:7px;');

    this.message = el(
      root,
      'position:absolute;left:0;right:0;top:35%;text-align:center;font-size:clamp(36px,12vw,96px);font-weight:900;letter-spacing:0.05em;opacity:0;transition:opacity 0.25s;',
    );
    this.update({ speedKmh: 0, health: 1, partsLost: 0 });
  }

  update(state: HudState): void {
    const speed = Math.round(Math.abs(state.speedKmh));
    if (speed !== this.lastSpeed) {
      this.lastSpeed = speed;
      this.speed.textContent = String(speed);
    }
    const health = Math.round(Math.min(1, Math.max(0, state.health)) * 100);
    if (health !== this.lastHealth) {
      this.lastHealth = health;
      this.bar.style.width = `${health}%`;
      this.bar.style.background = healthColor(health / 100);
    }
    if (state.partsLost !== this.lastParts) {
      this.lastParts = state.partsLost;
      this.parts.textContent = `parts lost: ${state.partsLost}`;
    }
    if (state.boost === undefined) {
      if (this.gauge.style.display !== 'none') this.gauge.style.display = 'none';
    } else {
      this.updateBoost(state.boost, state.boosting ?? false, state.boostEmpty ?? false);
    }
  }

  private updateBoost(charge: number, boosting: boolean, empty: boolean): void {
    if (this.gauge.style.display === 'none') this.gauge.style.display = '';
    const pct = Math.round(Math.min(1, Math.max(0, charge)) * 100);
    if (pct !== this.lastBoost) {
      this.lastBoost = pct;
      this.gaugePct.textContent = `${pct}%`;
      this.gaugeFill.style.width = `${pct}%`;
    }
    const look = boostStyle(boosting, empty);
    const key = `${look.label}|${look.color}`;
    if (key === this.lastLook) return;
    this.lastLook = key;
    this.gaugeLabel.textContent = look.label;
    this.gaugeFill.style.background = look.color;
    this.gaugeFill.style.boxShadow = look.glow ? `0 0 10px ${look.color}` : 'none';
  }

  showMessage(text: string, seconds = 2): void {
    this.message.textContent = text;
    this.message.style.opacity = '1';
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { this.message.style.opacity = '0'; }, seconds * 1000);
  }
}
