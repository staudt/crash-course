import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEFAULT_DIMS, type CarDims, type PartKind } from './CarStats';
import { WHEEL_ORDER, type CarModel, type CarPart } from './CarModel';

export type CarVariant = 'sedan' | 'pickup';

export interface CarBuildOptions {
  color: THREE.ColorRepresentation;
  variant?: CarVariant;
  dims?: CarDims;
}

// Materials are cached and shared between cars: Debris must never dispose them.
const paintMats = new Map<number, THREE.MeshStandardMaterial>();
let sharedMats: {
  bumper: THREE.MeshStandardMaterial;
  cabin: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
  hub: THREE.MeshStandardMaterial;
} | null = null;

function std(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.55,
    metalness: 0.15,
    ...extra,
  });
}

function getPaint(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  const key = new THREE.Color(color).getHex();
  let m = paintMats.get(key);
  if (!m) {
    m = std(key);
    paintMats.set(key, m);
  }
  return m;
}

function getShared() {
  sharedMats ??= {
    bumper: std(0x2b2b2b, { roughness: 0.7 }),
    // Paint is baked into the cabin's vertex colours, so one material serves every car.
    cabin: std(0xffffff, { vertexColors: true }),
    tyre: std(0x1c1c1c, { roughness: 0.9, metalness: 0 }),
    hub: std(0x9a9a9a, { metalness: 0.5 }),
  };
  return sharedMats;
}

const GLASS = new THREE.Color('#1f2a38');

/** Rewrites every vertex of `geo` in place. */
function mapVerts(geo: THREE.BufferGeometry, fn: (v: THREE.Vector3) => void): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
}

function box(w: number, h: number, l: number, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, l, sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

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

function buildHull(variant: CarVariant, d: CarDims): THREE.BufferGeometry {
  const hh = d.halfHeight - 0.04;
  const hw = d.halfWidth;
  const hl = d.halfLength;
  const hull = box(hw * 2, hh * 2, hl * 2, 8, 4, 16);
  const archX = d.wheelX - d.wheelWidth / 2 - 0.03;
  const archZ = d.wheelRadius + 0.08;
  mapVerts(hull, (v) => {
    const t = (v.y + hh) / (2 * hh); // 0 bottom .. 1 top
    v.x *= 1 - 0.08 * t;
    const az = Math.abs(v.z);
    // Nose and tail: rounded plan-view corners and lowered top edge.
    const end = Math.max(0, (az - (hl - 0.5)) / 0.5);
    if (end > 0) {
      const edge = Math.abs(v.x) / hw;
      v.z -= Math.sign(v.z) * 0.18 * edge * edge * end;
      if (t > 0.9 && (variant === 'sedan' || v.z > 0)) v.y -= 0.07 * end;
      if (t < 0.1) v.y += 0.06 * end;
    }
    // Wheel-arch cut: hull is narrowed so the wheels stay visible.
    if (v.y < 0.2 && Math.abs(az - d.wheelZ) < archZ && Math.abs(v.x) > archX) {
      v.x = Math.sign(v.x) * archX;
    }
  });
  if (variant === 'sedan') return hull;

  // Pickup bed walls, merged into the body mesh.
  const wallY = hh + 0.15;
  return mergeGeometries([
    hull,
    box(0.08, 0.3, 1.45, 1, 3, 6, hw * 0.88, wallY, -1.3),
    box(0.08, 0.3, 1.45, 1, 3, 6, -hw * 0.88, wallY, -1.3),
    box(hw * 1.8, 0.3, 0.08, 6, 3, 1, 0, wallY, -hl + 0.08),
    box(hw * 1.8, 0.36, 0.08, 6, 3, 1, 0, hh + 0.18, -0.62),
  ])!;
}

function buildCabin(variant: CarVariant, d: CarDims, paint: THREE.Color): THREE.BufferGeometry {
  const hh = d.halfHeight - 0.04;
  const sedan = variant === 'sedan';
  const w = sedan ? 1.62 : 1.6;
  const h = sedan ? 0.55 : 0.52;
  const len = sedan ? 2.0 : 1.4;
  const cz = sedan ? -0.25 : 0.25;
  const frontRake = sedan ? 0.42 : 0.38;
  const rearRake = sedan ? 0.32 : 0.06;
  const g = new THREE.BoxGeometry(w, h, len, 6, 8, 10);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) / (w / 2));
    const v = pos.getY(i) / h + 0.5;
    const s = pos.getZ(i) / (len / 2);
    const band = v >= 0.25 - 1e-4 && v <= 0.875 + 1e-4;
    let glass = false;
    if (Math.abs(nrm.getX(i)) > 0.5) glass = band && Math.abs(s) <= 0.8 + 1e-4;
    else if (Math.abs(nrm.getZ(i)) > 0.5) glass = band && Math.abs(u) <= 0.7;
    c.copy(glass ? GLASS : paint).toArray(col, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  mapVerts(g, (p) => {
    const t = p.y / h + 0.5;
    p.x *= 1 - 0.12 * t;
    p.z -= Math.sign(p.z) * (p.z > 0 ? frontRake : rearRake) * t * (Math.abs(p.z) / (len / 2));
  });
  g.translate(0, hh - 0.02 + h / 2, cz);
  return g;
}

