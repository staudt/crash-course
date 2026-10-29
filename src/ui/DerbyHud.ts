import { formatTime } from './RaceHud';

export interface DerbyHudCar {
  name: string;
  color: string;
  /** 0..1 */
  health: number;
  /** null while running, else why it's out: 'WRECKED' | 'DISABLED'. */
  out: string | null;
  isPlayer: boolean;
  /** This AI is currently hunting the player. */
  huntingPlayer: boolean;
  x: number;
  z: number;
}

export interface DerbyHudState {
  phase: 'countdown' | 'fighting' | 'over';
  /** Seconds left in the countdown. */
  countdown: number;
  /** Round time in seconds. */
  time: number;
  alive: number;
  total: number;
  cars: DerbyHudCar[];
  /** Car the camera follows; heading is yaw (0 = facing +Z, atan2(fx, fz)). */
  view: { x: number; z: number; heading: number };
  /** Name of the car being watched once the player is out, else null. */
  spectating: string | null;
}

export interface DerbyResultRow {
  place: number;
  name: string;
  color: string;
  isPlayer: boolean;
  /** Seconds survived (the winner's = round time). */
  survived: number;
  takedowns: number;
  /** HP of damage dealt to others. */
  damage: number;
  /** 'WINNER', 'by <name>' (wrecked by), 'WRECKED' or 'DISABLED'. */
  status: string;
}

const FONT = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SHADOW = '0 2px 0 rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.5)';
const GO_SECONDS = 0.8;
const FLASH_SECONDS = 1.2;
const MAP_SIZE = 180;
const MAP_PAD = 8;

/** Running cars first by health (highest first), then out cars in their given order. Returns a new array. */
export function rosterOrder(cars: readonly DerbyHudCar[]): DerbyHudCar[] {
  const running = cars.filter((c) => c.out === null).sort((a, b) => b.health - a.health);
  const out = cars.filter((c) => c.out !== null);
  return [...running, ...out];
}

/**
 * World (x, z) of an arena of radius R → minimap (u, v) in [-1, 1], rotated so `heading` points up (v = -1 is the top).
 * Same convention as RaceHud's minimapProject with up = (sin h, cos h): the viewer's left (+X at heading 0) is u < 0.
 */
export function arenaProject(x: number, z: number, R: number, heading: number): { u: number; v: number } {
  const ux = Math.sin(heading);
  const uz = Math.cos(heading);
  return { u: (x * -uz + z * ux) / R, v: -(x * ux + z * uz) / R };
}

function healthColor(h: number): string {
  return `hsl(${Math.round(Math.min(1, Math.max(0, h)) * 120)}, 85%, 48%)`;
}

function el(parent: HTMLElement, css: string, text = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  d.textContent = text;
  parent.appendChild(d);
  return d;
}

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = '@keyframes derbyhud-blink{0%,100%{opacity:1}50%{opacity:0.25}}';
  document.head.appendChild(s);
}

interface RosterRow {
  row: HTMLDivElement;
  swatch: HTMLDivElement;
  name: HTMLDivElement;
  fill: HTMLDivElement;
  hunt: HTMLDivElement;
  reason: HTMLDivElement;
  key: string;
}

