import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type DriveInput } from '../core/types';
import { TrackPath, type TrackDef } from '../race/TrackPath';
import { applyModifiers, cloneStats } from '../vehicle/CarStats';
import { BASE_STYLE, RIVAL_CONFIG, RIVALS, RivalDriver, wasHit, type OtherCar, type RivalProfile } from './Rival';

const square: TrackDef = {
  id: 'sq',
  name: 'Square',
  halfWidth: 8,
  checkpoints: 4,
  corners: [
    { x: 0, z: 0, r: 20 },
    { x: 0, z: 400, r: 20 },
    { x: 400, z: 400, r: 20 },
    { x: 400, z: 0, r: 20 },
  ],
};
const path = new TrackPath(square);
const steering = { maxSteer: 0.6, steerFadeSpeed: 8, wheelbase: 2.6 };
const profile: RivalProfile = { name: 'Test', title: 'Test', color: '#fff', variant: 'sedan', skill: 0.5, lane: 1, car: [], style: { ...BASE_STYLE } };
const byName = (name: string) => RIVALS.find((r) => r.name === name)!;
// On the first straight, at x = 0 heading +Z, 30 m/s. The first bend (a left turn) starts at z = 380.
const car = { x: 0, z: 220, fx: 0, fz: 1, speed: 30 };

function run(rival: RivalDriver, others: OtherCar[], seconds: number, behind = 0, at = car): DriveInput {
  const out: DriveInput = { ...NEUTRAL_INPUT };
  for (let t = 0; t < seconds - 1e-9; t += 0.1) rival.drive(at, others, behind, 0.1, out);
  return out;
}

describe('RivalDriver: racing', () => {
  it('follows its lane on a clear road', () => {
    const r = new RivalDriver(path, steering, profile);
    run(r, [], 1);
    expect(r.pilot.offset).toBeCloseTo(profile.lane, 6);
  });

  it('moves aside for a car ahead on its line, then returns to its lane', () => {
    const r = new RivalDriver(path, steering, profile);
    run(r, [{ id: 1, x: 0.5, z: 235 }], 3);
    expect(Math.abs(r.pilot.offset - profile.lane)).toBeGreaterThan(3);
    expect(Math.abs(r.pilot.offset)).toBeLessThanOrEqual(path.halfWidth - 2.5 + 1e-9);
    run(r, [], 5);
    expect(r.pilot.offset).toBeCloseTo(profile.lane, 6);
  });

  it('brakes instead of rear-ending a slower car close ahead', () => {
    const r = new RivalDriver(path, steering, profile);
    const out = run(r, [{ id: 1, x: 1, z: 228, vx: 0, vz: 10 }], 0.1);
    expect(out.throttle).toBe(0);
    expect(out.brake).toBeGreaterThan(0.3);
    const r2 = new RivalDriver(path, steering, profile);
    expect(run(r2, [{ id: 1, x: 1, z: 228, vx: 0, vz: 30 }], 0.1).brake).toBe(0);
  });

  it('ignores cars behind or well to the side', () => {
    const r = new RivalDriver(path, steering, profile);
    run(r, [{ id: 1, x: 0, z: 200 }, { id: 2, x: 6, z: 235 }], 2);
    expect(r.pilot.offset).toBeCloseTo(profile.lane, 6);
  });

  it('rubber-bands toward the player', () => {
    const r = new RivalDriver(path, steering, profile);
    run(r, [], 0.1, RIVAL_CONFIG.rubberRange * 2);
    expect(r.pilot.pace).toBeCloseTo(1 + RIVAL_CONFIG.rubberBand, 6);
    run(r, [], 0.1, -RIVAL_CONFIG.rubberRange / 2);
    expect(r.pilot.pace).toBeCloseTo(1 - RIVAL_CONFIG.rubberBand / 2, 6);
  });

  it('asks for a rescue when stuck or wrecked, not while driving', () => {
    const r = new RivalDriver(path, steering, profile);
    let rescue = false;
    for (let t = 0; t < 10; t += 0.1) rescue ||= r.needsRescue(25, false, 0.1);
    expect(rescue).toBe(false);
    for (let t = 0; t < RIVAL_CONFIG.stuckTime + 0.2; t += 0.1) rescue ||= r.needsRescue(0.5, false, 0.1);
    expect(rescue).toBe(true);
    r.reset();
    rescue = false;
    for (let t = 0; t < RIVAL_CONFIG.wreckedTime + 0.2; t += 0.1) rescue ||= r.needsRescue(10, true, 0.1);
    expect(rescue).toBe(true);
    r.reset();
    expect(r.needsRescue(30, false, 0.1, RIVAL_CONFIG.missedGate - 5)).toBe(false);
    expect(r.needsRescue(30, false, 0.1, RIVAL_CONFIG.missedGate + 5)).toBe(true);
  });
});

