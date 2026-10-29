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
  /** Painted lines and kerbs on paved tracks. */
  paved: {
    lineWidth: 0.35,
    lineInset: 0.3,
    line: '#f2f0ea',
    dash: 3,
    gap: 4.5,
    kerbWidth: 1.2,
    kerbLength: 2,
    kerbRed: '#d8432f',
    kerbWhite: '#f2f0ea',
    kerbRadius: 60,
    /** Paint is skipped within halfWidth + this of another part of the track. */
    crossMargin: 0.5,
    /** Ignore the stretch of track this close along it when looking for a crossing road. */
    crossWindow: 40,
    /** Paint pieces are at most this long. */
    piece: 2,
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

/** Pure: painted edge lines, centre dashes and bend kerbs of a paved track as decal triangles (empty for sand tracks). Pieces that touch another part of the track (the crossing of a figure-8) are left out. */
export function pavedMarkings(path: TrackPath): { pos: number[]; col: number[] } {
  const out = { pos: [] as number[], col: [] as number[] };
  if (!path.paved) return out;
  const c = CONFIG.paved;
  const hw = path.halfWidth;
  const d = new DecalBuilder(path, 0);
  const p = { x: 0, z: 0 };
  const t = { x: 0, z: 0 };
  const clear = (s: number, v: number): boolean => {
    path.pointAt(s, p);
    path.tangentAt(s, t);
    return path.distanceElsewhere(p.x + t.z * v, p.z - t.x * v, s, c.crossWindow) > hw + c.crossMargin;
  };
  /** Paints [u0, u1] at lateral [v0, v1] in pieces, each only if clear of other road. */
  const strip = (u0: number, u1: number, v0: number, v1: number, color: string): void => {
    const n = Math.max(1, Math.ceil((u1 - u0) / c.piece));
    for (let i = 0; i < n; i++) {
      const a = u0 + ((u1 - u0) * i) / n, b = u0 + ((u1 - u0) * (i + 1)) / n;
      const v = (v0 + v1) / 2;
      if (clear(a, v) && clear((a + b) / 2, v) && clear(b, v)) d.rect(a, b, v0, v1, color);
    }
  };
  const L = path.length;
  const edge = hw - c.lineInset;
  for (const side of [-1, 1]) strip(0, L, side * Math.min(edge, edge - c.lineWidth), side * Math.max(edge, edge - c.lineWidth), c.line);
  for (let u = 0; u + c.dash <= L; u += c.dash + c.gap) strip(u, u + c.dash, -c.lineWidth / 2, c.lineWidth / 2, c.line);
  for (const b of path.bends) {
    if (b.radius >= c.kerbRadius) continue;
    const side = b.turn > 0 ? 1 : -1;
    const v0 = side * (hw - c.kerbWidth / 2), v1 = side * (hw + c.kerbWidth / 2);
    const n = Math.max(1, Math.round((b.end - b.start) / c.kerbLength));
    for (let i = 0; i < n; i++) {
      const a = b.start + ((b.end - b.start) * i) / n, e = b.start + ((b.end - b.start) * (i + 1)) / n;
      strip(a, e, Math.min(v0, v1), Math.max(v0, v1), i % 2 === 0 ? c.kerbRed : c.kerbWhite);
    }
  }
  out.pos = d.pos;
  out.col = d.col;
  return out;
}

/** Jump hazard stripes across the lip and yellow edge lines up the ramp. Visual only. */
export class TrackMarkings {
  constructor(scene: THREE.Scene, private readonly path: TrackPath) {
    this.buildJumps(scene, jumpSpots(path));
    this.buildPaved(scene);
  }

  private buildPaved(scene: THREE.Scene): void {
    const { pos, col } = pavedMarkings(this.path);
    if (pos.length === 0) return;
    const mesh = new THREE.Mesh(toGeometry(pos, col), decalMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    scene.add(mesh);
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
