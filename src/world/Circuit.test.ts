import { describe, expect, it } from 'vitest';
import { TrackPath } from '../race/TrackPath';
import { CROSSOVER } from '../race/tracks';
import { CIRCUIT_CONFIG as C, carveCircuit } from './Circuit';
import { generateTerrain, samplePaved, sampleHeight, sampleSoftness } from './TerrainData';

describe('carveCircuit', () => {
  const path = new TrackPath(CROSSOVER);
  const data = generateTerrain({ n: 321, size: 640 });
  carveCircuit(data, path);
  const floor = path.elevation[0]!;
  const p = { x: 0, z: 0 };
  const t = { x: 0, z: 0 };
  const at = (s: number, lateral: number) => {
    path.pointAt(s, p);
    path.tangentAt(s, t);
    return { x: p.x + t.z * lateral, z: p.z - t.x * lateral };
  };

  it('lays one flat floor out past the walls, at the track elevation', () => {
    expect(path.elevation.every((h) => h === floor)).toBe(true);
    for (let s = 0; s < path.length; s += 10) {
      for (const lat of [-C.flat + 2, 0, C.flat - 2]) {
        const q = at(s, lat);
        expect(sampleHeight(data, q.x, q.z)).toBeCloseTo(floor, 3);
      }
    }
  });

  it('paves the road and leaves firm sand beside it', () => {
    for (let s = 0; s < path.length; s += 10) {
      const road = at(s, 0);
      // At the crossing, beside one road is on the other.
      if (Math.hypot(road.x, road.z) < 25) continue;
      expect(samplePaved(data, road.x, road.z)).toBe(1);
      expect(sampleSoftness(data, road.x, road.z)).toBe(0);
      const runoff = at(s, path.halfWidth + 4);
      expect(samplePaved(data, runoff.x, runoff.z)).toBe(0);
      expect(sampleSoftness(data, runoff.x, runoff.z)).toBeCloseTo(C.runoffSoftness, 3);
    }
  });
});
