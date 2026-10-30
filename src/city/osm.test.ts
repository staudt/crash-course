import polygonClipping from 'polygon-clipping';
import { describe, expect, it } from 'vitest';
import { CHICAGO_ROUTE, clipRing, convertChicago, decodeRing, encodeRing, inPolygons, parseLength, projector, ringArea, simplifyRing, type OverpassElement, type Route } from './osm';

const project = projector(CHICAGO_ROUTE.origin);
const [lat0, lon0] = CHICAGO_ROUTE.origin;
const unit = project(lat0 + 0.001, lon0 + 0.001);
/** Metres (x east, z south) → lat/lon, inverting the projection. */
const ll = (x: number, z: number) => ({ lat: lat0 - (z / -unit.z) * 0.001, lon: lon0 + (x / unit.x) * 0.001 });

let id = 1;
const way = (tags: Record<string, string>, pts: [number, number][]): OverpassElement => ({ type: 'way', id: id++, tags, geometry: pts.map(([x, z]) => ll(x, z)) });
const box = (x0: number, x1: number, z0: number, z1: number, tags: Record<string, string> = { building: 'yes', height: '40' }) =>
  way(tags, [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
    [x0, z0],
  ]);

// A toy Loop: LaSalle at x 75, Wells at x -66, Wacker at z -478, Jackson at z 466 (about where the real ones are),
// Madison crossing at z 0. Building lines 12 m off every street, 14 m on the outside of LaSalle and Wells, and the
// river 22 m north of Wacker, 200 m wide, with the Riverwalk (and a kiosk) on its far bank and Wells crossing it
// on a bascule bridge. Lower Wacker runs under Wacker and must be ignored.
const ROUTE: Route = {
  ...CHICAGO_ROUTE,
  streets: [
    { label: 'LaSalle Street', name: /\bLa ?Salle\b/i, from: [41.8866, -87.6324], to: [41.8781, -87.6322] },
    { label: 'Jackson Boulevard', name: /\bJackson\b/i, from: [41.8781, -87.6322], to: [41.8781, -87.634] },
    { label: 'Wells Street', name: /\bWells\b/i, from: [41.8781, -87.634], to: [41.8866, -87.6341] },
    { label: 'Wacker Drive', name: /\bWacker\b/i, from: [41.8866, -87.6341], to: [41.8866, -87.6324] },
  ],
};
const fixture = {
  osm3s: { timestamp_osm_base: '2026-10-01T00:00:00Z' },
  elements: [
    way({ highway: 'secondary', name: 'South LaSalle Street' }, [[75, -600], [75, 0], [75, 600]]),
    way({ highway: 'secondary', name: 'West Jackson Boulevard' }, [[200, 466], [-200, 466]]),
    way({ highway: 'secondary', name: 'South Wells Street' }, [[-66, 600], [-66, -490]]),
    way({ highway: 'secondary', name: 'North Wells Street', bridge: 'movable', 'bridge:movable': 'bascule', layer: '1', lanes: '3' }, [[-66, -490], [-66, -730]]),
    way({ highway: 'footway', name: 'Chicago Riverwalk' }, [[-250, -706], [250, -706]]),
    box(-30, -20, -712, -704, { building: 'yes' }),
    way({ highway: 'primary', name: 'West Wacker Drive' }, [[-200, -478], [200, -478]]),
    way({ highway: 'primary', name: 'Lower West Wacker Drive', layer: '-1' }, [[-200, -470], [200, -470]]),
    way({ highway: 'secondary', name: 'West Madison Street', lanes: '4' }, [[-200, 0], [200, 0]]),
    way({ highway: 'footway', name: 'Riverwalk' }, [[-200, -490], [200, -490]]),
    // Inside the loop, split by Madison.
    box(-54, 63, -466, -6),
    box(-54, 63, 6, 454),
    // East of LaSalle, west of Wells.
    box(89, 200, -466, -6),
    box(89, 200, 6, 454),
    box(-200, -80, -466, -6, { building: 'yes', 'building:levels': '10' }),
    box(-200, -80, 6, 454),
    // South of Jackson (the Board of Trade spans the end of LaSalle).
    box(-200, 200, 478, 600, { building: 'yes', height: '184', name: 'Chicago Board of Trade Building' }),
    // A bridge-like part high up must not count as a building line.
    box(-30, 30, -470, -460, { 'building:part': 'yes', min_height: '20', height: '24' }),
    way({ natural: 'water' }, [[-300, -500], [300, -500], [300, -700], [-300, -700], [-300, -500]]),
  ],
};

