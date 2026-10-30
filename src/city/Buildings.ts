import * as THREE from 'three';
import { buildingGeometry, type Building } from './City';

const CONFIG = {
  /** Buildings are merged into square tiles this big (m), so off-screen ones are culled. */
  tile: 256,
  /** Window texture: one bay × one floor per texel block. */
  texture: 64,
  frame: '#ffffff',
  glass: ['#4a5a68', '#56677a', '#3c4a57', '#6b7d8f', '#c9d4dc'],
};

/** Extruded low-poly buildings from the city's footprints, with a shared tiling window texture. No colliders: the corridor wall stops cars. */
export class Buildings {
  readonly meshes: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, buildings: readonly Building[]) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, map: windowTexture(), roughness: 0.85, metalness: 0.05, flatShading: true });
    const tiles = new Map<string, Building[]>();
    for (const b of buildings) {
      let x = 0;
      let z = 0;
      for (const p of b.ring) {
        x += p.x;
        z += p.z;
      }
      const key = `${Math.floor(x / b.ring.length / CONFIG.tile)},${Math.floor(z / b.ring.length / CONFIG.tile)}`;
      const list = tiles.get(key);
      if (list) list.push(b);
      else tiles.set(key, [b]);
    }
    for (const list of tiles.values()) {
      const g = buildingGeometry(list);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      // Tall buildings' shadows would be cut off at the edge of the small shadow box round the car: receive only.
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }
}

/** One bay × one floor: a white frame (tinted by the building's colour) round a window whose glass varies per texel block. */
function windowTexture(): THREE.CanvasTexture {
  const n = CONFIG.texture;
  const cells = 4;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n * cells;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = CONFIG.frame;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      ctx.fillStyle = CONFIG.glass[(i * 3 + j * 7) % CONFIG.glass.length]!;
      ctx.fillRect(i * n + n * 0.14, j * n + n * 0.2, n * 0.72, n * 0.6);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // The UVs count bays and floors; the texture holds 4 × 4 of them.
  tex.repeat.set(1 / cells, 1 / cells);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
