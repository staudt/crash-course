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
  it('five AI personalities race a lap from a grid with no rescues: they fight, pit, and nearly all finish', () => {
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
        if (victim.driver.target === attacker || !wasHit(motion(felt), motion(other))) {
          victim.driver.rammed(attacker, impact);
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
      out: '' as '' | 'wrecked' | 'stuck',
      stall: { best: 0, time: 0 },
      repaired: 0,
      worstDamage: 0,
    }));
    for (const r of racers) {
      const t = r.car.body.translation();
      r.prev = { x: t.x, z: t.z };
    }
    const fwd = new THREE.Vector3();
    const dt = physics.dt;
    for (let step = 0; step < 60 * 260 && racers.some((r) => !r.lapTime && !r.out); step++) {
      for (const r of racers) {
        if (r.race.phase !== 'racing' || r.out || r.lapTime) {
          r.car.input.throttle = 0;
          r.car.input.brake = 1;
          continue;
        }
        const t = r.car.body.translation();
        r.car.forward(fwd).setY(0).normalize();
        const others = racers.filter((o) => o !== r).map((o) => {
          const q = o.car.body.translation();
          const v = o.car.body.linvel();
          return { id: racers.indexOf(o), x: q.x, z: q.z, vx: v.x, vz: v.z, ahead: o.race.progress - r.race.progress, offTrack: o.race.distance, lateral: o.race.lateral, out: !!o.out };
        });
        const self = { x: t.x, z: t.z, fx: fwd.x, fz: fwd.z, speed: r.car.forwardSpeed, health: r.car.health / r.car.stats.maxHealth, pastGate: r.race.pastNextGate };
        r.driver.drive(self, others, 0, dt, r.car.input);
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
        if (r.race.phase !== 'racing' || r.out || r.lapTime) continue;
        // Same rules as RaceDirector: repairs in stations, no rescues, wrecks and stalled cars retire.
        if (r.race.repairStation >= 0 && r.car.damaged) {
          const before = r.car.health;
          r.car.repair(dt);
          r.repaired += r.car.health - before;
        }
        if (r.car.wrecked) r.out = 'wrecked';
        if (r.race.progress > r.stall.best + 20) r.stall = { best: r.race.progress, time: 0 };
        else if ((r.stall.time += dt) > 45) r.out = 'stuck';
      }
    }
    const summary =
      racers.map((r) => `${r.driver.profile.name}: ${r.out ? r.out.toUpperCase() : `${r.lapTime.toFixed(1)} s`}, ${(r.worstDamage * 100).toFixed(0)}% worst damage, ${r.repaired.toFixed(0)} hp repaired`).join('\n') +
      `\nhits: ${hits}, fights: ${[...fights].join(', ')}`;
    // Feuds knock someone out now and then (measured: Viper, ganged up on by Scorpion and Rusty, wrecked), but at most
    // one car a lap, and never a healthy car stuck for good.
    for (const r of racers) {
      if (r.out === 'stuck') expect(r.worstDamage, summary).toBeGreaterThan(0.8);
      if (r.out) continue;
      expect(r.lapTime, summary).toBeGreaterThan(150);
      expect(r.lapTime, summary).toBeLessThan(240);
    }
    expect(racers.filter((r) => r.out).length, summary).toBeLessThanOrEqual(1);
    // Cars pick up repairs in the stations (how much depends on where the crashes happen; pitting itself is unit-tested).
    expect(racers.some((r) => r.repaired > 0), summary).toBe(true);
    // Personalities show: the bully starts something, and someone fights back or holds a grudge.
    expect(hits, summary).toBeGreaterThan(0);
    expect(fights.size, summary).toBeGreaterThan(3);
  }, 180_000);
});
