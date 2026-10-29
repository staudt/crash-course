import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BEACON_CONFIG as C, CheckpointBeacon } from './CheckpointBeacon';

describe('CheckpointBeacon', () => {
  it('starts hidden, stands where it is placed, and bobs its diamond over the gate', () => {
    const scene = new THREE.Scene();
    const beacon = new CheckpointBeacon(scene);
    expect(beacon.visible).toBe(false);
    beacon.place(10, 2, -5);
    const root = scene.children[0]!;
    expect(root.position.toArray()).toEqual([10, 2, -5]);
    const heights = new Set<number>();
    for (let i = 0; i < 20; i++) {
      beacon.update(0.05);
      const diamond = root.children[0]!;
      expect(Math.abs(diamond.position.y - C.height)).toBeLessThanOrEqual(C.bob + 1e-9);
      heights.add(Math.round(diamond.position.y * 100));
    }
    expect(heights.size).toBeGreaterThan(5);
  });
});
