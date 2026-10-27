import type { Vec3Like } from '../core/types';

export interface DentParams {
  /** Vertices further than this from the impact point are untouched. */
  radius: number;
  /** Displacement at the impact centre (metres). */
  depth: number;
  /** Max distance any vertex may end up from its original position. */
  maxDent: number;
  /** 0..1 amount of positional noise that makes dents look crumpled. */
  noise: number;
}

/**
 * Smooth crumple field in [-1, 1] with a ~0.5 m wavelength. Smooth (not per-vertex
 * random) so neighbouring vertices fold together instead of spiking, and
 * position-based so seam vertices that share a position move together.
 */
function crumple(x: number, y: number, z: number): number {
  return (
    0.6 * Math.sin(x * 11.3 + y * 4.1 + 1.7) * Math.sin(z * 9.7 - y * 6.3 + 0.4) +
    0.4 * Math.sin(x * 5.9 - z * 7.7 + 2.9) * Math.sin(y * 13.1 + z * 3.3)
  );
}

/**
 * Pushes vertices near `point` along `dir` (unit vector, the direction the
 * metal is pushed, i.e. into the body). `positions` is modified in place;
 * `original` is the undamaged shape and is never written. Both are xyz
 * triplets in the same local space as `point`/`dir`.
 *
 * Returns the total displacement added (sum over vertices, metres): a
 * rough measure of how much damage this dent did.
 */
export function applyDent(
  positions: Float32Array,
  original: Float32Array,
  point: Vec3Like,
  dir: Vec3Like,
  p: DentParams,
): number {
  const r2 = p.radius * p.radius;
  const max2 = p.maxDent * p.maxDent;
  let total = 0;

  for (let i = 0; i < positions.length; i += 3) {
    const ox = original[i], oy = original[i + 1], oz = original[i + 2];
    const px = positions[i], py = positions[i + 1], pz = positions[i + 2];
    // Distance is measured on the current (already dented) shape so repeated hits keep pushing.
    const dx = px - point.x, dy = py - point.y, dz = pz - point.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;

    const t = 1 - Math.sqrt(d2) / p.radius;
    const falloff = t * t * (3 - 2 * t); // smoothstep
    const n = 1 + p.noise * crumple(ox, oy, oz);
    const amount = p.depth * falloff * n;
    if (amount <= 0) continue;

    let nx = px + dir.x * amount;
    let ny = py + dir.y * amount;
    let nz = pz + dir.z * amount;

    // Clamp the total offset from the original shape.
    let ex = nx - ox, ey = ny - oy, ez = nz - oz;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > max2) {
      const k = p.maxDent / Math.sqrt(e2);
      ex *= k; ey *= k; ez *= k;
      nx = ox + ex; ny = oy + ey; nz = oz + ez;
    }

    const mx = nx - px, my = ny - py, mz = nz - pz;
    total += Math.sqrt(mx * mx + my * my + mz * mz);
    positions[i] = nx;
    positions[i + 1] = ny;
    positions[i + 2] = nz;
  }
  return total;
}
