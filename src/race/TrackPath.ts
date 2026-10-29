/**
 * Closed race-track centreline, authored as a polygon of corners that are each
 * rounded with a circular arc (like road design: straights joined by arcs),
 * then sampled every ~2 m. Pure (no three), so it can be used by terrain
 * generation, AI, race logic and tests alike.
 *
 * Headings follow the car's yaw convention: heading 0 faces +Z, and the
 * direction is (sin h, cos h). Positive curvature turns left (toward +X when facing +Z).
 */

export interface Corner {
  x: number;
  z: number;
  /** Arc radius (m) rounding this corner. */
  r: number;
  /** A kicker jump at this fraction along the straight that leaves this corner. */
  jump?: number;
}

export interface TrackDef {
  id: string;
  name: string;
  /** Half the road width (m). */
  halfWidth: number;
  /** Closed loop, in driving order. The start/finish line is halfway along the straight from corner 0 to corner 1. */
  corners: Corner[];
  /** Number of checkpoints including the start/finish line (which is checkpoint 0 at s = 0). */
  checkpoints: number;
  /**
   * Open-sand stretches with no road: [from, to] corner indices, running from the middle of
   * corner `from`'s arc to the middle of corner `to`'s arc in driving order.
   */
  sand?: [number, number][];
  /** Where s = 0 (the start/finish line) sits along the straight from corner 0 to corner 1, as a fraction of it (default 0.5). */
  start?: number;
  /** Checkpoint positions as fractions of the lap, the first being 0 (default: `checkpoints` evenly spaced). */
  checkpointAt?: number[];
  /** Checkpoints that have a repair station (default: all of them). */
  stations?: number[];
  /** 'asphalt': a paved road with much more grip (CarStats asphaltGrip/asphaltSlip), painted lines, no marker stakes. Default 'sand'. */
  surface?: 'sand' | 'asphalt';
  /** Concrete walls along both sides: gaps (m) from the road edge on straights, and on the inside / outside of bends (see TrackWalls). */
  walls?: { straight: number; inside: number; outside: number };
  /** Laps in a race (default DIRECTOR_CONFIG.laps). */
  laps?: number;
  /** Parked cars beside the road (default DIRECTOR_CONFIG.parkedCount). */
  parked?: number;
  /**
   * How the player is guided: 'bends' (default) = the guide arrow previewing the bends ahead; 'checkpoints' =
   * a beacon on the next checkpoint instead (a short track where every bend is in sight anyway).
   */
  guide?: 'bends' | 'checkpoints';
}

/** One rounded corner, as laid out along the track. */
export interface Bend {
  corner: number;
  /** Distances along the track where the arc starts and ends (end may exceed length when it wraps). */
  start: number;
  end: number;
  radius: number;
  /** Signed turn (radians, positive = left). */
  turn: number;
}

export interface Projection {
  /** Distance along the track (0..length). */
  s: number;
  /** Signed offset from the centreline, positive = left of the travel direction. */
  lateral: number;
  /** Absolute distance from the centreline. */
  distance: number;
  /** Index of the sample segment, usable as the `hint` of the next query. */
  index: number;
}

const SAMPLE_STEP = 2;
const LOCAL_WINDOW = 60;
/** A car more than this far (m) off the edge of the stretch it's on, and SWITCH_MARGIN m closer to another stretch, is on that one now. */
const SWITCH_OFF_ROAD = 1;
const SWITCH_MARGIN = 4;
/** Length (m) of the blend between road and open sand. */
const SAND_RAMP = 30;

interface Piece {
  len: number;
  /** Signed curvature (1/m, positive left); 0 for straights. */
  k: number;
  x: number;
  z: number;
  h: number;
  jump?: number;
  /** Corner index, for arcs. */
  corner?: number;
}

