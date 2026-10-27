import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Particles } from './Particles';

describe('Particles', () => {
  it('survives overflow and hides everything eventually', () => {
    const scene = new THREE.Scene();
    const p = new Particles(scene);
    const sizes = scene.children.map((c) => (c as THREE.InstancedMesh).instanceMatrix.array.length);
    const v = new THREE.Vector3(1, 0, 1);
    const pos = new THREE.Vector3();
    const n = new THREE.Vector3(0, 1, 0);
    expect(() => {
      for (let i = 0; i < 400; i++) {
        p.emitDust(pos, v, 1);
        p.emitSmoke(pos, 1);
        p.emitImpact(pos, n, 1);
      }
      p.emitSparks(pos, n, 1000);
    }).not.toThrow();
    p.update(0.016);
    expect(scene.children.map((c) => (c as THREE.InstancedMesh).instanceMatrix.array.length)).toEqual(sizes);
    for (let i = 0; i < 300; i++) p.update(0.016);
    for (const c of scene.children) {
      const arr = (c as THREE.InstancedMesh).instanceMatrix.array;
      for (let i = 0; i < arr.length; i += 16) expect(arr[i]).toBe(0);
    }
  });
});