describe('RivalDriver: personalities', () => {
  it('the speed demon brakes later and aims faster; the smooth operator trusts its corners more', () => {
    const viper = new RivalDriver(path, steering, byName('Viper'));
    const mirage = new RivalDriver(path, steering, byName('Mirage'));
    expect(viper.pilot.tune.brakeDecel).toBeGreaterThan(mirage.pilot.tune.brakeDecel);
    expect(viper.pilot.tune.maxSpeed).toBeGreaterThan(mirage.pilot.tune.maxSpeed);
    expect(mirage.pilot.tune.lateralGrip).toBeGreaterThan(viper.pilot.tune.lateralGrip);
    expect(mirage.pilot.tune.lookahead).toBeGreaterThan(viper.pilot.tune.lookahead);
  });

  it('cars match their drivers', () => {
    const base = cloneStats();
    const car = (name: string) => applyModifiers(base, byName(name).car);
    expect(car('Viper').engineForce).toBeGreaterThan(base.engineForce);
    expect(car('Mirage').gripAccel).toBeGreaterThan(base.gripAccel);
    expect(car('Scorpion').mass).toBeGreaterThan(base.mass);
    expect(car('Scorpion').toughness).toBeGreaterThan(base.toughness);
    expect(car('Dune Rat').sandDrag).toBeLessThan(base.sandDrag);
    expect(new RivalDriver(path, steering, byName('Dune Rat')).pilot.tune.sandGrip).toBeGreaterThan(BASE_STYLE.sandGrip);
  });

  it('the smooth operator moves to the inside before a bend', () => {
    const mirage = new RivalDriver(path, steering, byName('Mirage'));
    // 40 m before the left-hand bend at z = 380: the inside is the left (+offset).
    const out = { ...NEUTRAL_INPUT };
    for (let t = 0; t < 3; t += 0.1) mirage.drive({ x: 0, z: 340, fx: 0, fz: 1, speed: 25 }, [], 0, 0.1, out);
    expect(mirage.pilot.offset).toBeGreaterThan(1.5);
  });
});

