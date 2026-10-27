import { describe, expect, it } from 'vitest';
import { applyDent, type DentParams } from './Deformer';

/** A flat grid of vertices on the z=0 plane, spacing 0.1, from -1..1. */
function grid(): Float32Array {
  const pts: number[] = [];
  for (let x = -10; x <= 10; x++) for (let y = -10; y <= 10; y++) pts.push(x / 10, y / 10, 0);
  return new Float32Array(pts);
}

const params: DentParams = { radius: 0.5, depth: 0.2, maxDent: 0.3, noise: 0 };
const origin = { x: 0, y: 0, z: 0 };
const inward = { x: 0, y: 0, z: -1 };

describe('applyDent', () => {
  it('pushes the impact centre by `depth` along dir', () => {
    const orig = grid();
    const pos = orig.slice();
    applyDent(pos, orig, origin, inward, params);
    const centre = (10 * 21 + 10) * 3; // x=0,y=0
    expect(pos[centre + 2]).toBeCloseTo(-0.2);
    expect(pos[centre]).toBeCloseTo(0);
  });

  it('leaves vertices outside the radius untouched', () => {
    const orig = grid();
    const pos = orig.slice();
    applyDent(pos, orig, origin, inward, params);
    for (let i = 0; i < pos.length; i += 3) {
      const d = Math.hypot(orig[i], orig[i + 1], orig[i + 2]);
      if (d >= params.radius) expect(pos[i + 2]).toBe(0);
    }
  });

  it('falls off with distance', () => {
    const orig = grid();
    const pos = orig.slice();
    applyDent(pos, orig, origin, inward, params);
    const at = (x: number) => pos[((x + 10) * 21 + 10) * 3 + 2];
    expect(Math.abs(at(0))).toBeGreaterThan(Math.abs(at(2)));
    expect(Math.abs(at(2))).toBeGreaterThan(Math.abs(at(4)));
  });

  it('clamps cumulative displacement to maxDent', () => {
    const orig = grid();
    const pos = orig.slice();
    for (let i = 0; i < 20; i++) applyDent(pos, orig, origin, inward, params);
    for (let i = 0; i < pos.length; i += 3) {
      const e = Math.hypot(pos[i] - orig[i], pos[i + 1] - orig[i + 1], pos[i + 2] - orig[i + 2]);
      expect(e).toBeLessThanOrEqual(params.maxDent + 1e-5);
    }
  });

  it('moves vertices sharing a position identically (seams stay closed)', () => {
    const orig = new Float32Array([0.1, 0.2, 0, 0.1, 0.2, 0]);
    const pos = orig.slice();
    applyDent(pos, orig, origin, inward, { ...params, noise: 0.5 });
    expect(pos[0]).toBe(pos[3]);
    expect(pos[1]).toBe(pos[4]);
    expect(pos[2]).toBe(pos[5]);
  });

  it('returns the total displacement added', () => {
    const orig = grid();
    const pos = orig.slice();
    expect(applyDent(pos, orig, origin, inward, params)).toBeGreaterThan(0.2);
    // Far away: nothing moves.
    expect(applyDent(pos, orig, { x: 5, y: 5, z: 0 }, inward, params)).toBe(0);
  });
});
