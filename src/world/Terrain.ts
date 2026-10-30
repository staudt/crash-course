import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { RAPIER, type Physics } from '../core/Physics';
import { sampleHeight, samplePaved, sampleSoftness, toRapierHeights, type TerrainData } from './TerrainData';

const SAND_LIT = new THREE.Color('#e57c3e');
const SAND_SHADOW = new THREE.Color('#a9461d');
const SAND_RIM = new THREE.Color('#f39a5c');
const HARDPAN = new THREE.Color('#d98f60');
const MUD_LIT = new THREE.Color('#98683f');
const MUD_SHADOW = new THREE.Color('#6a4629');
const MUD_WET = new THREE.Color('#563820');
const CONCRETE = new THREE.Color('#8e8d89');
const CONCRETE_FAR = '#7f7e7b';
/** Direction toward the sun, used only to bake slope shading into vertex colours. */
const SUN_DIR = new THREE.Vector3(45, 70, 10).normalize();
/** Cells per side of each render tile, so tiles off-screen (and outside the shadow camera) are culled. */
const CHUNK = 64;

export class Terrain {
  readonly data: TerrainData;
  /** Render tiles (one big mesh would be drawn in full into the shadow map every frame). */
  readonly chunks: THREE.Mesh[] = [];
  /** The plane round the world out to the horizon. */
  readonly far: THREE.Mesh;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  constructor(scene: THREE.Scene, physics: Physics, data: TerrainData) {
    this.data = data;
    const full = this.buildGeometry();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const geo of this.split(full)) {
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.castShadow = true; // dune slip faces throw real shadows
      scene.add(mesh);
      this.chunks.push(mesh);
    }
    full.dispose();
    this.far = this.buildFarGround();
    scene.add(this.far);

    // Heightfield is centred on the body origin; scale.x/z are the full extents.
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const { n, size } = data;
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(n - 1, n - 1, toRapierHeights(data), { x: size, y: 1, z: size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
      this.body,
    );
    physics.setOwner(this.collider, this);
  }

  heightAt(x: number, z: number): number {
    return sampleHeight(this.data, x, z);
  }

  softnessAt(x: number, z: number): number {
    return sampleSoftness(this.data, x, z);
  }

  /** 0..1 asphalt (paved circuits only). */
  pavedAt(x: number, z: number): number {
    return samplePaved(this.data, x, z);
  }

