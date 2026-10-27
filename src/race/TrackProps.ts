import * as THREE from 'three';
import { RAPIER, type Physics } from '../core/Physics';
import type { TrackPath } from './TrackPath';

const CONFIG = {
  road: {
    /** Lateral offsets of the cross-section, as [metres beyond halfWidth | fraction of halfWidth]. */
    shoulder: 1.2,
    rutFraction: 0.45,
    lift: 0.06,
    chunkSamples: 200,
    colors: { outer: '#d98f60', edge: '#e3a26c', rut: '#c9834f', centre: '#e8ab76' },
  },
  gate: {
    postOffset: 2.5,
    postRadius: 0.35,
    postHeight: 6.5,
    postColor: '#3a3f47',
    bannerOverhang: 0.7,
    bannerHeight: 1.3,
    bannerDepth: 0.25,
    bannerBottom: 5.2,
    nextColor: '#ffd23f',
    nextEmissive: '#ffb000',
    nextEmissiveIntensity: 0.6,
    dimColor: '#8a8f99',
    stripDepth: 2.5,
    stripLift: 0.08,
    friction: 0.6,
  },
  stake: {
    spacing: 40,
    /** Spacing where the road fades to open sand (sandAt >= sandThreshold): the stakes are the route guide. */
    sandSpacing: 20,
    sandThreshold: 0.5,
    lateral: 1.2,
    size: 0.16,
    height: 1.1,
    bandHeight: 0.25,
    heightSegments: 4,
    color: '#f2f0ea',
    bandColor: '#d8432f',
    mass: 4,
    friction: 0.6,
    checkpointClear: 15,
    jumpClear: 30,
  },
};

const ROAD_VERTS = 7;
const FULL_SAND = 0.999;

/** True when the quad between sample i and the next lies wholly on open sand (no road to draw). */
function sandQuad(path: TrackPath, i: number): boolean {
  return path.sandiness[i]! >= FULL_SAND && path.sandiness[(i + 1) % path.count]! >= FULL_SAND;
}

/** Pure: the road ribbon geometry arrays (no three objects), so it can be unit tested. */
export function buildRoadRibbon(path: TrackPath): { positions: Float32Array; colors: Float32Array; indices: Uint32Array } {
  const n = path.count;
  const hw = path.halfWidth;
  const sh = CONFIG.road.shoulder;
  const rut = CONFIG.road.rutFraction * hw;
  const offsets = [-(hw + sh), -hw, -rut, 0, rut, hw, hw + sh];
  const c = CONFIG.road.colors;
  const palette = [c.outer, c.edge, c.rut, c.centre, c.rut, c.edge, c.outer].map((h) => new THREE.Color(h));

  const positions = new Float32Array(n * ROAD_VERTS * 3);
  const colors = new Float32Array(n * ROAD_VERTS * 4);
  for (let i = 0; i < n; i++) {
    // Left normal of (tx, tz) is (tz, -tx).
    const nx = path.tzs[i]!;
    const nz = -path.txs[i]!;
    const y = path.elevation[i]! + CONFIG.road.lift;
    for (let j = 0; j < ROAD_VERTS; j++) {
      const k = (i * ROAD_VERTS + j) * 3;
      positions[k] = path.xs[i]! + nx * offsets[j]!;
      positions[k + 1] = y;
      positions[k + 2] = path.zs[i]! + nz * offsets[j]!;
      const kc = (i * ROAD_VERTS + j) * 4;
      colors[kc] = palette[j]!.r;
      colors[kc + 1] = palette[j]!.g;
      colors[kc + 2] = palette[j]!.b;
      colors[kc + 3] = 1 - path.sandiness[i]!;
    }
  }

  let quads = 0;
  for (let i = 0; i < n; i++) if (!sandQuad(path, i)) quads++;
  const indices = new Uint32Array(quads * (ROAD_VERTS - 1) * 6);
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (sandQuad(path, i)) continue;
    const a0 = i * ROAD_VERTS;
    const b0 = ((i + 1) % n) * ROAD_VERTS;
    for (let j = 0; j < ROAD_VERTS - 1; j++) {
      const a = a0 + j, c2 = a0 + j + 1, b = b0 + j, d = b0 + j + 1;
      indices[o++] = a; indices[o++] = b; indices[o++] = c2;
      indices[o++] = c2; indices[o++] = b; indices[o++] = d;
    }
  }
  return { positions, colors, indices };
}

