import { describe, expect, it } from 'vitest';
import { TrackPath } from '../race/TrackPath';
import { CHICAGO } from '../race/tracks';
import { TRACK_WALL_CONFIG, trackWallBlocks, wallLaterals } from '../world/TrackWalls';
import chicago from './chicago.json';
import { buildingGeometry, classifyWallBlocks, CITY_CONFIG, decodeCity, fitToCorridor, FootprintIndex } from './City';
import { inPolygons, type ChicagoCity } from './osm';

const path = new TrackPath(CHICAGO);
const lateral = wallLaterals(path)!;
const half = TRACK_WALL_CONFIG.thickness / 2;
const raw = decodeCity(chicago as ChicagoCity);
const before = raw.buildings.length;
const city = fitToCorridor(decodeCity(chicago as ChicagoCity), path, (s, side) => lateral(s, side) - half);
const index = new FootprintIndex(city.buildings);
const blocks = classifyWallBlocks(trackWallBlocks(path), index, TRACK_WALL_CONFIG.thickness, city.cut);

describe('Chicago Loop track', () => {
  it('starts on LaSalle heading south, ~150 m before Jackson, and runs clockwise', () => {
    expect(path.headingAt(0)).toBeCloseTo(0, 1); // heading 0 faces +z: south
    const jackson = CHICAGO.corners[1]!;
    const p = path.pointAt(0, { x: 0, z: 0 });
    expect(Math.hypot(jackson.x - p.x, jackson.z - p.z)).toBeGreaterThan(130);
    expect(Math.hypot(jackson.x - p.x, jackson.z - p.z)).toBeLessThan(170);
    for (const b of path.bends) expect(b.turn).toBeLessThan(0); // all right turns
    expect(path.length).toBeGreaterThan(2300);
    expect(path.length).toBeLessThan(2700);
  });

  it('runs up Wacker along the river, round the 333 W Wacker bend in two sweeping halves', () => {
    expect(CHICAGO.corners).toHaveLength(5);
    const [, , ns, a, b] = CHICAGO.corners;
    // Up the south branch (x ≈ -305), then the diagonal, then the main branch (z ≈ -509).
    expect(ns!.x).toBeLessThan(-290);
    expect(b!.z).toBeLessThan(-500);
    expect(a!.r).toBeGreaterThan(40);
    expect(b!.r).toBeGreaterThan(40);
    const quarter = path.bends.filter((k) => k.corner === 3 || k.corner === 4).reduce((t, k) => t + k.turn, 0);
    expect(quarter).toBeCloseTo(-Math.PI / 2, 0);
  });
});

describe('city walls', () => {
  it('no building pokes in front of the wall line', () => {
    const bad: string[] = [];
    for (const b of city.buildings) {
      if (b.bottom >= CITY_CONFIG.overhang) continue;
      for (const v of b.ring) {
        const pr = path.project(v.x, v.z);
        if (pr.distance > 60) continue;
        const face = lateral(pr.s, Math.sign(pr.lateral)) - half;
        if (pr.distance < face - 0.05) bad.push(`${b.name ?? '?'} (${v.x.toFixed(0)}, ${v.z.toFixed(0)}) ${pr.distance.toFixed(1)} < ${face.toFixed(1)}`);
      }
    }
    expect(bad).toEqual([]);
    // Only a handful stood on the road and were dropped.
    expect(before - city.buildings.length).toBeLessThan(10);
  });

  it('closes every side street with a visible barrier (or the river balustrade) and hides the wall along facades', () => {
    for (const m of city.mouths) {
      if (m.width < 6) continue;
      const near = blocks.filter((b) => Math.hypot(b.x - m.x, b.z - m.z) < m.width / 2);
      expect(near.some((b) => !b.hidden || b.rail), `${m.name} at (${m.x}, ${m.z})`).toBe(true);
    }
    const facades = blocks.filter((b) => b.hidden && !b.rail).length;
    expect(facades / blocks.length).toBeGreaterThan(0.3);
    expect(facades / blocks.length).toBeLessThan(0.9);
  });

  it('runs a balustrade along the river side of Wacker, over the drop', () => {
    const rails = blocks.filter((b) => b.rail);
    const length = rails.reduce((l, b) => l + b.length, 0);
    expect(length).toBeGreaterThan(300);
    // All on the river side (left of the travel direction on Wacker: west, north-west, north) and none on LaSalle or Jackson.
    for (const b of rails) {
      const s = path.project(b.x, b.z);
      expect(s.lateral, `rail at (${b.x.toFixed(0)}, ${b.z.toFixed(0)})`).toBeGreaterThan(0);
      expect(b.x < -250 || b.z < -480, `rail at (${b.x.toFixed(0)}, ${b.z.toFixed(0)})`).toBe(true);
    }
  });

  it('keeps the river cut out of the corridor', () => {
    for (let s = 0; s < path.length; s += 2) {
      for (const side of [1, -1]) {
        const p = path.pointAt(s, { x: 0, z: 0 });
        const t = path.tangentAt(s, { x: 0, z: 0 });
        const d = (lateral(s, side) + half) * side;
        expect(inPolygons(city.cut, p.x + t.z * d, p.z - t.x * d), `s ${s} side ${side}`).toBe(false);
      }
    }
  });

  it('keeps every wall off the road', () => {
    for (const b of blocks) expect(path.project(b.x, b.z).distance).toBeGreaterThan(path.halfWidth + half);
  });
});

describe('buildingGeometry', () => {
  it('makes walls facing out and roofs facing up', () => {
    const g = buildingGeometry([{ ring: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], bottom: 0, top: 20, color: '#ffffff' }]);
    const n = g.positions.length / 9;
    expect(n).toBe(4 * 2 + 2);
    for (let t = 0; t < n; t++) {
      const p = (k: number) => [g.positions[t * 9 + k * 3]!, g.positions[t * 9 + k * 3 + 1]!, g.positions[t * 9 + k * 3 + 2]!];
      const [a, b, c] = [p(0), p(1), p(2)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      // The winding agrees with the stored normal, which points away from the box's centre (5, 10, 5).
      const nx = g.normals[t * 9]!, ny = g.normals[t * 9 + 1]!, nz = g.normals[t * 9 + 2]!;
      expect(cross[0]! * nx + cross[1]! * ny + cross[2]! * nz).toBeGreaterThan(0);
      const mid = [(a[0]! + b[0]! + c[0]!) / 3 - 5, (a[1]! + b[1]! + c[1]!) / 3 - 10, (a[2]! + b[2]! + c[2]!) / 3 - 5];
      expect(mid[0]! * nx + mid[1]! * ny + mid[2]! * nz).toBeGreaterThan(0);
    }
  });
});