export class TrackPath {
  readonly def: TrackDef;
  readonly length: number;
  readonly count: number;
  readonly step: number;
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  /** Unit tangent (travel direction). */
  readonly txs: Float64Array;
  readonly tzs: Float64Array;
  /** Signed curvature (1/m, positive = turning left). */
  readonly curvature: Float64Array;
  /** Road surface height per sample. Zero until the terrain carver fills it in. */
  readonly elevation: Float64Array;
  /** Distances along the track of the jump lips. */
  readonly jumps: number[] = [];
  /** Distances along the track of each checkpoint; checkpoint 0 is the start/finish line at s = 0. */
  readonly checkpoints: number[] = [];
  /** Every rounded corner in driving order (by start). */
  readonly bends: Bend[] = [];
  /** Per sample: 0 = packed road, 1 = open sand (no road), blended over SAND_RAMP metres. */
  readonly sandiness: Float64Array;
  get halfWidth(): number {
    return this.def.halfWidth;
  }

  constructor(def: TrackDef) {
    this.def = def;
    const pieces = layOut(def);
    const total = pieces.reduce((a, p) => a + p.len, 0);
    this.count = Math.max(8, Math.round(total / SAMPLE_STEP));
    this.length = total;
    this.step = total / this.count;
    const n = this.count;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.txs = new Float64Array(n);
    this.tzs = new Float64Array(n);
    this.curvature = new Float64Array(n);
    this.elevation = new Float64Array(n);

    let pi = 0;
    let base = 0;
    for (let i = 0; i < n; i++) {
      const s = i * this.step;
      while (pi < pieces.length - 1 && s >= base + pieces[pi]!.len) base += pieces[pi++]!.len;
      const p = pieces[pi]!;
      const u = s - base;
      const h = p.h + p.k * u;
      const [dx, dz] = advance(p.h, p.k, u);
      this.xs[i] = p.x + dx;
      this.zs[i] = p.z + dz;
      this.txs[i] = Math.sin(h);
      this.tzs[i] = Math.cos(h);
      this.curvature[i] = p.k;
    }
    base = 0;
    for (const p of pieces) {
      if (p.jump !== undefined) this.jumps.push(base + p.len * p.jump);
      if (p.corner !== undefined) {
        this.bends.push({ corner: p.corner, start: base, end: base + p.len, radius: 1 / Math.abs(p.k), turn: p.k * p.len });
      }
      base += p.len;
    }
    const at = def.checkpointAt ?? Array.from({ length: def.checkpoints }, (_, c) => c / def.checkpoints);
    if (at.length !== def.checkpoints || at[0] !== 0) throw new Error(`${def.id}: checkpointAt must list ${def.checkpoints} lap fractions starting at 0`);
    for (const f of at) this.checkpoints.push(f * total);

    this.sandiness = new Float64Array(n);
    const mid = (corner: number) => {
      const b = this.bends.find((x) => x.corner === corner);
      if (!b) throw new Error(`${def.id}: sand range names corner ${corner}, which has no arc`);
      return (b.start + b.end) / 2;
    };
    for (const [from, to] of def.sand ?? []) {
      const a = mid(from);
      const len = this.wrap(mid(to) - a);
      for (let i = 0; i < n; i++) {
        const u = this.wrap(i * this.step - a);
        if (u > len) continue;
        const ramp = Math.min(1, u / SAND_RAMP, (len - u) / SAND_RAMP);
        this.sandiness[i] = Math.max(this.sandiness[i]!, ramp * ramp * (3 - 2 * ramp));
      }
    }
  }

  /**
   * The next bend (radius ≤ maxRadius) starting within `within` metres of s, or the one we are in.
   * Bends that follow it in the same direction with less than `chain` m of straight between are
   * merged into it (a hairpin built from two corners reads as one 150° turn).
   */
  nextBend(s: number, within: number, maxRadius: number, chain = 60): { distance: number; turn: number; radius: number } | null {
    const bends = this.bends;
    let first = -1;
    let best = Infinity;
    bends.forEach((b, i) => {
      if (b.radius > maxRadius) return;
      const inside = this.wrap(s - b.start) <= b.end - b.start;
      const d = inside ? 0 : this.wrap(b.start - s);
      if (d <= within && d < best) {
        best = d;
        first = i;
      }
    });
    if (first < 0) return null;
    let { turn, radius, end } = bends[first]!;
    for (let k = 1; k < bends.length; k++) {
      const b = bends[(first + k) % bends.length]!;
      if (Math.sign(b.turn) !== Math.sign(turn) || this.wrap(b.start - end) > chain) break;
      turn += b.turn;
      radius = Math.min(radius, b.radius);
      end = b.end;
    }
    return { distance: best, turn, radius };
  }

