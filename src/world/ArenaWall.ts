import * as THREE from 'three';
import { RAPIER, type Physics } from '../core/Physics';
import type { WallBlock } from './TrackWalls';

export interface WallConfig {
  wallRadius: number;
  wallHeight: number;
  wallThickness: number;
  wallSegments: number;
}

const CONCRETE = '#a39d92';
const STRIPE_A = '#c0392b';
const STRIPE_B = '#ece6da';
/** Hazard stripe length (m), alternating red/white along the inner face. */
const STRIPE_LENGTH = 2.5;
/** Extra length (m) on each block so neighbours overlap. */
const OVERLAP = 0.15;
/** Half-thickness (m) of the slab inside each rounded wall collider. */
const SLAB = 0.01;
/** How far (m) the base is sunk below the lowest ground under a block. */
const SINK = 0.5;

/** Ring of concrete blocks around the arena centre. */
export class ArenaWall {
  constructor(scene: THREE.Scene, physics: Physics, cfg: WallConfig, heightAt: (x: number, z: number) => number) {
    const { wallRadius: R, wallSegments: N } = cfg;
    const chord = 2 * R * Math.sin(Math.PI / N);
    const blocks: WallBlock[] = [];
    for (let i = 0; i < N; i++) {
      const th = ((i + 0.5) / N) * Math.PI * 2;
      // Local +x along the tangent, local +z pointing to the arena centre.
      blocks.push({ x: R * Math.cos(th), z: R * Math.sin(th), length: chord, yaw: -th - Math.PI / 2 });
    }
    new ConcreteWall(scene, physics, blocks, { height: cfg.wallHeight, thickness: cfg.wallThickness }, heightAt);
  }
}

/**
 * Concrete wall blocks with hazard stripes on the face toward the action (local +z): one fixed body,
 * rounded colliders (`wallBoxes`: one per straight run), instanced visuals. Each block stands `height` above the highest ground under it.
 */
export class ConcreteWall {
  /** Cars scrape along it on a glancing touch (Car.walls) instead of crashing: the track walls, not the derby's ring. */
  readonly smooth: boolean;
  /** Wall centreline segments (start, unit direction, length), for `normalAt`. */
  private readonly segments: { x: number; z: number; ax: number; az: number; length: number }[];

