import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Building blocks for the junkyard car meshes. Every piece is plain indexed geometry in the car's
 * root-local space (+Z forward, +X left) tagged with a finish; CarBuilder bakes finish + weathering
 * into vertex colours and merges a part's pieces into one mesh, so details dent and fly off with it.
 */

export type Finish =
  | 'paint' | 'primer' | 'steel' | 'darkSteel' | 'chrome' | 'rust' | 'rubber' | 'trim'
  | 'glass' | 'sign' | 'ink' | 'wood' | 'lamp' | 'lampDead' | 'tail';

/** A finish per piece, or per vertex (position, normal) for pieces that mix them. */
export type FinishFn = Finish | ((p: THREE.Vector3, n: THREE.Vector3) => Finish);

export interface Piece {
  geo: THREE.BufferGeometry;
  finish: FinishFn;
}

/** Lit with the unlit lamp material instead of the body one. */
export const LAMP_FINISHES: ReadonlySet<Finish> = new Set(['lamp', 'tail']);

export const FINISH_COLORS: Record<Exclude<Finish, 'paint'>, number> = {
  primer: 0x6f706a,
  steel: 0x5d6063,
  darkSteel: 0x2f3134,
  chrome: 0x9ea2a6,
  rust: 0x6b3a22,
  rubber: 0x1c1c1c,
  trim: 0x222324,
  glass: 0x1f2a38,
  sign: 0xe6e0cc,
  ink: 0x141414,
  wood: 0x6e4a2a,
  lamp: 0xfff0c0,
  lampDead: 0x3b3b36,
  tail: 0xd0221a,
};

/** How much rust and grime each finish takes (glass and lamps stay clean-ish, tyres only get dust). */
export const WEATHERING: Record<Finish, number> = {
  paint: 1, primer: 0.85, steel: 0.9, darkSteel: 0.6, chrome: 0.5, rust: 0, rubber: 0, trim: 0.3,
  glass: 0, sign: 0.6, ink: 0.3, wood: 0.4, lamp: 0, lampDead: 0, tail: 0,
};

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rewrites every vertex of `geo` in place. */
export function mapVerts(geo: THREE.BufferGeometry, fn: (v: THREE.Vector3) => void): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
}

export function box(w: number, h: number, l: number, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, l, sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/** A simple box (one segment per side) centred at (x, y, z). */
export function block(w: number, h: number, l: number, x = 0, y = 0, z = 0) {
  return box(w, h, l, 1, 1, 1, x, y, z);
}

const _up = new THREE.Vector3(0, 1, 0);

/** A bar from a to b (a low-poly cylinder; flat shading makes it read as square tube). */
export function tube(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, sides = 6): THREE.BufferGeometry {
  const from = new THREE.Vector3().copy(a);
  const dir = new THREE.Vector3().copy(b).sub(from);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, sides, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, dir.normalize()));
  g.translate(from.x + (b.x - from.x) / 2, from.y + (b.y - from.y) / 2, from.z + (b.z - from.z) / 2);
  return g;
}

/** A disc of radius r and thickness t facing `axis`, centred at (x, y, z). */
export function disc(r: number, t: number, axis: 'x' | 'y' | 'z', x: number, y: number, z: number, sides = 10) {
  const g = new THREE.CylinderGeometry(r, r, t, sides, 1);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** A spike pointing along +Z (sgn 1) or -Z (sgn -1) with its base at z. */
export function spike(r: number, len: number, x: number, y: number, z: number, sgn = 1) {
  const g = new THREE.ConeGeometry(r, len, 4, 1);
  g.rotateX((sgn * Math.PI) / 2);
  g.translate(x, y, z + (sgn * len) / 2);
  return g;
}

/** A one-sided quad (outward normal +Z before `face`): from inside the cabin it is culled, so glass never blocks the view. */
export function pane(w: number, h: number, segW = 2, segH = 1): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h, segW, segH);
}

/** Upper half of a ring in the car's YZ plane (a wheel-arch lip) round (x, y, z), squashed vertically by `squash`. */
export function archLip(radius: number, thick: number, x: number, y: number, z: number, squash = 0.8) {
  const g = new THREE.TorusGeometry(radius, thick, 3, 9, Math.PI);
  g.rotateY(Math.PI / 2);
  g.scale(1, squash, 1);
  g.translate(x, y, z);
  return g;
}

/** Rivets: tiny cubes at each point. */
export function rivets(points: THREE.Vector3Like[], size = 0.025): THREE.BufferGeometry[] {
  return points.map((p) => block(size, size, size, p.x, p.y, p.z));
}

// Seven-segment digits: a top, b top-right, c bottom-right, d bottom, e bottom-left, f top-left, g middle.
const SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abfgcd'];

/**
 * A number painted in blocky segments, in the XY plane facing +Z (reads correctly from +Z),
 * centred on the origin, `h` tall and `t` thick. Rotate about Y by θ to face direction θ.
 */
