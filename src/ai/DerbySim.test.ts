import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { DERBY_CONFIG, derbyPressure, DerbyRound, healthLossAt } from '../derby/DerbyRound';
import { Car } from '../vehicle/Car';
import { buildCarModel } from '../vehicle/CarBuilder';
import { applyModifiers, cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { ArenaWall } from '../world/ArenaWall';
import { BOWL_CONFIG, carveBowl } from '../world/Bowl';
import { generateTerrain, sampleHeight, sampleSoftness, toRapierHeights } from '../world/TerrainData';
import { DERBY_RIVALS, DerbyDriver, type DerbyMode, type DerbyProfile } from './DerbyDriver';
import { wasHit } from './Rival';

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * Exploring (no @types/node here, hence globalThis): DERBY_LOG=1 prints standings every 10 s and a summary, and runs
 * four more grid orders (DERBY_ROTATE=k for one); DERBY_TRACE=<name> with DERBY_FROM/DERBY_TO (s) traces one driver.
 */
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const LOG = !!ENV.DERBY_LOG;
const TRACE = ENV.DERBY_TRACE;
const TRACE_FROM = Number(ENV.DERBY_FROM ?? 0);
const TRACE_TO = Number(ENV.DERBY_TO ?? 40);

/** The player's stand-in: a plain car with a middle-of-the-road charger at the wheel. */
const STAND_IN: DerbyProfile = { name: 'Player', title: 'Stand-in', color: '#b9bec6', variant: 'sedan', car: [], style: { ...DERBY_RIVALS[1]!.style, temper: 0.12, calm: 0.04, dirty: 0, aggression: 0.6 } };

/** Same rules as DerbyDirector: a ring of 10 facing the centre, last car running. */
function runDerby(seconds: number, rotate = 0) {
  const data = generateTerrain({ seed: 1337, n: 321, size: 640 });
  carveBowl(data);
  const physics = new Physics();
  const ground = physics.world.createCollider(
    RAPIER.ColliderDesc.heightfield(data.n - 1, data.n - 1, toRapierHeights(data), { x: data.size, y: 1, z: data.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
    physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
  );
  new ArenaWall(new THREE.Scene(), physics, BOWL_CONFIG, (x, z) => sampleHeight(data, x, z));
  physics.onContactForce(({ a, b }) => {
    const ca = physics.ownerOf(a);
    const cb = physics.ownerOf(b);
    if (ca instanceof Car) ca.recordContact(b);
    if (cb instanceof Car) cb.recordContact(a);
  });
  const motion = (c: Car) => {
    const t = c.body.translation();
    const v = c.body.linvel();
    return { x: t.x, z: t.z, vx: v.x, vz: v.z };
  };

  const rivals = DERBY_RIVALS.map((_, i) => DERBY_RIVALS[(i + rotate) % DERBY_RIVALS.length]!);
  const profiles = [STAND_IN, ...rivals];
  const n = profiles.length;
  const round = new DerbyRound(n);
  const stats0 = cloneStats();
  const steering = { maxSteer: stats0.maxSteer, steerFadeSpeed: stats0.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ };
  let lastAction = 0;
  const hits = profiles.map(() => 0);
  const hitsTaken = profiles.map(() => 0);
  const rearHits = profiles.map(() => 0);
  const modeTime = profiles.map(() => new Map<DerbyMode, number>());
  const onPlayer = profiles.map(() => 0);
  let maxR = 0;
  const cars: Car[] = [];
  const events = {
    onCarContact: (felt: Car, other: Car, impact: number) => {
      const me = cars.indexOf(felt);
      const them = cars.indexOf(other);
      if (me < 0 || them < 0 || round.phase !== 'fighting') return;
      round.contact(me, them);
      if (impact >= DERBY_CONFIG.actionImpact) lastAction = round.time;
      const attacked = !wasHit(motion(felt), motion(other));
      if (attacked && impact >= 3) {
        hits[me]!++;
        if (felt.input.throttle < 0) rearHits[me]!++;
      } else if (impact >= 3) hitsTaken[me]!++;
      const d = drivers[me]!;
      if (d.target !== them && !attacked) d.provoke(them, impact);
      else d.rammed(them, impact);
    },
  };
  const drivers = profiles.map((p, i) => {
    const a = -Math.PI * 0.75 + (i / n) * Math.PI * 2;
    const x = Math.cos(a) * 60;
    const z = Math.sin(a) * 60;
    const car = new Car(physics, buildCarModel({ color: p.color, variant: p.variant }), applyModifiers(cloneStats(), p.car), { position: { x, y: sampleHeight(data, x, z) + 1.3, z }, yaw: Math.atan2(-x, -z) }, events);
    car.healthLoss = DERBY_CONFIG.healthLoss;
    car.surface = (g, sx, sz) => (g === ground ? sampleSoftness(data, sx, sz) : 0);
    cars.push(car);
    const d = new DerbyDriver(p, steering, BOWL_CONFIG.floorRadius, i % 2 ? 1 : -1);
    d.playerId = 0;
    return d;
  });

  const lastHealth = cars.map(() => 1);
  const outs: { name: string; t: number; why: string; by: string | null }[] = [];
  const f = new THREE.Vector3();
  const dt = physics.dt;
  let winner: number | null = null;
  for (let step = 0; step * dt < seconds && round.phase !== 'over'; step++) {
    const pressure = derbyPressure(n, round.alive, round.time, lastAction);
    for (const car of cars) car.healthLoss = healthLossAt(round.time);
    const others = cars
      .map((c, id) => {
        const t = c.body.translation();
        const v = c.body.linvel();
        const fw = c.forward(f).setY(0).normalize();
        return { id, x: t.x, z: t.z, vx: v.x, vz: v.z, fx: fw.x, fz: fw.z, health: c.health / c.stats.maxHealth };
      })
      .filter((o) => !round.isOut(o.id))
      .map((o) => ({ ...o, hunters: drivers.filter((d, j) => !round.isOut(j) && d.target === o.id && d.mode === 'hunt').length }));
    cars.forEach((car, i) => {
      const inp = car.input;
      if (round.phase === 'countdown' || round.isOut(i)) {
        inp.throttle = 0;
        inp.brake = 1;
        return;
      }
      const t = car.body.translation();
      const fw = car.forward(f).setY(0).normalize();
      drivers[i]!.drive({ x: t.x, z: t.z, fx: fw.x, fz: fw.z, speed: car.forwardSpeed, health: car.health / car.stats.maxHealth }, others.filter((o) => o.id !== i), pressure, dt, inp);
      if (drivers[i]!.target === 0 && drivers[i]!.mode === 'hunt') onPlayer[i]! += dt;
      const m = modeTime[i]!;
      m.set(drivers[i]!.mode, (m.get(drivers[i]!.mode) ?? 0) + dt);
      maxR = Math.max(maxR, Math.hypot(t.x, t.z));
    });
    for (const car of cars) car.fixedUpdate(dt);
    physics.step();
    for (const car of cars) car.postStep();
    cars.forEach((car, i) => {
      const h = car.health / car.stats.maxHealth;
      if (h < lastHealth[i]!) round.damage(i, (lastHealth[i]! - h) * car.stats.maxHealth);
      lastHealth[i] = h;
    });
    const evs = round.update(
      dt,
      cars.map((c) => ({ ...c.body.translation(), wrecked: c.wrecked })),
    );
    for (const e of evs) {
      if (e.type === 'out') outs.push({ name: profiles[e.id]!.name, t: round.time, why: e.why, by: e.by !== null ? profiles[e.by]!.name : null });
      if (e.type === 'over') winner = e.winner;
    }
    const ti = profiles.findIndex((p) => p.name === TRACE);
    if (ti >= 0 && step % 15 === 0 && !round.isOut(ti) && round.time >= TRACE_FROM && round.time < TRACE_TO) {
      const d = drivers[ti]!;
      const c = cars[ti]!;
      const t = c.body.translation();
      const tg = d.target !== null ? cars[d.target]!.body.translation() : null;
      const fw = c.forward(f);
      const dist = tg ? Math.hypot(tg.x - t.x, tg.z - t.z) : -1;
      const off = tg ? Math.abs(Math.atan2(fw.z * (tg.x - t.x) - fw.x * (tg.z - t.z), fw.x * (tg.x - t.x) + fw.z * (tg.z - t.z))) : -1;
      console.log(`${round.time.toFixed(1)} ${d.mode} tgt=${d.target} rev=${d.reversingIn} v=${c.forwardSpeed.toFixed(1)} d=${dist.toFixed(1)} off=${off.toFixed(2)} thr=${c.input.throttle.toFixed(2)} st=${c.input.steer.toFixed(2)} r=${Math.hypot(t.x, t.z).toFixed(0)} hp=${Math.round(c.health)} gw=${c.groundedWheels} lost=${[0, 1, 2, 3].filter((w) => c.isWheelLost(w)).join("")} y=${t.y.toFixed(1)} up=${c.up(new THREE.Vector3()).y.toFixed(2)}`);
    }
    if (LOG && step % 600 === 0) {
      console.log(
        `t=${round.time.toFixed(0)} alive=${round.alive} p=${pressure.toFixed(2)} ` +
          cars.map((c, i) => `${profiles[i]!.name}:${Math.round((100 * c.health) / c.stats.maxHealth)}${round.isOut(i) ? 'X' : drivers[i]!.mode[0]}`).join(' '),
      );
    }
  }
  const table = profiles.map((p, i) => {
    const e = round.entrants[i]!;
    const modes = [...modeTime[i]!].map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ');
    return `${p.name.padEnd(10)} out=${(e.out ?? '-').padEnd(8)} at=${(e.outAt ?? round.time).toFixed(0).padStart(4)} KOs=${e.takedowns} dmg=${Math.round(e.damage).toString().padStart(4)} hits=${hits[i]} (rear ${rearHits[i]}) taken=${hitsTaken[i]} | ${modes}`;
  });
  if (LOG) console.log(`hunting the player (s): ${profiles.map((p, i) => `${p.name} ${onPlayer[i]!.toFixed(0)}`).join(', ')}`);
  if (LOG) console.log(`winner=${winner !== null ? profiles[winner]!.name : 'none'} time=${round.time.toFixed(0)} maxR=${maxR.toFixed(1)}\n${table.join('\n')}`);
  return { round, outs, winner, maxR, hits, rearHits, profiles };
}

describe('Destruction derby in the bowl', () => {
  it.skipIf(!LOG)('grid orders (DERBY_LOG=1: explore)', { timeout: 120_000 }, () => {
    const only = ENV.DERBY_ROTATE;
    for (let k = 1; k < 9; k += 2) {
      if (only !== undefined && Number(only) !== k) continue;
      const r = runDerby(360, k);
      console.log(`rotate ${k}: winner ${r.winner !== null ? r.profiles[r.winner]!.name : '-'} at ${r.round.time.toFixed(0)} s; out: ${r.outs.map((o) => `${o.name} ${o.t.toFixed(0)}${o.why === 'WRECKED' ? '' : ' ' + o.why}`).join(', ')}`);
    }
  });

  it('ten cars fight it out to the last one running, inside the wall, each in its own style', { timeout: 90_000 }, () => {
    const r = runDerby(360);
    expect(r.round.phase).toBe('over');
    expect(r.winner).not.toBeNull();
    expect(r.round.time).toBeGreaterThan(90);
    expect(r.maxR).toBeLessThan(BOWL_CONFIG.wallRadius);
    // Mostly real wrecks: a car only goes DISABLED when it's crippled (lost wheels) and nobody bothers to finish it.
    expect(r.outs.filter((o) => o.why === 'WRECKED').length).toBeGreaterThanOrEqual(6);
    // The rear-enders back into their victims; the survivors outlast the chargers.
    const reverse = r.profiles.reduce((n, p, i) => n + (p.style.attack === 'rear' ? r.rearHits[i]! : 0), 0);
    expect(reverse).toBeGreaterThanOrEqual(3);
    // Measured over five grid orders (carHealthLoss 0.75): a survivor in the last three in four, 4th in the other.
    const lastFour = r.round.standings().slice(0, 4).map((i) => r.profiles[i]!.style.caution);
    expect(Math.max(...lastFour)).toBeGreaterThanOrEqual(0.9);
  });
});
