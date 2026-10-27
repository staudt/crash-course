import type { TrackPath } from '../race/TrackPath';

/**
 * Where the fixed-angle camera should zoom and lean, given the action around the player:
 * a rival right beside you zooms in; a rival further off widens the view and leans toward
 * it so it stays in frame; a sharp bend coming up at speed leans the view toward it and
 * widens it so you see the corner early. Pure: CameraRig smooths the result.
 */
export const FRAMING_CONFIG = {
  /** Rivals closer than this zoom the view in by closeZoom (m of camera distance). */
  closeRange: 14,
  closeZoom: -28,
  /** Rivals out to frameRange widen the view up to farZoom; beyond it they are ignored. */
  frameRange: 90,
  farZoom: 52,
  /** Fraction of the way toward the nearest rival the view leans (when it is far enough to need it). */
  rivalLean: 0.35,
  /** Bends tighter than curveRadius within curveLook metres ahead pull the view toward them. */
  curveLook: 160,
  curveRadius: 120,
  curveShift: 10,
  curveZoom: 32,
  /** Bend framing fades in up to this speed (m/s): no point leaning ahead while crawling. */
  curveSpeed: 25,
  /** Cap on the total lean (m). */
  maxShift: 32,
};

export interface Framing {
  /** Added camera distance (m); negative zooms in. */
  zoom: number;
  /** Look-target offset from the car on the ground plane (m). */
  lookX: number;
  lookZ: number;
}

interface XZ {
  x: number;
  z: number;
}

/** `s` is the car's position along the track; `others` the other cars' positions. */
export function cameraFraming(path: TrackPath | null, s: number, car: XZ, speed: number, others: readonly XZ[]): Framing {
  const c = FRAMING_CONFIG;
  const f: Framing = { zoom: 0, lookX: 0, lookZ: 0 };

  let nearest: XZ | null = null;
  let best = c.frameRange;
  for (const o of others) {
    const d = Math.hypot(o.x - car.x, o.z - car.z);
    if (d < best) {
      best = d;
      nearest = o;
    }
  }
  if (nearest) {
    const wide = smoothstep(c.closeRange, c.frameRange * 0.75, best);
    const fade = 1 - smoothstep(c.frameRange * 0.75, c.frameRange, best);
    f.zoom += (c.closeZoom + (c.farZoom - c.closeZoom) * wide) * fade;
    f.lookX += (nearest.x - car.x) * c.rivalLean * wide * fade;
    f.lookZ += (nearest.z - car.z) * c.rivalLean * wide * fade;
  }

  if (path) {
    const pace = Math.min(1, Math.max(0, speed) / c.curveSpeed);
    for (let d = 0; d <= c.curveLook && pace > 0; d += 4) {
      if (Math.abs(path.curvatureAt(s + d)) * c.curveRadius <= 1) continue;
      const w = (1 - d / c.curveLook) * pace;
      // Lean toward a point a little into the bend, where the road turns away.
      const p = path.pointAt(s + d + 20, { x: 0, z: 0 });
      const len = Math.hypot(p.x - car.x, p.z - car.z) || 1;
      f.lookX += ((p.x - car.x) / len) * c.curveShift * w;
      f.lookZ += ((p.z - car.z) / len) * c.curveShift * w;
      f.zoom += c.curveZoom * w;
      break;
    }
  }

  const shift = Math.hypot(f.lookX, f.lookZ);
  if (shift > c.maxShift) {
    f.lookX *= c.maxShift / shift;
    f.lookZ *= c.maxShift / shift;
  }
  return f;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
