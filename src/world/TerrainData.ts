import { createNoise2D } from 'simplex-noise';

export interface TerrainData {
  /** Grid vertices per side. */
  n: number;
  /** World size in metres, centred on the origin. */
  size: number;
  /** ROW-MAJOR: index = iz * n + ix; x = -size/2 + ix*size/(n-1), z likewise. */
  heights: Float32Array;
  /** Same layout as heights. 0 = firm hardpan, 1 = deep soft sand. */
  softness: Float32Array;
  /** Optional, same layout: 0..1 how muddy the ground looks (set by carveBowl). */
  mud?: Float32Array;
  /** Optional, same layout: 0..1 asphalt (set by carveCircuit; grippier for cars, see CarStats.asphaltGrip). */
  paved?: Float32Array;
}

/** Radius (m) of the gentle, firm central arena (small dunes only). */
export const ARENA_RADIUS = 40;

/** Prevailing wind direction (unit, in the XZ plane): +X rotated 20 degrees. Dune ridges run perpendicular to it. */
const WIND_ANGLE = (20 * Math.PI) / 180;
const WIND_X = Math.cos(WIND_ANGLE);
const WIND_Z = Math.sin(WIND_ANGLE);

/** Mean dune spacing (m) along the wind axis; domain warping varies it roughly 50-85 m. */
const WAVELENGTH = 65;
/** Dune height (m) near the centre and far out (>= DUNE_FAR_R). */
const DUNE_H_NEAR = 2.2;
const DUNE_H_FAR = 14;
const DUNE_FAR_R = 120;
/** Fractions of one wavelength: flat trough, gentle windward slope, steeper lee slip face. */
const FLAT_FRAC = 0.15;
const WIND_FRAC = 0.5;
/** Dune height is capped at this fraction of the local wavelength, keeping slopes drivable. */
const MAX_H_PER_WAVELENGTH = 0.145;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function generateTerrain(opts: { seed?: number; n?: number; size?: number } = {}): TerrainData {
  const seed = opts.seed ?? 1337;
  const n = opts.n ?? 257;
  const size = opts.size ?? 600;
  const rand = mulberry32(seed);
  const noiseA = createNoise2D(rand);
  const noiseC = createNoise2D(rand);
  const noiseW = createNoise2D(rand);
  const noiseAmp = createNoise2D(rand);
  const noiseS = createNoise2D(rand);
  const half = size / 2;
  const step = size / (n - 1);
  const heights = new Float32Array(n * n);
  const softness = new Float32Array(n * n);

  /** Dune phase: one unit per wavelength along the wind axis, domain-warped so ridges curve and fork. */
  const phase = (x: number, z: number): number =>
    (x * WIND_X + z * WIND_Z) / WAVELENGTH +
    noiseW(x * 0.004 + 11, z * 0.004 - 7) * 0.45 +
    noiseW(x * 0.011 - 3, z * 0.011 + 19) * 0.1;

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * step;
      const z = -half + iz * step;
      const r = Math.hypot(x, z);

      // Asymmetric sawtooth profile along the phase: flat trough, long windward ramp, short steep lee.
      const ph = phase(x, z);
      const f = ph - Math.floor(ph);
      const leeFrac = 1 - FLAT_FRAC - WIND_FRAC;
      let prof: number;
      let sProf: number;
      if (f < FLAT_FRAC) {
        prof = 0;
        sProf = 0.1;
      } else if (f < FLAT_FRAC + WIND_FRAC) {
        const e = smoothstep(0, 1, (f - FLAT_FRAC) / WIND_FRAC);
        prof = e;
        sProf = 0.15 + 0.7 * e;
      } else {
        const v = (f - FLAT_FRAC - WIND_FRAC) / leeFrac;
        prof = 1 - smoothstep(0, 1, v);
        sProf = 1 - 0.85 * smoothstep(0.65, 1, v);
      }

      // Local wavelength from the phase gradient, so tall dunes only form where they are widely spaced.
      const e = 2;
      const gx = (phase(x + e, z) - phase(x - e, z)) / (2 * e);
      const gz = (phase(x, z + e) - phase(x, z - e)) / (2 * e);
      const localWave = 1 / Math.max(1e-3, Math.hypot(gx, gz));
      const rampR = smoothstep(ARENA_RADIUS, DUNE_FAR_R, r);
      const hMax = DUNE_H_NEAR + (DUNE_H_FAR - DUNE_H_NEAR) * rampR;
      // Some dunes tall, others fade into flats (fading only applies away from the arena).
      const ampN = 0.12 + 0.88 * smoothstep(-0.35, 0.45, noiseAmp(x * 0.006 + 5, z * 0.006 + 2));
      const hWant = hMax * (1 + (ampN - 1) * rampR);
      const hCap = MAX_H_PER_WAVELENGTH * localWave;
      const duneH = Math.pow(Math.pow(hWant, -4) + Math.pow(hCap, -4), -0.25);
      const dunes = prof * duneH;

      // Larger hills and ramps further out.
      const farMask = smoothstep(90, 200, r);
      const hills = (noiseA(x * 0.0045, z * 0.0045) * 0.5 + 0.5) * 9 * farMask;
      const ramps = Math.max(0, noiseC(x * 0.008, z * 0.008)) ** 2 * 6 * farMask;
      const gentle = noiseC(x * 0.02, z * 0.02) * 0.3 + noiseA(x * 0.05, z * 0.05) * 0.1;

      let h = gentle + dunes + hills + ramps;

      // Steep rim bounding the play area.
      const edge = Math.max(Math.abs(x), Math.abs(z)) / half;
      const rim = smoothstep(0.86, 1, edge);
      h += rim * rim * 45 + rim * 12;
      heights[iz * n + ix] = h;

      // Softness: profile-driven on dunes, firm in flats and in the arena, plus noise.
      const duneWeight = Math.min(1, duneH / 3);
      let s = 0.1 + (sProf - 0.1) * duneWeight;
      s += (hills + ramps) * 0.015;
      s += noiseS(x * 0.03, z * 0.03) * 0.08 + noiseS(x * 0.12 + 40, z * 0.12) * 0.04;
      const arena = 0.15 + noiseS(x * 0.05, z * 0.05) * 0.03;
      s = arena + (s - arena) * smoothstep(ARENA_RADIUS - 5, ARENA_RADIUS + 50, r);
      softness[iz * n + ix] = Math.min(1, Math.max(0, s));
    }
  }
  return { n, size, heights, softness };
}