  /** Paved (asphalt) track. */
  get paved(): boolean {
    return this.def.surface === 'asphalt';
  }

  /** Whether checkpoint i has a repair station. */
  hasStation(i: number): boolean {
    return this.def.stations?.includes(i) ?? true;
  }

  /** Index of the sample at or before s (a `project` hint for a car known to be at s). */
  indexAt(s: number): number {
    return this.locate(s)[0];
  }

  /**
   * Distance from (x, z) to the centreline, ignoring the stretch within `window` m of s along it:
   * how close some *other* part of the track comes (e.g. the road crossing this one).
   */
  distanceElsewhere(x: number, z: number, s: number, window: number): number {
    const best: Projection = { s: 0, lateral: 0, distance: Infinity, index: 0 };
    for (let i = 0; i < this.count; i++) {
      const u = this.wrap(i * this.step - s);
      if (Math.min(u, this.length - u) > window) this.projectOnto(i, x, z, best);
    }
    return best.distance;
  }

  /** 0 = packed road .. 1 = open sand at s. */
  sandAt(s: number): number {
    const [i, j, f] = this.locate(s);
    return this.sandiness[i]! + (this.sandiness[j]! - this.sandiness[i]!) * f;
  }

  /** Wraps any distance into 0..length. */
  wrap(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  pointAt(s: number, out: { x: number; z: number }): { x: number; z: number } {
    const [i, j, f] = this.locate(s);
    out.x = this.xs[i]! + (this.xs[j]! - this.xs[i]!) * f;
    out.z = this.zs[i]! + (this.zs[j]! - this.zs[i]!) * f;
    return out;
  }

  /** Unit tangent (travel direction) at s. */
  tangentAt(s: number, out: { x: number; z: number }): { x: number; z: number } {
    const [i, j, f] = this.locate(s);
    const x = this.txs[i]! + (this.txs[j]! - this.txs[i]!) * f;
    const z = this.tzs[i]! + (this.tzs[j]! - this.tzs[i]!) * f;
    const l = Math.hypot(x, z) || 1;
    out.x = x / l;
    out.z = z / l;
    return out;
  }

  /** Yaw (car convention) of the travel direction at s. */
  headingAt(s: number): number {
    const t = this.tangentAt(s, { x: 0, z: 0 });
    return Math.atan2(t.x, t.z);
  }

  curvatureAt(s: number): number {
    return this.curvature[this.locate(s)[0]]!;
  }

  heightAt(s: number): number {
    const [i, j, f] = this.locate(s);
    return this.elevation[i]! + (this.elevation[j]! - this.elevation[i]!) * f;
  }

  /**
   * Nearest point on the centreline. With a `hint` (the previous result's index) it searches
   * locally first, which keeps the answer continuous where two parts of the track run close (and
   * across the crossing of a figure 8), until the car is off the road and clearly on another stretch.
   */
  project(x: number, z: number, hint = -1): Projection {
    const n = this.count;
    let best: Projection = { s: 0, lateral: 0, distance: Infinity, index: 0 };
    if (hint >= 0) {
      for (let o = -LOCAL_WINDOW; o <= LOCAL_WINDOW; o++) this.projectOnto((((hint + o) % n) + n) % n, x, z, best);
      // Trust the local answer unless the car has wandered far from this stretch of road.
      const edge = Math.abs(best.index - hint) % n;
      if (best.distance < 40 && Math.min(edge, n - edge) < LOCAL_WINDOW - 2) {
        if (best.distance <= this.halfWidth + SWITCH_OFF_ROAD) return best;
        // Off this road: if it's clearly on another stretch (spun round at a crossing), follow that one instead.
        const local = best;
        best = { s: 0, lateral: 0, distance: Infinity, index: 0 };
        for (let i = 0; i < n; i++) this.projectOnto(i, x, z, best);
        return best.distance < local.distance - SWITCH_MARGIN ? best : local;
      }
      best = { s: 0, lateral: 0, distance: Infinity, index: 0 };
    }
    for (let i = 0; i < n; i++) this.projectOnto(i, x, z, best);
    return best;
  }

  private projectOnto(i: number, x: number, z: number, best: Projection): void {
    const j = (i + 1) % this.count;
    const ax = this.xs[i]!;
    const az = this.zs[i]!;
    const bx = this.xs[j]! - ax;
    const bz = this.zs[j]! - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz)));
    const px = x - (ax + bx * t);
    const pz = z - (az + bz * t);
    const d = Math.hypot(px, pz);
    if (d >= best.distance) return;
    const len = Math.hypot(bx, bz) || 1;
    best.distance = d;
    best.index = i;
    best.s = (i + t) * this.step;
    // Left normal of (tx, tz) is (tz, -tx).
    best.lateral = (px * bz - pz * bx) / len;
  }

  private locate(s: number): [number, number, number] {
    const u = this.wrap(s) / this.step;
    const i = Math.min(this.count - 1, Math.floor(u));
    return [i, (i + 1) % this.count, u - i];
  }
}

