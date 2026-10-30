/**
 * Pure OpenStreetMap → Chicago Loop level converter, run offline by scripts/osm-chicago.ts.
 * No imports, so node can load this file directly (type stripping).
 *
 * World axes: x = metres east, z = metres south (north is -z, which keeps the map unmirrored seen from above
 * in three.js), centred on CHICAGO_ROUTE.origin. The route is clockwise: south on LaSalle, west on Jackson,
 * north on Wacker along the river's south branch, round the 333 W Wacker bend, east on Wacker along the main branch.
 *
 * Polygon booleans (the river cut) come in as `PolygonOps` (polygon-clipping, passed by the script and the tests),
 * so this module stays import-free and out of the game bundle's dependencies.
 */

export const CHICAGO_ROUTE: Route = {
  /** Overpass bbox: south, west, north, east (the route plus ~900 m). */
  bbox: [41.87, -87.645, 41.8947, -87.6214] as [number, number, number, number],
  /** Projection origin (lat, lon): the middle of the route. */
  origin: [41.8823, -87.6332] as [number, number],
  /**
   * The streets in driving order, each with a rough seed segment (lat, lon from → to) used to pick the
   * street's nodes; the street lines are then fitted to them. Street i runs from corner i to corner i + 1.
   * Wacker is three straights: up the south branch, the diagonal at 333 W Wacker, along the main branch.
   */
  streets: [
    { label: 'LaSalle Street', name: /\bLa ?Salle\b/i, from: [41.8866, -87.6324], to: [41.8781, -87.6322] },
    { label: 'Jackson Boulevard', name: /\bJackson\b/i, from: [41.8781, -87.6322], to: [41.87808, -87.63687] },
    { label: 'Wacker Drive', name: /\bWacker\b/i, from: [41.87808, -87.63687], to: [41.88565, -87.63685], reach: 10 },
    { label: 'Wacker Drive', name: /\bWacker\b/i, from: [41.88628, -87.63643], to: [41.88671, -87.63571], width: 15, reach: 0, cornerMax: 90 },
    { label: 'Wacker Drive', name: /\bWacker\b/i, from: [41.88688, -87.63489], to: [41.8866, -87.6324], reach: 10, cornerMax: 90 },
  ] as RouteStreet[],
};

export interface RouteStreet {
  label: string;
  name: RegExp;
  from: [number, number];
  to: [number, number];
  /** Seed overrides (m): how far across and beyond the seed segment's ends nodes are taken (`OSM_CONFIG.seedWidth`/`seedReach`). */
  width?: number;
  reach?: number;
  /** The largest radius (m) for the corner where this street starts (a sweeping bend rather than a city junction). */
  cornerMax?: number;
}

export interface Route {
  bbox: [number, number, number, number];
  origin: [number, number];
  streets: RouteStreet[];
}

export const OSM_CONFIG = {
  /** Street nodes this close (m) to a seed segment's line, and within its ends ± `seedReach`, fit that street. */
  seedWidth: 45,
  seedReach: 25,
  /** Road half width (m), curb to curb; the sidewalks are the rest of the corridor. */
  halfWidth: 8,
  /** Corridor probes: every `probeStep` m along each straight, skipping `probeSkip` m at its ends, out to `probeRange` m. */
  probeStep: 5,
  probeSkip: 30,
  probeRange: 45,
  /** Corridor (centreline to building line) clamps (m), and the fallback when too few probes hit anything. */
  corridorMin: 10,
  corridorMax: 30,
  corridorDefault: 14,
  /** At least this share of the probes must hit to count; the building line is this quantile of the hits (the nearer facades). */
  probeShare: 0.3,
  probeQuantile: 0.3,
  /** Building parts starting this high (m) or higher (bridges, overhangs) are no building line. */
  overhang: 4,
  /** Corner radius (m): the largest within these that keeps the road's inner edge `cornerClear` m off the inside block. */
  cornerMin: 10,
  cornerMax: 25,
  cornerClear: 1.5,
  /** The start/finish line sits this far (m) before the LaSalle × Jackson junction's centre. */
  startBefore: 150,
  /** Building heights (m): per level, and with no height tagged. */
  levelHeight: 3.8,
  defaultHeight: 24,
  /** Untagged footprints smaller than this (m², kiosks, riverwalk shelters) get `smallHeight` instead. */
  smallArea: 200,
  smallHeight: 5,
  /**
   * The river and the Riverwalk sit below the street (m): the walk a little above the water. Shallower than the
   * real ~7 m, so the water shows from the car: over a 6 m drop it was out of sight unless ~120 m away.
   */
  walkLevel: -2.6,
  waterLevel: -3.6,
  /** Water areas this big (m²) or bigger are the river (cut into the ground); smaller ones are pools at street level. */
  riverArea: 5000,
  /** The Riverwalk floor reaches this far (m) either side of its paths. */
  walkReach: 9,
  /** The cut stays this far (m) behind the corridor's building line (the wall's back face, plus a little). */
  cutMargin: 1.5,
  /** A footprint this small (m²) standing mostly (`kioskShare`) on the Riverwalk is a kiosk down on the walk. */
  kioskArea: 400,
  kioskShare: 0.6,
  /** Kiosks reach at most this high (m): just over the street, not above the balustrade. */
  kioskTop: 0.3,
  /** Side-street stubs reach at most this far (m), and stop short of the cut. */
  mouthReach: 40,
  /** Road decks over the cut: widths clamped to these (m), ends carried this far (m) onto the ground. */
  deckMin: 5,
  deckMax: 24,
  deckOverhang: 2,
  /** Footprint simplification (m): near the route (within `nearRoute` m) and further out; small far buildings are dropped. */
  nearRoute: 250,
  simplifyNear: 0.5,
  simplifyFar: 2,
  minFarArea: 60,
};

