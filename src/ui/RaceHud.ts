export interface RaceHudState {
  phase: 'countdown' | 'racing';
  /** Seconds left in the countdown (only meaningful when phase === 'countdown'). */
  countdown: number;
  /** 1-based lap number in progress. */
  lap: number;
  /** Current lap time in seconds. */
  lapTime: number;
  bestLap: number | null;
  lastLap: number | null;
  /** Index of the checkpoint the player must cross next (0 = finish line). */
  nextCheckpoint: number;
  checkpointCount: number;
  wrongWay: boolean;
  /** Player car in world space; heading is yaw where 0 faces +Z and the direction is (sin h, cos h). */
  car: { x: number; z: number; heading: number };
  /** Race mode: current position (1-based) and field size. Omit both in time trial. */
  position?: number;
  racers?: number;
  /** Race mode: laps in the race (the timer line then shows "LAP 2/3"). */
  totalLaps?: number;
  /** Minimap markers for the other cars (world x/z, CSS colour). */
  opponents?: { x: number; z: number; color: string }[];
}

export interface ResultRow {
  position: number;
  name: string;
  color: string;
  /** Total race time in seconds, or null if the racer has not finished (shown as "racing…" or "DNF" via `status`). */
  time: number | null;
  status?: string;
  isPlayer: boolean;
}

const FONT = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SHADOW = '0 2px 0 rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.5)';
const MAP_PAD = 10;
const MAP_DECIMATE = 4;
const GO_SECONDS = 0.8;