export function numberGeo(n: number, h: number, t: number): THREE.BufferGeometry[] {
  const text = String(Math.max(0, Math.floor(n)) % 100);
  const w = 0.52 * h;
  const s = 0.15 * h;
  const gap = 0.22 * h;
  const total = text.length * w + (text.length - 1) * gap;
  const out: THREE.BufferGeometry[] = [];
  [...text].forEach((ch, i) => {
    const cx = -total / 2 + w / 2 + i * (w + gap);
    for (const seg of SEGMENTS[Number(ch)]!) {
      const horiz = seg === 'a' || seg === 'g' || seg === 'd';
      const y = seg === 'a' ? h / 2 - s / 2 : seg === 'd' ? -h / 2 + s / 2 : seg === 'g' ? 0 : seg === 'b' || seg === 'f' ? h / 4 : -h / 4;
      const x = horiz ? 0 : seg === 'b' || seg === 'c' ? w / 2 - s / 2 : -w / 2 + s / 2;
      // Verticals are a hair shorter so the joints look hand-painted rather than drawn.
      out.push(horiz ? block(w, s, t, cx + x, y, 0) : block(s, h / 2 - s * 0.2, t, cx + x, y, 0));
    }
  });
  return out;
}

/** Pieces sharing one finish. */
export function pieces(finish: FinishFn, ...geos: THREE.BufferGeometry[]): Piece[] {
  return geos.map((geo) => ({ geo, finish }));
}

/** Applies fn to each piece's geometry (a shared warp, e.g. the cabin's rake). */
export function warp(list: Piece[], fn: (v: THREE.Vector3) => void): Piece[] {
  for (const p of list) mapVerts(p.geo, fn);
  return list;
}

/** Smooth noise in about [-1, 1], ~0.4-0.9 m features: position-based, so patches span neighbouring vertices and parts. */
export function grimeNoise(x: number, y: number, z: number, seed: number): number {
  const s = seed * 0.000173;
  return (
    0.5 * Math.sin(x * 4.7 + z * 1.9 + s * 7.1) * Math.sin(z * 3.9 - y * 5.3 + s * 3.3) +
    0.3 * Math.sin(x * 9.1 - y * 7.7 + z * 2.3 + s * 11.9) +
    0.2 * Math.sin(z * 11.3 + y * 9.4 - s * 5.7)
  );
}

const RUST_DARK = new THREE.Color(0x3e1e0f);
const RUST_LIGHT = new THREE.Color(0x9a5426);
const DUST = new THREE.Color(0xa88458);

export interface WeatherOptions {
  /** 0 = clean .. 1 = rotten. */
  rust: number;
  seed: number;
  /** Root-local y of the sills (where the grime is thickest). */
  sillY: number;
  /** Wheel centres in root space (rust gathers round the arches); empty for wheels themselves. */
  arches: THREE.Vector3[];
}

const _c = new THREE.Color();
const _g = new THREE.Color();

/** Weathers one vertex colour in place: rust patches (low down and round the arches), grime, dust, fading. */
export function weatherColor(c: THREE.Color, p: THREE.Vector3, finish: Finish, o: WeatherOptions): void {
  const w = WEATHERING[finish];
  const low = THREE.MathUtils.clamp((o.sillY + 0.38 - p.y) / 0.45, 0, 1);
  let arch = 0;
  for (const a of o.arches) {
    const d = Math.hypot(p.y - a.y, p.z - a.z);
    arch = Math.max(arch, 1 - Math.abs(d - 0.5) / 0.25);
  }
  if (w > 0 && o.rust > 0) {
    const n = grimeNoise(p.x, p.y, p.z, o.seed) * 0.5 + 0.5;
    const score = n + 0.35 * low + 0.3 * Math.max(0, arch);
    const from = 1.2 - 0.75 * o.rust;
    const m = THREE.MathUtils.smoothstep(score, from, from + 0.12) * w;
    if (m > 0) {
      const tone = grimeNoise(p.z * 2.1, p.x * 1.7, p.y * 2.9, o.seed + 77) * 0.5 + 0.5;
      _c.copy(RUST_DARK).lerp(RUST_LIGHT, tone);
      c.lerp(_c, m);
    }
    // Sun-faded paint: a little desaturation.
    const lum = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    c.lerp(_g.setRGB(lum, lum, lum), 0.22 * o.rust * w);
  }
  // Dust and grime gather low down on everything but the lamps.
  if (!LAMP_FINISHES.has(finish)) {
    c.lerp(DUST, 0.18 * low * (0.4 + o.rust));
    c.multiplyScalar(1 - 0.25 * low * o.rust);
  }
}

/** Bakes a finish (with weathering) into a `color` attribute. `paint` is the panel's colour. */
export function bakeColors(geo: THREE.BufferGeometry, finish: FinishFn, paint: THREE.Color, o: WeatherOptions): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    const f = typeof finish === 'function' ? finish(p, n) : finish;
    if (f === 'paint') c.copy(paint);
    else c.setHex(FINISH_COLORS[f]);
    weatherColor(c, p, f, o);
    c.toArray(col, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** The finish a piece starts with (for grouping into body vs lamp). A per-vertex finish counts as body. */
export function isLamp(p: Piece): boolean {
  return typeof p.finish === 'string' && LAMP_FINISHES.has(p.finish);
}

/** Merges baked pieces: body pieces first (group 0), lamps after (group 1, only if any). */
export function mergePieces(list: Piece[]): { geo: THREE.BufferGeometry; lamps: boolean } {
  const clean = (g: THREE.BufferGeometry) => {
    g.deleteAttribute('uv');
    g.deleteAttribute('uv1');
    g.clearGroups();
    return g;
  };
  const body = list.filter((p) => !isLamp(p)).map((p) => clean(p.geo));
  const lamp = list.filter(isLamp).map((p) => clean(p.geo));
  const bodyGeo = body.length === 1 ? body[0]! : mergeGeometries(body)!;
  if (lamp.length === 0) return { geo: bodyGeo, lamps: false };
  return { geo: mergeGeometries([bodyGeo, mergeGeometries(lamp)!], true)!, lamps: true };
}
