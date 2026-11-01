import * as THREE from 'three';
import { TRACK_WALL_CONFIG, type WallBlock } from '../world/TrackWalls';
import type { CityData, Deck } from './City';
import { hexToLinear } from './CityGround';
import { inPolygons, OSM_CONFIG, segmentDistance } from './osm';

type P = { x: number; z: number };

/**
 * The river below the street: the ground at street level with the cut (river + Riverwalk) left open, concrete
 * embankments down to the water, the Riverwalk floor a little above it (lamps, trees, kiosks), road decks and
 * bascule bridges (railings, girders, bridge houses) spanning it, and Wacker's stone balustrade along the drop.
 * Visual only: the corridor walls keep cars on the street, so physics stays flat.
 */
export const RIVER_CONFIG = {
  street: '#8e8d89',
  /** The street-level ground reaches this far (m) from the centre: out past the fog. */
  groundReach: 6000,
  walkLevel: OSM_CONFIG.walkLevel,
  waterLevel: OSM_CONFIG.waterLevel,
  embankment: { top: '#8d887f', foot: '#54554a' },
  walk: '#b3a58d',
  quay: '#7f796e',
  water: '#2c6585',
  poolY: 0.04,
  deck: { asphalt: '#4f5155', y: 0.05, depth: 0.9, steel: '#56676a', girder: 1, inset: 1.4, girderWidth: 0.7 },
  railing: { height: 1.15, posts: 2.4, inset: 0.25, colour: '#2f3a3c' },
  house: { along: 7, across: 5.5, height: 6.5, gap: 1.2, stone: '#d3cbbb', roof: '#5d8a7a', roofHeight: 2.6 },
  lamp: { every: 16, height: 4.2, side: 2.4, colour: '#23282a', glow: '#ffe7a8' },
  tree: { every: 13, side: 4.5, trunk: 2.2, crown: 2.1, leaves: '#4c7a3b', bark: '#5b4636' },
  /** Trees and lamps keep this far (m) off a deck's edge. */
  deckClear: 2,
  balustrade: { height: 1.05, baluster: 0.42, stone: '#d8d0c0', lampEvery: 30 },
};

const CFG = RIVER_CONFIG;

/** (−dz, dx): the normal that points into a ring of positive `ringArea` (and the way `verticalStrip` faces when `towardA`). */
function aNormal(a: P, b: P): P {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
}

function signedArea(ring: readonly P[]): number {
  let a = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.z - q.x * p.z;
  });
  return a / 2;
}

/** Vertical quads along a line (closed: back to the start), from `bottom` up to `top`, facing its A side (or the other). */
export function verticalStrip(line: readonly P[], closed: boolean, top: number, bottom: number, towardA: boolean, out: number[]): void {
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) {
    const a = line[i]!;
    const b = line[(i + 1) % line.length]!;
    if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-4) continue;
    const a0 = [a.x, bottom, a.z], b0 = [b.x, bottom, b.z], b1 = [b.x, top, b.z], a1 = [a.x, top, a.z];
    // (a0, b0, b1) faces the A side.
    if (towardA) out.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
    else out.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1);
  }
}

/** The walls round polygons (outer ring, then holes), facing into the filled area (`inward`) or out of it. */
export function cliffWalls(polys: readonly (readonly P[])[][], top: number, bottom: number, inward: boolean): number[] {
  const out: number[] = [];
  for (const poly of polys) {
    poly.forEach((ring, k) => {
      const intoRing = signedArea(ring) > 0;
      const intoFill = k === 0 ? intoRing : !intoRing;
      verticalStrip(ring, true, top, bottom, intoFill === inward, out);
    });
  }
  return out;
}

/** Flat triangles facing up (or down) at height y over polygons with holes. */
export function flatPolygons(polys: readonly (readonly P[])[][], y: number, up = true, out: number[] = []): number[] {
  for (const poly of polys) {
    const outer = poly[0]!;
    const holes = poly.slice(1);
    const tris = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p.x, p.z)),
      holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z))),
    );
    const all = [...outer, ...holes.flat()];
    for (const [i, j, k] of tris) {
      let [p, q, r] = [all[i!]!, all[j!]!, all[k!]!];
      // Up: (q - p) × (r - p) must point +y.
      if (((q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z) < 0) === up) [q, r] = [r, q];
      out.push(p.x, y, p.z, q.x, y, q.z, r.x, y, r.z);
    }
  }
  return out;
}

