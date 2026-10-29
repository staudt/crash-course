import { describe, expect, it } from 'vitest';
import { TrackPath } from './TrackPath';
import { CROSSOVER, DUNE_LOOP } from './tracks';
import { buildRoadRibbon, buildStationMarkings, gatePostOffsets } from './TrackProps';
import { TRACK_WALL_CONFIG, trackWallBlocks } from '../world/TrackWalls';

const path = new TrackPath(DUNE_LOOP);
for (let i = 0; i < path.count; i++) path.elevation[i] = Math.sin(i * 0.01) * 5;
// Force a block of open sand with a ramp on each side.
const A = 100, B = 160;
for (let i = A; i <= B; i++) path.sandiness[i] = i < A + 10 ? (i - A) / 10 : i > B - 10 ? (B - i) / 10 : 1;
for (let i = A + 10; i <= B - 10; i++) path.sandiness[i] = 1;
const sandQuads = (() => {
  let c = 0;
  for (let i = 0; i < path.count; i++) if (path.sandiness[i]! >= 0.999 && path.sandiness[(i + 1) % path.count]! >= 0.999) c++;
  return c;
})();
const ribbon = buildRoadRibbon(path);
const hw = path.halfWidth;

describe('buildRoadRibbon', () => {
  it('has 7 vertices per sample, RGBA colours, and skips quads wholly on sand', () => {
    expect(ribbon.positions.length).toBe(7 * path.count * 3);
    expect(ribbon.colors.length).toBe(7 * path.count * 4);
    expect(sandQuads).toBeGreaterThan(30);
    expect(ribbon.indices.length).toBe(36 * (path.count - sandQuads));
    const used = new Set<number>();
    for (const v of ribbon.indices) used.add(Math.floor(v / 7));
    expect(used.has(A + 20)).toBe(false);
    expect(used.has(A + 5)).toBe(true);
  });

  it('fades alpha with sandiness on every vertex of a row', () => {
    for (const i of [0, A + 3, A + 5, A + 30, B - 2, 700]) {
      for (let j = 0; j < 7; j++) expect(ribbon.colors[(i * 7 + j) * 4 + 3]).toBeCloseTo(1 - path.sandiness[i]!, 5);
    }
  });

  it('puts the centre vertex on the sample, lifted above the elevation', () => {
    for (const i of [0, 1, 100, path.count - 1]) {
      const k = (i * 7 + 3) * 3;
      expect(ribbon.positions[k]).toBeCloseTo(path.xs[i]!, 3);
      expect(ribbon.positions[k + 1]).toBeCloseTo(path.elevation[i]! + 0.06, 4);
      expect(ribbon.positions[k + 2]).toBeCloseTo(path.zs[i]!, 3);
    }
  });

  it('puts the outermost vertices hw + 1.2 from the centreline', () => {
    for (const i of [0, 50, 700]) {
      for (const j of [0, 6]) {
        const k = (i * 7 + j) * 3;
        const d = Math.hypot(ribbon.positions[k]! - path.xs[i]!, ribbon.positions[k + 2]! - path.zs[i]!);
        expect(d).toBeCloseTo(hw + 1.2, 3);
      }
    }
  });

  it('winds every triangle upwards, including the loop closure', () => {
    const p = ribbon.positions;
    const ix = ribbon.indices;
    const tris = ix.length / 3;
    const check = (t: number) => {
      const [a, b, c] = [ix[t * 3]! * 3, ix[t * 3 + 1]! * 3, ix[t * 3 + 2]! * 3];
      const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      // y component of e1 x e2
      expect(e1[2]! * e2[0]! - e1[0]! * e2[2]!).toBeGreaterThan(0);
    };
    for (let t = 0; t < tris; t += 37) check(t);
    for (let t = tris - 36; t < tris; t++) check(t);
  });
});

describe('buildStationMarkings', () => {
  const { positions, indices } = buildStationMarkings(path, 15);

  it('paints every gate, upward-facing quads only', () => {
    expect(indices.length % 6).toBe(0);
    expect(Math.max(...indices)).toBe(positions.length / 3 - 1);
    // Per gate: 15 edge segments a side, 2 end bars, 3 plus-sign pieces.
    expect(indices.length / 6).toBe(path.checkpoints.length * (2 * 15 + 2 + 3));
    for (let k = 0; k < indices.length; k += 3) {
      const v = [0, 1, 2].map((j) => indices[k + j]! * 3);
      const [a, b, c] = v.map((i) => [positions[i]!, positions[i + 1]!, positions[i + 2]!]);
      // Cross product y of (b - a) x (c - a) > 0: the triangle faces up.
      const ny = (b![2]! - a![2]!) * (c![0]! - a![0]!) - (b![0]! - a![0]!) * (c![2]! - a![2]!);
      expect(ny).toBeGreaterThan(0);
    }
  });

  it('stays on the road, just above it', () => {
    for (let i = 0; i < positions.length; i += 3) {
      const p = path.project(positions[i]!, positions[i + 2]!);
      expect(p.distance).toBeLessThanOrEqual(hw + 1e-3);
      expect(positions[i + 1]! - path.heightAt(p.s)).toBeCloseTo(0.1, 0);
    }
  });
});

describe('gatePostOffsets', () => {
  it('stands the posts beside the road on open tracks, and behind the walls on walled ones', () => {
    const open = new TrackPath(DUNE_LOOP);
    for (const [l, r] of gatePostOffsets(open)) expect([l, r]).toEqual([open.halfWidth + 2.5, open.halfWidth + 2.5]);
    const walled = new TrackPath(CROSSOVER);
    const blocks = trackWallBlocks(walled);
    const p = { x: 0, z: 0 };
    const t = { x: 0, z: 0 };
    gatePostOffsets(walled).forEach(([left, right], k) => {
      const s = walled.checkpoints[k]!;
      walled.pointAt(s, p);
      walled.tangentAt(s, t);
      for (const [side, off] of [[1, left], [-1, right]] as const) {
        // The nearest wall block on that side is closer to the road than the post, by more than half its thickness.
        let best = Infinity;
        let wall = 0;
        for (const b of blocks) {
          const l = (b.x - p.x) * t.z - (b.z - p.z) * t.x;
          const d = Math.hypot(b.x - p.x, b.z - p.z);
          if (Math.sign(l) === side && d < best) {
            best = d;
            wall = Math.abs(l);
          }
        }
        expect(off - wall).toBeGreaterThan(TRACK_WALL_CONFIG.thickness / 2 + 0.35);
      }
    });
  });
});
