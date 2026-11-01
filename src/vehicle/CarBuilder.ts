import * as THREE from 'three';
import { DEFAULT_DIMS, type CarDims, type PartKind } from './CarStats';
import { WHEEL_ORDER, type CarModel, type CarPart } from './CarModel';
import { bakeColors, mergePieces, rng, type Piece, type WeatherOptions } from './carkit/Kit';
import { buildStyle, DEFAULT_KITS, type CarKit, type CarVariant } from './carkit/Styles';

export type { CarKit, CarVariant } from './carkit/Styles';

export interface CarBuildOptions {
  color: THREE.ColorRepresentation;
  variant?: CarVariant;
  dims?: CarDims;
  /** Painted on the doors and the roof sign (0..99). */
  number?: number;
  /** Overrides on the style's default kit. */
  kit?: Partial<CarKit>;
  /** Picks the rust pattern, dead lamps and mismatched panels; defaults to a hash of colour, style and number. */
  seed?: number;
}

/** A car's look as the AI profiles and the player carry it (colour is separate). */
export interface CarLook {
  number?: number;
  kit?: Partial<CarKit>;
}

// Colour lives in the vertices, so two materials serve every car. Debris must never dispose them.
let sharedMats: { body: THREE.MeshStandardMaterial; lamp: THREE.MeshBasicMaterial; withLamps: THREE.Material[] } | null = null;

export function carMaterials() {
  if (!sharedMats) {
    const body = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.78, metalness: 0.18 });
    // Unlit, so head and tail lights glow a little against the sand.
    const lamp = new THREE.MeshBasicMaterial({ vertexColors: true });
    sharedMats = { body, lamp, withLamps: [body, lamp] };
  }
  return sharedMats;
}

/** Odd panels on junkers: primer, red oxide, or a door off another car. */
const PANEL_COLORS = [0x6f706a, 0x7b3526, 0x2f5d8a, 0x8a7b2f, 0x3b6b3b, 0xd8d0b8];

/** Centres geometry on its bounding box, positions the mesh there and registers the part. */
function addPart(
  parts: CarPart[],
  parent: THREE.Object3D,
  kind: PartKind,
  geo: THREE.BufferGeometry,
  mat: THREE.Material | THREE.Material[],
  wheelIndex = -1,
  keepCentre = false,
): THREE.Mesh {
  geo.computeBoundingBox();
  const centre = geo.boundingBox!.getCenter(new THREE.Vector3());
  if (keepCentre) centre.set(0, 0, 0);
  geo.translate(-centre.x, -centre.y, -centre.z);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const halfExtents = geo.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(centre);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  parts.push({ kind, mesh, halfExtents, wheelIndex });
  return mesh;
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function bake(list: Piece[], paint: THREE.Color, weather: WeatherOptions) {
  for (const p of list) bakeColors(p.geo, p.finish, paint, weather);
  const { geo, lamps } = mergePieces(list);
  const m = carMaterials();
  return { geo, mat: lamps ? m.withLamps : m.body };
}

const PART_ORDER: Exclude<PartKind, 'wheel'>[] = ['body', 'cabin', 'hood', 'bumperFront', 'bumperRear', 'doorLeft', 'doorRight', 'wing'];

export function buildCarModel(opts: CarBuildOptions): CarModel {
  const variant = opts.variant ?? 'sedan';
  const d = opts.dims ?? DEFAULT_DIMS;
  const kit: CarKit = { ...DEFAULT_KITS[variant], ...opts.kit };
  const num = opts.number ?? 0;
  const color = new THREE.Color(opts.color);
  const seed = opts.seed ?? hashSeed(`${color.getHexString()}|${variant}|${num}`);
  const rand = rng(seed);
  const style = buildStyle(variant, d, kit, num, rand);
  const root = new THREE.Group();
  const parts: CarPart[] = [];

  const arches = WHEEL_ORDER.map((id) => new THREE.Vector3(id[1] === 'L' ? d.wheelX : -d.wheelX, d.wheelY, id[0] === 'F' ? d.wheelZ : -d.wheelZ));
  const weather: WeatherOptions = { rust: kit.rust, seed, sillY: -(d.halfHeight - 0.04), arches };
  for (const kind of PART_ORDER) {
    const list = style.parts[kind];
    if (!list) continue;
    let paint = color;
    if ((kind === 'hood' || kind === 'doorLeft' || kind === 'doorRight') && rand() < 0.6 * kit.rust) {
      paint = new THREE.Color(PANEL_COLORS[Math.floor(rand() * PANEL_COLORS.length)]!);
    }
    const { geo, mat } = bake(list, paint, weather);
    addPart(parts, root, kind, geo, mat);
  }

  const wheel = bake(style.wheel, color, { ...weather, sillY: -10, arches: [] });
  const wheelPivots: THREE.Object3D[] = [];
  WHEEL_ORDER.forEach((id, i) => {
    const pivot = new THREE.Object3D();
    pivot.name = `wheel${id}`;
    pivot.position.copy(arches[i]!);
    root.add(pivot);
    wheelPivots.push(pivot);
    addPart(parts, pivot, 'wheel', i === 0 ? wheel.geo : wheel.geo.clone(), wheel.mat, i, true);
  });

  return { root, parts, wheelPivots };
}