/** The line moved `d` m toward its A side (mitred joints). */
export function offsetLine(line: readonly P[], d: number): P[] {
  return line.map((p, i) => {
    const n0 = i > 0 ? aNormal(line[i - 1]!, p) : null;
    const n1 = i < line.length - 1 ? aNormal(p, line[i + 1]!) : null;
    const a = n0 ?? n1!;
    const b = n1 ?? n0!;
    let nx = a.x + b.x;
    let nz = a.z + b.z;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const miter = d / Math.max(0.5, nx * a.x + nz * a.z);
    return { x: p.x + nx * miter, z: p.z + nz * miter };
  });
}

/** Where `s` m along a line is, and which way it runs there. */
export function pointAlong(line: readonly P[], s: number): { x: number; z: number; dx: number; dz: number } {
  let left = s;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    if (left <= len || i === line.length - 2) {
      const t = Math.min(1, Math.max(0, left / len));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
    }
    left -= len;
  }
  const p = line[0]!;
  return { x: p.x, z: p.z, dx: 1, dz: 0 };
}

export function lineLength(line: readonly P[]): number {
  let l = 0;
  for (let i = 1; i < line.length; i++) l += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.z - line[i - 1]!.z);
  return l;
}

/** Positions of every `every` m along a line, `side` m off it toward A, starting half a step in. */
export function placesAlong(line: readonly P[], every: number, side: number): { x: number; z: number; dx: number; dz: number }[] {
  const out: { x: number; z: number; dx: number; dz: number }[] = [];
  const len = lineLength(line);
  for (let s = every / 2; s < len; s += every) {
    const p = pointAlong(line, s);
    out.push({ x: p.x - p.dz * side, z: p.z + p.dx * side, dx: p.dx, dz: p.dz });
  }
  return out;
}

function nearDeck(decks: readonly Deck[], x: number, z: number, clear: number): boolean {
  const p = { x, z };
  return decks.some((d) => d.line.some((a, i) => i > 0 && segmentDistance(p, d.line[i - 1]!, a) < d.width / 2 + clear));
}

function mesh(positions: number[], colour: string | number[], opts: { shadows?: boolean; side?: THREE.Side } = {}): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  let mat: THREE.MeshLambertMaterial;
  if (typeof colour === 'string') mat = new THREE.MeshLambertMaterial({ color: colour, side: opts.side });
  else {
    g.setAttribute('color', new THREE.Float32BufferAttribute(colour, 3));
    mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: opts.side });
  }
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  m.castShadow = opts.shadows ?? false;
  return m;
}

/** Vertex colours fading from `top` (at y 0) to `foot` (at `bottom`) down walls. */
function heightTint(positions: number[], top: string, foot: string, bottom: number): number[] {
  const a = hexToLinear(top);
  const b = hexToLinear(foot);
  const out: number[] = [];
  for (let i = 1; i < positions.length; i += 3) {
    const t = Math.min(1, Math.max(0, positions[i]! / bottom));
    out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }
  return out;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Instanced street lamps (pole and a bright head) standing at `points` (y = their base). */
function lamps(scene: THREE.Scene, points: { x: number; y: number; z: number }[]): void {
  if (points.length === 0) return;
  const l = CFG.lamp;
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, l.height, 6).translate(0, l.height / 2, 0), new THREE.MeshLambertMaterial({ color: l.colour }), points.length);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 8, 6).translate(0, l.height + 0.15, 0), new THREE.MeshBasicMaterial({ color: l.glow }), points.length);
  const m = new THREE.Matrix4();
  points.forEach((p, i) => {
    m.makeTranslation(p.x, p.y, p.z);
    poles.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
  });
  poles.castShadow = true;
  for (const im of [poles, heads]) {
    im.frustumCulled = false;
    scene.add(im);
  }
}

export class River {
  constructor(scene: THREE.Scene, city: CityData) {
    this.buildGround(scene, city);
    this.buildCut(scene, city);
    this.buildDecks(scene, city.decks);
    this.buildWalkLife(scene, city);
  }

  /** Street level everywhere but the cut (its islands too: footprints standing in the river). */
  private buildGround(scene: THREE.Scene, city: CityData): void {
    const r = CFG.groundReach;
    const square: P[] = [{ x: -r, z: -r }, { x: r, z: -r }, { x: r, z: r }, { x: -r, z: r }];
    const pos = flatPolygons([[square, ...city.cut.map((poly) => poly[0]!)]], 0);
    flatPolygons(city.cut.flatMap((poly) => poly.slice(1).map((hole) => [hole])), 0, true, pos);
    scene.add(mesh(pos, CFG.street));
  }

