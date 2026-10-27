import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Race } from '../race/Race';
import { TrackPath } from '../race/TrackPath';
import { DUNE_LOOP } from '../race/tracks';
import { Car } from '../vehicle/Car';
import { buildCarModel } from '../vehicle/CarBuilder';
import { applyModifiers, cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { buildElevation, carveRoad } from '../world/Road';
import { generateTerrain, sampleHeight, sampleSoftness, toRapierHeights } from '../world/TerrainData';
import { RIVALS, RivalDriver, wasHit } from './Rival';

beforeAll(async () => {
  await RAPIER.init();
});

describe('Rivals racing the Dune Loop', () => {
  it('five AI personalities race a lap from a grid: they fight, but everyone finishes', () => {
    const path = new TrackPath(DUNE_LOOP);
    const data = generateTerrain({ n: 769, size: 2048 });
    buildElevation(path, data);
    carveRoad(data, path);
    const physics = new Physics();
    const ground = physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(data.n - 1, data.n - 1, toRapierHeights(data), { x: data.size, y: 1, z: data.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
      physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
    );
    const motion = (c: Car) => {
      const t = c.body.translation();
      const v = c.body.linvel();
      return { x: t.x, z: t.z, vx: v.x, vz: v.z };
    };
    let hits = 0;
    const fights = new Set<string>();
    const events = {
      onCarContact: (felt: Car, other: Car, impact: number) => {
        const victim = racers.find((r) => r.car === felt);
        const attacker = racers.findIndex((r) => r.car === other);
        if (!victim || attacker < 0) return;
        if (!wasHit(motion(felt), motion(other))) {
          victim.driver.rammed(attacker);
          return;
        }
        victim.driver.provoke(attacker, impact);
        hits++;
      },
    };
    physics.onContactForce(({ a, b }) => {
      const ca = physics.ownerOf(a);
      const cb = physics.ownerOf(b);
      if (ca instanceof Car) ca.recordContact(b);
      if (cb instanceof Car) cb.recordContact(a);
    });
    const stats = cloneStats();
    const steering = { maxSteer: stats.maxSteer, steerFadeSpeed: stats.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ };
    const spawn = (s: number, lat: number, profile: (typeof RIVALS)[number]) => {
      const q = path.pointAt(s, { x: 0, z: 0 });
      const t = path.tangentAt(s, { x: 0, z: 0 });
      const x = q.x + t.z * lat;
      const z = q.z - t.x * lat;
      const car = new Car(physics, buildCarModel({ color: profile.color, variant: profile.variant }), applyModifiers(cloneStats(), profile.car), { position: { x, y: sampleHeight(data, x, z) + 1.3, z }, yaw: path.headingAt(s) }, events);
      car.surface = (c, px, pz) => (c === ground ? sampleSoftness(data, px, pz) : 0);
      return car;
    };
    const racers = RIVALS.map((profile, slot) => ({
      car: spawn(-12 - Math.floor(slot / 2) * 10 - (slot % 2) * 5, slot % 2 ? -3.5 : 3.5, profile),
      driver: new RivalDriver(path, steering, profile),
      race: new Race(path),
      prev: { x: 0, z: 0 },
      lapTime: 0,
      rescues: 0,
      worstDamage: 0,
    }));
    for (const r of racers) {
      const t = r.car.body.translation();
      r.prev = { x: t.x, z: t.z };
    }
    const fwd = new THREE.Vector3();
    const dt = physics.dt;
    for (let step = 0; step < 60 * 260 && racers.some((r) => !r.lapTime); step++) {
      for (const r of racers) {
        if (r.race.phase !== 'racing') continue;
        const t = r.car.body.translation();
        r.car.forward(fwd).setY(0).normalize();
        const others = racers.filter((o) => o !== r).map((o) => {
          const q = o.car.body.translation();
          const v = o.car.body.linvel();
          return { id: racers.indexOf(o), x: q.x, z: q.z, vx: v.x, vz: v.z, ahead: o.race.progress - r.race.progress, offTrack: o.race.distance };
        });
        r.driver.drive({ x: t.x, z: t.z, fx: fwd.x, fz: fwd.z, speed: r.car.forwardSpeed }, others, 0, dt, r.car.input);
      }
      for (const r of racers) if (r.driver.target !== null) fights.add(`${r.driver.profile.name}→${racers[r.driver.target]!.driver.profile.name}`);
      for (const r of racers) r.car.fixedUpdate(dt);
      physics.step();
      for (const r of racers) r.car.postStep();
      for (const r of racers) {
        const t = r.car.body.translation();
        for (const e of r.race.update(dt, r.prev, t, r.car.body.linvel())) if (e.type === 'lap' && !r.lapTime) r.lapTime = e.time;
        r.prev = { x: t.x, z: t.z };
        r.worstDamage = Math.max(r.worstDamage, 1 - r.car.health / r.car.stats.maxHealth);
        if (r.race.phase === 'racing' && r.driver.needsRescue(r.car.speed, r.car.wrecked, dt, r.race.pastNextGate)) {
          // Same free-spot rule as RaceDirector.respawn.
          let p = r.race.respawnPose();
          let lane = 0;
          for (const lateral of [0, 4, -4, 6.5, -6.5]) {
            p = r.race.respawnPose(lateral);
            lane = lateral;
            if (racers.every((o) => o === r || Math.hypot(o.car.body.translation().x - p.x, o.car.body.translation().z - p.z) > 6)) break;
          }
          r.car.dispose();
          r.car = spawn(path.project(p.x, p.z).s, lane, r.driver.profile);
          r.driver.reset();
          r.prev = { x: p.x, z: p.z };
          r.rescues++;
        }
      }
    }
    const summary = racers.map((r) => `${r.driver.profile.name}: ${r.lapTime.toFixed(1)} s, ${r.rescues} rescues, ${(r.worstDamage * 100).toFixed(0)}% damage`).join('\n') + `\nhits: ${hits}, fights: ${[...fights].join(', ')}`;
    // Every rival finishes, mostly without help, despite the fighting.
    for (const r of racers) {
      expect(r.lapTime, summary).toBeGreaterThan(150);
      expect(r.lapTime, summary).toBeLessThan(230);
      expect(r.rescues, summary).toBeLessThanOrEqual(1);
      expect(r.worstDamage, summary).toBeLessThan(0.5);
    }
    // Personalities show: the bully starts something, and someone fights back or holds a grudge.
    expect(hits, summary).toBeGreaterThan(0);
    expect(fights.size, summary).toBeGreaterThan(1);
  }, 180_000);
});
