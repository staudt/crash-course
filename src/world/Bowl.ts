import { createNoise2D } from 'simplex-noise';
import type { TerrainData } from './TerrainData';

export const BOWL_CONFIG = {
  floorRadius: 75,
  floorRoll: 0.35,
  floorWave: 22,
  floorSoftness: 0.12,
  bankWidth: 12,
  bankHeight: 3,
  bankSoftness: 0.6,
  wallRadius: 89,
  wallHeight: 3,
  wallThickness: 1.2,
  wallSegments: 56,
  outerBlend: 40,
};
export type BowlConfig = typeof BOWL_CONFIG;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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

/** Height of the bowl surface (without the floor roll) at radius r: 0 on the floor, the bank, bankHeight on top. */
export function bowlProfile(r: number, cfg: BowlConfig = BOWL_CONFIG): number {
  return cfg.bankHeight * smoothstep(cfg.floorRadius, cfg.floorRadius + cfg.bankWidth, r);
}

/** Carves the bowl into `data` in place (heights + softness) and sets `data.mud`. */
export function carveBowl(data: TerrainData, cfg: BowlConfig = BOWL_CONFIG): void {
  const { n, size, heights, softness } = data;
  const mud = new Float32Array(n * n);
  const noise = createNoise2D(mulberry32(4242));
  const half = size / 2;
  const step = size / (n - 1);
  const k = (2 * Math.PI) / cfg.floorWave;
  const outerStart = cfg.wallRadius + cfg.wallThickness;
  const outerEnd = cfg.wallRadius + cfg.outerBlend;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const x = -half + ix * step;
      const z = -half + iz * step;
      const r = Math.hypot(x, z);
      const natural = heights[i]!;
      const naturalSoft = softness[i]!;
      // Fades the roll out over the last 6 m of the floor so the bank starts flat.
      const roll = cfg.floorRoll * (noise(x * k * 0.5, z * k * 0.5) * 0.7 + noise(x * k + 31, z * k - 17) * 0.3) * (1 - smoothstep(cfg.floorRadius - 6, cfg.floorRadius, r));
      const base = bowlProfile(r, cfg) + roll;
      const t = smoothstep(outerStart, outerEnd, r);
      heights[i] = r < outerStart ? base : cfg.bankHeight * (1 - t) + (natural + cfg.bankHeight) * t;
      const bankT = smoothstep(cfg.floorRadius, cfg.floorRadius + cfg.bankWidth * 0.4, r);
      const inner = cfg.floorSoftness + (cfg.bankSoftness - cfg.floorSoftness) * bankT;
      softness[i] = r < outerStart ? inner : cfg.bankSoftness + (naturalSoft - cfg.bankSoftness) * t;
      mud[i] = 1 - smoothstep(cfg.floorRadius, cfg.floorRadius + 3, r);
    }
  }
  data.mud = mud;
}