/** Building colours, by palette index (the runtime uses the same list). */
export const BUILDING_COLOURS = ['#cfc6b4', '#9c5a44', '#41596b', '#8d939a', '#b9a07c', '#e4e1da', '#34383d', '#7a6a58'];
const MATERIAL_COLOUR: Record<string, number> = { brick: 1, glass: 2, metal: 3, steel: 3, stone: 4, sandstone: 4, limestone: 0, concrete: 0, plaster: 5, marble: 5 };
/** Weights for buildings with no colour or material: limestone and brick downtown, some glass and steel. */
const DEFAULT_WEIGHTS = [5, 3, 3, 2, 2, 1, 1, 1];

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
  members?: { type: string; ref: number; role: string; geometry?: ({ lat: number; lon: number } | null)[] }[];
}

export interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  /** The date the data is as of, when the download was pinned to one (added by the script). */
  date?: string;
  elements: OverpassElement[];
}

/** The track part of the level (small: imported statically by src/race/tracks.ts). */
export interface ChicagoTrack {
  corners: { x: number; z: number; r: number }[];
  /** Per straight: centreline → building line (m) on its [left, right]. */
  corridor: [number, number][];
  halfWidth: number;
  /** The start/finish line sits this far (m) before corner 1 (LaSalle × Jackson). */
  startBefore: number;
  /** The street names, per straight. */
  streets: string[];
}

/** One extruded building (footprint ring delta-coded in decimetres: x0, z0, dx1, dz1, …). */
export interface EncodedBuilding {
  r: number[];
  /** Top (decimetres above the ground). */
  h: number;
  /** Bottom (decimetres), when it doesn't stand on the ground (a part on top of another). */
  b?: number;
  /** BUILDING_COLOURS index. */
  c: number;
  n?: string;
}

/** Where a side street (or alley) meets the corridor's wall line. */
export interface StreetMouth {
  x: number;
  z: number;
  /** Unit direction from the route into the side street. */
  dx: number;
  dz: number;
  name: string;
  width: number;
  /** How far (m) the street runs at street level before the river cut (capped at `mouthReach`). */
  reach: number;
}

/** A road crossing the river cut at street level: a bridge, or an approach over the Riverwalk. */
export interface EncodedDeck {
  /** Centreline (delta-coded decimetres, like a ring but open). */
  p: number[];
  /** Width (m). */
  w: number;
  /** A bascule bridge: where along the centreline (m) it leaves and reaches the bank (its bridge houses). */
  h?: [number, number];
  n?: string;
}

/** The heavy part (buildings and decoration), loaded with the level. */
export interface ChicagoCity {
  attribution: string;
  source: { timestamp: string; bbox: number[] };
  buildings: EncodedBuilding[];
  mouths: StreetMouth[];
  /** Everything below street level (the river and the Riverwalk): polygons, outer ring first, then holes. */
  cut: number[][][];
  /** The Riverwalk floor (the cut less the river), at `walkLevel`. */
  walk: number[][][];
  /** The river (inside the cut), at `waterLevel`. */
  water: number[][][];
  /** Small water areas (fountains, pools) at street level. */
  pools: number[][];
  decks: EncodedDeck[];
  /** The Riverwalk's paths, down on the walk (open lines). */
  paths: number[][];
}

