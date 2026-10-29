import type { TrackPath } from '../race/TrackPath';
import type { TerrainData } from './TerrainData';

/**
 * Cuts a small walled asphalt circuit (CROSSOVER) into the dunes. Pure (no three): everything within
 * `flat` m of the centreline becomes one flat floor (the mean natural height along the track), the road
 * is paved (`data.paved`, firm), the run-off and the islands inside the loops are firm sand, and the
 * ground beyond blends back to the natural dunes over `blend` m. Fills `path.elevation` with the floor.
 */
export const CIRCUIT_CONFIG = {
  /** Flat out to this far (m) from the centreline: past the widest wall (halfWidth + outside gap + wall). */
  flat: 20,
  blend: 35,
  /** Asphalt reaches this far (m) past the road edge, under the ribbon's shoulder. */
  pavedMargin: 0.4,
  /** Sand softness inside the walls (run-off, islands): firm enough to drive out of. */
  runoffSoftness: 0.3,
};

export function carveCircuit(data: TerrainData, path: TrackPath, cfg = CIRCUIT_CONFIG): void {
  const { n, size, heights, softness } = data;
  const cell = size / (n - 1);
  const half = size / 2;
  let floor = 0;
  for (let i = 0; i < path.count; i++) floor += sampleNatural(data, path.xs[i]!, path.zs[i]!);
  floor /= path.count;
  path.elevation.fill(floor);

  const paved = new Float32Array(n * n);
  const reach = cfg.flat + cfg.blend;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < path.count; i++) {
    x0 = Math.min(x0, path.xs[i]!);
    x1 = Math.max(x1, path.xs[i]!);
    z0 = Math.min(z0, path.zs[i]!);
    z1 = Math.max(z1, path.zs[i]!);
  }
  const clampIx = (v: number) => Math.min(n - 1, Math.max(0, Math.round((v + half) / cell)));
  const road = path.halfWidth + cfg.pavedMargin;
  for (let iz = clampIx(z0 - reach); iz <= clampIx(z1 + reach); iz++) {
    for (let ix = clampIx(x0 - reach); ix <= clampIx(x1 + reach); ix++) {
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      // A full search (no hint): the nearest stretch, whichever it is.
      const d = path.project(x, z).distance;
      if (d >= reach) continue;
      const v = iz * n + ix;
      const t = smoothstep(cfg.flat, reach, d);
      heights[v] = floor + (heights[v]! - floor) * t;
      softness[v] = cfg.runoffSoftness + (softness[v]! - cfg.runoffSoftness) * t;
      if (d <= road) {
        paved[v] = 1;
        softness[v] = 0;
      }
    }
  }
  data.paved = paved;
}

function sampleNatural(data: TerrainData, x: number, z: number): number {
  const cell = data.size / (data.n - 1);
  const ix = Math.min(data.n - 1, Math.max(0, Math.round((x + data.size / 2) / cell)));
  const iz = Math.min(data.n - 1, Math.max(0, Math.round((z + data.size / 2) / cell)));
  return data.heights[iz * data.n + ix]!;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