describe('RivalDriver: anger', () => {
  const victim = { id: 7, x: 2, z: 235, vx: 0, vz: 28 };

  it('gets angry when hit hard, rams the attacker, then calms down', () => {
    const r = new RivalDriver(path, steering, byName('Viper'));
    r.provoke(7, 12);
    expect(r.angerAt(7)).toBeGreaterThan(RIVAL_CONFIG.fightAt);
    const out = run(r, [victim], 0.1);
    expect(r.target).toBe(7);
    expect(out.throttle).toBe(1);
    expect(out.brake).toBe(0);
    // Steering toward the target, which is to the left (+X): steer < 0.
    expect(out.steer).toBeLessThan(0);
    run(r, [victim], 20);
    expect(r.target).toBeNull();
    expect(r.angerAt(7)).toBeLessThan(RIVAL_CONFIG.fightUntil);
  });

  it('a light bump only angers the hothead', () => {
    const rusty = new RivalDriver(path, steering, byName('Rusty'));
    const mirage = new RivalDriver(path, steering, byName('Mirage'));
    rusty.provoke(7, 3);
    mirage.provoke(7, 3);
    run(rusty, [victim], 0.1);
    run(mirage, [victim], 0.1);
    expect(rusty.target).toBe(7);
    expect(mirage.target).toBeNull();
  });

  it('never turns back to fight: winning comes first', () => {
    const r = new RivalDriver(path, steering, byName('Viper'));
    r.provoke(7, 15);
    run(r, [{ ...victim, z: 200, ahead: -(RIVAL_CONFIG.fightBehind + 5) }], 0.1);
    expect(r.target).toBeNull();
    run(r, [{ ...victim, x: 0, z: 220 + RIVAL_CONFIG.fightRange + 10 }], 0.1);
    expect(r.target).toBeNull();
  });

  it('the bully rams a car in front unprovoked; calm drivers just pass', () => {
    const bully = new RivalDriver(path, steering, byName('Scorpion'));
    const calm = new RivalDriver(path, steering, byName('Mirage'));
    const inFront = { id: 3, x: 1, z: 236, vx: 0, vz: 25 };
    expect(run(bully, [inFront], 0.1).throttle).toBe(1);
    expect(bully.target).toBe(3);
    run(calm, [inFront], 0.1);
    expect(calm.target).toBeNull();
  });

  it('landing a hit on the target is revenge: anger drops, bullies back off for a while', () => {
    const viper = new RivalDriver(path, steering, byName('Viper'));
    viper.provoke(7, 15);
    run(viper, [victim], 0.1);
    viper.rammed(7);
    expect(viper.angerAt(7)).toBeLessThanOrEqual(RIVAL_CONFIG.fightUntil);
    run(viper, [victim], 0.1);
    expect(viper.target).toBeNull();

    const bully = new RivalDriver(path, steering, byName('Scorpion'));
    const inFront = { id: 3, x: 1, z: 236, vx: 0, vz: 25 };
    run(bully, [inFront], 0.1);
    bully.rammed(3);
    run(bully, [inFront], 1);
    expect(bully.target).toBeNull();
    run(bully, [inFront], RIVAL_CONFIG.bullyCooldown);
    expect(bully.target).toBe(3);
  });

  it('lets a target go once it is off in the dunes', () => {
    const r = new RivalDriver(path, steering, byName('Viper'));
    r.provoke(7, 15);
    run(r, [{ ...victim, offTrack: RIVAL_CONFIG.fightMaxOffTrack + 5 }], 0.1);
    expect(r.target).toBeNull();
  });

  it('forgets grudges on a fresh race, but not on a respawn', () => {
    const r = new RivalDriver(path, steering, byName('Rusty'));
    r.provoke(7, 5);
    r.reset();
    expect(r.angerAt(7)).toBeGreaterThan(0);
    r.forgetAll();
    expect(r.angerAt(7)).toBe(0);
  });
});

describe('wasHit', () => {
  it('blames the car that drove into the other', () => {
    const slow = { x: 0, z: 10, vx: 0, vz: 20 };
    const fast = { x: 0, z: 6, vx: 0, vz: 30 };
    // Rear-ended: the slow car in front was hit, the fast one behind did the hitting.
    expect(wasHit(slow, fast)).toBe(true);
    expect(wasHit(fast, slow)).toBe(false);
    // T-bone: the car moving sideways into a passing car is the attacker.
    const passing = { x: 0, z: 0, vx: 0, vz: 25 };
    const tbone = { x: 3, z: 0, vx: -15, vz: 0 };
    expect(wasHit(passing, tbone)).toBe(true);
    expect(wasHit(tbone, passing)).toBe(false);
    // Head-on, equal speeds: both were hit.
    const a = { x: 0, z: 0, vx: 0, vz: 20 };
    const b = { x: 0, z: 4, vx: 0, vz: -20 };
    expect(wasHit(a, b) && wasHit(b, a)).toBe(true);
  });
});