/** Polygon booleans (polygon-clipping's signatures): a polygon is rings of [x, z] pairs, outer first. */
export type Pair = [number, number];
export type Polygon = Pair[][];
export type MultiPolygon = Polygon[];
export interface PolygonOps {
  union(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
  intersection(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
  difference(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
}

type P = { x: number; z: number };
type Ring = P[];

const R2D = 180 / Math.PI;

/** Equirectangular projection about `origin` (accurate to centimetres over a few km). */
export function projector(origin: [number, number]): (lat: number, lon: number) => P {
  const phi = origin[0] / R2D;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return (lat, lon) => ({ x: (lon - origin[1]) * mLon, z: -(lat - origin[0]) * mLat });
}

export function encodeRing(ring: readonly P[]): number[] {
  const out: number[] = [];
  let px = 0;
  let pz = 0;
  for (const p of ring) {
    const x = Math.round(p.x * 10);
    const z = Math.round(p.z * 10);
    out.push(x - px, z - pz);
    px = x;
    pz = z;
  }
  return out;
}

export function decodeRing(r: readonly number[]): P[] {
  const out: P[] = [];
  let x = 0;
  let z = 0;
  for (let i = 0; i + 1 < r.length; i += 2) {
    x += r[i]!;
    z += r[i + 1]!;
    out.push({ x: x / 10, z: z / 10 });
  }
  return out;
}

/** Parses an OSM length ("120", "120 m", "394'", "394 ft", "12'6\""); NaN if it can't. */
export function parseLength(v: string | undefined): number {
  if (!v) return NaN;
  const s = v.trim().replace(',', '.');
  const feet = s.match(/^([\d.]+)\s*(?:'|ft|feet)(?:\s*([\d.]+)\s*(?:"|in))?$/i);
  if (feet) return (parseFloat(feet[1]!) + (feet[2] ? parseFloat(feet[2]) / 12 : 0)) * 0.3048;
  const m = s.match(/^([\d.]+)\s*(?:m|metres|meters)?$/i);
  return m ? parseFloat(m[1]!) : NaN;
}

/** Signed area (m², positive = counter-clockwise in x/z, i.e. clockwise seen from above with north up). */
export function ringArea(ring: readonly P[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export function pointInRing(x: number, z: number, ring: readonly P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker on a closed ring (no repeated end point). */
export function simplifyRing(ring: readonly P[], tolerance: number): P[] {
  if (ring.length <= 4) return ring.slice();
  // Split at the vertex farthest from the first, and simplify both halves as open lines.
  let far = 0;
  let best = -1;
  ring.forEach((p, i) => {
    const d = Math.hypot(p.x - ring[0]!.x, p.z - ring[0]!.z);
    if (d > best) {
      best = d;
      far = i;
    }
  });
  const a = simplifyLine(ring.slice(0, far + 1), tolerance);
  const b = simplifyLine([...ring.slice(far), ring[0]!], tolerance);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring.slice();
}

function simplifyLine(line: readonly P[], tolerance: number): P[] {
  if (line.length <= 2) return line.slice();
  const a = line[0]!;
  const b = line[line.length - 1]!;
  let worst = -1;
  let at = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const d = segmentDistance(line[i]!, a, b);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tolerance) return [a, b];
  return [...simplifyLine(line.slice(0, at + 1), tolerance).slice(0, -1), ...simplifyLine(line.slice(at), tolerance)];
}

export function segmentDistance(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** Least-squares line through points: centroid and unit direction (principal axis), turned to point along `hint`. */
export function fitLine(points: readonly P[], hint: P): { x: number; z: number; dx: number; dz: number } {
  let cx = 0;
  let cz = 0;
  for (const p of points) {
    cx += p.x;
    cz += p.z;
  }
  cx /= points.length;
  cz /= points.length;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const p of points) {
    sxx += (p.x - cx) ** 2;
    sxz += (p.x - cx) * (p.z - cz);
    szz += (p.z - cz) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  let dx = Math.cos(angle);
  let dz = Math.sin(angle);
  if (dx * hint.x + dz * hint.z < 0) {
    dx = -dx;
    dz = -dz;
  }
  return { x: cx, z: cz, dx, dz };
}

/** Where two lines (point + direction) cross. */
export function intersectLines(a: { x: number; z: number; dx: number; dz: number }, b: { x: number; z: number; dx: number; dz: number }): P {
  const den = a.dx * b.dz - a.dz * b.dx;
  if (Math.abs(den) < 1e-9) throw new Error('parallel street lines');
  const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / den;
  return { x: a.x + a.dx * t, z: a.z + a.dz * t };
}

/** Distance along a ray (origin, unit direction) to the first crossing of segment a–b, or Infinity. */
export function raySegment(o: P, ux: number, uz: number, a: P, b: P): number {
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const den = ux * ez - uz * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const t = ((a.x - o.x) * ez - (a.z - o.z) * ex) / den;
  const u = ((a.x - o.x) * uz - (a.z - o.z) * ux) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}

/**
 * The corner radius for a junction: the largest in [min, max] keeping the road's inner edge at the apex
 * `clear` m off the inside block's corner (where the two inside building lines meet).
 */
export function cornerRadius(corner: P, dirIn: P, dirOut: P, insideIn: number, insideOut: number, halfWidth: number, cfg = OSM_CONFIG): number {
  const turn = Math.atan2(dirIn.x * dirOut.z - dirIn.z * dirOut.x, dirIn.x * dirOut.x + dirIn.z * dirOut.z);
  const side = Math.sign(turn); // +1: the inside is to the left of travel (car convention: left normal (dz, -dx))
  const nIn = { x: dirIn.z * side, z: -dirIn.x * side };
  const nOut = { x: dirOut.z * side, z: -dirOut.x * side };
  const block = intersectLines(
    { x: corner.x + nIn.x * insideIn, z: corner.z + nIn.z * insideIn, dx: dirIn.x, dz: dirIn.z },
    { x: corner.x + nOut.x * insideOut, z: corner.z + nOut.z * insideOut, dx: dirOut.x, dz: dirOut.z },
  );
  const clearance = (r: number): number => {
    // The arc's centre sits on the inside, r from both centrelines.
    const c = intersectLines(
      { x: corner.x + nIn.x * r, z: corner.z + nIn.z * r, dx: dirIn.x, dz: dirIn.z },
      { x: corner.x + nOut.x * r, z: corner.z + nOut.z * r, dx: dirOut.x, dz: dirOut.z },
    );
    // The road's inner edge bulges r - halfWidth from the centre toward the junction; the block's corner sits this far along that way.
    const l = Math.hypot(corner.x - c.x, corner.z - c.z);
    const along = ((block.x - c.x) * (corner.x - c.x) + (block.z - c.z) * (corner.z - c.z)) / l;
    return r - halfWidth - along;
  };
  if (clearance(cfg.cornerMin) < cfg.cornerClear) return cfg.cornerMin;
  let lo = cfg.cornerMin;
  let hi = cfg.cornerMax;
  if (clearance(hi) >= cfg.cornerClear) return hi;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (clearance(mid) >= cfg.cornerClear) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 10) / 10;
}

interface Footprint {
  id: number;
  ring: Ring;
  top: number;
  bottom: number;
  colour: number;
  name?: string;
  part: boolean;
}

/** Joins a multipolygon's member ways into closed rings (members of one role). */
export function joinRings(chains: P[][]): Ring[] {
  const rings: Ring[] = [];
  const open = chains.filter((c) => c.length >= 2).map((c) => c.slice());
  const same = (a: P, b: P) => Math.abs(a.x - b.x) < 0.05 && Math.abs(a.z - b.z) < 0.05;
  while (open.length > 0) {
    let ring = open.shift()!;
    for (let guard = 0; guard < 10000 && !same(ring[0]!, ring[ring.length - 1]!); guard++) {
      const end = ring[ring.length - 1]!;
      const i = open.findIndex((c) => same(c[0]!, end) || same(c[c.length - 1]!, end));
      if (i < 0) break;
      const next = open.splice(i, 1)[0]!;
      ring = ring.concat(same(next[0]!, end) ? next.slice(1) : next.slice(0, -1).reverse());
    }
    if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) rings.push(ring.slice(0, -1));
  }
  return rings;
}

function colourIndex(tags: Record<string, string>, id: number): number {
  const hex = tags['building:colour'] ?? tags['colour'];
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) {
    const v = parseInt(hex.slice(1), 16);
    let best = 0;
    let bestD = Infinity;
    BUILDING_COLOURS.forEach((c, i) => {
      const w = parseInt(c.slice(1), 16);
      const d = (((v >> 16) & 255) - ((w >> 16) & 255)) ** 2 + (((v >> 8) & 255) - ((w >> 8) & 255)) ** 2 + ((v & 255) - (w & 255)) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
  const material = MATERIAL_COLOUR[(tags['building:material'] ?? tags['building:facade:material'] ?? '').toLowerCase()];
  if (material !== undefined) return material;
  // A stable pick by id, weighted.
  const total = DEFAULT_WEIGHTS.reduce((a, b) => a + b, 0);
  let h = Math.imul(id ^ (id >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 13)) % total;
  for (let i = 0; i < DEFAULT_WEIGHTS.length; i++) {
    h -= DEFAULT_WEIGHTS[i]!;
    if (h < 0) return i;
  }
  return 0;
}

function heights(tags: Record<string, string>, area: number): { top: number; bottom: number } {
  const levels = parseFloat(tags['building:levels'] ?? '');
  const minLevel = parseFloat(tags['building:min_level'] ?? '');
  let top = parseLength(tags['height']);
  if (!Number.isFinite(top)) top = Number.isFinite(levels) ? levels * OSM_CONFIG.levelHeight : area < OSM_CONFIG.smallArea ? OSM_CONFIG.smallHeight : OSM_CONFIG.defaultHeight;
  let bottom = parseLength(tags['min_height']);
  if (!Number.isFinite(bottom)) bottom = Number.isFinite(minLevel) ? minLevel * OSM_CONFIG.levelHeight : 0;
  return { top: Math.max(3, top), bottom: Math.min(bottom, top - 1) };
}

/** Whole conversion: the track and the city around it. */
export function convertChicago(raw: OverpassResponse, ops: PolygonOps, route: Route = CHICAGO_ROUTE, cfg = OSM_CONFIG): { track: ChicagoTrack; city: ChicagoCity } {
  const project = projector(route.origin);
  const pts = (g: OverpassElement['geometry']): P[] => (g ?? []).filter((p): p is { lat: number; lon: number } => p !== null).map((p) => project(p.lat, p.lon));

  const roads = raw.elements.filter((e) => e.type === 'way' && e.tags?.['highway']);
  const driveable = roads.filter((e) => !/^(footway|cycleway|path|steps|pedestrian|corridor|elevator|platform|construction|proposed)$/.test(e.tags!['highway']!) && e.tags!['tunnel'] !== 'yes' && e.tags!['area'] !== 'yes');

  // Street lines: fitted to the nodes of the named street near its seed segment (upper level only).
  const n = route.streets.length;
  const lines = route.streets.map((st) => {
    const a = project(st.from[0], st.from[1]);
    const b = project(st.to[0], st.to[1]);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    const nodes: P[] = [];
    const seedWidth = st.width ?? cfg.seedWidth;
    const seedReach = st.reach ?? cfg.seedReach;
    for (const w of driveable) {
      const t = w.tags!;
      if (!st.name.test(t['name'] ?? '') || /lower/i.test(t['name'] ?? '') || parseFloat(t['layer'] ?? '0') < 0 || parseFloat(t['level'] ?? '0') < 0) continue;
      if (/_link$/.test(t['highway']!)) continue;
      for (const p of densify(pts(w.geometry), 5)) {
        const along = (p.x - a.x) * ux + (p.z - a.z) * uz;
        const across = Math.abs((p.x - a.x) * uz - (p.z - a.z) * ux);
        if (across < seedWidth && along > -seedReach && along < len + seedReach) nodes.push(p);
      }
    }
    if (nodes.length < 2) throw new Error(`no OSM nodes found for ${st.name}`);
    return fitLine(nodes, { x: ux, z: uz });
  });
  const junctions = lines.map((_, i) => intersectLines(lines[(i + n - 1) % n]!, lines[i]!));

  // Buildings (outlines and parts), as footprints in metres.
  const footprints: Footprint[] = [];
  for (const e of raw.elements) {
    const t = e.tags ?? {};
    const isPart = !!t['building:part'] && !t['building'];
    if (!t['building'] && !t['building:part']) continue;
    // Not: underground, canopies, or structures up on the L (station shelters, signal boxes: layer 1+) standing over the street.
    if (t['building'] === 'no' || t['building:part'] === 'no' || t['building'] === 'roof' || t['location'] === 'underground' || parseFloat(t['layer'] ?? '0') !== 0) continue;
    let rings: Ring[] = [];
    if (e.type === 'way') {
      const r = pts(e.geometry);
      if (r.length >= 4) rings = [r.slice(0, -1)];
    } else if (e.type === 'relation') {
      rings = joinRings((e.members ?? []).filter((m) => m.type === 'way' && m.role === 'outer').map((m) => pts(m.geometry)));
    }
    for (const ring of rings) {
      const area = Math.abs(ringArea(ring));
      if (area < 4) continue;
      const { top, bottom } = heights(t, area);
      footprints.push({ id: e.id, ring, top, bottom, colour: colourIndex(t, e.id), name: t['name'], part: isPart });
    }
  }
  // An outline mostly covered by its parts is drawn as those parts (the OSM 3D rule).
  const parts = footprints.filter((f) => f.part);
  const shown = footprints.filter((f) => {
    if (f.part) return true;
    let covered = 0;
    for (const p of parts) {
      const c = centroid(p.ring);
      if (pointInRing(c.x, c.z, f.ring)) covered += Math.abs(ringArea(p.ring));
    }
    return covered < 0.5 * Math.abs(ringArea(f.ring));
  });

  // Corridor: centreline → building line, per straight and side, from probes against building edges and water.
  const water: Ring[] = [];
  for (const e of raw.elements) {
    const t = e.tags ?? {};
    if (t['natural'] !== 'water' && t['waterway'] !== 'riverbank') continue;
    if (e.type === 'way') {
      const r = pts(e.geometry);
      if (r.length >= 4) water.push(r.slice(0, -1));
    } else water.push(...joinRings((e.members ?? []).filter((m) => m.role === 'outer').map((m) => pts(m.geometry))));
  }
  const rawWater = water.slice();
  // Rivers run far beyond the map: cut every water area to the bbox.
  const [bs, bw, bn, be] = route.bbox;
  const sw = project(bs, bw);
  const ne = project(bn, be);
  const clipped = water.map((r) => clipRing(r, sw.x, ne.x, ne.z, sw.z)).filter((r) => r.length >= 3);
  water.length = 0;
  water.push(...clipped);
  const edges: [P, P][] = [];
  for (const f of shown) {
    if (f.bottom >= cfg.overhang) continue;
    f.ring.forEach((p, i) => edges.push([p, f.ring[(i + 1) % f.ring.length]!]));
  }
  for (const r of water) r.forEach((p, i) => edges.push([p, r[(i + 1) % r.length]!]));
  const near = (o: P, ux: number, uz: number): number => {
    let best = Infinity;
    for (const [a, b] of edges) {
      if (Math.min(a.x, b.x) > o.x + cfg.probeRange || Math.max(a.x, b.x) < o.x - cfg.probeRange || Math.min(a.z, b.z) > o.z + cfg.probeRange || Math.max(a.z, b.z) < o.z - cfg.probeRange) continue;
      best = Math.min(best, raySegment(o, ux, uz, a, b));
    }
    return best;
  };
  const corridor: [number, number][] = junctions.map((a, i) => {
    const b = junctions[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    return [1, -1].map((side) => {
      const hits: number[] = [];
      let probes = 0;
      for (let u = cfg.probeSkip; u <= len - cfg.probeSkip; u += cfg.probeStep) {
        probes++;
        const d = near({ x: a.x + dx * u, z: a.z + dz * u }, dz * side, -dx * side);
        if (d <= cfg.probeRange) hits.push(d);
      }
      hits.sort((p, q) => p - q);
      const line = hits.length >= Math.max(1, probes * cfg.probeShare) ? hits[Math.floor(hits.length * cfg.probeQuantile)]! : cfg.corridorDefault;
      return Math.round(Math.min(cfg.corridorMax, Math.max(cfg.corridorMin, line)) * 10) / 10;
    }) as [number, number];
  });

  // Corner radii from the inside blocks.
  const dirs = junctions.map((a, i) => {
    const b = junctions[(i + 1) % n]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  });
  const corners = junctions.map((c, i) => {
    const into = (i + n - 1) % n;
    const dIn = dirs[into]!;
    const dOut = dirs[i]!;
    const turn = Math.atan2(dIn.x * dOut.z - dIn.z * dOut.x, dIn.x * dOut.x + dIn.z * dOut.z);
    const k = turn > 0 ? 0 : 1; // the inside: left (0) on a left turn
    const r = cornerRadius(c, dIn, dOut, corridor[into]![k]!, corridor[i]![k]!, cfg.halfWidth, { ...cfg, cornerMax: route.streets[i]!.cornerMax ?? cfg.cornerMax });
    return { x: Math.round(c.x * 10) / 10, z: Math.round(c.z * 10) / 10, r };
  });

  // The river cut: the river and the Riverwalk beside it sit below the street. It is the river plus a band round
  // the Riverwalk's paths, less the route's corridor (each straight's strip out to its building lines, carried
  // across the junctions) and the buildings standing in it; kiosks out on the walk itself go down with it.
  const unionAll = (list: Polygon[]): MultiPolygon => (list.length === 0 ? [] : ops.union(list[0]!, ...list.slice(1)));
  const box: Polygon = [closed([{ x: sw.x + 1, z: ne.z + 1 }, { x: ne.x - 1, z: ne.z + 1 }, { x: ne.x - 1, z: sw.z - 1 }, { x: sw.x + 1, z: sw.z - 1 }])];
  const riverRings = rawWater.filter((r) => Math.abs(ringArea(r)) >= cfg.riverArea);
  const river = riverRings.length > 0 ? ops.intersection(unionAll(riverRings.map((r) => [closed(r)])), box) : [];
  const walkLines = roads
    .filter((e) => /riverwalk/i.test(e.tags!['name'] ?? '') && /^(footway|pedestrian|path|cycleway)$/.test(e.tags!['highway']!) && !e.tags!['bridge'] && !(parseFloat(e.tags!['layer'] ?? '0') || 0))
    .map((e) => pts(e.geometry))
    .filter((l) => l.length >= 2);
  const zone = unionAll([...river, ...walkLines.flatMap((l) => bandPieces(l, cfg.walkReach))]);
  const zoneBoxes = zone.map((poly) => bounds(poly[0]!.map(([x, z]) => ({ x, z }))));
  const strips: Polygon[] = junctions.map((a, i) => {
    const b = junctions[(i + 1) % n]!;
    const d = dirs[i]!;
    const e0 = Math.max(...corridor[(i + n - 1) % n]!) + cfg.cutMargin;
    const e1 = Math.max(...corridor[(i + 1) % n]!) + cfg.cutMargin;
    const l = corridor[i]![0] + cfg.cutMargin;
    const r = corridor[i]![1] + cfg.cutMargin;
    const a0 = { x: a.x - d.x * e0, z: a.z - d.z * e0 };
    const b0 = { x: b.x + d.x * e1, z: b.z + d.z * e1 };
    return [closed([{ x: a0.x + d.z * l, z: a0.z - d.x * l }, { x: b0.x + d.z * l, z: b0.z - d.x * l }, { x: b0.x - d.z * r, z: b0.z + d.x * r }, { x: a0.x - d.z * r, z: a0.z + d.x * r }])];
  });
  const kiosks = new Set<Footprint>();
  const solid: Polygon[] = [];
  for (const f of shown) {
    if (f.bottom >= cfg.overhang) continue;
    const fb = bounds(f.ring);
    if (!zoneBoxes.some((zb) => fb.x0 < zb.x1 && fb.x1 > zb.x0 && fb.z0 < zb.z1 && fb.z1 > zb.z0)) continue;
    const foot: Polygon = [closed(f.ring)];
    const inZone = multiArea(ops.intersection(foot, zone));
    if (inZone < 0.5) continue;
    const area = Math.abs(ringArea(f.ring));
    const inRiver = river.length > 0 ? multiArea(ops.intersection(foot, river)) : 0;
    if (area <= cfg.kioskArea && inZone / area >= cfg.kioskShare && inRiver < 1) kiosks.add(f);
    else solid.push(foot);
  }
  const cutP = cleanPolygons(toPolygons(zone.length > 0 ? ops.difference(ops.intersection(zone, box), ...strips, ...solid) : []));
  const cut = cutP.map((poly) => poly.map(closed));
  const waterP = river.length > 0 && cut.length > 0 ? cleanPolygons(toPolygons(ops.intersection(river, cut))) : [];
  const walkP = cut.length > 0 ? cleanPolygons(toPolygons(river.length > 0 ? ops.difference(cut, river) : cut)) : [];
  const pools = water.filter((r) => {
    const a = Math.abs(ringArea(r));
    const c = centroid(r);
    return a >= 50 && a < cfg.riverArea && !inPolygons(cutP, c.x, c.z);
  });

  // Roads crossing the cut at street level: the bridges, and approaches over the Riverwalk.
  const decks: EncodedDeck[] = [];
  for (const w of roads) {
    const t = w.tags!;
    const hw = t['highway']!;
    if (/^(footway|cycleway|path|steps|pedestrian|corridor|elevator|platform|proposed|bridleway|track)$/.test(hw) || t['tunnel'] === 'yes' || t['area'] === 'yes') continue;
    // A bridge closed for rebuilding still stands (Lake Street's); other construction doesn't.
    if (hw === 'construction' && !(t['bridge'] && t['name'])) continue;
    if ((parseFloat(t['layer'] ?? '0') || 0) < 0) continue;
    const lanes = parseFloat(t['lanes'] ?? '');
    const width = Math.min(cfg.deckMax, Math.max(cfg.deckMin, parseLength(t['width']) || (Number.isFinite(lanes) ? lanes * 3.3 + 2 : hw === 'service' ? 5 : 10)));
    const bascule = t['bridge'] === 'movable' || !!t['bridge:movable'];
    for (const run of runsInside(densify(pts(w.geometry), 2), cutP, 3)) {
      const line = extendLine(run, cfg.deckOverhang);
      const deck: EncodedDeck = { p: encodeRing(simplifyLine(line, 0.2)), w: round(width) };
      if (bascule) {
        // The bank on each side: the first and last points over the water (measured along the extended line).
        let along = 0;
        let s0 = -1;
        let s1 = -1;
        line.forEach((p, i) => {
          if (i > 0) along += Math.hypot(p.x - line[i - 1]!.x, p.z - line[i - 1]!.z);
          if (!inPolygons(waterP, p.x, p.z)) return;
          if (s0 < 0) s0 = along;
          s1 = along;
        });
        if (s1 - s0 >= 15) deck.h = [round(s0), round(s1)];
      }
      if (t['name']) deck.n = t['name'];
      decks.push(deck);
    }
  }
  const paths = walkLines.flatMap((l) => runsInside(densify(l, 2), walkP, 4)).map((l) => encodeRing(simplifyLine(l, 0.3)));

  // Side streets: drivable ways crossing a wall line (each straight's building lines, between the junctions' corners).
  const mouths: StreetMouth[] = [];
  const wallLines = junctions.flatMap((a, i) => {
    const d = dirs[i]!;
    return [0, 1].map((k) => {
      const side = k === 0 ? 1 : -1;
      const nx = d.z * side;
      const nz = -d.x * side;
      const off = corridor[i]![k]!;
      const prev = (i + n - 1) % n;
      const next = (i + 1) % n;
      // Ends: where this line meets the previous and next straights' lines on the same side.
      const line = { x: a.x + nx * off, z: a.z + nz * off, dx: d.x, dz: d.z };
      const other = (j: number) => {
        const e = dirs[j]!;
        const o = corridor[j]![k]!;
        return { x: junctions[j]!.x + e.z * side * o, z: junctions[j]!.z - e.x * side * o, dx: e.x, dz: e.z };
      };
      return { a: intersectLines(line, other(prev)), b: intersectLines(line, other(next)), nx, nz };
    });
  });
  for (const w of driveable) {
    const g = pts(w.geometry);
    for (let j = 0; j + 1 < g.length; j++) {
      const p = g[j]!;
      const q = g[j + 1]!;
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      if (len < 1e-6) continue;
      for (const wl of wallLines) {
        const t = raySegment(p, (q.x - p.x) / len, (q.z - p.z) / len, wl.a, wl.b);
        if (t > len) continue;
        const x = p.x + ((q.x - p.x) / len) * t;
        const z = p.z + ((q.z - p.z) / len) * t;
        const tags = w.tags!;
        const lanes = parseFloat(tags['lanes'] ?? '');
        const width = parseLength(tags['width']) || (Number.isFinite(lanes) ? lanes * 3.3 + 2 : tags['highway'] === 'service' ? 5 : 10);
        if (mouths.some((m) => Math.hypot(m.x - x, m.z - z) < 6)) continue;
        let reach = 0;
        while (reach < cfg.mouthReach && !inPolygons(cutP, x + wl.nx * (reach + 0.5), z + wl.nz * (reach + 0.5))) reach += 0.5;
        mouths.push({ x: round(x), z: round(z), dx: wl.nx, dz: wl.nz, name: tags['name'] ?? (tags['service'] === 'alley' ? 'Alley' : ''), width: round(width), reach });
      }
    }
  }

  // Route outline (for simplification distance).
  const routeDistance = (p: P): number => Math.min(...junctions.map((a, i) => segmentDistance(p, a, junctions[(i + 1) % n]!)));
  const buildings: EncodedBuilding[] = [];
  for (const f of shown) {
    const c = centroid(f.ring);
    const far = routeDistance(c) > cfg.nearRoute;
    if (far && Math.abs(ringArea(f.ring)) < cfg.minFarArea) continue;
    let ring = simplifyRing(f.ring, far ? cfg.simplifyFar : cfg.simplifyNear);
    if (ringArea(ring) < 0) ring = ring.reverse();
    const b: EncodedBuilding = { r: encodeRing(ring), h: Math.round(f.top * 10), c: f.colour };
    if (f.bottom > 0.5) b.b = Math.round(f.bottom * 10);
    if (kiosks.has(f)) {
      b.b = Math.round(cfg.walkLevel * 10);
      b.h = Math.round(Math.min(cfg.walkLevel + f.top, cfg.kioskTop) * 10);
    }
    if (f.name) b.n = f.name;
    buildings.push(b);
  }

  const streets = route.streets.map((s) => s.label);
  const encode = (polys: P[][][]) => polys.map((poly) => poly.map(encodeRing));
  return {
    track: { corners, corridor, halfWidth: cfg.halfWidth, startBefore: cfg.startBefore, streets },
    city: {
      attribution: '© OpenStreetMap contributors (ODbL)',
      source: { timestamp: raw.date ?? raw.osm3s?.timestamp_osm_base ?? '', bbox: route.bbox },
      buildings,
      mouths,
      cut: encode(cutP),
      walk: encode(walkP),
      water: encode(waterP),
      pools: pools.map((r) => encodeRing(simplifyRing(r, 1))),
      decks,
      paths,
    },
  };
}

/** Is (x, z) inside any of the polygons (outer ring first, then holes)? */
export function inPolygons(polys: readonly (readonly (readonly P[])[])[], x: number, z: number): boolean {
  return polys.some((poly) => pointInRing(x, z, poly[0]!) && !poly.slice(1).some((hole) => pointInRing(x, z, hole)));
}

function closed(ring: readonly P[]): Pair[] {
  const out: Pair[] = ring.map((p) => [p.x, p.z]);
  out.push([ring[0]!.x, ring[0]!.z]);
  return out;
}

/** polygon-clipping output (closed rings) as rings of points. */
function toPolygons(mp: MultiPolygon): P[][][] {
  return mp.map((poly) => poly.map((ring) => ring.slice(0, -1).map(([x, z]) => ({ x, z }))));
}

/** Simplified a little (0.3 m), with slivers and specks dropped. */
function cleanPolygons(polys: P[][][]): P[][][] {
  const ok = (ring: P[]) => ring.length >= 3 && Math.abs(ringArea(ring)) >= 4;
  const out: P[][][] = [];
  for (const poly of polys) {
    const outer = simplifyRing(poly[0]!, 0.3);
    if (ok(outer)) out.push([outer, ...poly.slice(1).map((ring) => simplifyRing(ring, 0.3)).filter(ok)]);
  }
  return out;
}

function multiArea(mp: MultiPolygon): number {
  let a = 0;
  for (const poly of mp) poly.forEach((ring, i) => (a += Math.abs(ringArea(ring.slice(0, -1).map(([x, z]) => ({ x, z })))) * (i === 0 ? 1 : -1)));
  return a;
}

function bounds(ring: readonly P[]): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of ring) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  return { x0, x1, z0, z1 };
}

/** A band `reach` m either side of a polyline: a box per segment and an octagon at each point (to be unioned). */
function bandPieces(line: readonly P[], reach: number): Polygon[] {
  const out: Polygon[] = [];
  line.forEach((p, i) => {
    const oct: P[] = [];
    for (let k = 0; k < 8; k++) oct.push({ x: p.x + Math.cos((k * Math.PI) / 4) * reach, z: p.z + Math.sin((k * Math.PI) / 4) * reach });
    out.push([closed(oct)]);
    const q = line[i + 1];
    if (!q) return;
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-6) return;
    const nx = ((q.z - p.z) / len) * reach;
    const nz = (-(q.x - p.x) / len) * reach;
    out.push([closed([{ x: p.x + nx, z: p.z + nz }, { x: q.x + nx, z: q.z + nz }, { x: q.x - nx, z: q.z - nz }, { x: p.x - nx, z: p.z - nz }])]);
  });
  return out;
}

/** The stretches of a (densified) line inside the polygons, each at least `min` points long. */
function runsInside(line: readonly P[], polys: P[][][], min: number): P[][] {
  const runs: P[][] = [];
  let run: P[] = [];
  for (const p of line) {
    if (inPolygons(polys, p.x, p.z)) run.push(p);
    else {
      if (run.length >= min) runs.push(run);
      run = [];
    }
  }
  if (run.length >= min) runs.push(run);
  return runs;
}

/** The line carried on `by` m straight past both ends. */
function extendLine(line: readonly P[], by: number): P[] {
  const a = line[0]!;
  const a1 = line[1]!;
  const b = line[line.length - 1]!;
  const b1 = line[line.length - 2]!;
  const la = Math.hypot(a.x - a1.x, a.z - a1.z) || 1;
  const lb = Math.hypot(b.x - b1.x, b.z - b1.z) || 1;
  return [{ x: a.x + ((a.x - a1.x) / la) * by, z: a.z + ((a.z - a1.z) / la) * by }, ...line, { x: b.x + ((b.x - b1.x) / lb) * by, z: b.z + ((b.z - b1.z) / lb) * by }];
}

/** The line's points plus extra ones so no two are more than `step` m apart (a long straight way has few nodes). */
function densify(line: readonly P[], step: number): P[] {
  const out: P[] = [];
  line.forEach((p, i) => {
    out.push(p);
    const q = line[i + 1];
    if (!q) return;
    const k = Math.floor(Math.hypot(q.x - p.x, q.z - p.z) / step);
    for (let j = 1; j < k; j++) out.push({ x: p.x + ((q.x - p.x) * j) / k, z: p.z + ((q.z - p.z) * j) / k });
  });
  return out;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function centroid(ring: readonly P[]): P {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p.x;
    z += p.z;
  }
  return { x: x / ring.length, z: z / ring.length };
}

/** Sutherland–Hodgman: a ring cut to the rectangle x0..x1, z0..z1 (a concave ring may keep zero-width bridges along the edge, harmless for a flat fill). */
export function clipRing(ring: readonly P[], x0: number, x1: number, z0: number, z1: number): P[] {
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= x0, (a, b) => lerpAt(a, b, (x0 - a.x) / (b.x - a.x))],
    [(p) => p.x <= x1, (a, b) => lerpAt(a, b, (x1 - a.x) / (b.x - a.x))],
    [(p) => p.z >= z0, (a, b) => lerpAt(a, b, (z0 - a.z) / (b.z - a.z))],
    [(p) => p.z <= z1, (a, b) => lerpAt(a, b, (z1 - a.z) / (b.z - a.z))],
  ];
  let out = ring.slice();
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    input.forEach((b, i) => {
      const a = input[(i + input.length - 1) % input.length]!;
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    });
    if (out.length === 0) break;
  }
  return out;
}

function lerpAt(a: P, b: P, t: number): P {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}
