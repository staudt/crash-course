import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Race } from '../race/Race';
import { TrackPath } from '../race/TrackPath';
import { DUNE_LOOP } from '../race/tracks';
import { Car } from '../vehicle/Car';
import { buildCarModel } from '../vehicle/CarBuilder';
import { cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { buildElevation, carveRoad } from '../world/Road';
import { generateTerrain, sampleHeight, sampleSoftness, toRapierHeights } from '../world/TerrainData';
import { Autopilot } from './Autopilot';

beforeAll(async () => {
  await RAPIER.init();
});

describe('Autopilot on the Dune Loop', () => {
  it('laps the track on the road in about 3 minutes', () => {
    const path = new TrackPath(DUNE_LOOP);
    const data = generateTerrain({ n: 769, size: 2048 });
    buildElevation(path, data);
    carveRoad(data, path);

    const physics = new Physics();
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const ground = physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(data.n - 1, data.n - 1, toRapierHeights(data), { x: data.size, y: 1, z: data.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
      body,
    );

    const stats = cloneStats();
    const start = path.pointAt(-12, { x: 0, z: 0 });
    const car = new Car(physics, buildCarModel({ color: '#c33' }), stats, {
      position: { x: start.x, y: sampleHeight(data, start.x, start.z) + 1.3, z: start.z },
      yaw: path.headingAt(0),
    });
    car.surface = (c, x, z) => (c === ground ? sampleSoftness(data, x, z) : 0);

    const pilot = new Autopilot(path, { maxSteer: stats.maxSteer, steerFadeSpeed: stats.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ });
    const race = new Race(path);
    const fwd = new THREE.Vector3();
    let lapTime = 0;
    let worstOff = 0;
    let hint = -1;
    const prev = { x: start.x, z: start.z };
    for (let step = 0; step < 60 * 300 && !lapTime; step++) {
      const t = car.body.translation();
      car.forward(fwd).setY(0).normalize();
      if (race.phase === 'racing') pilot.drive({ x: t.x, z: t.z, fx: fwd.x, fz: fwd.z, speed: car.forwardSpeed }, car.input);
      car.fixedUpdate(physics.dt);
      physics.step();
      car.postStep();
      const now = car.body.translation();
      const lv = car.body.linvel();
      for (const e of race.update(physics.dt, prev, now, { x: lv.x, z: lv.z })) if (e.type === 'lap') lapTime = e.time;
      prev.x = now.x;
      prev.z = now.z;
      const p = path.project(now.x, now.z, hint);
      hint = p.index;
      if (race.phase === 'racing') worstOff = Math.max(worstOff, p.distance);
    }
    // The autopilot knows the track perfectly (~2:50 with the sand stretches); a person should land near 3:00.
    expect(lapTime).toBeGreaterThan(140);
    expect(lapTime).toBeLessThan(185);
    expect(worstOff).toBeLessThan(path.halfWidth + 3);
    expect(car.wrecked).toBe(false);
  }, 120_000);
});