describe('osm helpers', () => {
  it('projects east to +x and north to -z, in metres', () => {
    const p = project(lat0 + 0.001, lon0 + 0.001);
    expect(p.x).toBeCloseTo(83, 0);
    expect(p.z).toBeCloseTo(-111.1, 0);
  });

  it('parses OSM lengths', () => {
    expect(parseLength('120')).toBe(120);
    expect(parseLength('120.5 m')).toBe(120.5);
    expect(parseLength("394'")).toBeCloseTo(120.09, 1);
    expect(parseLength('10 ft')).toBeCloseTo(3.048, 3);
    expect(parseLength('tall')).toBeNaN();
  });

  it('round-trips rings through the decimetre delta coding', () => {
    const ring = [
      { x: 10.04, z: -3.26 },
      { x: 52.9, z: -3.2 },
      { x: 52.9, z: 40 },
    ];
    decodeRing(encodeRing(ring)).forEach((p, i) => {
      expect(p.x).toBeCloseTo(ring[i]!.x, 1);
      expect(p.z).toBeCloseTo(ring[i]!.z, 1);
    });
  });

  it('simplifies a ring without losing its shape', () => {
    const square = [
      { x: 0, z: 0 },
      { x: 10, z: 0.1 },
      { x: 20, z: 0 },
      { x: 20, z: 20 },
      { x: 0, z: 20 },
    ];
    const s = simplifyRing(square, 0.5);
    expect(s).toHaveLength(4);
    expect(Math.abs(ringArea(s))).toBeCloseTo(400, 0);
  });
});

describe('clipRing', () => {
  it('cuts a river running off the map to the map', () => {
    // A 1 km long, 60 m wide channel crossing the right edge (x = 100) of a 200 m square.
    const river = [
      { x: -50, z: -30 },
      { x: 950, z: -30 },
      { x: 950, z: 30 },
      { x: -50, z: 30 },
    ];
    const c = clipRing(river, -100, 100, -100, 100);
    expect(Math.abs(ringArea(c))).toBeCloseTo(150 * 60, 3);
    for (const p of c) expect(p.x).toBeLessThanOrEqual(100);
    expect(clipRing(river, 1000, 1100, -100, 100)).toHaveLength(0);
  });
});