/**
 * Height at world (x, z), clamped at the edges. Interpolates over the same
 * triangles Rapier uses: each cell is split along the diagonal from
 * (ix, iz+1) to (ix+1, iz).
 */
export function sampleHeight(t: TerrainData, x: number, z: number): number {
  const { n, size, heights } = t;
  const cell = size / (n - 1);
  const gx = Math.min(n - 1, Math.max(0, (x + size / 2) / cell));
  const gz = Math.min(n - 1, Math.max(0, (z + size / 2) / cell));
  const ix = Math.min(n - 2, Math.floor(gx));
  const iz = Math.min(n - 2, Math.floor(gz));
  const fx = gx - ix;
  const fz = gz - iz;
  const h00 = heights[iz * n + ix]!;
  const h10 = heights[iz * n + ix + 1]!;
  const h01 = heights[(iz + 1) * n + ix]!;
  if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
  const h11 = heights[(iz + 1) * n + ix + 1]!;
  return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

/** Rapier wants column-major (index = ix * n + iz); we store row-major. */
export function toRapierHeights(t: TerrainData): Float32Array {
  const { n, heights } = t;
  const out = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) out[ix * n + iz] = heights[iz * n + ix]!;
  }
  return out;
}

/** Bilinear softness (0 firm .. 1 deep sand) at world (x, z), clamped at the edges. */
export function sampleSoftness(t: TerrainData, x: number, z: number): number {
  return sampleGrid(t, t.softness, x, z);
}

/** 0..1 asphalt at (x, z); 0 where the terrain has no paving. */
export function samplePaved(t: TerrainData, x: number, z: number): number {
  return t.paved ? sampleGrid(t, t.paved, x, z) : 0;
}

/** Bilinear sample of a per-vertex grid (same layout as heights). */
function sampleGrid(t: TerrainData, grid: Float32Array, x: number, z: number): number {
  const { n, size } = t;
  const cell = size / (n - 1);
  const gx = Math.min(n - 1, Math.max(0, (x + size / 2) / cell));
  const gz = Math.min(n - 1, Math.max(0, (z + size / 2) / cell));
  const ix = Math.min(n - 2, Math.floor(gx));
  const iz = Math.min(n - 2, Math.floor(gz));
  const fx = gx - ix;
  const fz = gz - iz;
  const a = grid[iz * n + ix]! * (1 - fx) + grid[iz * n + ix + 1]! * fx;
  const b = grid[(iz + 1) * n + ix]! * (1 - fx) + grid[(iz + 1) * n + ix + 1]! * fx;
  return a * (1 - fz) + b * fz;
}
