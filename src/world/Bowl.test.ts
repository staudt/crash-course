import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { ArenaWall } from './ArenaWall';
import { BOWL_CONFIG as C, bowlProfile, carveBowl } from './Bowl';
import { generateTerrain, sampleHeight, sampleSoftness, toRapierHeights } from './TerrainData';

beforeAll(async () => {
  await RAPIER.init();
});

describe('bowlProfile', () => {
  it('is flat on the floor, bankHeight at the wall, monotonic and gentle', () => {
    expect(bowlProfile(0)).toBe(0);
    expect(bowlProfile(C.floorRadius)).toBe(0);
    expect(bowlProfile(C.wallRadius)).toBe(C.bankHeight);
    let prev = 0;
    for (let r = 0; r <= C.wallRadius + 5; r += 0.1) {
      const h = bowlProfile(r);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
      expect((h - prev) / 0.1).toBeLessThanOrEqual(0.45);
      prev = h;
    }
  });
  it('bankHeight 0 gives a flat floor up to the wall', () => {
    expect(bowlProfile(C.wallRadius, { ...C, bankHeight: 0 })).toBe(0);
  });
});

describe('carveBowl', () => {
  const data = generateTerrain({ seed: 1337, n: 321, size: 640 });
  carveBowl(data);
  it('has a floor within the roll amplitude', () => {
    for (let x = -72; x <= 72; x += 3) {
      for (let z = -72; z <= 72; z += 3) {
        if (Math.hypot(x, z) >= 72) continue;
        expect(Math.abs(sampleHeight(data, x, z))).toBeLessThanOrEqual(C.floorRoll + 1e-4);
      }
    }
  });
  it('sets mud and softness', () => {
    const n = data.n;
    expect(data.mud![Math.floor(n / 2) * n + Math.floor(n / 2)]).toBeGreaterThan(0.99);
    expect(data.mud![Math.floor(n / 2) * n + n - 2]).toBe(0);
    expect(sampleSoftness(data, 0, 0)).toBeCloseTo(C.floorSoftness, 1);
    expect(sampleSoftness(data, 50, 30)).toBeCloseTo(C.floorSoftness, 1);
    expect(sampleSoftness(data, C.floorRadius + C.bankWidth / 2, 0)).toBeGreaterThanOrEqual(0.5);
  });
  it('keeps the bank top level under the wall and bank slopes drivable', () => {
    for (let a = 0; a < 6.28; a += 0.2) {
      const h = sampleHeight(data, C.wallRadius * Math.cos(a), C.wallRadius * Math.sin(a));
      expect(h).toBeCloseTo(C.bankHeight, 1);
    }
  });
});

describe('ArenaWall', () => {
  it('holds a 30 m/s car', () => {
    const data = generateTerrain({ seed: 1337, n: 321, size: 640 });
    carveBowl(data);
    const physics = new Physics();
    physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(data.n - 1, data.n - 1, toRapierHeights(data), { x: data.size, y: 1, z: data.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
      physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
    );
    new ArenaWall(new THREE.Scene(), physics, C, (x, z) => sampleHeight(data, x, z));
    const x0 = C.wallRadius - 8;
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x0, C.bankHeight + 1, 0).setLinvel(30, 0, 0).setCcdEnabled(true),
    );
    body.setSoftCcdPrediction?.(1.5);
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.3, 2.2).setMass(1300).setFriction(0.5), body);
    let maxR = 0;
    for (let i = 0; i < 180; i++) {
      physics.step();
      const t = body.translation();
      maxR = Math.max(maxR, Math.hypot(t.x, t.z));
    }
    expect(maxR).toBeLessThan(C.wallRadius);
  });
});
