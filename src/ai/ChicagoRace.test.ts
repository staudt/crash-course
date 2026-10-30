import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Race } from '../race/Race';
import { TrackPath } from '../race/TrackPath';
import { CHICAGO } from '../race/tracks';
import { Car } from '../vehicle/Car';
import { buildCarModel } from '../vehicle/CarBuilder';
import { applyModifiers, cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { ConcreteWall } from '../world/ArenaWall';
import chicago from '../city/chicago.json';
import { classifyWallBlocks, decodeCity, fitToCorridor, FootprintIndex } from '../city/City';
import type { ChicagoCity } from '../city/osm';
import { flatTerrain, samplePaved, sampleHeight, sampleSoftness, toRapierHeights } from '../world/TerrainData';
import { TRACK_WALL_CONFIG, trackWallBlocks, wallLaterals } from '../world/TrackWalls';
import { RIVALS, RivalDriver, wasHit } from './Rival';

/** No @types/node here, hence globalThis. */
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * Physics QA for the Chicago Loop street circuit: the five rivals race the full distance from the grid with the
 * director's rules (repairs in stations, no rescues), between the real city walls (facades and barriers).
 * `CHICAGO_LOG=1` prints lap times and junction crashes, `CHICAGO_TRACE=<name>` traces one driver,
 * `CHICAGO_REVERSE=1` reverses the grid and `CHICAGO_ROTATE=k` rotates it.
 */
describe('Rivals racing the Chicago Loop', () => {
  it('race three laps of the downtown streets: they stay between the walls, take the 90° junctions and finish', () => {
    const path = new TrackPath(CHICAGO);
    const data = flatTerrain(257, 2048);
    const lateral = wallLaterals(path)!;
    const half = TRACK_WALL_CONFIG.thickness / 2;
    const city = fitToCorridor(decodeCity(chicago as ChicagoCity), path, (s, side) => lateral(s, side) - half);
    const physics = new Physics();
    const ground = physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(data.n - 1, data.n - 1, toRapierHeights(data), { x: data.size, y: 1, z: data.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
      physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
    );
    const blocks = classifyWallBlocks(trackWallBlocks(path), new FootprintIndex(city.buildings), TRACK_WALL_CONFIG.thickness, city.cut);
    new ConcreteWall(new THREE.Scene(), physics, blocks, TRACK_WALL_CONFIG, (x, z) => sampleHeight(data, x, z));
    const motion = (c: Car) => {
      const t = c.body.translation();
      const v = c.body.linvel();
      return { x: t.x, z: t.z, vx: v.x, vz: v.z };
    };
    let hits = 0;
    /** Car-car contacts within 30 m of a junction, counted once per pair per second. */
    let crossingCrashes = 0;
    const nearJunction = (x: number, z: number) => CHICAGO.corners.some((c) => Math.hypot(c.x - x, c.z - z) < 30);
    const lastCrash = new Map<string, number>();
    let time = 0;
    const events = {
      onCarContact: (felt: Car, other: Car, impact: number) => {
        const victim = racers.find((r) => r.car === felt);
        const attacker = racers.findIndex((r) => r.car === other);
        if (!victim || attacker < 0) return;
        const t = felt.body.translation();
        const key = [racers.indexOf(victim), attacker].sort().join('-');
        if (nearJunction(t.x, t.z) && impact > 3 && time - (lastCrash.get(key) ?? -9) > 1) {
          crossingCrashes++;
          lastCrash.set(key, time);
        }
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
    const laps = CHICAGO.laps!;
    const ordered = ENV.CHICAGO_REVERSE ? [...RIVALS].reverse() : RIVALS;
    const k = Number(ENV.CHICAGO_ROTATE ?? 0) % ordered.length;
    const grid = [...ordered.slice(k), ...ordered.slice(0, k)];
    const racers = grid.map((profile, slot) => {
      const s = -12 - Math.floor(slot / 2) * 10 - (slot % 2) * 5;
      const lat = slot % 2 ? -3.5 : 3.5;
      const q = path.pointAt(s, { x: 0, z: 0 });
      const t = path.tangentAt(s, { x: 0, z: 0 });
      const x = q.x + t.z * lat;
      const z = q.z - t.x * lat;
      const car = new Car(physics, buildCarModel({ color: profile.color, variant: profile.variant }), applyModifiers(cloneStats(), profile.car), { position: { x, y: sampleHeight(data, x, z) + 1.3, z }, yaw: path.headingAt(s) }, events);
      car.surface = (c, px, pz) => (c === ground ? sampleSoftness(data, px, pz) : 0);
      car.paving = (c, px, pz) => (c === ground ? samplePaved(data, px, pz) : 0);
      car.walls = (c, px, pz) => {
        const o = physics.ownerOf(c);
        return o instanceof ConcreteWall ? o.normalAt(px, pz) : null;
      };
      const race = new Race(path);
      race.placeAt(s);
      const driver = new RivalDriver(path, steering, profile);
      driver.pilot.reset(s);
      return { car, driver, race, prev: { x, z }, laps: [] as number[], finish: 0, out: '' as '' | 'wrecked' | 'stuck', stall: { best: 0, time: 0 }, repaired: 0, worstDamage: 0, maxOff: 0, maxPast: -Infinity, wrongWay: 0 };
    });
    const fwd = new THREE.Vector3();
    const dt = physics.dt;
    for (let step = 0; step < 60 * 420 && racers.some((r) => !r.finish && !r.out); step++) {
      time += dt;
      for (const r of racers) {
        // As in RaceDirector, finishers drive on (stopping past the line would block the road a lap down).
        if (r.race.phase !== 'racing' || r.out) {
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
        r.car.powerScale = r.driver.power;
      }
      for (const r of racers) r.car.fixedUpdate(dt);
      physics.step();
      for (const r of racers) r.car.postStep();
      for (const r of racers) {
        const t = r.car.body.translation();
        for (const e of r.race.update(dt, r.prev, t, r.car.body.linvel())) {
          if (e.type !== 'lap') continue;
          r.laps.push(e.time);
          if (e.lap === laps) r.finish = r.race.totalTime;
        }
        r.prev = { x: t.x, z: t.z };
        r.worstDamage = Math.max(r.worstDamage, 1 - r.car.health / r.car.stats.maxHealth);
        // How far off the line, and how far past the wall's centre line (> 0 = escaped the street).
        const pr = path.project(t.x, t.z);
        r.maxOff = Math.max(r.maxOff, pr.distance);
        r.maxPast = Math.max(r.maxPast, pr.distance - lateral(pr.s, pr.lateral >= 0 ? 1 : -1));
        const name = r.driver.profile.name;
        if (ENV.CHICAGO_TRACE === name && step % 30 === 0) {
          const d = r.driver;
          console.log(`${time.toFixed(1)} s=${r.race.s.toFixed(0)} lat=${r.race.lateral.toFixed(1)} v=${r.car.forwardSpeed.toFixed(1)} hp=${(r.car.health / r.car.stats.maxHealth).toFixed(2)} next=${r.race.next} past=${r.race.pastNextGate.toFixed(0)} pit=${d.pitting} back=${d.turningBack} tgt=${d.target} wheels=${4 - r.car.partsLost} pos=(${t.x.toFixed(0)},${t.z.toFixed(0)}) in=${r.car.input.throttle.toFixed(1)}/${r.car.input.brake.toFixed(1)}/${r.car.input.steer.toFixed(1)} off=${d.pilot.offset.toFixed(1)} near: ${racers
              .filter((o) => o !== r)
              .map((o) => ({ o, q: o.car.body.translation() }))
              .filter(({ q }) => Math.hypot(q.x - t.x, q.z - t.z) < 20)
              .map(({ o, q }) => `${o.driver.profile.name}${o.out ? '(' + o.out + ')' : ''}@(${q.x.toFixed(0)},${q.z.toFixed(0)})`)
              .join(' ')}`);
        }
        if (r.race.phase !== 'racing' || r.out || r.finish) continue;
        // Only while racing: a wreck left facing backwards isn't lost.
        if (r.race.wrongWay) r.wrongWay += dt;
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
      racers
        .map((r) => `${r.driver.profile.name}: ${r.out ? r.out.toUpperCase() : `${r.finish.toFixed(1)} s`} laps [${r.laps.map((l) => l.toFixed(1)).join(' ')}], ${(r.worstDamage * 100).toFixed(0)}% worst damage, ${r.repaired.toFixed(0)} hp repaired, ${r.maxOff.toFixed(1)} m max off the line, ${r.maxPast.toFixed(1)} m max past the wall, ${r.wrongWay.toFixed(1)} s wrong way`)
        .join('\n') + `\nhits: ${hits}, junction crashes: ${crossingCrashes}`;
    if (ENV.CHICAGO_LOG) console.log(summary);
    for (const r of racers) {
      // Nobody gets through a wall (the car's centre past the wall's centre line), and nobody is lost going the wrong way.
      expect(r.maxPast, summary).toBeLessThan(0);
      // Cumulative over the race: several first-lap spins in a fight, each turned round in a 25–40 m wide street.
      expect(r.wrongWay, summary).toBeLessThan(15);
      if (r.out) continue;
      expect(r.finish, summary).toBeGreaterThan(0);
      for (const l of r.laps.slice(1)) {
        expect(l, summary).toBeGreaterThan(40);
        expect(l, summary).toBeLessThan(140);
      }
    }
    // Measured over four grid orders (CHICAGO_ROTATE 0–3): laps 40–45 s once clear (50–141 s first laps: grid feuds and
    // repair stops), 6–35 hits, 0–3 junction crashes, 0–1 wrecked, the closest any car came to a wall's centre line 1.3 m.
    expect(racers.filter((r) => r.out).length, summary).toBeLessThanOrEqual(2);
  }, 180_000);
});
