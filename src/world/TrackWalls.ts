import type { TrackPath } from '../race/TrackPath';

/** One straight wall block: centre, length along the wall, and yaw that turns local +z toward the road. */
export interface WallBlock {
  x: number;
  z: number;
  length: number;
  yaw: number;
}

export const TRACK_WALL_CONFIG = {
  thickness: 1.2,
  height: 1.8,
  /** Wall blocks are at most this long (m); curves are followed chord by chord. */
  blockLength: 4,
  /** Scan step (m) along the track: how precisely a wall stops where it meets another road. */
  scan: 0.5,
  /** The gap follows the bend curvature averaged over ± this (m), so it opens before a bend and closes after it. */
  bendWindow: 12,
  /** Curvature (1/m) at and above which a bend gets its full inside/outside gap. */
  bendFull: 1 / 40,
  /** Parts of the track further than this along it (m) count as another road (e.g. the one crossing this). */
  elsewhere: 40,
  /** Each end of a wall run reaches this far past where it meets another wall, closing the corner. */
  endReach: 0.9,
  /** Cars ride along these walls on a glancing touch (ConcreteWall.smooth). */
  smooth: true,
};

/**
 * Concrete walls along both sides of a walled track (`def.walls` gives the gaps from the road edge).
 * Each side runs along an offset of the centreline: `straight` m off the edge on straights, opening to
 * `inside`/`outside` round bends. A wall stops where it would run into another stretch of road (the
 * crossing of a figure 8), so the walls of two crossing roads meet at the corners of an open X. Pure.
 */
export function trackWallBlocks(path: TrackPath, cfg = TRACK_WALL_CONFIG): WallBlock[] {
  const lateralAt = wallLaterals(path, cfg);
  if (!lateralAt) return [];
  const steps = Math.ceil(path.length / cfg.scan);
  const ds = path.length / steps;
  const p = { x: 0, z: 0 };
  const t = { x: 0, z: 0 };
  const blocks: WallBlock[] = [];

  for (const side of [1, -1]) {
    /** Wall centreline point at s (side +1 = left of travel), or null where another road is in the way. */
    const point = (s: number): { x: number; z: number; lateral: number } => {
      const lateral = lateralAt(s, side);
      path.pointAt(s, p);
      path.tangentAt(s, t);
      return { x: p.x + t.z * lateral * side, z: p.z - t.x * lateral * side, lateral };
    };
    const blocked = (s: number): boolean => {
      const w = point(s);
      return path.distanceElsewhere(w.x, w.z, s, cfg.elsewhere) < w.lateral;
    };

    const free = Array.from({ length: steps }, (_, i) => !blocked(i * ds));
    // Start scanning at a blocked step so no run wraps past the end of the array.
    const first = free.indexOf(false);
    const runs: [number, number][] = [];
    if (first < 0) runs.push([0, path.length]);
    else {
      let open = -1;
      for (let k = 1; k <= steps; k++) {
        const i = (first + k) % steps;
        const s = (first + k) * ds;
        if (free[i] && open < 0) open = s;
        if (!free[i] && open >= 0) {
          runs.push([open - cfg.endReach, s - ds + cfg.endReach]);
          open = -1;
        }
      }
    }

    for (const [a, b] of runs) {
      const n = Math.max(1, Math.ceil((b - a) / cfg.blockLength));
      for (let j = 0; j < n; j++) {
        const p0 = point(a + ((b - a) * j) / n);
        const p1 = point(a + ((b - a) * (j + 1)) / n);
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const len = Math.hypot(dx, dz) || 1;
        // The road is to the right of a left-side wall (+1) going along the track, and to the left of a right-side one.
        const nx = (-dz / len) * side;
        const nz = (dx / len) * side;
        blocks.push({ x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2, length: len, yaw: Math.atan2(nx, nz) });
      }
    }
  }
  return blocks;
}

/**
 * Distance (m) from the centreline to the wall's centre on `side` (+1 = left of travel) at s, or null for an
 * unwalled track: `straight` m off the road edge, opening to `inside`/`outside` round bends.
 */
export function wallLaterals(path: TrackPath, cfg = TRACK_WALL_CONFIG): ((s: number, side: number) => number) | null {
  const gaps = path.def.walls;
  if (!gaps) return null;
  const bend = averagedCurvature(path, cfg.bendWindow);
  return (s, side) => {
    const k = sampleLoop(bend, s / path.step);
    const full = Math.min(1, Math.abs(k) / cfg.bendFull);
    // Turning left (k > 0), the left side (+1) is the inside.
    const curveGap = k * side > 0 ? gaps.inside : gaps.outside;
    return path.halfWidth + gaps.straight + (curveGap - gaps.straight) * full + cfg.thickness / 2;
  };
}

/** Signed curvature averaged over ± `window` m around each sample (circular box filter, 2 passes). */
function averagedCurvature(path: TrackPath, window: number): Float64Array {
  const n = path.count;
  const w = Math.max(1, Math.round(window / path.step));
  let k = Float64Array.from(path.curvature);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let o = -w; o <= w; o++) sum += k[(i + o + n) % n]!;
      out[i] = sum / (2 * w + 1);
    }
    k = out;
  }
  return k;
}

function sampleLoop(a: Float64Array, u: number): number {
  const n = a.length;
  const i = ((Math.floor(u) % n) + n) % n;
  const f = u - Math.floor(u);
  return a[i]! + (a[(i + 1) % n]! - a[i]!) * f;
}
