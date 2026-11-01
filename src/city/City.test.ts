import { describe, expect, it } from 'vitest';
import { TrackPath } from '../race/TrackPath';
import { CHICAGO } from '../race/tracks';
import { TRACK_WALL_CONFIG, trackWallBlocks, wallLaterals } from '../world/TrackWalls';
import chicago from './chicago.json';
import { buildingGeometry, classifyWallBlocks, CITY_CONFIG, decodeCity, fitToCorridor, FootprintIndex } from './City';
import { inPolygons, segmentDistance, type ChicagoCity } from './osm';

const path = new TrackPath(CHICAGO);
const lateral = wallLaterals(path)!;
const half = TRACK_WALL_CONFIG.thickness / 2;
const raw = decodeCity(chicago as ChicagoCity);
const before = raw.buildings.length;
const city = fitToCorridor(decodeCity(chicago as ChicagoCity), path, (s, side) => lateral(s, side) - half);
const index = new FootprintIndex(city.buildings);
const blocks = classifyWallBlocks(trackWallBlocks(path), index, TRACK_WALL_CONFIG.thickness, city.cut);

describe('Chicago Loop track', () => {
  it('starts on the Lake Street bridge heading east, and runs anticlockwise round the main branch', () => {
    expect(CHICAGO.corners).toHaveLength(10);
    // Heading east: +x is heading π/2 (heading 0 faces +z).
    expect(Math.abs(path.headingAt(0) - Math.PI / 2)).toBeLessThan(0.05);
    const p = path.pointAt(0, { x: 0, z: 0 });
    expect(inPolygons(city.water, p.x, p.z)).toBe(true);
    const turns = path.bends.map((b) => Math.sign(b.turn));
    // Left everywhere but Wacker's two S-bends (diagonal → main branch, the bend past State) and State → Kinzie.
    expect(turns.filter((t) => t < 0)).toHaveLength(3);
    expect(path.bends.reduce((t, b) => t + b.turn, 0)).toBeCloseTo(2 * Math.PI, 1);
    expect(path.length).toBeGreaterThan(3000);
    expect(path.length).toBeLessThan(3800);
  });

  it('crosses the river three times on bridges (Lake, Michigan, Kinzie), with water under them', () => {
    const bridges = city.decks.filter((d) => d.route);
    expect(bridges.map((d) => d.name).sort()).toEqual(['Kinzie Street', 'Lake Street', 'Michigan Avenue']);
    for (const d of bridges) {
      expect(d.houses).toBeDefined();
      const a = d.line[0]!;
      const b = d.line[d.line.length - 1]!;
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      expect(inPolygons(city.water, mid.x, mid.z), d.name).toBe(true);
      // No street deck of the route's own (with railings in the road) on top of it.
      expect(city.decks.filter((o) => !o.route && o.line.some((p) => Math.hypot(p.x - mid.x, p.z - mid.z) < 5))).toHaveLength(0);
    }
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

  it('runs a balustrade along the river side, over the drop', () => {
    const rails = blocks.filter((b) => b.rail);
    const length = rails.reduce((l, b) => l + b.length, 0);
    expect(length).toBeGreaterThan(600);
    // The river is inside the loop: the balustrades are on the left (inside) but for both sides of the bridges.
    const left = rails.filter((b) => path.project(b.x, b.z).lateral > 0).reduce((l, b) => l + b.length, 0);
    expect(left / length).toBeGreaterThan(0.6);
  });

  it('keeps the river cut out of the corridor, except on the bridges', () => {
    const bridges = city.decks.filter((d) => d.route);
    const onBridge = (x: number, z: number) => bridges.some((d) => d.line.some((p, i) => i > 0 && segmentDistance({ x, z }, d.line[i - 1]!, p) < d.width / 2 + 0.1));
    for (let s = 0; s < path.length; s += 2) {
      for (const side of [1, -1]) {
        const p = path.pointAt(s, { x: 0, z: 0 });
        const t = path.tangentAt(s, { x: 0, z: 0 });
        const d = (lateral(s, side) + half) * side;
        const x = p.x + t.z * d;
        const z = p.z - t.x * d;
        if (onBridge(x, z)) continue;
        expect(inPolygons(city.cut, x, z), `s ${s} side ${side}`).toBe(false);
      }
    }
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