/** "1:23.45" (m:ss.cc). Negative or non-finite values give "--:--.--". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const cs = Math.round(seconds * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Signed split delta: "-1.23" / "+0.50" (always shows a sign, 2 decimals). */
export function formatDelta(seconds: number): string {
  const r = Math.round(seconds * 100) / 100;
  const neg = r < 0;
  return `${neg ? '-' : '+'}${Math.abs(r).toFixed(2)}`;
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th", 21 → "21st". */
export function ordinal(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/**
 * Project world (x, z) into minimap space, rotated so the camera's view direction points up.
 * right = (-up.z, up.x). Returns { u: dot(p, right), v: -dot(p, up) }, so +v is DOWN the canvas.
 */
export function minimapProject(x: number, z: number, up: { x: number; z: number }): { u: number; v: number } {
  return { u: x * -up.z + z * up.x, v: -(x * up.x + z * up.z) };
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
  s.textContent = '@keyframes racehud-blink{0%,100%{opacity:1}50%{opacity:0.15}}';
  document.head.appendChild(s);
}

export class RaceHud {
  private readonly timer: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly split: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly big: HTMLDivElement;
  private readonly lapBox: HTMLDivElement;
  private readonly lapText: HTMLDivElement;
  private readonly lapBest: HTMLDivElement;
  private readonly wrong: HTMLDivElement;
  private readonly posBox: HTMLDivElement;
  private readonly posNum: HTMLSpanElement;
  private readonly posOf: HTMLSpanElement;
  private readonly root: HTMLDivElement;
  private results: HTMLDivElement | null = null;
  private resultsVisible = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly size: number;
  private readonly dpr: number;

  private outline: HTMLCanvasElement | null = null;
  private up = { x: 0, z: 1 };
  private fit = { scale: 1, ox: 0, oy: 0 };
  private checkpoints: { x: number; z: number }[] = [];

  private lastTimer = '';
  private lastInfo = '';
  private lastBig = '';
  private lastWrong = false;
  private lastPos = '';
  private prevPhase: 'countdown' | 'racing' | null = null;
  private goUntil = 0;
  private splitTimer: ReturnType<typeof setTimeout> | undefined;
  private lapTimerId: ReturnType<typeof setTimeout> | undefined;

  constructor(container: HTMLElement) {
    injectStyle();
    const root = el(
      container,
      `position:absolute;inset:0;pointer-events:none;overflow:hidden;color:#fff;font-family:${FONT};text-shadow:${SHADOW};user-select:none;`,
    );

    const top = el(root, 'position:absolute;left:0;right:0;top:12px;text-align:center;');
    this.timer = el(top, 'font-size:clamp(28px,7vw,48px);line-height:1;font-weight:900;font-variant-numeric:tabular-nums;', formatTime(0));
    this.info = el(top, 'margin-top:4px;font-size:clamp(10px,2.6vw,14px);font-weight:700;font-variant-numeric:tabular-nums;opacity:0.95;');
    this.split = el(top, 'margin-top:4px;font-size:clamp(16px,4vw,26px);font-weight:900;opacity:0;transition:opacity 0.3s;');
    this.notice = el(top, 'margin-top:4px;font-size:clamp(13px,3.2vw,20px);font-weight:900;letter-spacing:0.04em;opacity:0;transition:opacity 0.3s;');

    this.big = el(
      root,
      'position:absolute;left:0;right:0;top:14%;text-align:center;font-size:clamp(64px,18vw,160px);font-weight:900;line-height:1;opacity:0;',
    );

    this.lapBox = el(root, 'position:absolute;left:0;right:0;top:24%;text-align:center;opacity:0;transition:opacity 0.3s;');
    this.lapText = el(this.lapBox, 'font-size:clamp(32px,9vw,72px);font-weight:900;font-variant-numeric:tabular-nums;');
    this.lapBest = el(this.lapBox, 'margin-top:6px;font-size:clamp(20px,5vw,40px);font-weight:900;color:#ffd23f;');

    this.wrong = el(
      root,
      'position:absolute;left:0;right:0;top:22%;text-align:center;font-size:clamp(28px,8vw,64px);font-weight:900;letter-spacing:0.06em;color:#ff3b30;display:none;animation:racehud-blink 0.7s steps(2,jump-none) infinite;',
      'WRONG WAY',
    );

    this.root = root;
    this.posBox = el(root, 'position:absolute;left:16px;top:12px;line-height:1;white-space:nowrap;display:none;');
    this.posNum = document.createElement('span');
    this.posNum.style.cssText = 'font-size:clamp(30px,8vw,56px);font-weight:900;font-variant-numeric:tabular-nums;';
    this.posOf = document.createElement('span');
    this.posOf.style.cssText = 'margin-left:4px;font-size:clamp(12px,3vw,20px);font-weight:700;opacity:0.85;';
    this.posBox.append(this.posNum, this.posOf);

    this.size = 180;
    this.dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = Math.round(this.size * this.dpr);
    this.canvas.style.cssText =
      'position:absolute;right:16px;top:16px;width:min(180px,34vw);aspect-ratio:1;border-radius:12px;background:rgba(0,0,0,0.4);box-shadow:0 0 0 2px rgba(0,0,0,0.35);';
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  setTrack(points: { x: number; z: number }[], checkpoints: { x: number; z: number }[], viewUp: { x: number; z: number }): void {
    this.up = viewUp;
    this.checkpoints = checkpoints;
    const proj = points.map((p) => minimapProject(p.x, p.z, viewUp));
    if (proj.length === 0) {
      this.outline = null;
      return;
    }
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of proj) {
      if (p.u < minU) minU = p.u;
      if (p.u > maxU) maxU = p.u;
      if (p.v < minV) minV = p.v;
      if (p.v > maxV) maxV = p.v;
    }
    const px = this.size - MAP_PAD * 2;
    const scale = Math.min(px / Math.max(maxU - minU, 1e-6), px / Math.max(maxV - minV, 1e-6));
    const ox = MAP_PAD + (px - (maxU - minU) * scale) / 2 - minU * scale;
    const oy = MAP_PAD + (px - (maxV - minV) * scale) / 2 - minV * scale;
    this.fit = { scale, ox, oy };

    const off = document.createElement('canvas');
    off.width = off.height = Math.round(this.size * this.dpr);
    const g = off.getContext('2d');
    if (!g) return;
    g.scale(this.dpr, this.dpr);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const trace = (): void => {
      g.beginPath();
      for (let i = 0; i < proj.length; i += MAP_DECIMATE) {
        const x = proj[i]!.u * scale + ox;
        const y = proj[i]!.v * scale + oy;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
    };
    trace();
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 5;
    g.stroke();
    trace();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 3;
    g.stroke();
    // start/finish marker
    const s = proj[0]!;
    g.fillStyle = '#fff';
    g.fillRect(s.u * scale + ox - 3, s.v * scale + oy - 3, 6, 6);
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.strokeRect(s.u * scale + ox - 3, s.v * scale + oy - 3, 6, 6);
    this.outline = off;
  }

  update(state: RaceHudState): void {
    const now = performance.now();

    const t = formatTime(state.lapTime);
    if (t !== this.lastTimer) {
      this.lastTimer = t;
      this.timer.textContent = t;
    }
    const cp = state.nextCheckpoint === 0 ? state.checkpointCount : state.nextCheckpoint;
    const lapLabel = state.totalLaps !== undefined ? `${Math.min(state.lap, state.totalLaps)}/${state.totalLaps}` : `${state.lap}`;
    let info = `LAP ${lapLabel} · CP ${cp}/${state.checkpointCount}`;
    if (state.bestLap !== null) info += ` · BEST ${formatTime(state.bestLap)}`;
    if (state.lastLap !== null) info += ` · LAST ${formatTime(state.lastLap)}`;
    if (info !== this.lastInfo) {
      this.lastInfo = info;
      this.info.textContent = info;
    }

    const posKey = state.position !== undefined && state.racers !== undefined ? `${state.position}/${state.racers}` : '';
    if (posKey !== this.lastPos) {
      this.lastPos = posKey;
      if (posKey) {
        this.posNum.textContent = ordinal(state.position!);
        this.posOf.textContent = `/ ${state.racers}`;
      }
      this.posBox.style.display = posKey ? 'block' : 'none';
    }

    if (state.phase === 'racing' && this.prevPhase === 'countdown') this.goUntil = now + GO_SECONDS * 1000;
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

    const wrong = state.wrongWay && !this.resultsVisible;
    if (wrong !== this.lastWrong) {
      this.lastWrong = wrong;
      this.wrong.style.display = wrong ? 'block' : 'none';
    }

    this.drawMap(state, now);
  }

  flashSplit(delta: number | null): void {
    if (delta === null) {
      this.split.textContent = 'CHECKPOINT';
      this.split.style.color = '#fff';
    } else {
      this.split.textContent = formatDelta(delta);
      this.split.style.color = delta < 0 ? '#4cd964' : '#ff3b30';
    }
    this.split.style.opacity = '1';
    clearTimeout(this.splitTimer);
    this.splitTimer = setTimeout(() => { this.split.style.opacity = '0'; }, 2000);
  }

  /** A short line under the timer for ~2.5 s (e.g. a rival coming after you), in `color`. */
  notify(text: string, color: string): void {
    this.notice.textContent = text;
    this.notice.style.color = color;
    this.notice.style.opacity = '1';
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice.style.opacity = '0'; }, 2500);
  }

  flashLap(time: number, isBest: boolean): void {
    this.lapText.textContent = `LAP ${formatTime(time)}`;
    this.lapBest.textContent = isBest ? 'NEW BEST!' : '';
    this.lapBox.style.opacity = '1';
    clearTimeout(this.lapTimerId);
    this.lapTimerId = setTimeout(() => { this.lapBox.style.opacity = '0'; }, 2500);
  }

  showResults(title: string, rows: ResultRow[], footer: string): void {
    if (!this.results) {
      this.results = el(
        this.root,
        'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,92vw);box-sizing:border-box;padding:16px 14px;background:rgba(0,0,0,0.65);border-radius:14px;text-shadow:none;',
      );
    }
    const panel = this.results;
    const frag = document.createDocumentFragment();
    const mk = (parent: HTMLElement, css: string, text = ''): HTMLDivElement => {
      const d = document.createElement('div');
      d.style.cssText = css;
      d.textContent = text;
      parent.appendChild(d);
      return d;
    };
    const holder = document.createElement('div');
    mk(holder, 'text-align:center;font-size:clamp(22px,6vw,34px);font-weight:900;margin-bottom:12px;color:#ffd23f;text-shadow:' + SHADOW + ';', title);
    const winner = rows.find((r) => r.time !== null);
    for (const r of rows) {
      const row = mk(
        holder,
        `display:flex;align-items:center;gap:8px;padding:6px 8px;margin-top:3px;border-left:4px solid ${r.isPlayer ? '#ffd23f' : 'transparent'};background:${r.isPlayer ? 'rgba(255,210,63,0.12)' : 'rgba(255,255,255,0.05)'};font-size:clamp(13px,3.6vw,17px);font-weight:${r.isPlayer ? 900 : 600};`,
      );
      mk(row, 'width:3em;flex:none;font-variant-numeric:tabular-nums;', ordinal(r.position));
      mk(row, `width:12px;height:12px;flex:none;border-radius:3px;background:${r.color};box-shadow:0 0 0 1px rgba(0,0,0,0.6);`);
      mk(row, 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', r.name);
      const t = mk(row, 'flex:none;text-align:right;font-variant-numeric:tabular-nums;');
      if (r.time !== null) {
        t.textContent = formatTime(r.time);
        if (winner && r !== winner) {
          const gap = document.createElement('span');
          gap.style.cssText = 'margin-left:8px;font-size:0.75em;opacity:0.65;font-weight:600;';
          gap.textContent = `+${(r.time - winner.time!).toFixed(2)}`;
          t.appendChild(gap);
        }
      } else {
        t.textContent = r.status ?? 'racing…';
        t.style.opacity = '0.7';
      }
    }
    mk(holder, 'text-align:center;margin-top:12px;font-size:clamp(11px,3vw,14px);font-weight:700;opacity:0.85;', footer);
    frag.append(...Array.from(holder.childNodes));
    panel.replaceChildren(frag);
    panel.style.display = 'block';
    this.resultsVisible = true;
    this.big.style.opacity = '0';
    this.lastBig = '';
    this.big.textContent = '';
    this.wrong.style.display = 'none';
    this.lastWrong = false;
  }

  hideResults(): void {
    this.resultsVisible = false;
    if (this.results) this.results.style.display = 'none';
  }

  private drawMap(state: RaceHudState, now: number): void {
    const g = this.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.outline) return;
    g.drawImage(this.outline, 0, 0);
    g.scale(this.dpr, this.dpr);
    const { scale, ox, oy } = this.fit;

    for (const o of state.opponents ?? []) {
      const q = minimapProject(o.x, o.z, this.up);
      g.fillStyle = o.color;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(q.u * scale + ox, q.v * scale + oy, 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    const cp = this.checkpoints[state.nextCheckpoint];
    if (cp && state.phase === 'racing') {
      const p = minimapProject(cp.x, cp.z, this.up);
      const pulse = 0.5 + 0.5 * Math.sin(now / 160);
      g.fillStyle = '#ffd23f';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(p.u * scale + ox, p.v * scale + oy, 4 + pulse * 2.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    const c = state.car;
    const cp0 = minimapProject(c.x, c.z, this.up);
    const d = minimapProject(Math.sin(c.heading), Math.cos(c.heading), this.up);
    const cx = cp0.u * scale + ox;
    const cy = cp0.v * scale + oy;
    const ang = Math.atan2(d.v, d.u);
    g.save();
    g.translate(cx, cy);
    g.rotate(ang);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(7, 0);
    g.lineTo(-5, 4.5);
    g.lineTo(-5, -4.5);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
