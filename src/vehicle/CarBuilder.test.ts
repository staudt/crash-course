import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCarModel, carMaterials, type CarVariant } from './CarBuilder';
import { DEFAULT_KITS } from './carkit/Styles';
import { DEFAULT_DIMS, type PartKind } from './CarStats';
import { WHEEL_ORDER } from './CarModel';
import { COCKPIT_CONFIG } from '../core/CameraRig';

const variants: CarVariant[] = ['sedan', 'pickup', 'muscle', 'wagon'];

function triangles(model: ReturnType<typeof buildCarModel>): number {
  let n = 0;
  for (const p of model.parts) n += p.mesh.geometry.index!.count / 3;
  return n;
}

describe.each(variants)('buildCarModel (%s)', (variant) => {
  const model = buildCarModel({ color: 0xcc3322, variant, number: 47 });
  const d = DEFAULT_DIMS;

  it('has exactly the expected parts', () => {
    const kinds = model.parts.map((p) => p.kind).sort();
    const expected: PartKind[] = [
      'body', 'cabin', 'hood', 'bumperFront', 'bumperRear', 'doorLeft', 'doorRight',
      'wheel', 'wheel', 'wheel', 'wheel',
    ];
    if (DEFAULT_KITS[variant].wing) expected.push('wing');
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

  it('has indexed, centred, subdivided, vertex-coloured geometry', () => {
    for (const p of model.parts) {
      const g = p.mesh.geometry;
      expect(g.index).not.toBeNull();
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      expect(c.length()).toBeLessThan(0.01);
      expect(p.mesh.castShadow && p.mesh.receiveShadow).toBe(true);
      expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
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

  it('puts the cockpit eye inside the cabin', () => {
    const cabin = model.parts.find((p) => p.kind === 'cabin')!;
    const bb = cabin.mesh.geometry.boundingBox!.clone().translate(cabin.mesh.position);
    expect(bb.containsPoint(COCKPIT_CONFIG.eye)).toBe(true);
  });

  it('stays within the triangle budget', () => {
    expect(triangles(model)).toBeLessThan(8000);
  });
});

describe('kit', () => {
  it('fits every bolt-on at once within the footprint', () => {
    const all = { pushBar: true, spikes: true, rearRam: true, plating: true, blower: true, wing: true, lightBar: true, roofRack: true, rust: 1 };
    for (const variant of variants) {
      const model = buildCarModel({ color: 0x777777, variant, kit: all, number: 88 });
      const bb = new THREE.Box3();
      for (const p of model.parts.filter((q) => q.kind !== 'wheel')) bb.union(p.mesh.geometry.boundingBox!.clone().translate(p.mesh.position));
      expect(bb.max.z).toBeLessThanOrEqual(DEFAULT_DIMS.halfLength + 0.25);
      expect(bb.min.z).toBeGreaterThanOrEqual(-(DEFAULT_DIMS.halfLength + 0.25));
      expect(Math.max(bb.max.x, -bb.min.x)).toBeLessThanOrEqual(DEFAULT_DIMS.halfWidth + 0.15);
      expect(triangles(model)).toBeLessThan(10000);
    }
  });

  it('only fits a wing when the kit asks for one', () => {
    expect(buildCarModel({ color: 0x777777, variant: 'sedan' }).parts.some((p) => p.kind === 'wing')).toBe(false);
    expect(buildCarModel({ color: 0x777777, variant: 'sedan', kit: { wing: true } }).parts.some((p) => p.kind === 'wing')).toBe(true);
  });
});

describe('materials and colour', () => {
  it('shares the same materials across every car, whatever its colour', () => {
    const a = buildCarModel({ color: 0x3366cc, variant: 'sedan' });
    const b = buildCarModel({ color: 0xffcc00, variant: 'pickup' });
    const m = carMaterials();
    for (const kind of ['body', 'hood', 'doorLeft', 'cabin', 'bumperFront', 'wheel'] as const) {
      const ma = a.parts.find((p) => p.kind === kind)!.mesh.material;
      const mb = b.parts.find((p) => p.kind === kind)!.mesh.material;
      expect(ma === m.body || ma === m.withLamps).toBe(true);
      if (kind !== 'body') expect(ma).toBe(mb);
    }
    // Head and tail lights are on the body, in the lamp group.
    expect(a.parts.find((p) => p.kind === 'body')!.mesh.material).toBe(m.withLamps);
  });

  it('bakes the paint into the vertex colours, weathered by the seed', () => {
    const colors = (opts: Parameters<typeof buildCarModel>[0]) =>
      (buildCarModel(opts).parts.find((p) => p.kind === 'cabin')!.mesh.geometry.getAttribute('color').array as Float32Array);
    const a = colors({ color: 0x3366cc, seed: 1 });
    expect(colors({ color: 0x3366cc, seed: 1 })).toEqual(a);
    expect(colors({ color: 0x3366cc, seed: 2 })).not.toEqual(a);
    expect(colors({ color: 0xffcc00, seed: 1 })).not.toEqual(a);
  });
});
