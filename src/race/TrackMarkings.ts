import * as THREE from 'three';
import type { TrackPath } from './TrackPath';

const CONFIG = {
  jump: {
    bandLength: 2.5,
    stripes: 8,
    edgeLength: 30,
    edgeWidth: 0.5,
    edgeInset: 0.1,
    yellow: '#ffd23f',
    black: '#1d1d1f',
  },
  /** Decal height above the road surface, and the max distance between vertex rows. */
  lift: 0.1,
  maxStep: 2,
  offset: { factor: -2, units: -8 },
};

/** Pure: the kicker lips to mark. (Upcoming bends are shown by the guide arrow, not on the track.) */
export function jumpSpots(path: TrackPath): number[] {
  return [...path.jumps];
}

/** Accumulates decal triangles mapped from (u along, v lateral) onto the road surface. */
class DecalBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  private readonly p = { x: 0, z: 0 };
  private readonly t = { x: 0, z: 0 };
  private readonly c = new THREE.Color();

  constructor(private readonly path: TrackPath, private readonly s: number) {}

  private vert(u: number, v: number): [number, number, number] {
    const path = this.path;
    path.pointAt(this.s + u, this.p);
    path.tangentAt(this.s + u, this.t);
    // Left normal of (tx, tz) is (tz, -tx).
    return [this.p.x + this.t.z * v, path.heightAt(this.s + u) + CONFIG.lift, this.p.z - this.t.x * v];
  }

  private tri(a: number[], b: number[], c: number[]): void {
    const up = (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!);
    const [p, q, r] = up >= 0 ? [a, b, c] : [a, c, b];
    for (const v of [p!, q!, r!]) {
      this.pos.push(v[0]!, v[1]!, v[2]!);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
  }

  /** Axis-aligned rectangle in (u, v), subdivided along u. */
  rect(u0: number, u1: number, v0: number, v1: number, color: string): void {
    this.c.set(color);
    const n = Math.max(1, Math.ceil(Math.abs(u1 - u0) / CONFIG.maxStep));
    for (let i = 0; i < n; i++) {
      const a = u0 + ((u1 - u0) * i) / n, b = u0 + ((u1 - u0) * (i + 1)) / n;
      const p00 = this.vert(a, v0), p10 = this.vert(b, v0), p01 = this.vert(a, v1), p11 = this.vert(b, v1);
      this.tri(p00, p10, p01);
      this.tri(p01, p10, p11);
    }
  }
}

function toGeometry(pos: number[], col: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function decalMaterial(extra: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    polygonOffset: true,
    polygonOffsetFactor: CONFIG.offset.factor,
    polygonOffsetUnits: CONFIG.offset.units,
    ...extra,
  });
}

/** Jump hazard stripes across the lip and yellow edge lines up the ramp. Visual only. */
export class TrackMarkings {
  constructor(scene: THREE.Scene, private readonly path: TrackPath) {
    this.buildJumps(scene, jumpSpots(path));
  }

  private buildJumps(scene: THREE.Scene, jumps: number[]): void {
    if (jumps.length === 0) return;
    const j = CONFIG.jump;
    const hw = this.path.halfWidth;
    const pos: number[] = [];
    const col: number[] = [];
    for (const s of jumps) {
      const d = new DecalBuilder(this.path, s);
      const w = (2 * hw) / j.stripes;
      for (let i = 0; i < j.stripes; i++) {
        d.rect(-j.bandLength, 0, -hw + i * w, -hw + (i + 1) * w, i % 2 === 0 ? j.yellow : j.black);
      }
      for (const side of [-1, 1]) {
        const outer = hw - j.edgeInset, inner = outer - j.edgeWidth;
        d.rect(-j.edgeLength, -j.bandLength, side * Math.min(inner, outer), side * Math.max(inner, outer), j.yellow);
      }
      pos.push(...d.pos);
      col.push(...d.col);
    }
    const mesh = new THREE.Mesh(toGeometry(pos, col), decalMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}
