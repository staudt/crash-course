import { describe, expect, it } from 'vitest';
import { turnArrowGeometry } from './GuideArrow';

/** Centroid (x, z) of the arrowhead (the last triangle) and the start of the shaft (first vertex). */
function shape(turn: number) {
  const p = turnArrowGeometry(turn).getAttribute('position');
  const n = p.count;
  const head = { x: (p.getX(n - 1) + p.getX(n - 2) + p.getX(n - 3)) / 3, z: (p.getZ(n - 1) + p.getZ(n - 2) + p.getZ(n - 3)) / 3 };
  return { head, start: { x: p.getX(0), z: p.getZ(0) } };
}

describe('turnArrowGeometry', () => {
  it('points straight ahead (+Z) with no bend', () => {
    const { head } = shape(0);
    expect(Math.abs(head.x)).toBeLessThan(1e-6);
    expect(head.z).toBeGreaterThan(1);
  });

  it('curves toward +X (left) for a left bend and -X for a right one', () => {
    const left = shape(Math.PI / 2);
    const right = shape(-Math.PI / 2);
    expect(left.head.x).toBeGreaterThan(left.start.x + 1);
    expect(right.head.x).toBeLessThan(right.start.x - 1);
  });

  it('a hairpin turns the head back toward the start', () => {
    const { head, start } = shape(Math.PI * 0.85);
    // The head has come round to roughly beside the shaft, not ahead of it.
    expect(head.z - start.z).toBeLessThan(3);
  });

  it('stays centred so it does not stray off screen', () => {
    for (const turn of [0, 1, -2, 2.6]) {
      const g = turnArrowGeometry(turn);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      expect(Math.abs(b.min.x + b.max.x)).toBeLessThan(1e-4);
      expect(Math.abs(b.min.z + b.max.z)).toBeLessThan(1e-4);
    }
  });
});