describe('convertChicago', () => {
  const { track, city } = convertChicago(fixture, polygonClipping, ROUTE);

  it('finds the four junctions in clockwise driving order (all right turns), upper Wacker only', () => {
    const expected = [
      [75, -478],
      [75, 466],
      [-66, 466],
      [-66, -478],
    ];
    track.corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(expected[i]![0]!, 0);
      expect(c.z).toBeCloseTo(expected[i]![1]!, 0);
    });
    const n = track.corners.length;
    for (let i = 0; i < n; i++) {
      const a = track.corners[(i + n - 1) % n]!;
      const b = track.corners[i]!;
      const c = track.corners[(i + 1) % n]!;
      // Positive cross = left turn in the car convention (left normal (dz, -dx)): every one must be right.
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      expect(cross).toBeGreaterThan(0);
    }
  });

  it('measures each side’s building line (the river on Wacker’s north side), ignoring overhangs', () => {
    const expected = [
      [14, 12], // LaSalle southbound: east, west
      [12, 12], // Jackson westbound: south, north
      [14, 12], // Wells northbound: west, east
      [22, 12], // Wacker eastbound: north (river), south
    ];
    track.corridor.forEach((c, i) => {
      expect(c[0]).toBeCloseTo(expected[i]![0]!, 0);
      expect(c[1]).toBeCloseTo(expected[i]![1]!, 0);
    });
  });

  it('rounds the corners as wide as the inside block allows', () => {
    for (const c of track.corners) {
      expect(c.r).toBeGreaterThanOrEqual(10);
      expect(c.r).toBeLessThanOrEqual(25);
    }
  });

  it('finds the side streets crossing the building lines', () => {
    const madison = city.mouths.filter((m) => m.name === 'West Madison Street');
    expect(madison).toHaveLength(4);
    for (const m of madison) expect(m.width).toBeCloseTo(15.2, 1);
    // LaSalle carrying on north over the river, Jackson carrying on east.
    expect(city.mouths.some((m) => m.name === 'South LaSalle Street' && m.z < -480)).toBe(true);
    expect(city.mouths.some((m) => m.name === 'West Jackson Boulevard' && m.x > 85)).toBe(true);
    // Every mouth points away from the route.
    for (const m of city.mouths) expect(Math.hypot(m.dx, m.dz)).toBeCloseTo(1, 5);
  });

  it('keeps the buildings with their heights and names', () => {
    expect(city.buildings).toHaveLength(9);
    const cbot = city.buildings.find((b) => b.n === 'Chicago Board of Trade Building')!;
    expect(cbot.h).toBe(1840);
    expect(city.buildings.some((b) => b.h === 380)).toBe(true); // 10 levels
    expect(city.buildings.some((b) => b.b === 200)).toBe(true); // the raised part
    for (const b of city.buildings) expect(ringArea(decodeRing(b.r))).toBeGreaterThan(0);
    expect(city.attribution).toMatch(/OpenStreetMap/);
  });

  it('cuts the river and the Riverwalk below the street, behind the corridor', () => {
    const cut = city.cut.map((poly) => poly.map(decodeRing));
    const walk = city.walk.map((poly) => poly.map(decodeRing));
    // Wacker's north building line is 22 m out (the river): the cut starts just behind the wall there.
    expect(inPolygons(cut, 0, -500.5)).toBe(false);
    expect(inPolygons(cut, 0, -503)).toBe(true);
    expect(inPolygons(cut, 0, -600)).toBe(true);
    expect(city.water).toHaveLength(1);
    // The walk: the far bank's band round the Riverwalk, not the water.
    expect(inPolygons(walk, 0, -710)).toBe(true);
    expect(inPolygons(walk, 0, -600)).toBe(false);
    expect(inPolygons(cut, 0, -720)).toBe(false);
    expect(city.paths.length).toBeGreaterThan(0);
    // The kiosk on it stands on the walk, below the street.
    const kiosk = city.buildings.find((b) => b.b !== undefined && b.b < 0)!;
    expect(kiosk.b).toBe(-26);
    expect(kiosk.h).toBe(3); // 5 m tall, but capped just over the street
  });

  it('carries the roads over the cut on decks, bridge houses on the bascule bridge', () => {
    const wells = city.decks.find((d) => d.n === 'North Wells Street')!;
    expect(wells.w).toBeCloseTo(11.9, 1);
    expect(wells.h).toBeDefined();
    // Over the water from the south bank (2 m of overhang plus the few metres of walkway) to the north bank.
    expect(wells.h![1] - wells.h![0]).toBeGreaterThan(190);
    expect(wells.h![1] - wells.h![0]).toBeLessThan(205);
    const lasalle = city.decks.find((d) => d.n === 'South LaSalle Street')!;
    expect(lasalle.h).toBeUndefined();
    // Its side-street stub stops at the cut.
    const mouth = city.mouths.find((m) => m.name === 'South LaSalle Street' && m.z < -480)!;
    expect(mouth.reach).toBeLessThan(3);
    const madison = city.mouths.find((m) => m.name === 'West Madison Street')!;
    expect(madison.reach).toBe(40);
  });
});
