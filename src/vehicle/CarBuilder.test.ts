import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCarModel, type CarVariant } from './CarBuilder';
import { DEFAULT_DIMS, type PartKind } from './CarStats';
import { WHEEL_ORDER } from './CarModel';

const variants: CarVariant[] = ['sedan', 'pickup'];

describe.each(variants)('buildCarModel (%s)', (variant) => {
  const model = buildCarModel({ color: 0xcc3322, variant });
  const d = DEFAULT_DIMS;

  it('has exactly the expected parts', () => {
    const kinds = model.parts.map((p) => p.kind).sort();
    const expected: PartKind[] = [
      'body', 'cabin', 'hood', 'bumperFront', 'bumperRear', 'doorLeft', 'doorRight',
      'wheel', 'wheel', 'wheel', 'wheel',
    ];
    expect(kinds).toEqual(expected.sort());
  });

  it('places wheel pivots per WHEEL_ORDER', () => {
    expect(model.wheelPivots).toHaveLength(4);
    WHEEL_ORDER.forEach((id, i) => {
      const pivot = model.wheelPivots[i]!;
      expect(pivot.position.x).toBeCloseTo(id[1] === 'L' ? d.wheelX : -d.wheelX);
      expect(pivot.position.y).toBeCloseTo(d.wheelY);
      expect(pivot.position.z).toBeCloseTo(id[0] === 'F' ? d.wheelZ : -d.wheelZ);
      const wheel = model.parts.find((p) => p.wheelIndex === i)!;
      expect(wheel.kind).toBe('wheel');
      expect(wheel.mesh.parent).toBe(pivot);
      expect(wheel.mesh.position.length()).toBe(0);
      expect(wheel.halfExtents.x).toBeCloseTo(d.wheelWidth / 2);
      expect(wheel.halfExtents.y).toBeCloseTo(d.wheelRadius, 1);
    });
  });

  it('parents non-wheel parts to root with wheelIndex -1', () => {
    for (const p of model.parts.filter((q) => q.kind !== 'wheel')) {
      expect(p.wheelIndex).toBe(-1);
      expect(p.mesh.parent).toBe(model.root);
    }
  });

  it('has indexed, centred, subdivided geometry', () => {
    for (const p of model.parts) {
      const g = p.mesh.geometry;
      expect(g.index).not.toBeNull();
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      expect(c.length()).toBeLessThan(0.01);
      expect(p.mesh.castShadow && p.mesh.receiveShadow).toBe(true);
    }
    const count = (k: PartKind) => model.parts.find((p) => p.kind === k)!.mesh.geometry.getAttribute('position').count;
    expect(count('body')).toBeGreaterThanOrEqual(200);
    expect(count('hood')).toBeGreaterThan(50);
    expect(count('cabin')).toBeGreaterThan(100);
  });

  it('fits within the chassis footprint (excluding wheels)', () => {
    const bb = new THREE.Box3();
    for (const p of model.parts.filter((q) => q.kind !== 'wheel')) {
      p.mesh.geometry.computeBoundingBox();
      const b = p.mesh.geometry.boundingBox!.clone().translate(p.mesh.position);
      bb.union(b);
    }
    expect(bb.max.x).toBeLessThanOrEqual(d.halfWidth + 0.15);
    expect(bb.min.x).toBeGreaterThanOrEqual(-(d.halfWidth + 0.15));
    expect(bb.max.z).toBeLessThanOrEqual(d.halfLength + 0.25);
    expect(bb.min.z).toBeGreaterThanOrEqual(-(d.halfLength + 0.25));
    expect(bb.min.y).toBeGreaterThanOrEqual(-0.4);
  });

  it('uses vertex colours on the cabin', () => {
    const cabin = model.parts.find((p) => p.kind === 'cabin')!;
    expect(cabin.mesh.geometry.getAttribute('color')).toBeDefined();
    expect((cabin.mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });
});

describe('material sharing', () => {
  it('shares materials between cars of the same colour', () => {
    const a = buildCarModel({ color: 0x3366cc, variant: 'sedan' });
    const b = buildCarModel({ color: 0x3366cc, variant: 'pickup' });
    for (const kind of ['body', 'hood', 'doorLeft', 'cabin', 'bumperFront'] as const) {
      const ma = a.parts.find((p) => p.kind === kind)!.mesh.material;
      const mb = b.parts.find((p) => p.kind === kind)!.mesh.material;
      expect(ma).toBe(mb);
    }
    const wa = a.parts.find((p) => p.kind === 'wheel')!.mesh.material as THREE.Material[];
    const wb = b.parts.find((p) => p.kind === 'wheel')!.mesh.material as THREE.Material[];
    wa.forEach((m, i) => expect(m).toBe(wb[i]));
  });

  it('uses different paint for different colours', () => {
    const a = buildCarModel({ color: 0x3366cc });
    const b = buildCarModel({ color: 0xffcc00 });
    expect(a.parts[0]!.mesh.material).not.toBe(b.parts[0]!.mesh.material);
  });
});