  private buildCut(scene: THREE.Scene, city: CityData): void {
    const bottom = CFG.waterLevel - 0.5;
    const banks = cliffWalls(city.cut, 0, bottom, true);
    scene.add(mesh(banks, heightTint(banks, CFG.embankment.top, CFG.embankment.foot, bottom)));
    scene.add(mesh(flatPolygons(city.walk, CFG.walkLevel), CFG.walk));
    // The walk's edge down to the water (facing out of the walk; along the embankment it faces the wall, unseen).
    scene.add(mesh(cliffWalls(city.walk, CFG.walkLevel, bottom, false), CFG.quay));
    scene.add(mesh(flatPolygons(city.water, CFG.waterLevel), CFG.water));
    if (city.pools.length > 0) scene.add(mesh(flatPolygons(city.pools.map((r) => [r]), CFG.poolY), CFG.water));
  }

  private buildDecks(scene: THREE.Scene, decks: readonly Deck[]): void {
    const d = CFG.deck;
    const top: number[] = [];
    const steel: number[] = [];
    const rails: { a: P; b: P }[] = [];
    const posts: P[] = [];
    const houses: { x: number; z: number; dx: number; dz: number }[] = [];
    for (const deck of decks) {
      const h = deck.width / 2;
      const left = offsetLine(deck.line, h);
      const right = offsetLine(deck.line, -h);
      // Road surface (up) and underside (down), quad by quad.
      for (let i = 0; i + 1 < left.length; i++) {
        const quad = [[left[i]!, left[i + 1]!, right[i + 1]!, right[i]!]];
        // The route's road and sidewalks are drawn by the track and CityGround.
        if (!deck.route) flatPolygons([quad], d.y, true, top);
        flatPolygons([quad], d.y - d.depth, false, steel);
      }
      verticalStrip(left, false, d.y, d.y - d.depth, true, steel);
      verticalStrip(right, false, d.y, d.y - d.depth, false, steel);
      // Two girders under the deck.
      for (const k of [1, -1]) {
        const o = (h - d.inset) * k;
        const a = offsetLine(deck.line, o + d.girderWidth / 2);
        const b = offsetLine(deck.line, o - d.girderWidth / 2);
        verticalStrip(a, false, d.y - d.depth, d.y - d.depth - d.girder, true, steel);
        verticalStrip(b, false, d.y - d.depth, d.y - d.depth - d.girder, false, steel);
        flatPolygons(a.slice(1).map((p, i) => [[a[i]!, p, b[i + 1]!, b[i]!]]), d.y - d.depth - d.girder, false, steel);
      }
      // The route's own bridges: its walls are the balustrades.
      for (const k of deck.route ? [] : [1, -1]) {
        const edge = offsetLine(deck.line, (h - CFG.railing.inset) * k);
        edge.slice(1).forEach((p, i) => rails.push({ a: edge[i]!, b: p }));
        for (const p of placesAlong(edge, CFG.railing.posts, 0)) posts.push(p);
        posts.push(edge[0]!, edge[edge.length - 1]!);
      }
      if (deck.houses) {
        const hc = CFG.house;
        for (const s of deck.houses) {
          const p = pointAlong(deck.line, s);
          for (const k of [1, -1]) {
            const off = (h + hc.gap + hc.across / 2) * k;
            houses.push({ x: p.x - p.dz * off, z: p.z + p.dx * off, dx: p.dx, dz: p.dz });
          }
        }
      }
    }
    scene.add(mesh(top, d.asphalt));
    scene.add(mesh(steel, d.steel, { shadows: true }));
    this.buildRailings(scene, rails, posts);
    this.buildHouses(scene, houses);
  }

