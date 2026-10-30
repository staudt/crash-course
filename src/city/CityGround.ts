import * as THREE from 'three';
import type { TrackPath } from '../race/TrackPath';
import { TRACK_WALL_CONFIG, wallLaterals } from '../world/TrackWalls';
import type { CityData } from './City';

export const CITY_GROUND_CONFIG = {
  sidewalk: { colour: '#b8b4ac', variation: 0.04, y: 0.1, gapFromShoulder: 1.2 },
  curb: { colour: '#d9d6cf', width: 0.35, y: 0.13 },
  asphalt: '#55575b',
  /** Metres either side of a bend's span where the outside of the ribbon is junction roadway. */
  junctionMargin: 6,
  mouth: { y: 0.11, minWidth: 4, maxWidth: 20, backOff: 1 },
  /** Decal-style depth bias, like the road markings. */
  offset: { factor: -2, units: -2 },
  barricade: { minWidth: 6, setback: 3, maxWidth: 5, boardHeight: 0.3, boardY: 0.85, legHeight: 1.0, legSize: 0.07, stripe: '#e8731a' },
  sign: { pole: 3.2, poleRadius: 0.05, side: 1, setback: 1.5, width: 1.5, height: 0.45, poleColour: '#7d8084', bg: '#1d6b43' },
};

const CFG = CITY_GROUND_CONFIG;

export interface SidewalkRibbon {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** Hex colour to linear 0..1 (what vertex colours expect under three's colour management). */
export function hexToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}

/** True when the sample at s lies in the junction roadway on `side`: the outside of a bend, within the margin of its span. */
export function isJunctionRoad(path: TrackPath, s: number, side: number, margin = CFG.junctionMargin): boolean {
  for (const b of path.bends) {
    if (b.turn * side >= 0) continue;
    if (path.wrap(s - (b.start - margin)) <= b.end - b.start + 2 * margin) return true;
  }
  return false;
}

/**
 * Pure: the sidewalk as a vertex-coloured ribbon, curb to wall face, both sides. Four vertices per path
 * sample (left curb, left wall, right curb, right wall: `i * 4 + (side < 0 ? 2 : 0) + (wall ? 1 : 0)`).
 * Junction roadway quads are asphalt-coloured.
 */
export function sidewalkRibbon(path: TrackPath): SidewalkRibbon {
  const lateralAt = wallLaterals(path);
  if (!lateralAt) throw new Error('sidewalkRibbon needs a walled track');
  const n = path.count;
  const curb = path.halfWidth + CFG.sidewalk.gapFromShoulder;
  const base = hexToLinear(CFG.sidewalk.colour);
  const asphalt = hexToLinear(CFG.asphalt);
  const positions = new Float32Array(n * 4 * 3);
  const colors = new Float32Array(n * 4 * 3);
  const road: boolean[][] = [[], []];
  for (let i = 0; i < n; i++) {
    const s = i * path.step;
    const nx = path.tzs[i]!;
    const nz = -path.txs[i]!;
    const shade = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * CFG.sidewalk.variation;
    [1, -1].forEach((side, k) => {
      const wall = Math.max(curb + 0.5, lateralAt(s, side) - TRACK_WALL_CONFIG.thickness / 2);
      const junction = isJunctionRoad(path, s, side);
      road[k]![i] = junction;
      for (let w = 0; w < 2; w++) {
        const d = side * (w === 0 ? curb : wall);
        const o = (i * 4 + k * 2 + w) * 3;
        positions[o] = path.xs[i]! + nx * d;
        positions[o + 1] = CFG.sidewalk.y;
        positions[o + 2] = path.zs[i]! + nz * d;
        const c = junction ? asphalt : base;
        const m = junction ? 1 : shade;
        colors[o] = c[0] * m;
        colors[o + 1] = c[1] * m;
        colors[o + 2] = c[2] * m;
      }
    });
  }
  const indices = new Uint32Array(n * 2 * 6);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k < 2; k++) {
      const a = i * 4 + k * 2, c = a + 1, b = j * 4 + k * 2, d = b + 1;
      if (k === 0) { indices[o++] = a; indices[o++] = b; indices[o++] = c; indices[o++] = c; indices[o++] = b; indices[o++] = d; }
      else { indices[o++] = a; indices[o++] = c; indices[o++] = b; indices[o++] = c; indices[o++] = d; indices[o++] = b; }
    }
  }
  return { positions, colors, indices };
}

