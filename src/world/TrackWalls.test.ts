import { describe, expect, it } from 'vitest';
import { TrackPath, type TrackDef } from '../race/TrackPath';
import { CROSSOVER, DUNE_LOOP } from '../race/tracks';
import { TRACK_WALL_CONFIG as C, trackWallBlocks, wallLaterals } from './TrackWalls';

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

describe('corridor walls', () => {
  // A city block loop (clockwise seen from above: north is -z): south, right turn west, right turn north, right turn east.
  const def: TrackDef = {
    id: 'block',
    name: 'Block',
    halfWidth: 8,
    checkpoints: 1,
    corners: [
      { x: 0, z: -500, r: 20 },
      { x: 0, z: 500, r: 20 },
      { x: -140, z: 500, r: 20 },
      { x: -140, z: -500, r: 20 },
    ],
    corridor: [
      [12, 13],
      [15, 12],
      [12, 11],
      [25, 12],
    ],
  };
  const path = new TrackPath(def);
  const lateral = wallLaterals(path)!;
  const blocks = trackWallBlocks(path);
  const half = C.thickness / 2;
  /** Distance from (x, z) to the nearest block end (the wall's polyline vertices). */
  const near = (x: number, z: number) =>
    Math.min(
      ...blocks.flatMap((b) => [1, -1].map((e) => Math.hypot(b.x + (e * Math.cos(b.yaw) * b.length) / 2 - x, b.z - (e * Math.sin(b.yaw) * b.length) / 2 - z))),
    );

  it('follows each street’s own line on the straights', () => {
    const s = path.length * 0.2; // on the first straight (heading +z: left is +x)
    expect(lateral(s, 1)).toBeCloseTo(12 + half, 5);
    expect(lateral(s, -1)).toBeCloseTo(13 + half, 5);
  });

  it('turns the inside block’s square corner and runs to the far block’s corner on the outside', () => {
    // Corner 1 (0, 500), turning right onto the westbound street: inside = the right side (-x, then -z).
    expect(near(-(13 + half), 500 - (12 + half))).toBeLessThan(1);
    // Outside: the first street's left line (+x) meets the second one's left line (+z).
    expect(near(12 + half, 500 + 15 + half)).toBeLessThan(1);
  });

  it('is continuous all the way round and never closer than the narrowest street line', () => {
    for (const side of [1, -1]) {
      let last = lateral(0, side);
      for (let s = 0.5; s < path.length; s += 0.5) {
        const l = lateral(s, side);
        // Fast near the outer corner (the ray sweeps along a street line), but never a jump.
        expect(Math.abs(l - last)).toBeLessThan(2);
        // The inside of a bend dips toward the square corner, but never onto the road.
        expect(l).toBeGreaterThan(path.halfWidth + half);
        last = l;
      }
    }
  });

  it('keeps every block off the road', () => {
    for (const b of blocks) expect(path.project(b.x, b.z).distance).toBeGreaterThan(path.halfWidth + half);
  });
});