  private buildRailings(scene: THREE.Scene, rails: { a: P; b: P }[], posts: P[]): void {
    const r = CFG.railing;
    const mat = new THREE.MeshLambertMaterial({ color: r.colour });
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 0.1), mat, Math.max(1, rails.length * 2));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    rails.forEach(({ a, b }, i) => {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      q.setFromAxisAngle(UP, Math.atan2(-(b.z - a.z), b.x - a.x));
      s.set(len, 1, 1);
      [r.height, r.height * 0.5].forEach((y, k) => {
        m.compose(v.set((a.x + b.x) / 2, CFG.deck.y + y, (a.z + b.z) / 2), q, s);
        bars.setMatrixAt(i * 2 + k, m);
      });
    });
    bars.count = rails.length * 2;
    const uprights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, r.height, 0.12).translate(0, r.height / 2, 0), mat, Math.max(1, posts.length));
    posts.forEach((p, i) => {
      m.makeTranslation(p.x, CFG.deck.y, p.z);
      uprights.setMatrixAt(i, m);
    });
    uprights.count = posts.length;
    for (const im of [bars, uprights]) {
      im.castShadow = true;
      im.frustumCulled = false;
      scene.add(im);
    }
  }

  /** Bridge houses: stone towers on the banks either side of each bascule span, up from the water, with copper roofs. */
  private buildHouses(scene: THREE.Scene, houses: { x: number; z: number; dx: number; dz: number }[]): void {
    if (houses.length === 0) return;
    const hc = CFG.house;
    const rise = hc.height - CFG.waterLevel;
    const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: hc.stone }), houses.length);
    // A four-sided cone turned square to the box: a hipped roof.
    const roofGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    const roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshLambertMaterial({ color: hc.roof, flatShading: true }), houses.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    houses.forEach((h, i) => {
      q.setFromAxisAngle(UP, Math.atan2(-h.dz, h.dx));
      m.compose(v.set(h.x, CFG.waterLevel, h.z), q, s.set(hc.along, rise, hc.across));
      bodies.setMatrixAt(i, m);
      m.compose(v.set(h.x, hc.height, h.z), q, s.set(hc.along * 1.08, hc.roofHeight, hc.across * 1.08));
      roofs.setMatrixAt(i, m);
    });
    for (const im of [bodies, roofs]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      scene.add(im);
    }
  }

  /** Lamps along one side of the Riverwalk's paths, trees along the other, clear of the decks. */
  private buildWalkLife(scene: THREE.Scene, city: CityData): void {
    const ok = (p: P) => inPolygons(city.walk, p.x, p.z) && !nearDeck(city.decks, p.x, p.z, CFG.deckClear);
    const lampAt = city.paths.flatMap((l) => placesAlong(l, CFG.lamp.every, CFG.lamp.side)).filter(ok);
    lamps(scene, lampAt.map((p) => ({ x: p.x, y: CFG.walkLevel, z: p.z })));
    const t = CFG.tree;
    const treeAt = city.paths.flatMap((l) => placesAlong(l, t.every, -t.side)).filter(ok);
    if (treeAt.length === 0) return;
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.22, t.trunk, 5).translate(0, t.trunk / 2, 0), new THREE.MeshLambertMaterial({ color: t.bark }), treeAt.length);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(t.crown, 0).translate(0, t.trunk + t.crown * 0.7, 0), new THREE.MeshLambertMaterial({ color: t.leaves, flatShading: true }), treeAt.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    treeAt.forEach((p, i) => {
      const size = 0.85 + ((i * 7919) % 11) / 11 * 0.35;
      q.setFromAxisAngle(UP, i * 2.4);
      m.compose(v.set(p.x, CFG.walkLevel, p.z), q, s.set(size, size, size));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
    });
    for (const im of [trunks, crowns]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      scene.add(im);
    }
  }
}

/** Wacker's stone balustrade along the river drop, with lamps: drawn over the corridor's `rail` wall blocks (their colliders). */
export class Balustrade {
  constructor(scene: THREE.Scene, blocks: readonly WallBlock[]) {
    if (blocks.length === 0) return;
    const b = CFG.balustrade;
    const mat = new THREE.MeshLambertMaterial({ color: b.stone });
    const plinths = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, TRACK_WALL_CONFIG.thickness).translate(0, 0.15, 0), mat, blocks.length);
    const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.16, 0.45).translate(0, b.height - 0.08, 0), mat, blocks.length);
    const count = blocks.reduce((n, k) => n + Math.max(1, Math.round(k.length / b.baluster)), 0);
    const h = b.height - 0.46;
    const balusters = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.09, h, 6).translate(0, 0.3 + h / 2, 0), mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const lampAt: { x: number; y: number; z: number }[] = [];
    let n = 0;
    let run = 0;
    blocks.forEach((k, i) => {
      q.setFromAxisAngle(UP, k.yaw);
      // Local +x runs along the block.
      const ax = Math.cos(k.yaw);
      const az = -Math.sin(k.yaw);
      m.compose(v.set(k.x, 0, k.z), q, s.set(k.length + 0.05, 1, 1));
      plinths.setMatrixAt(i, m);
      caps.setMatrixAt(i, m);
      const c = Math.max(1, Math.round(k.length / b.baluster));
      for (let j = 0; j < c; j++) {
        const f = ((j + 0.5) / c - 0.5) * k.length;
        m.makeTranslation(k.x + ax * f, 0, k.z + az * f);
        balusters.setMatrixAt(n++, m);
      }
      run += k.length;
      if (run >= b.lampEvery) {
        run = 0;
        lampAt.push({ x: k.x, y: b.height, z: k.z });
      }
    });
    for (const im of [plinths, caps, balusters]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      scene.add(im);
    }
    lamps(scene, lampAt);
  }
}
