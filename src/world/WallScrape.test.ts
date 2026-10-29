import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Car } from '../vehicle/Car';
import { buildCarModel } from '../vehicle/CarBuilder';
import { cloneStats } from '../vehicle/CarStats';
import { ConcreteWall, wallBoxes } from './ArenaWall';
import type { WallBlock } from './TrackWalls';

beforeAll(async () => {
  await RAPIER.init();
});

/** 100 blocks of 4 m along +z with their face at x = 8; `kink` bends alternate joints by ±kink rad (like chords round a curve). */
function blockWall(kink = 0): WallBlock[] {
  const out: WallBlock[] = [];
  let x = 8.6;
  let z = -200;
  for (let i = 0; i < 100; i++) {
    const a = (i % 2 ? 1 : -1) * kink;
    const dx = Math.sin(a) * 4;
    const dz = Math.cos(a) * 4;
    out.push({ x: x + dx / 2, z: z + dz / 2, length: 4, yaw: Math.atan2(-dz, dx) });
    x += dx;
    z += dz;
  }
  return out;
}

/** A car at 100 km/h, full throttle, wheel straight, heading `angle` rad into the wall; 2.5 s later. */
function drive(angle: number, kink = 0) {
  const physics = new Physics();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0).setFriction(0.9), ground);
  new ConcreteWall(new THREE.Scene(), physics, blockWall(kink), { height: 1.8, thickness: 1.2, smooth: true }, () => 0);
  physics.onContactForce(({ a, b }) => {
    const ca = physics.ownerOf(a);
    const cb = physics.ownerOf(b);
    if (ca instanceof Car) ca.recordContact(b);
    if (cb instanceof Car) cb.recordContact(a);
  });
  let scrapes = 0;
  const car = new Car(physics, buildCarModel({ color: '#c33' }), cloneStats(), { position: { x: 0, y: 1.2, z: -100 }, yaw: angle }, { onScrape: () => scrapes++ });
  car.walls = (c, x, z) => {
    const o = physics.ownerOf(c);
    return o instanceof ConcreteWall ? o.normalAt(x, z) : null;
  };
  const step = () => {
    car.fixedUpdate(physics.dt);
    physics.step();
    car.postStep();
  };
  for (let i = 0; i < 60; i++) step();
  car.body.setLinvel({ x: Math.sin(angle) * 28, y: 0, z: Math.cos(angle) * 28 }, true);
  car.input.throttle = 1;
  let minSpeed = Infinity;
  let knock = 0;
  for (let i = 0; i < 150; i++) {
    step();
    minSpeed = Math.min(minSpeed, car.speed);
    knock = Math.max(knock, car.knock);
  }
  return { car, minSpeed, knock, scrapes, hpLost: car.stats.maxHealth - car.health };
}

describe('scraping along concrete walls', () => {
  it('a straight run of blocks is one collider', () => {
    const blocks = blockWall();
    expect(wallBoxes(blocks, blocks.map(() => -0.5), blocks.map(() => 1.8), 1.2)).toHaveLength(1);
    const kinked = blockWall(0.035);
    expect(wallBoxes(kinked, kinked.map(() => -0.5), kinked.map(() => 1.8), 1.2)).toHaveLength(100);
  });

  it('riding into a wall at a shallow angle slides along it at speed, scratched, not crashed', () => {
    for (const kink of [0, 0.035]) {
      for (const deg of [5, 10, 20]) {
        const r = drive((deg * Math.PI) / 180, kink);
        const tag = `${deg}° kink ${kink}: ${JSON.stringify({ min: r.minSpeed, knock: r.knock, hp: r.hpLost, scrapes: r.scrapes })}`;
        expect(r.minSpeed, tag).toBeGreaterThan(25); // never stopped dead (it entered at 28)
        expect(r.knock, tag).toBe(0);
        expect(r.hpLost, tag).toBeLessThan(10);
        expect(r.scrapes, tag).toBeGreaterThan(0); // sparks
      }
    }
    // Scratched: dented bodywork and a little wear, but every part still on with full HP.
    const { car, hpLost } = drive((10 * Math.PI) / 180);
    const d = car.damageReport();
    expect(car.damaged).toBe(true);
    expect(hpLost).toBeGreaterThan(0);
    expect([d.bumperFront, d.doorLeft, d.doorRight, d.bumperRear, ...d.wheels]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('a steep hit is still a crash', () => {
    const r = drive((70 * Math.PI) / 180);
    expect(r.hpLost).toBeGreaterThan(30);
    expect(r.knock).toBeGreaterThan(0.5);
  });
});
