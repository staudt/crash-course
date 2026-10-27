import type { TrackPath } from '../race/TrackPath';
import { sampleHeight, type TerrainData } from './TerrainData';

/**
 * Cuts the race road into the generated dunes. Pure (no three): the road profile
 * follows a smoothed, grade-limited version of the natural ground, kickers are
 * added at the track's jumps, and the terrain blends from the flat road out to
 * the untouched dunes through banks that get wider the deeper the cut.
 * Open-sand stretches (`path.sandiness`) get a rougher profile that rides the dunes, and keep loose sand.
 */
export const ROAD_CONFIG = {
  /** Half-window (m) of the box filter that smooths the natural ground into a road profile; applied 3 times. */
  smoothWindow: 20,
  /** Half-window (m) of the final smoothing that rounds crests and sags, so fast cars neither launch nor bottom out. */
  crestWindow: 50,
  /** Max road grade (rise per metre), so the road rolls over dunes instead of climbing them. */
  maxGrade: 0.12,
  /** Flat strip (m) beyond the road edge before the banks start. */
  shoulder: 2.5,
  /** Bank width (m) = bankMin + bankPerMetre * |height difference|, capped at bankMax. */
  bankMin: 6,
  bankPerMetre: 1.6,
  bankMax: 45,
  /** Kicker: rises jumpHeight over jumpRun metres to the lip, then drops back over jumpDrop. */
  jumpHeight: 2,
  jumpRun: 30,
  jumpDrop: 8,
  /** Softness of the packed road (0 firm .. 1 deep sand). */
  roadSoftness: 0.04,
  /** Open sand: lighter smoothing (m, 2 passes) and a steeper grade limit, so the track rides the dunes. */
  sandSmoothWindow: 8,
  sandMaxGrade: 0.22,
  sandCrestWindow: 30,
  /** Minimum softness on open-sand stretches (deep sand elsewhere stays deeper). */
  sandSoftness: 0.5,
};

/** Fills `path.elevation` from the natural (uncarved) terrain. Call before `carveRoad`. */
export function buildElevation(path: TrackPath, data: TerrainData): void {
  const n = path.count;
  const hw = path.halfWidth;
  const h = path.elevation;
  for (let i = 0; i < n; i++) {
    const x = path.xs[i]!;
    const z = path.zs[i]!;
    const lx = path.tzs[i]! * hw;
    const lz = -path.txs[i]! * hw;
    h[i] = (sampleHeight(data, x, z) * 2 + sampleHeight(data, x + lx, z + lz) + sampleHeight(data, x - lx, z - lz)) / 4;
  }

  const sand = Float64Array.from(h);
  smooth(sand, Math.round(ROAD_CONFIG.sandSmoothWindow / path.step), 2);
  gradeLimit(sand, ROAD_CONFIG.sandMaxGrade * path.step);
  smooth(sand, Math.round(ROAD_CONFIG.sandCrestWindow / path.step), 2);

  smooth(h, Math.round(ROAD_CONFIG.smoothWindow / path.step), 3);
  gradeLimit(h, ROAD_CONFIG.maxGrade * path.step);
  // Round off the crests and sags the grade limit leaves (averaging keeps the grade limit).
  smooth(h, Math.round(ROAD_CONFIG.crestWindow / path.step), 2);

  for (let i = 0; i < n; i++) h[i]! += (sand[i]! - h[i]!) * path.sandiness[i]!;
  addJumps(path, h);
}

/** Forward and backward passes around the loop until no step rises or falls more than g. */
function gradeLimit(h: Float64Array, g: number): void {
  const n = h.length;
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (let k = 1; k <= 2 * n; k++) {
      const i = k % n;
      const p = (k - 1) % n;
      const c = Math.min(h[p]! + g, Math.max(h[p]! - g, h[i]!));
      if (c !== h[i]) changed = true;
      h[i] = c;
    }
    for (let k = 2 * n - 1; k >= 0; k--) {
      const i = k % n;
      const p = (k + 1) % n;
      const c = Math.min(h[p]! + g, Math.max(h[p]! - g, h[i]!));
      if (c !== h[i]) changed = true;
      h[i] = c;
    }
    if (!changed) break;
  }
}