function chequerTexture(cols: number, rows: number, cell: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const g = canvas.getContext('2d')!;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
      g.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

interface Stake {
  body: RAPIER.RigidBody;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export class TrackProps {
  private readonly physics: Physics;
  private readonly brightMat: THREE.MeshLambertMaterial;
  private readonly dimMat: THREE.MeshLambertMaterial;
  private readonly postMat: THREE.MeshLambertMaterial;
  private readonly banners: THREE.Mesh[] = [];
  private readonly startPosts: THREE.Mesh[] = [];
  private readonly stakes: Stake[] = [];
  private stakeMesh: THREE.InstancedMesh | null = null;
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private next = -1;

  constructor(scene: THREE.Scene, physics: Physics, private readonly path: TrackPath) {
    this.physics = physics;
    const g = CONFIG.gate;
    this.brightMat = new THREE.MeshLambertMaterial({
      color: g.nextColor,
      emissive: g.nextEmissive,
      emissiveIntensity: g.nextEmissiveIntensity,
      flatShading: true,
    });
    this.dimMat = new THREE.MeshLambertMaterial({ color: g.dimColor, flatShading: true });
    this.postMat = new THREE.MeshLambertMaterial({ color: g.postColor, flatShading: true });

    this.buildRoad(scene);
    this.buildGates(scene);
    this.buildStakes(scene);
    this.setNextCheckpoint(0);
  }

  setNextCheckpoint(i: number): void {
    if (i === this.next) return;
    this.next = i;
    this.banners.forEach((b, k) => {
      if (k !== 0) b.material = k === i ? this.brightMat : this.dimMat;
    });
    for (const post of this.startPosts) post.material = i === 0 ? this.brightMat : this.postMat;
  }

  update(): void {
    const mesh = this.stakeMesh;
    if (!mesh) return;
    let any = false;
    for (let i = 0; i < this.stakes.length; i++) {
      const body = this.stakes[i]!.body;
      if (body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      this.p.set(t.x, t.y, t.z);
      this.q.set(r.x, r.y, r.z, r.w);
      this.m.compose(this.p, this.q, this.one);
      mesh.setMatrixAt(i, this.m);
      any = true;
    }
    if (any) mesh.instanceMatrix.needsUpdate = true;
  }

  resetStakes(): void {
    const mesh = this.stakeMesh;
    if (!mesh) return;
    const zero = { x: 0, y: 0, z: 0 };
    this.stakes.forEach((s, i) => {
      s.body.setTranslation(s.pos, false);
      s.body.setRotation(s.quat, false);
      s.body.setLinvel(zero, false);
      s.body.setAngvel(zero, false);
      s.body.sleep();
      this.m.compose(s.pos, s.quat, this.one);
      mesh.setMatrixAt(i, this.m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  private buildRoad(scene: THREE.Scene): void {
    const { positions, colors } = buildRoadRibbon(this.path);
    const n = this.path.count;
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    const V = ROAD_VERTS;
    for (let a = 0; a < n; a += CONFIG.road.chunkSamples) {
      const b = Math.min(n, a + CONFIG.road.chunkSamples);
      // Samples a..b inclusive; sample b wraps to 0 at the end of the loop.
      const rows = b - a + 1;
      const pos = new Float32Array(rows * V * 3);
      const col = new Float32Array(rows * V * 4);
      for (let r = 0; r < rows; r++) {
        const src = (((a + r) % n) * V) * 3;
        pos.set(positions.subarray(src, src + V * 3), r * V * 3);
        const srcC = (((a + r) % n) * V) * 4;
        col.set(colors.subarray(srcC, srcC + V * 4), r * V * 4);
      }
      let live = 0;
      for (let i = a; i < b; i++) if (!sandQuad(this.path, i)) live++;
      if (live === 0) continue;
      const local = new Uint32Array(live * (V - 1) * 6);
      // Global indices of sample i start at i*V; remap to local rows (wrapped last row -> row `rows-1`).
      let o = 0;
      for (let i = a; i < b; i++) {
        if (sandQuad(this.path, i)) continue;
        for (let j = 0; j < V - 1; j++) {
          const r0 = (i - a) * V + j, r1 = (i - a + 1) * V + j;
          local[o++] = r0; local[o++] = r1; local[o++] = r0 + 1;
          local[o++] = r0 + 1; local[o++] = r1; local[o++] = r1 + 1;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      geo.setIndex(new THREE.BufferAttribute(local, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  private buildGates(scene: THREE.Scene): void {
    const path = this.path;
    const g = CONFIG.gate;
    const hw = path.halfWidth;
    const off = hw + g.postOffset;
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const postGeo = new THREE.CylinderGeometry(g.postRadius, g.postRadius, g.postHeight, 8);
    const bannerGeo = new THREE.BoxGeometry(2 * off + g.bannerOverhang, g.bannerHeight, g.bannerDepth);
    const chequer = chequerTexture(16, 4, 16);
    const startMat = new THREE.MeshLambertMaterial({ map: chequer, flatShading: true });
    const tmp = { x: 0, z: 0 };
    const tan = { x: 0, z: 0 };

    path.checkpoints.forEach((s, k) => {
      path.pointAt(s, tmp);
      path.tangentAt(s, tan);
      const y = path.heightAt(s);
      const heading = Math.atan2(tan.x, tan.z);
      const nx = tan.z, nz = -tan.x;

      for (const side of [-1, 1]) {
        const px = tmp.x + nx * off * side;
        const pz = tmp.z + nz * off * side;
        const post = new THREE.Mesh(postGeo, this.postMat);
        post.position.set(px, y + g.postHeight / 2, pz);
        post.castShadow = true;
        scene.add(post);
        if (k === 0) this.startPosts.push(post);
        const desc = RAPIER.ColliderDesc.cylinder(g.postHeight / 2, g.postRadius)
          .setTranslation(px, y + g.postHeight / 2, pz)
          .setFriction(g.friction);
        this.physics.setOwner(this.physics.world.createCollider(desc, body), this);
      }

      const banner = new THREE.Mesh(bannerGeo, k === 0 ? startMat : this.dimMat);
      banner.position.set(tmp.x, y + g.bannerBottom + g.bannerHeight / 2, tmp.z);
      banner.rotation.y = heading;
      banner.castShadow = true;
      scene.add(banner);
      this.banners.push(banner);

      if (k === 0) {
        const stripTex = chequerTexture(2 * Math.round(hw), 3, 16);
        const strip = new THREE.Mesh(
          new THREE.PlaneGeometry(hw * 2, g.stripDepth),
          new THREE.MeshLambertMaterial({
            map: stripTex,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -8,
          }),
        );
        strip.rotation.set(-Math.PI / 2, 0, 0);
        strip.rotation.order = 'YXZ';
        strip.rotation.y = heading;
        strip.position.set(tmp.x, y + g.stripLift, tmp.z);
        strip.receiveShadow = true;
        scene.add(strip);
      }
    });
  }

  private buildStakes(scene: THREE.Scene): void {
    const path = this.path;
    const c = CONFIG.stake;
    const off = path.halfWidth + c.lateral;
    const geo = new THREE.BoxGeometry(c.size, c.height, c.size, 1, c.heightSegments, 1);
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const bandEdge = c.height / 2 - c.height / c.heightSegments;
    for (let i = 0; i < pos.count; i++) {
      // Snap the top row of inner vertices so the band boundary is exactly bandHeight below the top.
      if (Math.abs(pos.getY(i) - bandEdge) < 1e-4) pos.setY(i, c.height / 2 - c.bandHeight);
    }
    const white = new THREE.Color(c.color), red = new THREE.Color(c.bandColor);
    const bandY = c.height / 2 - c.bandHeight;
    for (let i = 0; i < pos.count; i++) {
      // Segment edges sit on the band boundary, so each vertex is wholly red or white.
      const col = pos.getY(i) >= bandY - 1e-4 ? red : white;
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Un-index so flat shading and colours stay per face.
    const flat = geo.toNonIndexed();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    const tmp = { x: 0, z: 0 };
    const tan = { x: 0, z: 0 };
    const list: { x: number; y: number; z: number; yaw: number }[] = [];
    const near = (s: number, set: number[], clear: number) =>
      set.some((t) => {
        const d = Math.abs(s - t);
        return Math.min(d, path.length - d) < clear;
      });
    for (let s = 0; s < path.length; s += path.sandAt(s) >= c.sandThreshold ? c.sandSpacing : c.spacing) {
      if (near(s, path.checkpoints, c.checkpointClear) || near(s, path.jumps, c.jumpClear)) continue;
      path.pointAt(s, tmp);
      path.tangentAt(s, tan);
      const y = path.heightAt(s);
      for (const side of [-1, 1]) {
        list.push({
          x: tmp.x + tan.z * off * side,
          y: y + c.height / 2,
          z: tmp.z - tan.x * off * side,
          yaw: Math.atan2(tan.x, tan.z),
        });
      }
    }

    const mesh = new THREE.InstancedMesh(flat, material, Math.max(1, list.length));
    mesh.count = list.length;
    mesh.castShadow = true;
    const density = c.mass / (c.size * c.size * c.height);
    const axis = new THREE.Vector3(0, 1, 0);
    list.forEach((it, i) => {
      const quat = new THREE.Quaternion().setFromAxisAngle(axis, it.yaw);
      const p = new THREE.Vector3(it.x, it.y, it.z);
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p.x, p.y, p.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setCanSleep(true)
          .setSleeping(true),
      );
      const collider = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(c.size / 2, c.height / 2, c.size / 2).setDensity(density).setFriction(c.friction),
        body,
      );
      this.physics.setOwner(collider, this);
      this.stakes.push({ body, pos: p, quat });
      this.m.compose(p, quat, this.one);
      mesh.setMatrixAt(i, this.m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.stakeMesh = mesh;
    scene.add(mesh);
  }
}
