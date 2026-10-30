import { describe, expect, it } from 'vitest';
import { TrackPath, type TrackDef } from '../race/TrackPath';
import { TRACK_WALL_CONFIG, wallLaterals } from '../world/TrackWalls';
import { CITY_GROUND_CONFIG, curbStrip, hexToLinear, isJunctionRoad, sidewalkRibbon, signText } from './CityGround';

const def: TrackDef = { id: 'block', name: 'Block', halfWidth: 8, checkpoints: 1,
  corners: [{ x: 0, z: -500, r: 20 }, { x: 0, z: 500, r: 20 }, { x: -140, z: 500, r: 20 }, { x: -140, z: -500, r: 20 }],
  corridor: [[12, 13], [15, 12], [12, 11], [25, 12]] };
const path = new TrackPath(def);

describe('sidewalkRibbon', () => {
  const r = sidewalkRibbon(path);
  it('has four vertices per sample', () => {
    expect(r.positions.length).toBe(path.count * 4 * 3);
    expect(r.colors.length).toBe(r.positions.length);
    expect(r.indices.length).toBe(path.count * 12);
  });
  it('lies between the curb and the wall face', () => {
    const lat = wallLaterals(path)!;
    const curb = path.halfWidth + CITY_GROUND_CONFIG.sidewalk.gapFromShoulder;
    for (let i = 0; i < path.count; i += 7) {
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? 1 : -1;
        const face = lat(i * path.step, side) - TRACK_WALL_CONFIG.thickness / 2;
        for (let w = 0; w < 2; w++) {
          const o = (i * 4 + k * 2 + w) * 3;
          const d = ((r.positions[o]! - path.xs[i]!) * path.tzs[i]! - (r.positions[o + 2]! - path.zs[i]!) * path.txs[i]!) * side;
          expect(d).toBeGreaterThanOrEqual(curb - 1e-3);
          expect(d).toBeLessThanOrEqual(Math.max(face, curb + 0.5) + 1e-3);
        }
      }
    }
  });
  it('is asphalt on the outside of bends only', () => {
    const asphalt = hexToLinear(CITY_GROUND_CONFIG.asphalt);
    let junction = 0;
    for (let i = 0; i < path.count; i++) {
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? 1 : -1;
        const o = (i * 4 + k * 2) * 3;
        const isAsphalt = Math.abs(r.colors[o]! - asphalt[0]) < 1e-6;
        expect(isAsphalt).toBe(isJunctionRoad(path, i * path.step, side));
        if (isAsphalt) junction++;
      }
    }
    expect(junction).toBeGreaterThan(0);
    const b = path.bends[0]!;
    const side = b.turn > 0 ? -1 : 1;
    expect(isJunctionRoad(path, (b.start + b.end) / 2, side)).toBe(true);
    expect(isJunctionRoad(path, (b.start + b.end) / 2, -side)).toBe(false);
  });
  it('faces up', () => {
    for (let t = 0; t < r.indices.length; t += 3 * 37) {
      const [a, b, c] = [r.indices[t]!, r.indices[t + 1]!, r.indices[t + 2]!].map((v) => v * 3);
      const e1 = [r.positions[b!]! - r.positions[a!]!, r.positions[b! + 2]! - r.positions[a! + 2]!];
      const e2 = [r.positions[c!]! - r.positions[a!]!, r.positions[c! + 2]! - r.positions[a! + 2]!];
      expect(e1[1]! * e2[0]! - e1[0]! * e2[1]!).toBeGreaterThan(0);
    }
  });
});

describe('curbStrip / signText', () => {
  it('skips junction quads', () => {
    expect(curbStrip(path).indices.length).toBeLessThan(path.count * 12);
  });
  it('abbreviates street names', () => {
    expect(signText('West Madison Street')).toBe('MADISON ST');
    expect(signText('North Michigan Avenue')).toBe('MICHIGAN AVE');
    expect(signText('Wacker Drive')).toBe('WACKER DR');
  });
});
