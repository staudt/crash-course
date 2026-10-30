import { ShapeUtils, Vector2 } from 'three';
import type { TrackPath } from '../race/TrackPath';
import type { WallBlock } from '../world/TrackWalls';
import { BUILDING_COLOURS, decodeRing, inPolygons, type ChicagoCity, type StreetMouth } from './osm';

/**
 * The city around a street circuit (Chicago Loop), decoded from the level's data file: building footprints
 * to extrude, side-street mouths to close off, water. Pure (three's math only), so it is unit tested.
 */
export const CITY_CONFIG = {
  /** A wall block with a building this far (m) behind its face, all along it, stands in for the facade: a collider only. */
  facadeReach: 2.5,
  /** Facade colliders are this tall, so nothing climbs into a building. */
  facadeHeight: 8,
  /** Building parts starting this high (m) or higher (bridges, overhangs) don't hide a wall. */
  overhang: 4,
  /** A barrier with the river cut this far (m) behind it is a balustrade over the drop instead. */
  riverReach: 12,
  /** Spatial grid cell (m) for footprint lookups. */
  cell: 50,
  /** Window texture: one bay is this wide and one floor this tall (m). */
  bay: 4,
  floor: 3.8,
};

export interface Building {
  ring: { x: number; z: number }[];
  bottom: number;
  top: number;
  color: string;
  name?: string;
}

type Ring = { x: number; z: number }[];

/** A road over the river cut at street level (a bridge, or an approach over the Riverwalk). */
export interface Deck {
  line: Ring;
  width: number;
  /** A bascule bridge: along the line (m), where it leaves and reaches the banks (its bridge houses). */
  houses?: [number, number];
  name?: string;
}

export interface CityData {
  buildings: Building[];
  mouths: StreetMouth[];
  /** Below street level: polygons (outer ring, then holes). The Riverwalk floor and the river are inside it. */
  cut: Ring[][];
  walk: Ring[][];
  water: Ring[][];
  pools: Ring[];
  decks: Deck[];
  /** The Riverwalk's paths, down on the walk. */
  paths: Ring[];
  attribution: string;
}

export function decodeCity(file: ChicagoCity): CityData {
  const polys = (list: number[][][]) => list.map((poly) => poly.map(decodeRing));
  return {
    buildings: file.buildings.map((b) => ({ ring: decodeRing(b.r), bottom: (b.b ?? 0) / 10, top: b.h / 10, color: BUILDING_COLOURS[b.c] ?? BUILDING_COLOURS[0]!, name: b.n })),
    mouths: file.mouths,
    cut: polys(file.cut),
    walk: polys(file.walk),
    water: polys(file.water),
    pools: file.pools.map(decodeRing),
    decks: file.decks.map((d) => ({ line: decodeRing(d.p), width: d.w, houses: d.h, name: d.n })),
    paths: file.paths.map(decodeRing),
    attribution: file.attribution,
  };
}

/**
 * Fits the buildings to the corridor: a footprint vertex in front of the wall line (a facade standing proud of
 * the street's building line) is pushed back onto it, so no building pokes into the street; a building standing
 * on the road itself (something the converter missed) is dropped. Mutates and returns `city`.
 */
export function fitToCorridor(city: CityData, path: TrackPath, wallFace: (s: number, side: number) => number, reach = 60): CityData {
  const p = { x: 0, z: 0 };
  const t = { x: 0, z: 0 };
  city.buildings = city.buildings.filter((b) => {
    if (b.bottom >= CITY_CONFIG.overhang) return true;
    let onRoad = false;
    b.ring = b.ring.map((v) => {
      // Near a corner the moved point projects onto a slightly different stretch: push again until it holds.
      for (let k = 0; k < 4; k++) {
        const pr = path.project(v.x, v.z);
        if (pr.distance > reach) return v;
        const side = pr.lateral >= 0 ? 1 : -1;
        const face = wallFace(pr.s, side);
        if (pr.distance >= face) return v;
        if (k === 0 && pr.distance < path.halfWidth) onRoad = true;
        path.pointAt(pr.s, p);
        path.tangentAt(pr.s, t);
        const back = face + 0.3;
        v = { x: p.x + t.z * back * side, z: p.z - t.x * back * side };
      }
      return v;
    });
    return !onRoad;
  });
  return city;
}

/** Footprints by grid cell, for point-in-building tests. */
export class FootprintIndex {
  private readonly cells = new Map<string, Building[]>();