function buildHood(variant: CarVariant, d: CarDims): THREE.BufferGeometry {
  const hh = d.halfHeight - 0.04;
  const z0 = variant === 'sedan' ? 0.75 : 1.0;
  const z1 = d.halfLength - 0.1;
  const hw = d.halfWidth - 0.1;
  const g = box(hw * 2, 0.1, z1 - z0, 6, 1, 5, 0, hh + 0.03, (z0 + z1) / 2);
  mapVerts(g, (v) => {
    const top = v.y > hh + 0.03;
    const k = Math.abs(v.x) / hw;
    v.x *= 1 - 0.05 * (v.y - hh) * 10;
    if (top) v.y += 0.06 * (1 - k * k);
    v.y -= 0.06 * (v.z - z0) / (z1 - z0);
  });
  return g;
}

function buildBumper(front: boolean, d: CarDims): THREE.BufferGeometry {
  const hw = d.halfWidth - 0.03;
  const depth = 0.32;
  const sgn = front ? 1 : -1;
  const g = box(hw * 2, 0.3, depth, 8, 2, 2, 0, -0.08, sgn * (d.halfLength + 0.12 - depth / 2));
  mapVerts(g, (v) => {
    const e = Math.max(0, (Math.abs(v.x) - hw * 0.7) / (hw * 0.3));
    v.z -= sgn * 0.12 * e * e * Math.max(0, sgn * (v.z - sgn * (d.halfLength - 0.1)) > 0 ? 1 : 0.3);
  });
  return g;
}

function buildDoor(left: boolean, d: CarDims): THREE.BufferGeometry {
  const hh = d.halfHeight - 0.04;
  const x = (d.halfWidth - 0.02) * (left ? 1 : -1);
  const g = box(0.06, hh * 1.4, 1.4, 1, 4, 6, x, -0.02, 0.15);
  mapVerts(g, (v) => {
    const k = Math.abs(v.z - 0.15) / 0.7;
    v.x -= Math.sign(x) * 0.015 * k * k;
  });
  return g;
}

function buildWheel(d: CarDims): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(d.wheelRadius, d.wheelRadius, d.wheelWidth, 12, 1);
  g.rotateZ(Math.PI / 2);
  return g;
}

export function buildCarModel(opts: CarBuildOptions): CarModel {
  const variant = opts.variant ?? 'sedan';
  const d = opts.dims ?? DEFAULT_DIMS;
  const paint = getPaint(opts.color);
  const shared = getShared();
  const root = new THREE.Group();
  const parts: CarPart[] = [];

  addPart(parts, root, 'body', buildHull(variant, d), paint);
  addPart(parts, root, 'cabin', buildCabin(variant, d, paint.color), shared.cabin);
  addPart(parts, root, 'hood', buildHood(variant, d), paint);
  addPart(parts, root, 'bumperFront', buildBumper(true, d), shared.bumper);
  addPart(parts, root, 'bumperRear', buildBumper(false, d), shared.bumper);
  addPart(parts, root, 'doorLeft', buildDoor(true, d), paint);
  addPart(parts, root, 'doorRight', buildDoor(false, d), paint);

  const wheelPivots: THREE.Object3D[] = [];
  WHEEL_ORDER.forEach((id, i) => {
    const pivot = new THREE.Object3D();
    pivot.name = `wheel${id}`;
    pivot.position.set(id[1] === 'L' ? d.wheelX : -d.wheelX, d.wheelY, id[0] === 'F' ? d.wheelZ : -d.wheelZ);
    root.add(pivot);
    wheelPivots.push(pivot);
    // Cylinder groups: side, top cap, bottom cap. Both caps get the lighter hub material.
    addPart(parts, pivot, 'wheel', buildWheel(d), [shared.tyre, shared.hub, shared.hub], i, true);
  });

  return { root, parts, wheelPivots };
}