/** Pure: the raised curb strip along both road edges as triangles (skipped where the outside is junction roadway). */
export function curbStrip(path: TrackPath): { positions: Float32Array; indices: Uint32Array } {
  const n = path.count;
  const inner = path.halfWidth + CFG.sidewalk.gapFromShoulder;
  const outer = inner + CFG.curb.width;
  const positions = new Float32Array(n * 4 * 3);
  for (let i = 0; i < n; i++) {
    const nx = path.tzs[i]!;
    const nz = -path.txs[i]!;
    [1, -1].forEach((side, k) => {
      [inner, outer].forEach((d, w) => {
        const o = (i * 4 + k * 2 + w) * 3;
        positions[o] = path.xs[i]! + nx * d * side;
        positions[o + 1] = CFG.curb.y;
        positions[o + 2] = path.zs[i]! + nz * d * side;
      });
    });
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const s0 = i * path.step;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      if (isJunctionRoad(path, s0, side) || isJunctionRoad(path, s0 + path.step, side)) continue;
      const a = i * 4 + k * 2, c = a + 1, b = j * 4 + k * 2, d = b + 1;
      if (k === 0) idx.push(a, b, c, c, b, d);
      else idx.push(a, c, b, c, d, b);
    }
  }
  return { positions, indices: new Uint32Array(idx) };
}

/** "WEST MADISON STREET" becomes "MADISON ST". */
export function signText(name: string): string {
  const words = name.toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length > 2 && /^(N|S|E|W|NORTH|SOUTH|EAST|WEST)$/.test(words[0]!)) words.shift();
  const last = words.length - 1;
  const abbr: Record<string, string> = { STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR' };
  if (last > 0 && abbr[words[last]!]) words[last] = abbr[words[last]!]!;
  return words.join(' ');
}

function toGeometry(positions: Float32Array, indices: Uint32Array, colors?: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}

function decalMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: CFG.offset.factor, polygonOffsetUnits: CFG.offset.units });
}

/** Sidewalks, curbs, side streets, barricades and street signs round a street circuit (the river: `River`). */
export class CityGround {
  constructor(scene: THREE.Scene, path: TrackPath, city: CityData) {
    this.buildSidewalks(scene, path);
    this.buildMouths(scene, city);
    this.buildBarricades(scene, city);
    this.buildSigns(scene, city);
  }

  private buildSidewalks(scene: THREE.Scene, path: TrackPath): void {
    const r = sidewalkRibbon(path);
    const walk = new THREE.Mesh(toGeometry(r.positions, r.indices, r.colors), decalMaterial());
    walk.receiveShadow = true;
    scene.add(walk);

    const c = curbStrip(path);
    const col = new Float32Array((c.positions.length / 3) * 3);
    const lin = hexToLinear(CFG.curb.colour);
    for (let i = 0; i < col.length; i += 3) col.set(lin, i);
    const curb = new THREE.Mesh(toGeometry(c.positions, c.indices, col), decalMaterial());
    curb.material.polygonOffsetFactor = CFG.offset.factor * 2;
    curb.receiveShadow = true;
    scene.add(curb);
  }