  constructor(
    buildings: readonly Building[],
    private readonly cell = CITY_CONFIG.cell,
    maxBottom = CITY_CONFIG.overhang,
  ) {
    for (const b of buildings) {
      // Not raised parts, nor kiosks down on the Riverwalk.
      if (b.bottom >= maxBottom || b.bottom < 0) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of b.ring) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z);
        z1 = Math.max(z1, p.z);
      }
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
        for (let k = Math.floor(z0 / cell); k <= Math.floor(z1 / cell); k++) {
          const key = `${i},${k}`;
          const list = this.cells.get(key);
          if (list) list.push(b);
          else this.cells.set(key, [b]);
        }
      }
    }
  }

  /** The building standing on (x, z), if any. */
  at(x: number, z: number): Building | undefined {
    return this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`)?.find((b) => insideRing(x, z, b.ring));
  }
}

function insideRing(x: number, z: number, ring: readonly { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Splits the corridor's wall into facade, balustrade and barrier: a block with a building right behind it all
 * along becomes a hidden, taller collider (the building's face stops the car); one with the river cut (the
 * river, the Riverwalk) close behind it is a balustrade over the drop (`rail`: hidden, drawn by the city);
 * every other block stays a visible concrete barrier (side streets, alleys, plazas, the far side of junctions).
 */
export function classifyWallBlocks(blocks: readonly WallBlock[], index: FootprintIndex, thickness: number, cut: readonly Ring[][] = [], cfg = CITY_CONFIG): WallBlock[] {
  return blocks.map((b) => {
    // Local +x runs along the block, +z faces the road.
    const ax = Math.cos(b.yaw);
    const az = -Math.sin(b.yaw);
    const back = thickness / 2 + cfg.facadeReach;
    const nx = Math.sin(b.yaw);
    const nz = Math.cos(b.yaw);
    const facade = [-0.3, 0, 0.3].every((f) => index.at(b.x + ax * f * b.length - nx * back, b.z + az * f * b.length - nz * back) !== undefined);
    if (facade) return { ...b, hidden: true, height: cfg.facadeHeight };
    for (let d = thickness / 2 + 0.5; d <= thickness / 2 + cfg.riverReach; d += 1) {
      if (inPolygons(cut, b.x - nx * d, b.z - nz * d)) return { ...b, hidden: true, rail: true };
    }
    return { ...b };
  });
}

/** Flat-shaded building prisms as plain arrays: positions, normals, colours (linear 0..1) and window UVs (in bays and floors). */
export function buildingGeometry(buildings: readonly Building[], cfg = CITY_CONFIG): { positions: Float32Array; normals: Float32Array; colors: Float32Array; uvs: Float32Array } {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, n: [number, number, number], c: [number, number, number], u: number, v: number) => {
    pos.push(x, y, z);
    nor.push(n[0], n[1], n[2]);
    col.push(c[0], c[1], c[2]);
    uv.push(u, v);
  };
  for (const b of buildings) {
    const ring = b.ring;
    if (ring.length < 3) continue;
    const c = srgbToLinear(b.color);
    // Outward normals: the ring is counter-clockwise in (x, z) maths terms, so its inside is left of each edge.
    const area = ring.reduce((a, p, i) => a + p.x * ring[(i + 1) % ring.length]!.z - ring[(i + 1) % ring.length]!.x * p.z, 0);
    const out = area > 0 ? 1 : -1;
    let along = 0;
    const v0 = b.bottom / cfg.floor;
    const v1 = b.top / cfg.floor;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q.x - a.x, q.z - a.z);
      if (len < 1e-3) continue;
      const n: [number, number, number] = [((q.z - a.z) / len) * out, 0, (-(q.x - a.x) / len) * out];
      const u0 = along / cfg.bay;
      const u1 = (along + len) / cfg.bay;
      along += len;
      // Two triangles facing out: (a0, q1, q0) and (a0, a1, q1) for an outward normal on a counter-clockwise ring.
      const [p0, p1] = out > 0 ? [a, q] : [q, a];
      const [w0, w1] = out > 0 ? [u0, u1] : [u1, u0];
      push(p0.x, b.bottom, p0.z, n, c, w0, v0);
      push(p1.x, b.top, p1.z, n, c, w1, v1);
      push(p1.x, b.bottom, p1.z, n, c, w1, v0);
      push(p0.x, b.bottom, p0.z, n, c, w0, v0);
      push(p0.x, b.top, p0.z, n, c, w0, v1);
      push(p1.x, b.top, p1.z, n, c, w1, v1);
    }
    // Flat roof, a little darker; its UV sits on the window frame (no glass).
    const roof: [number, number, number] = [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8];
    const tris = ShapeUtils.triangulateShape(ring.map((p) => new Vector2(p.x, p.z)), []);
    for (const [i, j, k] of tris) {
      let [p, q, r] = [ring[i!]!, ring[j!]!, ring[k!]!];
      // Face up: (q - p) × (r - p) must point +y.
      if ((q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z) < 0) [q, r] = [r, q];
      for (const v of [p, q, r]) push(v.x, b.top, v.z, [0, 1, 0], roof, 0.02, 0.02);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors: new Float32Array(col), uvs: new Float32Array(uv) };
}

function srgbToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}