  constructor(scene: THREE.Scene, physics: Physics, blocks: readonly WallBlock[], cfg: { height: number; thickness: number; smooth?: boolean }, heightAt: (x: number, z: number) => number) {
    this.smooth = cfg.smooth ?? false;
    const T = cfg.thickness;
    this.segments = blocks.map((b) => {
      const ax = Math.cos(b.yaw);
      const az = -Math.sin(b.yaw);
      return { x: b.x - (ax * b.length) / 2, z: b.z - (az * b.length) / 2, ax, az, length: b.length };
    });
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    // Unit block (x length, y 0..1, z thickness) with the top face pulled in a little: a chamfered top.
    const block = new THREE.BoxGeometry(1, 1, 1);
    block.translate(0, 0.5, 0);
    const pos = block.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      if (pos.getY(v) > 0.99) pos.setZ(v, pos.getZ(v) * 0.7);
    }
    block.computeVertexNormals();
    const stripeCounts = blocks.map((b) => (b.hidden ? 0 : Math.max(1, Math.round(b.length / STRIPE_LENGTH))));
    const shown = blocks.filter((b) => !b.hidden).length;
    const concrete = new THREE.InstancedMesh(block, new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 0.95 }), Math.max(1, shown));
    concrete.count = shown;
    const stripeGeo = new THREE.BoxGeometry(1, 1, 1);
    const stripeTotal = stripeCounts.reduce((a, b) => a + b, 0);
    const stripes = new THREE.InstancedMesh(stripeGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 0.8 }), Math.max(1, stripeTotal));
    stripes.count = stripeTotal;
    for (const m of [concrete, stripes]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const base = new THREE.Color(CONCRETE);
    const tint = new THREE.Color();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    let stripe = 0;
    let instance = 0;
    const bottoms: number[] = [];
    const tops: number[] = [];

    blocks.forEach((b, i) => {
      const { x: cx, z: cz, length } = b;
      // Local +x (along the wall) and +z (the striped face) in world space.
      const ax = Math.cos(b.yaw);
      const az = -Math.sin(b.yaw);
      const nx = Math.sin(b.yaw);
      const nz = Math.cos(b.yaw);
      // Lowest and highest ground under the block footprint.
      let lo = Infinity;
      let hi = -Infinity;
      for (const a of [-0.5, -0.25, 0, 0.25, 0.5]) {
        for (const c of [-0.5, 0, 0.5]) {
          const h = heightAt(cx + ax * a * length + nx * c * T, cz + az * a * length + nz * c * T);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      }
      const bottom = lo - SINK;
      const top = hi + (b.height ?? cfg.height);
      const h = top - bottom;
      const len = length + OVERLAP * 2;

      q.setFromAxisAngle(yAxis, b.yaw);
      bottoms.push(bottom);
      tops.push(top);
      if (b.hidden) return;

      p.set(cx, bottom, cz);
      s.set(len, h, T);
      m.compose(p, q, s);
      concrete.setMatrixAt(instance, m);
      const v = 0.92 + ((i * 7919) % 13) / 13 * 0.16;
      tint.copy(base).multiplyScalar(v);
      concrete.setColorAt(instance++, tint);

      // Hazard stripes just below the top lip, on the striped face (+z local).
      const count = stripeCounts[i]!;
      const stripeLen = length / count;
      const band = Math.min(0.55, cfg.height * 0.3);
      for (let j = 0; j < count; j++) {
        const a = ((j + 0.5) / count - 0.5) * length;
        p.set(cx + ax * a + nx * (T / 2 - 0.08), top - band - Math.min(0.4, cfg.height * 0.13), cz + az * a + nz * (T / 2 - 0.08));
        s.set(stripeLen + 0.02, band, 0.16);
        m.compose(p, q, s);
        stripes.setMatrixAt(stripe, m);
        stripes.setColorAt(stripe, tint.set(stripe % 2 === 0 ? STRIPE_A : STRIPE_B));
        stripe++;
      }
    });
    // Seams snag a car sliding along the wall: with a box collider per block, a 10° scrape at 100 km/h stopped dead on
    // the next block's end, which at a joint bending toward the car starts right on the surface it slides along. (A
    // compound and a triangle mesh with fixed internal edges snagged too, as did overlapping or cylinder-capped boxes.)
    // So each straight run of blocks is one collider, swept round with a radius of half the wall's thickness: a thin
    // slab inflated into a wall with rounded ends. Neighbours share their end points, so their rounded ends coincide
    // and the outline has no edge anywhere: smooth round a corner bending away, a shallow crease at one bending toward.
    const r = T / 2;
    for (const w of wallBoxes(blocks, bottoms, tops, T)) {
      q.setFromAxisAngle(yAxis, w.yaw);
      const collider = physics.world.createCollider(
        RAPIER.ColliderDesc.roundCuboid(w.hx, Math.max(SLAB, w.hy - r), SLAB, r - SLAB)
          .setTranslation(w.x, w.y, w.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setFriction(0.4)
          .setRestitution(0.1),
        body,
      );
      physics.setOwner(collider, this);
    }
    for (const mesh of [concrete, stripes]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  /**
   * Unit normal (on the ground plane) of the wall's smooth outline facing (x, z): from the nearest point
   * of the wall's centreline toward it. Continuous round the joints, unlike the colliders' contact normals.
   */
  normalAt(x: number, z: number): { x: number; z: number } {
    let best = Infinity;
    let nx = 0;
    let nz = 0;
    for (const g of this.segments) {
      const t = Math.min(g.length, Math.max(0, (x - g.x) * g.ax + (z - g.z) * g.az));
      const dx = x - (g.x + g.ax * t);
      const dz = z - (g.z + g.az * t);
      const d = Math.hypot(dx, dz);
      if (d < best) {
        best = d;
        nx = dx / (d || 1);
        nz = dz / (d || 1);
      }
    }
    return { x: nx, z: nz };
  }
}

/** One wall collider: a box (half extents, centred at x, y, z, turned by yaw like a WallBlock). */
export interface WallBox {
  x: number;
  y: number;
  z: number;
  yaw: number;
  hx: number;
  hy: number;
  hz: number;
}

/** Blocks that meet end to end within this (m) and turn by less than MERGE_TURN (rad) merge into one collider. */
const JOINT = 0.3;
const MERGE_TURN = 0.01;

/**
 * Collision boxes for wall blocks: each run of blocks lying end to end in a straight line becomes one
 * long box, so a straight wall has no seams at all; the rest (the chords round a curve) stay one box per block.
 */
export function wallBoxes(blocks: readonly WallBlock[], bottoms: readonly number[], tops: readonly number[], thickness: number): WallBox[] {
  const boxes: WallBox[] = [];
  let run: { a: { x: number; z: number }; b: { x: number; z: number }; yaw: number; lo: number; hi: number } | null = null;
  const flush = () => {
    if (!run) return;
    boxes.push({
      x: (run.a.x + run.b.x) / 2,
      z: (run.a.z + run.b.z) / 2,
      y: (run.lo + run.hi) / 2,
      yaw: run.yaw,
      hx: Math.hypot(run.b.x - run.a.x, run.b.z - run.a.z) / 2,
      hy: (run.hi - run.lo) / 2,
      hz: thickness / 2,
    });
    run = null;
  };
  blocks.forEach((b, i) => {
    const ax = Math.cos(b.yaw) * (b.length / 2);
    const az = -Math.sin(b.yaw) * (b.length / 2);
    const start = { x: b.x - ax, z: b.z - az };
    const end = { x: b.x + ax, z: b.z + az };
    const lo = bottoms[i]!;
    const hi = tops[i]!;
    const turn = run ? Math.abs(Math.atan2(Math.sin(b.yaw - run.yaw), Math.cos(b.yaw - run.yaw))) : Infinity;
    if (run && turn < MERGE_TURN && Math.hypot(start.x - run.b.x, start.z - run.b.z) < JOINT && Math.abs(lo - run.lo) < 0.05 && Math.abs(hi - run.hi) < 0.05) {
      run.b = end;
      return;
    }
    flush();
    run = { a: start, b: end, yaw: b.yaw, lo, hi };
  });
  flush();
  return boxes;
}