export class DerbyHud {
  private readonly root: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly big: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly aliveBox: HTMLDivElement;
  private readonly aliveNum: HTMLSpanElement;
  private readonly aliveOf: HTMLSpanElement;
  private readonly spectate: HTMLDivElement;
  private readonly roster: HTMLDivElement;
  private rows: RosterRow[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly dpr: number;
  private results: HTMLDivElement | null = null;
  private resultsVisible = false;

  private lastTimer = '';
  private lastAlive = '';
  private lastBig = '';
  private lastSpectate = '';
  private prevPhase: DerbyHudState['phase'] | null = null;
  private goUntil = 0;

  constructor(
    container: HTMLElement,
    private readonly arenaRadius: number,
  ) {
    injectStyle();
    const root = el(
      container,
      `position:absolute;inset:0;pointer-events:none;overflow:hidden;color:#fff;font-family:${FONT};text-shadow:${SHADOW};user-select:none;`,
    );
    this.root = root;

    const top = el(root, 'position:absolute;left:0;right:0;top:12px;text-align:center;');
    this.timer = el(top, 'font-size:clamp(28px,7vw,48px);line-height:1;font-weight:900;font-variant-numeric:tabular-nums;', formatTime(0));
    this.notice = el(top, 'margin-top:4px;font-size:clamp(13px,3.2vw,20px);font-weight:900;letter-spacing:0.04em;opacity:0;transition:opacity 0.3s;');

    this.big = el(
      root,
      'position:absolute;left:0;right:0;top:14%;text-align:center;font-size:clamp(64px,18vw,160px);font-weight:900;line-height:1;opacity:0;',
    );
    this.flashEl = el(
      root,
      'position:absolute;left:0;right:0;top:28%;text-align:center;font-size:clamp(32px,10vw,84px);font-weight:900;letter-spacing:0.06em;line-height:1;opacity:0;transition:opacity 0.25s;',
    );

    this.aliveBox = el(root, 'position:absolute;left:16px;top:12px;line-height:1;white-space:nowrap;');
    this.aliveNum = document.createElement('span');
    this.aliveNum.style.cssText = 'font-size:clamp(30px,8vw,56px);font-weight:900;font-variant-numeric:tabular-nums;';
    this.aliveOf = document.createElement('span');
    this.aliveOf.style.cssText = 'margin-left:4px;font-size:clamp(12px,3vw,20px);font-weight:700;opacity:0.85;';
    this.aliveBox.append(this.aliveNum, this.aliveOf);

    this.spectate = el(
      root,
      'position:absolute;left:0;right:0;bottom:clamp(64px,14vh,110px);text-align:center;font-size:clamp(12px,3.2vw,18px);font-weight:900;letter-spacing:0.05em;display:none;',
    );

    this.dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = Math.round(MAP_SIZE * this.dpr);
    this.canvas.style.cssText =
      'position:absolute;right:16px;top:16px;width:min(180px,34vw);aspect-ratio:1;border-radius:12px;background:rgba(0,0,0,0.4);box-shadow:0 0 0 2px rgba(0,0,0,0.35);';
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.roster = el(
      root,
      'position:absolute;right:16px;top:calc(16px + min(180px,34vw) + 8px);width:min(180px,34vw);box-sizing:border-box;padding:4px 5px;border-radius:8px;background:rgba(0,0,0,0.4);font-size:clamp(9px,2.3vw,12px);font-weight:700;',
    );
  }

  update(state: DerbyHudState): void {
    const now = performance.now();

    const t = formatTime(state.time);
    if (t !== this.lastTimer) {
      this.lastTimer = t;
      this.timer.textContent = t;
    }

    const aliveKey = `${state.alive}/${state.total}`;
    if (aliveKey !== this.lastAlive) {
      this.lastAlive = aliveKey;
      this.aliveNum.textContent = String(state.alive);
      this.aliveOf.textContent = `/ ${state.total} LEFT`;
    }

    if (state.phase === 'fighting' && this.prevPhase === 'countdown') this.goUntil = now + GO_SECONDS * 1000;
    this.prevPhase = state.phase;
    let big = '';
    let opacity = 1;
    if (state.phase === 'countdown') {
      big = String(Math.max(1, Math.ceil(state.countdown)));
    } else if (now < this.goUntil) {
      big = 'GO!';
      opacity = Math.min(1, (this.goUntil - now) / (GO_SECONDS * 400));
    }
    if (this.resultsVisible) big = '';
    if (big !== this.lastBig) {
      this.lastBig = big;
      this.big.textContent = big;
    }
    this.big.style.opacity = big ? String(opacity) : '0';

    const spec = this.resultsVisible || !state.spectating ? '' : state.spectating;
    if (spec !== this.lastSpectate) {
      this.lastSpectate = spec;
      this.spectate.style.display = spec ? 'block' : 'none';
      if (spec) this.spectate.textContent = `SPECTATING ${spec.toUpperCase()} · ← → switch car · Enter restart`;
    }

    this.updateRoster(state.cars);
    this.drawMap(state);
  }

  notify(text: string, color: string): void {
    this.notice.textContent = text;
    this.notice.style.color = color;
    this.notice.style.opacity = '1';
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice.style.opacity = '0'; }, 2500);
  }

  flash(text: string, color: string): void {
    this.flashEl.textContent = text;
    this.flashEl.style.color = color;
    this.flashEl.style.opacity = '1';
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flashEl.style.opacity = '0'; }, FLASH_SECONDS * 1000);
  }

  showResults(title: string, rows: DerbyResultRow[], footer: string): void {
    if (!this.results) {
      this.results = el(
        this.root,
        'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,94vw);max-height:90vh;overflow:auto;box-sizing:border-box;padding:16px 14px;background:rgba(0,0,0,0.65);border-radius:14px;text-shadow:none;',
      );
    }
    const mk = (parent: HTMLElement, css: string, text = ''): HTMLDivElement => {
      const d = document.createElement('div');
      d.style.cssText = css;
      d.textContent = text;
      parent.appendChild(d);
      return d;
    };
    const holder = document.createElement('div');
    mk(holder, `text-align:center;font-size:clamp(22px,6vw,34px);font-weight:900;margin-bottom:12px;color:#ffd23f;text-shadow:${SHADOW};`, title);
    // Same font size as the rows so the em column widths line up; the labels are shrunk inside.
    const head = mk(holder, 'display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;font-size:clamp(10px,2.9vw,15px);font-weight:700;opacity:0.6;letter-spacing:0.06em;');
    const label = (style: string, text: string) => {
      const cell = mk(head, style);
      mk(cell, 'font-size:0.7em;', text);
    };
    label('width:1.6em;flex:none;', '#');
    mk(head, 'width:12px;flex:none;');
    label('flex:1;min-width:0;', 'CAR');
    label('width:4.6em;flex:none;text-align:right;', 'SURVIVED');
    label('width:2.4em;flex:none;text-align:right;', 'KOS');
    label('width:3em;flex:none;text-align:right;', 'DMG');
    label('width:9.5em;flex:none;text-align:right;', 'STATUS');
    for (const r of rows) {
      const row = mk(
        holder,
        `display:flex;align-items:center;gap:8px;padding:6px 8px;margin-top:3px;border-left:4px solid ${r.isPlayer ? '#ffd23f' : 'transparent'};background:${r.isPlayer ? 'rgba(255,210,63,0.12)' : 'rgba(255,255,255,0.05)'};font-size:clamp(10px,2.9vw,15px);font-weight:${r.isPlayer ? 900 : 600};`,
      );
      mk(row, 'width:1.6em;flex:none;font-variant-numeric:tabular-nums;', String(r.place));
      mk(row, `width:12px;height:12px;flex:none;border-radius:3px;background:${r.color};box-shadow:0 0 0 1px rgba(0,0,0,0.6);`);
      mk(row, 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', r.name);
      mk(row, 'width:4.6em;flex:none;text-align:right;font-variant-numeric:tabular-nums;', formatTime(r.survived));
      mk(row, 'width:2.4em;flex:none;text-align:right;font-variant-numeric:tabular-nums;', String(r.takedowns));
      mk(row, 'width:3em;flex:none;text-align:right;font-variant-numeric:tabular-nums;', String(Math.round(r.damage)));
      const st = mk(row, 'width:9.5em;flex:none;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.85em;', r.status);
      if (r.status === 'WINNER') st.style.color = '#ffd23f';
    }
    mk(holder, 'text-align:center;margin-top:12px;font-size:clamp(11px,3vw,14px);font-weight:700;opacity:0.85;', footer);
    this.results.replaceChildren(...Array.from(holder.childNodes));
    this.results.style.display = 'block';
    this.resultsVisible = true;
    this.big.style.opacity = '0';
    this.lastBig = '';
    this.big.textContent = '';
    this.lastSpectate = '\0';
    this.spectate.style.display = 'none';
  }

  hideResults(): void {
    this.resultsVisible = false;
    if (this.results) this.results.style.display = 'none';
    this.lastSpectate = '\0';
  }

  dispose(): void {
    clearTimeout(this.noticeTimer);
    clearTimeout(this.flashTimer);
    this.root.remove();
  }

  private buildRow(): RosterRow {
    const row = el(this.roster, 'display:flex;align-items:center;gap:4px;padding:2px 0;');
    const swatch = el(row, 'width:9px;height:9px;flex:none;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,0.6);');
    const mid = el(row, 'flex:1;min-width:0;');
    const line = el(mid, 'display:flex;align-items:baseline;gap:4px;');
    const name = el(line, 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.15;');
    const hunt = el(line, 'flex:none;width:7px;height:7px;border-radius:50%;background:#ff3b30;box-shadow:0 0 5px #ff3b30;display:none;');
    const reason = el(line, 'flex:none;font-size:0.8em;color:#ff7b72;display:none;');
    const track = el(mid, 'margin-top:1px;height:3px;border-radius:2px;background:rgba(255,255,255,0.15);overflow:hidden;');
    const fill = el(track, 'height:100%;');
    return { row, swatch, name, fill, hunt, reason, key: '' };
  }

  private updateRoster(cars: readonly DerbyHudCar[]): void {
    while (this.rows.length < cars.length) this.rows.push(this.buildRow());
    while (this.rows.length > cars.length) this.rows.pop()!.row.remove();
    const ordered = rosterOrder(cars);
    for (let i = 0; i < ordered.length; i++) {
      const c = ordered[i]!;
      const r = this.rows[i]!;
      const pct = Math.round(Math.min(1, Math.max(0, c.health)) * 100);
      const key = `${c.name}|${c.color}|${c.out ?? ''}|${c.isPlayer}|${c.huntingPlayer}|${c.out ? 0 : pct}`;
      if (key === r.key) continue;
      r.key = key;
      const out = c.out !== null;
      r.swatch.style.background = c.color;
      r.name.textContent = c.isPlayer ? 'YOU' : c.name;
      r.name.style.fontWeight = c.isPlayer ? '900' : '700';
      r.name.style.textDecoration = out ? 'line-through' : 'none';
      r.row.style.opacity = out ? '0.45' : '1';
      r.row.style.filter = out ? 'grayscale(1)' : 'none';
      r.row.style.boxShadow = c.isPlayer ? 'inset 0 0 0 1px rgba(255,255,255,0.85)' : 'none';
      r.row.style.padding = c.isPlayer ? '2px 3px' : '2px 0';
      r.hunt.style.display = !out && c.huntingPlayer ? 'block' : 'none';
      r.reason.style.display = out ? 'block' : 'none';
      r.reason.textContent = c.out ?? '';
      r.fill.style.width = `${out ? 0 : pct}%`;
      r.fill.style.background = healthColor(c.health);
    }
  }

  private drawMap(state: DerbyHudState): void {
    const g = this.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.scale(this.dpr, this.dpr);
    const c = MAP_SIZE / 2;
    const r = c - MAP_PAD;
    const h = state.view.heading;

    g.fillStyle = 'rgba(20,14,10,0.75)';
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 3;
    g.stroke();

    // Out cars first so running cars draw on top.
    g.strokeStyle = 'rgba(160,160,160,0.8)';
    g.lineWidth = 1.5;
    for (const car of state.cars) {
      if (car.out === null) continue;
      const q = arenaProject(car.x, car.z, this.arenaRadius, h);
      const px = c + q.u * r;
      const py = c + q.v * r;
      g.beginPath();
      g.moveTo(px - 3, py - 3);
      g.lineTo(px + 3, py + 3);
      g.moveTo(px + 3, py - 3);
      g.lineTo(px - 3, py + 3);
      g.stroke();
    }

    g.lineWidth = 1;
    for (const car of state.cars) {
      if (car.out !== null || car.isPlayer) continue;
      const q = arenaProject(car.x, car.z, this.arenaRadius, h);
      g.fillStyle = car.color;
      g.strokeStyle = car.huntingPlayer ? '#ff3b30' : 'rgba(0,0,0,0.8)';
      g.lineWidth = car.huntingPlayer ? 2 : 1;
      g.beginPath();
      g.arc(c + q.u * r, c + q.v * r, 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    const player = state.cars.find((p) => p.isPlayer && p.out === null);
    if (player) {
      const q = arenaProject(player.x, player.z, this.arenaRadius, h);
      // The player's own heading is not in the state; the view heading is the followed car's, which is the player while running.
      g.save();
      g.translate(c + q.u * r, c + q.v * r);
      g.fillStyle = player.color;
      g.strokeStyle = '#fff';
      g.lineWidth = 1.8;
      g.beginPath();
      g.moveTo(0, -7);
      g.lineTo(5, 5);
      g.lineTo(-5, 5);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
  }
}
