import * as THREE from 'three';
import { RAPIER, type Physics } from '../core/Physics';
import type { Terrain } from './Terrain';

const CONFIG = {
  variants: 6,
  keepOut: 38,
  maxRadius: 820,
  lines: 40,
  boulders: 320,
  /** Clear distance (m) between rocks and the road centreline, beyond the road's half width. */
  lineClearance: 14,
  boulderClearance: 3,
  friction: 0.8,
  color: '#a9502c',
};

interface Placement {
  variant: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance (m) from (x, z) to the nearest road centreline, or Infinity when there is no road. */
export type RoadDistanceFn = (x: number, z: number) => number;

export class Rocks {
  /** `roadHalfWidth` + `roadDistance` keep rock lines well clear of the road; lone boulders may sit on the shoulder. */
  constructor(scene: THREE.Scene, physics: Physics, terrain: Terrain, seed = 7, roadDistance: RoadDistanceFn = () => Infinity, roadHalfWidth = 0) {
    const rand = mulberry32(seed);
    const range = (a: number, b: number) => a + rand() * (b - a);

    const geos = Array.from({ length: CONFIG.variants }, (_, i) => this.makeGeometry(rand, i % 3 === 2 ? 1 : 0));
    const placements = this.layout(terrain, rand, range, roadDistance, roadHalfWidth);

    const material = new THREE.MeshStandardMaterial({ color: CONFIG.color, flatShading: true, roughness: 0.95 });
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const m = new THREE.Matrix4();
    const tint = new THREE.Color();

    geos.forEach((geo, v) => {
      const list = placements.filter((p) => p.variant === v);
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const unique = this.uniqueVertices(geo);
      list.forEach((p, i) => {
        m.compose(p.pos, p.quat, p.scale);
        mesh.setMatrixAt(i, m);
        tint.setHSL(0.045 + rand() * 0.02, 0.55, 0.62 + rand() * 0.25);
        mesh.setColorAt(i, tint);
        // World-space hull points, baked into the single fixed body at the origin.
        const pts = new Float32Array(unique.length * 3);
        const v3 = new THREE.Vector3();
        unique.forEach((u, j) => {
          v3.copy(u).applyMatrix4(m);
          pts[j * 3] = v3.x;
          pts[j * 3 + 1] = v3.y;
          pts[j * 3 + 2] = v3.z;
        });
        const desc = RAPIER.ColliderDesc.convexHull(pts);
        if (!desc) return;
        const collider = physics.world.createCollider(desc.setFriction(CONFIG.friction), body);
        physics.setOwner(collider, this);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      scene.add(mesh);
    });
  }

  /** Jittered icosahedron. Jitter is hashed from position so duplicated seam vertices stay together. */
  private makeGeometry(rand: () => number, detail: number): THREE.BufferGeometry {
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const salt = rand() * 1000;
    const pos = geo.getAttribute('position');
    const hash = (x: number, y: number, z: number, k: number) => {
      const s = Math.sin((x * 127.1 + y * 311.7 + z * 74.7 + k * 19.19 + salt) * 12.9898) * 43758.5453;
      return s - Math.floor(s);
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const r = 0.72 + hash(x, y, z, 0) * 0.5;
      pos.setXYZ(i, x * r, y * r * 0.85, z * r);
    }
    geo.computeVertexNormals();
    return geo;
  }

  private uniqueVertices(geo: THREE.BufferGeometry): THREE.Vector3[] {
    const pos = geo.getAttribute('position');
    const seen = new Set<string>();
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    return out;
  }

  private layout(
    terrain: Terrain,
    rand: () => number,
    range: (a: number, b: number) => number,
    roadDistance: RoadDistanceFn,
    roadHalfWidth: number,
  ): Placement[] {
    const out: Placement[] = [];
    const euler = new THREE.Euler();
    let clearance = CONFIG.lineClearance;
    const place = (x: number, z: number, size: number) => {
      const r = Math.hypot(x, z);
      if (r < CONFIG.keepOut + size || r > CONFIG.maxRadius) return;
      if (roadDistance(x, z) < roadHalfWidth + clearance + size) return;
      const sy = size * range(0.8, 1.2);
      const scale = new THREE.Vector3(size * range(0.85, 1.25), sy, size * range(0.85, 1.25));
      euler.set(range(-0.15, 0.15), range(0, Math.PI * 2), range(-0.15, 0.15));
      out.push({
        variant: Math.floor(rand() * CONFIG.variants),
        // Sunk in: centre sits a little under one radius above the ground.
        pos: new THREE.Vector3(x, terrain.heightAt(x, z) + sy * 0.4, z),
        quat: new THREE.Quaternion().setFromEuler(euler),
        scale,
      });
    };

    for (let l = 0; l < CONFIG.lines; l++) {
      const a = (l / CONFIG.lines) * Math.PI * 2 + range(-0.3, 0.3);
      const dist = CONFIG.maxRadius * Math.sqrt(range(0.01, 1)); // uniform over the disc
      let x = Math.cos(a) * dist;
      let z = Math.sin(a) * dist;
      let heading = range(0, Math.PI * 2);
      const curve = range(-0.025, 0.025);
      const steps = Math.floor(range(25, 55));
      for (let s = 0; s < steps; s++) {
        heading += curve;
        x += Math.cos(heading) * 3;
        z += Math.sin(heading) * 3;
        // Each step is a small clump of overlapping rocks, with a bigger one in the middle.
        place(x + range(-1, 1), z + range(-1, 1), range(1.2, 2));
        const extra = 1 + Math.floor(rand() * 2);
        for (let e = 0; e < extra; e++) place(x + range(-3, 3), z + range(-3, 3), range(0.6, 1.3));
      }
    }
    clearance = CONFIG.boulderClearance;
    for (let b = 0; b < CONFIG.boulders; b++) {
      const a = range(0, Math.PI * 2);
      const d = CONFIG.maxRadius * Math.sqrt(range(0.005, 1));
      place(Math.cos(a) * d, Math.sin(a) * d, range(0.7, 2));
    }
    return out;
  }
}
