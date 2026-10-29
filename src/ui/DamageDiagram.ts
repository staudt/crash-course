import type { DamageReport } from '../vehicle/DamageReport';

const FONT = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const STOPS: [number, number, number][] = [
  [0xff, 0x3b, 0x30], // 0
  [0xff, 0x8a, 0x2a], // 1/3
  [0xff, 0xd2, 0x3f], // 2/3
  [0x36, 0xd1, 0x7a], // 1
];

/** Pure: css colour for a zone health (1 green .. 0 red); null (lost) → 'none'. */
export function damageColor(value: number | null): string {
  if (value === null) return 'none';
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 3;
  const i = Math.min(2, Math.floor(v));
  const t = v - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  const c = (k: number) => Math.round(a[k]! + (b[k]! - a[k]!) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

type Zone =
  | 'bumperFront' | 'engine' | 'doorLeft' | 'doorRight' | 'chassis' | 'bumperRear'
  | 'wheelFL' | 'wheelFR' | 'wheelRL' | 'wheelRR';

/** [x, y, w, h, rx, tooltip] in the 60x104 viewBox, nose at the top. */
const ZONES: Record<Zone, [number, number, number, number, number, string]> = {
  bumperFront: [16, 2, 28, 6, 2, 'Front bumper'],
  engine: [16, 10, 28, 22, 3, 'Engine'],
  doorLeft: [14, 34, 6, 60, 2, 'Left side'],
  doorRight: [40, 34, 6, 60, 2, 'Right side'],
  chassis: [22, 34, 16, 60, 2, 'Chassis'],
  bumperRear: [16, 96, 28, 6, 2, 'Rear bumper'],
  wheelFL: [4, 14, 8, 18, 3, 'Front left wheel'],
  wheelFR: [48, 14, 8, 18, 3, 'Front right wheel'],
  wheelRL: [4, 74, 8, 18, 3, 'Rear left wheel'],
  wheelRR: [48, 74, 8, 18, 3, 'Rear right wheel'],
};

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = '@keyframes dmgdiagram-blink{0%,100%{opacity:1}50%{opacity:0.2}}';
  document.head.appendChild(s);
}

const NS = 'http://www.w3.org/2000/svg';

function zoneValues(r: DamageReport): Record<Zone, number | null> {
  return {
    bumperFront: r.bumperFront, engine: r.engine, doorLeft: r.doorLeft, doorRight: r.doorRight,
    chassis: r.chassis, bumperRear: r.bumperRear,
    wheelFL: r.wheels[0], wheelFR: r.wheels[1], wheelRL: r.wheels[2], wheelRR: r.wheels[3],
  };
}

/** Top-down car silhouette with each zone coloured by damage. Nose is up. */
export class DamageDiagram {
  readonly element: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly rects = new Map<Zone, SVGRectElement>();
  private readonly colors = new Map<Zone, string>();
  private readonly cross: SVGGElement;
  private readonly caption: HTMLElement;
  private wrecked: boolean | null = null;
  private blinking: boolean | null = null;

  constructor(parent: HTMLElement) {
    injectStyle();
    const el = document.createElement('div');
    el.style.cssText =
      `display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 8px;border-radius:8px;` +
      `background:rgba(0,0,0,0.35);pointer-events:none;color:#fff;font-family:${FONT};` +
      `text-shadow:0 1px 3px rgba(0,0,0,0.8);user-select:none;`;
    this.element = el;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 60 104');
    svg.style.cssText = 'width:clamp(42px,8vw,64px);height:auto;aspect-ratio:60/104;display:block;overflow:visible;';
    this.svg = svg;
    for (const zone of Object.keys(ZONES) as Zone[]) {
      const [x, y, w, h, rx, tip] = ZONES[zone];
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(w));
      r.setAttribute('height', String(h));
      r.setAttribute('rx', String(rx));
      r.setAttribute('stroke', 'rgba(0,0,0,0.6)');
      r.setAttribute('stroke-width', '1');
      const t = document.createElementNS(NS, 'title');
      t.textContent = tip;
      r.appendChild(t);
      svg.appendChild(r);
      this.rects.set(zone, r);
    }
    const cross = document.createElementNS(NS, 'g');
    cross.setAttribute('stroke', '#ff3b30');
    cross.setAttribute('stroke-width', '4');
    cross.setAttribute('stroke-linecap', 'round');
    cross.setAttribute('display', 'none');
    for (const [x1, y1, x2, y2] of [[6, 6, 54, 98], [54, 6, 6, 98]] as const) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', String(x1));
      l.setAttribute('y1', String(y1));
      l.setAttribute('x2', String(x2));
      l.setAttribute('y2', String(y2));
      cross.appendChild(l);
    }
    svg.appendChild(cross);
    this.cross = cross;
    el.appendChild(svg);

    const cap = document.createElement('div');
    cap.textContent = 'DAMAGE';
    cap.style.cssText = 'font-size:8px;letter-spacing:0.2em;opacity:0.85;';
    this.caption = cap;
    el.appendChild(cap);
    parent.appendChild(el);
  }

  update(report: DamageReport): void {
    const values = zoneValues(report);
    for (const zone of Object.keys(ZONES) as Zone[]) {
      const color = damageColor(values[zone]);
      if (this.colors.get(zone) === color) continue;
      this.colors.set(zone, color);
      const r = this.rects.get(zone)!;
      if (color === 'none') {
        r.setAttribute('fill', 'none');
        r.setAttribute('stroke', 'rgba(255,255,255,0.45)');
        r.setAttribute('stroke-dasharray', '2 1.5');
      } else {
        r.setAttribute('fill', color);
        r.setAttribute('stroke', 'rgba(0,0,0,0.6)');
        r.removeAttribute('stroke-dasharray');
      }
    }
    const blink = report.chassis < 0.25 && !report.wrecked;
    if (blink !== this.blinking) {
      this.blinking = blink;
      this.rects.get('chassis')!.style.animation = blink ? 'dmgdiagram-blink 0.5s infinite' : '';
    }
    if (report.wrecked !== this.wrecked) {
      this.wrecked = report.wrecked;
      this.svg.style.opacity = report.wrecked ? '0.55' : '1';
      this.svg.style.filter = report.wrecked ? 'saturate(0.4)' : '';
      this.cross.setAttribute('display', report.wrecked ? 'inline' : 'none');
      this.caption.textContent = report.wrecked ? 'WRECKED' : 'DAMAGE';
      this.caption.style.color = report.wrecked ? '#ff3b30' : '';
    }
  }
}