function addJumps(path: TrackPath, h: Float64Array): void {
  const n = path.count;
  for (const sj of path.jumps) {
    const { jumpHeight: H, jumpRun: run, jumpDrop: drop } = ROAD_CONFIG;
    for (let i = 0; i < n; i++) {
      let ds = i * path.step - sj;
      if (ds > path.length / 2) ds -= path.length;
      if (ds < -path.length / 2) ds += path.length;
      if (ds >= -run && ds <= 0) h[i]! += H * ((ds + run) / run) ** 2;
      else if (ds > 0 && ds < drop) h[i]! += H * (1 - smoothstep(0, drop, ds));
    }
  }
}

/** Lowers/raises the heightfield to the track profile: packed road firms the sand, open stretches stay loose. */
export function carveRoad(data: TerrainData, path: TrackPath): void {
  const { n, size, heights, softness } = data;
  const cell = size / (n - 1);
  const half = size / 2;
  const hw = path.halfWidth;
  const inner = hw + ROAD_CONFIG.shoulder;
  const reach = inner + ROAD_CONFIG.bankMax + 2;

  // Stamp every centreline segment into the grid, keeping each vertex's nearest road point.
  const bestD = new Float32Array(n * n).fill(Infinity);
  const bestS = new Float32Array(n * n);
  for (let i = 0; i < path.count; i++) {
    const j = (i + 1) % path.count;
    const ax = path.xs[i]!;
    const az = path.zs[i]!;
    const bx = path.xs[j]! - ax;
    const bz = path.zs[j]! - az;
    const len2 = bx * bx + bz * bz;
    const ix0 = Math.max(0, Math.floor((Math.min(ax, ax + bx) - reach + half) / cell));
    const ix1 = Math.min(n - 1, Math.ceil((Math.max(ax, ax + bx) + reach + half) / cell));
    const iz0 = Math.max(0, Math.floor((Math.min(az, az + bz) - reach + half) / cell));
    const iz1 = Math.min(n - 1, Math.ceil((Math.max(az, az + bz) + reach + half) / cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = -half + iz * cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -half + ix * cell;
        const t = Math.min(1, Math.max(0, ((x - ax) * bx + (z - az) * bz) / len2));
        const d = Math.hypot(x - ax - bx * t, z - az - bz * t);
        const v = iz * n + ix;
        if (d < bestD[v]!) {
          bestD[v] = d;
          bestS[v] = (i + t) * path.step;
        }
      }
    }
  }

  for (let v = 0; v < n * n; v++) {
    const d = bestD[v]!;
    if (d >= reach) continue;
    const road = path.heightAt(bestS[v]!);
    const natural = heights[v]!;
    const bank = Math.min(ROAD_CONFIG.bankMax, ROAD_CONFIG.bankMin + ROAD_CONFIG.bankPerMetre * Math.abs(natural - road));
    heights[v] = road + (natural - road) * smoothstep(inner, inner + bank, d);
    // Packed road, or loose sand on open stretches; blending out to the natural sand beyond the edge.
    const loose = Math.max(softness[v]!, ROAD_CONFIG.sandSoftness);
    const track = ROAD_CONFIG.roadSoftness + (loose - ROAD_CONFIG.roadSoftness) * path.sandAt(bestS[v]!);
    softness[v] = track + (softness[v]! - track) * smoothstep(hw, inner + 6, d);
  }
}

/** Circular box filter, `passes` times (≈ a gaussian). */
function smooth(h: Float64Array, w: number, passes: number): void {
  const n = h.length;
  w = Math.max(1, w);
  const tmp = new Float64Array(n);
  for (let pass = 0; pass < passes; pass++) {
    let sum = 0;
    for (let o = -w; o <= w; o++) sum += h[(o + n) % n]!;
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / (2 * w + 1);
      sum += h[(i + w + 1) % n]! - h[(i - w + n) % n]!;
    }
    h.set(tmp);
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