/** Offset after travelling `u` metres from heading h with signed curvature k. */
function advance(h: number, k: number, u: number): [number, number] {
  if (Math.abs(k) < 1e-9) return [Math.sin(h) * u, Math.cos(h) * u];
  return [(Math.cos(h) - Math.cos(h + k * u)) / k, (Math.sin(h + k * u) - Math.sin(h)) / k];
}

/** Rounds each polygon corner with its arc and returns straights and arcs, starting at the start line. */
function layOut(def: TrackDef): Piece[] {
  const c = def.corners;
  const n = c.length;
  const dir = (i: number): [number, number] => {
    const a = c[i % n]!;
    const b = c[(i + 1) % n]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    return [(b.x - a.x) / l, (b.z - a.z) / l];
  };
  // Per corner: turn angle (positive = left) and how far the arc reaches back along each edge.
  const turns = c.map((_, i) => {
    const [ix, iz] = dir(i + n - 1);
    const [ox, oz] = dir(i);
    return Math.atan2(iz * ox - ix * oz, ix * ox + iz * oz);
  });
  const reach = c.map((p, i) => p.r * Math.tan(Math.abs(turns[i]!) / 2));

  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const a = c[i]!;
    const b = c[(i + 1) % n]!;
    const [dx, dz] = dir(i);
    const h = Math.atan2(dx, dz);
    const len = Math.hypot(b.x - a.x, b.z - a.z) - reach[i]! - reach[(i + 1) % n]!;
    pieces.push({ len, k: 0, x: a.x + dx * reach[i]!, z: a.z + dz * reach[i]!, h, jump: a.jump });
    const j = (i + 1) % n;
    const t = turns[j]!;
    const arcLen = Math.abs(t) * b.r;
    if (arcLen > 1e-6) pieces.push({ len: arcLen, k: Math.sign(t) / b.r, x: b.x - dx * reach[j]!, z: b.z - dz * reach[j]!, h, corner: j });
  }
  // Split the first straight so s = 0 is at def.start along it (its midpoint by default).
  const first = pieces[0]!;
  const f = def.start ?? 0.5;
  const before = first.len * f;
  const tail: Piece = { ...first, len: before, jump: first.jump === undefined ? undefined : first.jump / f };
  const head: Piece = { ...first, len: first.len - before, x: first.x + Math.sin(first.h) * before, z: first.z + Math.cos(first.h) * before, jump: undefined };
  if (first.jump !== undefined && first.jump > f) {
    head.jump = (first.jump - f) / (1 - f);
    tail.jump = undefined;
  }
  return [head, ...pieces.slice(1), tail];
}

/** Length of each straight between corner arcs (negative = arcs overlap; the layout is invalid). */
export function straightLengths(def: TrackDef): number[] {
  return layOut(def).filter((p) => p.k === 0).map((p) => p.len);
}
