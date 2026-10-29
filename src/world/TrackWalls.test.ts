import { describe, expect, it } from 'vitest';
import { TrackPath } from '../race/TrackPath';
import { CROSSOVER, DUNE_LOOP } from '../race/tracks';
import { TRACK_WALL_CONFIG as C, trackWallBlocks } from './TrackWalls';

describe('trackWallBlocks', () => {
  const path = new TrackPath(CROSSOVER);
  const walls = CROSSOVER.walls!;
  const blocks = trackWallBlocks(path);

  it('only walled tracks get walls', () => {
    expect(trackWallBlocks(new TrackPath(DUNE_LOOP))).toHaveLength(0);
    expect(blocks.length).toBeGreaterThan(100);
  });

  it('no wall stands on any road, and the crossing is open', () => {
    for (const b of blocks) {
      expect(path.project(b.x, b.z).distance).toBeGreaterThan(path.halfWidth + walls.straight - 0.5);
      expect(Math.hypot(b.x, b.z)).toBeGreaterThan(path.halfWidth + walls.straight);
    }
  });

  it('walls the straights tightly on both sides and gives the outside of the loops room', () => {
    const p = { x: 0, z: 0 };
    const t = { x: 0, z: 0 };
    /** Lateral offset (m, + = left) of the nearest wall block on `side` of the track at s. */
    const wallAt = (s: number, side: number) => {
      path.pointAt(s, p);
      path.tangentAt(s, t);
      let best = Infinity;
      let lateral = 0;
      for (const b of blocks) {
        const l = (b.x - p.x) * t.z - (b.z - p.z) * t.x;
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        if (Math.sign(l) === side && d < best) {
          best = d;
          lateral = l;
        }
      }
      return lateral;
    };
    const wall = (gap: number) => path.halfWidth + gap + C.thickness / 2;
    for (const s of [path.checkpoints[0]!, path.checkpoints[2]!]) {
      expect(wallAt(s, 1)).toBeCloseTo(wall(walls.straight), 0);
      expect(wallAt(s, -1)).toBeCloseTo(-wall(walls.straight), 0);
    }
    // Apex of the first loop (turning left): the outside (right) wall is `outside` m off the edge.
    const apex = path.checkpoints[1]!;
    expect(Math.abs(wallAt(apex, -1) + wall(walls.outside))).toBeLessThan(0.5);
    expect(Math.abs(wallAt(apex, 1) - wall(walls.inside))).toBeLessThan(0.5);
  });

  it('turns every block’s striped face toward the road', () => {
    for (const b of blocks) {
      const fx = b.x + Math.sin(b.yaw);
      const fz = b.z + Math.cos(b.yaw);
      expect(path.project(fx, fz).distance).toBeLessThan(path.project(b.x, b.z).distance);
    }
  });
});