  private buildMouths(scene: THREE.Scene, city: CityData): void {
    const pos: number[] = [];
    const idx: number[] = [];
    const m = CFG.mouth;
    for (const mouth of city.mouths) {
      const w = Math.min(m.maxWidth, Math.max(m.minWidth, mouth.width)) / 2;
      const px = -mouth.dz * w;
      const pz = mouth.dx * w;
      const x0 = mouth.x - mouth.dx * m.backOff;
      const z0 = mouth.z - mouth.dz * m.backOff;
      // Up to the river cut, if the street runs into it (a bridge carries on from there).
      const x1 = mouth.x + mouth.dx * mouth.reach;
      const z1 = mouth.z + mouth.dz * mouth.reach;
      const o = pos.length / 3;
      pos.push(x0 + px, m.y, z0 + pz, x0 - px, m.y, z0 - pz, x1 + px, m.y, z1 + pz, x1 - px, m.y, z1 - pz);
      // (a, c, b) faces up whatever the direction.
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
    if (pos.length === 0) return;
    const col = new Float32Array(pos.length);
    const lin = hexToLinear(CFG.asphalt);
    for (let i = 0; i < col.length; i += 3) col.set(lin, i);
    const mesh = new THREE.Mesh(toGeometry(new Float32Array(pos), new Uint32Array(idx), col), decalMaterial());
    mesh.material.polygonOffsetFactor = CFG.offset.factor * 3;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  private buildBarricades(scene: THREE.Scene, city: CityData): void {
    const b = CFG.barricade;
    const list = city.mouths.filter((m) => m.width >= b.minWidth);
    if (list.length === 0) return;

    const tex = stripeTexture();
    const boardMat = new THREE.MeshLambertMaterial({ map: tex });
    const legMat = new THREE.MeshLambertMaterial({ color: '#e8e8e8' });
    const boards = new THREE.InstancedMesh(new THREE.BoxGeometry(1, b.boardHeight, 0.06), boardMat, list.length);
    // An A-frame: two boxes leaning together, apex at the top.
    const frame = new THREE.BoxGeometry(b.legSize, b.legHeight, b.legSize);
    const legGeoms = [-1, 1].map((k) => frame.clone().rotateZ(k * 0.2).translate(0, b.legHeight / 2, k * 0.0));
    legGeoms[0]!.translate(0, 0, -0.25);
    legGeoms[1]!.translate(0, 0, 0.25);
    const legs = new THREE.InstancedMesh(mergeGeoms(legGeoms), legMat, list.length * 2);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((mouth, i) => {
      const width = Math.min(mouth.width - 1, b.maxWidth);
      const x = mouth.x + mouth.dx * b.setback;
      const z = mouth.z + mouth.dz * b.setback;
      // Local +z faces the route.
      q.setFromAxisAngle(up, Math.atan2(-mouth.dx, -mouth.dz));
      m4.compose(new THREE.Vector3(x, b.boardY, z), q, new THREE.Vector3(width, 1, 1));
      boards.setMatrixAt(i, m4);
      for (const k of [-1, 1]) {
        const px = x + (-mouth.dz) * k * (width / 2 - 0.3);
        const pz = z + mouth.dx * k * (width / 2 - 0.3);
        m4.compose(new THREE.Vector3(px, 0, pz), q, new THREE.Vector3(1, 1, 1));
        legs.setMatrixAt(i * 2 + (k + 1) / 2, m4);
      }
    });
    for (const mesh of [boards, legs]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  private buildSigns(scene: THREE.Scene, city: CityData): void {
    const s = CFG.sign;
    const list = city.mouths.filter((m) => m.name !== '' && m.name !== 'Alley');
    if (list.length === 0) return;
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(s.poleRadius, s.poleRadius, s.pole, 6).translate(0, s.pole / 2, 0), new THREE.MeshLambertMaterial({ color: s.poleColour }), list.length);
    const plate = new THREE.PlaneGeometry(s.width, s.height);
    const mats = new Map<string, THREE.MeshLambertMaterial>();
    // The text reads from the route only; from the side street the plate's back is plain green (not mirrored text).
    const back = new THREE.MeshLambertMaterial({ color: s.bg });
    const m4 = new THREE.Matrix4();
    list.forEach((mouth, i) => {
      const x = mouth.x + mouth.dx * s.setback - mouth.dz * s.side;
      const z = mouth.z + mouth.dz * s.setback + mouth.dx * s.side;
      m4.makeTranslation(x, 0, z);
      poles.setMatrixAt(i, m4);
      const text = signText(mouth.name);
      let mat = mats.get(text);
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({ map: signTexture(text) });
        mats.set(text, mat);
      }
      const mesh = new THREE.Mesh(plate, mat);
      mesh.position.set(x, s.pole - s.height / 2 - 0.1, z);
      mesh.rotation.y = Math.atan2(-mouth.dx, -mouth.dz);
      mesh.castShadow = true;
      const rear = new THREE.Mesh(plate, back);
      rear.rotation.y = Math.PI;
      mesh.add(rear);
      scene.add(mesh);
    });
    poles.castShadow = true;
    poles.frustumCulled = false;
    scene.add(poles);
  }
}

function mergeGeoms(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const g of list) {
    const o = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    for (const i of g.getIndex()!.array) idx.push(o + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = CFG.barricade.stripe;
  for (let x = -32; x < 160; x += 32) {
    g.beginPath();
    g.moveTo(x, 32);
    g.lineTo(x + 16, 32);
    g.lineTo(x + 48, 0);
    g.lineTo(x + 32, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.fillStyle = CFG.sign.bg;
  g.fillRect(0, 0, 256, 80);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 4;
  g.strokeRect(4, 4, 248, 72);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 40;
  g.font = `bold ${size}px sans-serif`;
  while (g.measureText(text).width > 230 && size > 12) {
    size -= 2;
    g.font = `bold ${size}px sans-serif`;
  }
  g.fillText(text, 128, 42);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