  private buildGeometry(): THREE.BufferGeometry {
    const { n, size, heights } = this.data;
    const step = size / (n - 1);
    const positions = new Float32Array(n * n * 3);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        positions[i * 3] = -size / 2 + ix * step;
        positions[i * 3 + 1] = heights[i]!;
        positions[i * 3 + 2] = -size / 2 + iz * step;
      }
    }
    // Same diagonal as Rapier: (ix, iz+1) to (ix+1, iz). Both triangles face +Y.
    const indices = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let iz = 0; iz < n - 1; iz++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const v00 = iz * n + ix;
        const v10 = v00 + 1;
        const v01 = v00 + n;
        const v11 = v01 + 1;
        indices[k++] = v00; indices[k++] = v01; indices[k++] = v10;
        indices[k++] = v10; indices[k++] = v01; indices[k++] = v11;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(this.buildColors(geo), 3));
    geo.computeBoundingSphere();
    return geo;
  }

  /** Cuts the full grid into CHUNK×CHUNK-cell tiles sharing edge vertices (same normals and colours, so no seams). */
  private split(full: THREE.BufferGeometry): THREE.BufferGeometry[] {
    const { n } = this.data;
    const pos = full.getAttribute('position').array as Float32Array;
    const nor = full.getAttribute('normal').array as Float32Array;
    const col = full.getAttribute('color').array as Float32Array;
    const out: THREE.BufferGeometry[] = [];
    for (let cz = 0; cz < n - 1; cz += CHUNK) {
      for (let cx = 0; cx < n - 1; cx += CHUNK) {
        const w = Math.min(CHUNK, n - 1 - cx) + 1;
        const h = Math.min(CHUNK, n - 1 - cz) + 1;
        const p = new Float32Array(w * h * 3);
        const q = new Float32Array(w * h * 3);
        const c = new Float32Array(w * h * 3);
        for (let z = 0; z < h; z++) {
          for (let x = 0; x < w; x++) {
            const src = ((cz + z) * n + cx + x) * 3;
            const dst = (z * w + x) * 3;
            for (let k = 0; k < 3; k++) {
              p[dst + k] = pos[src + k]!;
              q[dst + k] = nor[src + k]!;
              c[dst + k] = col[src + k]!;
            }
          }
        }
        const idx = new Uint32Array((w - 1) * (h - 1) * 6);
        let k = 0;
        for (let z = 0; z < h - 1; z++) {
          for (let x = 0; x < w - 1; x++) {
            const v00 = z * w + x;
            const v10 = v00 + 1;
            const v01 = v00 + w;
            const v11 = v01 + 1;
            idx[k++] = v00; idx[k++] = v01; idx[k++] = v10;
            idx[k++] = v10; idx[k++] = v01; idx[k++] = v11;
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(q, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        out.push(geo);
      }
    }
    return out;
  }

  private buildColors(geo: THREE.BufferGeometry): Float32Array {
    const { n, size, heights, softness } = this.data;
    const noise = createNoise2D(() => 0.37);
    const normals = geo.getAttribute('normal');
    const colors = new Float32Array(n * n * 3);
    const c = new THREE.Color();
    const cell = size / (n - 1);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const x = -size / 2 + ix * cell;
        const z = -size / 2 + iz * cell;
        const sun = normals.getX(i) * SUN_DIR.x + normals.getY(i) * SUN_DIR.y + normals.getZ(i) * SUN_DIR.z;
        // Strong shading: lee faces fall to SAND_SHADOW, sunlit windward faces reach SAND_LIT.
        const lit = THREE.MathUtils.smoothstep(sun, 0.1, 0.9);
        c.copy(SAND_SHADOW).lerp(SAND_LIT, lit);

        // Crest rim: a local high point (above the neighbour average) gets a light edge.
        const ixa = Math.max(0, ix - 2);
        const ixb = Math.min(n - 1, ix + 2);
        const iza = Math.max(0, iz - 2);
        const izb = Math.min(n - 1, iz + 2);
        const avg = (heights[iz * n + ixa]! + heights[iz * n + ixb]! + heights[iza * n + ix]! + heights[izb * n + ix]!) / 4;
        const crest = THREE.MathUtils.clamp((heights[i]! - avg) / 1.2, 0, 1);
        c.lerp(SAND_RIM, crest * 0.4);

        // Firm hardpan: paler, less saturated.
        const firm = 1 - THREE.MathUtils.smoothstep(softness[i]!, 0.1, 0.5);
        const hard = HARDPAN.clone().multiplyScalar(0.8 + lit * 0.25);
        c.lerp(hard, firm * 0.6);

        const mudW = this.data.mud?.[i] ?? 0;
        if (mudW > 0) {
          const m = MUD_SHADOW.clone().lerp(MUD_LIT, lit);
          // Low-frequency darker wet patches.
          const wet = THREE.MathUtils.smoothstep(noise(x * 0.035 + 50, z * 0.035 - 20), 0.05, 0.6);
          m.lerp(MUD_WET, wet * 0.5);
          c.lerp(m, mudW);
        }

        const urban = this.data.urban?.[i] ?? 0;
        if (urban > 0) c.lerp(CONCRETE, urban);

        c.multiplyScalar(0.95 + noise(x * 0.05, z * 0.05) * 0.04 + noise(x * 0.4, z * 0.4) * 0.03);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
    }
    return colors;
  }

  /** Big flat plane below the rim so the horizon is never empty. */
  private buildFarGround(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(12000, 12000);
    geo.rotateX(-Math.PI / 2);
    const city = (this.data.urban?.[0] ?? 0) > 0;
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: city ? CONCRETE_FAR : '#c8663a' }));
    // The city floor is flat to its edge: the plane meets it there instead of sitting below a rim.
    mesh.position.y = city ? -0.05 : -4;
    mesh.receiveShadow = true;
    return mesh;
  }
}
