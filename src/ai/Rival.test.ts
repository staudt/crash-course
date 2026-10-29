import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type DriveInput } from '../core/types';
import { TrackPath, type TrackDef } from '../race/TrackPath';
import { applyModifiers, cloneStats } from '../vehicle/CarStats';
import { attackPoint, BASE_STYLE, RIVAL_CONFIG, RIVALS, RivalDriver, wasHit, type OtherCar, type RivalProfile, type RivalSelf } from './Rival';

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

function run(rival: RivalDriver, others: OtherCar[], seconds: number, behind = 0, at: RivalSelf = car, out: DriveInput = { ...NEUTRAL_INPUT }): DriveInput {
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

  it('backs out when stuck against something, then drives on', () => {
    const r = new RivalDriver(path, steering, profile);
    const stuck = { ...car, speed: 0.5 };
    const out: DriveInput = { ...NEUTRAL_INPUT };
    run(r, [], RIVAL_CONFIG.stuckTime - 0.3, 0, stuck, out);
    expect(out.throttle).toBeGreaterThan(0);
    run(r, [], 0.5, 0, stuck, out);
    expect(out.throttle).toBe(-1);
    run(r, [], RIVAL_CONFIG.reverseTime + 0.2, 0, car, out);
    expect(out.throttle).toBeGreaterThan(0);
  });

  it('turns back for a gate it drove past, instead of carrying on', () => {
    const r = new RivalDriver(path, steering, profile);
    // Facing +Z, 40 m past the gate: it must turn round (full lock) toward the gate behind.
    const out = run(r, [], 0.2, 0, { ...car, pastGate: RIVAL_CONFIG.missedGate + 15 });
    expect(r.turningBack).toBe(true);
    expect(Math.abs(out.steer)).toBe(1);
    run(r, [], 0.1, 0, { ...car, pastGate: 0 });
    expect(r.turningBack).toBe(false);
  });
});

describe('RivalDriver: going after the player', () => {
  const PLAYER = 9;
  const driver = (name: string) => {
    const r = new RivalDriver(path, steering, byName(name));
    r.playerId = PLAYER;
    return r;
  };

  it('anger at the player builds faster than at anyone else', () => {
    const r = driver('Viper');
    r.provoke(PLAYER, 4);
    r.provoke(3, 4);
    expect(r.angerAt(PLAYER)).toBeCloseTo(r.angerAt(3) * RIVAL_CONFIG.playerGrudge);
  });

  it('dirty drivers go for the player alongside; the smooth operator leaves it', () => {
    const alongside = { id: PLAYER, x: 3, z: 219, vx: 0, vz: 30 };
    const rusty = driver('Rusty');
    rusty.provoke(PLAYER, 0.5); // a scrape on top of the urge
    run(rusty, [alongside], 0.1);
    expect(rusty.target).toBe(PLAYER);
    const mirage = driver('Mirage');
    mirage.provoke(PLAYER, 0.5);
    run(mirage, [alongside], 0.1);
    expect(mirage.target).toBeNull();
    // The same car alongside that isn't the player is left alone.
    const other = driver('Rusty');
    other.provoke(4, 0.5);
    run(other, [{ ...alongside, id: 4 }], 0.1);
    expect(other.target).toBeNull();
  });

  it('keeps the pack around the player: more power behind it, less ahead', () => {
    const r = driver('Viper');
    run(r, [], 0.1, RIVAL_CONFIG.catchRange);
    expect(r.power).toBeCloseTo(1 + RIVAL_CONFIG.catchUp);
    run(r, [], 0.1, -RIVAL_CONFIG.catchRange);
    expect(r.power).toBeCloseTo(1 - RIVAL_CONFIG.holdBack);
    run(r, [], 0.1, 0);
    expect(r.power).toBeCloseTo(1);
  });

  it('rage: hunting a car well ahead on a straight adds power and boosts', () => {
    const r = driver('Rusty');
    r.provoke(PLAYER, 10);
    const out = run(r, [{ id: PLAYER, x: 0, z: 260, vx: 0, vz: 30 }], 0.1, 0, { ...car, speed: 20 });
    expect(r.target).toBe(PLAYER);
    expect(r.power).toBeCloseTo(1 + RIVAL_CONFIG.rage);
    expect(out.boost).toBe(true);
  });
});

describe('RivalDriver: chasing safely', () => {
  it('a hunter still brakes for the bend ahead instead of charging into it flat out', () => {
    const r = new RivalDriver(path, steering, profile);
    r.provoke(4, 10);
    // 60 m/s with the first bend (r = 20) 50 m ahead and the target just in front.
    const out = run(r, [{ id: 4, x: 0, z: 345, vx: 0, vz: 30 }], 0.1, 0, { ...car, z: 330, speed: 60 });
    expect(r.target).toBe(4);
    expect(out.throttle).toBe(0);
    expect(out.brake).toBeGreaterThan(0);
    expect(out.boost).toBe(false);
  });

  it('a car facing the wrong way slows down before turning round', () => {
    const r = new RivalDriver(path, steering, profile);
    const out = run(r, [], 0.1, 0, { ...car, fz: -1, speed: 25 });
    expect(out.throttle).toBe(0);
    expect(out.brake).toBeGreaterThan(0);
  });
});

describe('RivalDriver: pitting', () => {
  // The square's checkpoints: s = 0 (z = 200 on the first straight) and every quarter lap.
  const gate = path.checkpoints[1]!;
  const at = (s: number, speed: number) => {
    const p = path.pointAt(s, { x: 0, z: 0 });
    const t = path.tangentAt(s, { x: 0, z: 0 });
    return { x: p.x, z: p.z, fx: t.x, fz: t.z, speed };
  };

  it('a healthy car races through the station', () => {
    const r = new RivalDriver(path, steering, profile);
    const out = run(r, [], 0.1, 0, { ...at(gate - 30, 30), health: 0.8 });
    expect(r.pitting).toBe(false);
    expect(out.brake).toBe(0);
  });

  it('a badly damaged car brakes into the next station, waits, and leaves once mended', () => {
    const r = new RivalDriver(path, steering, profile);
    let out = run(r, [], 0.1, 0, { ...at(gate - 30, 30), health: 0.2 });
    expect(r.pitting).toBe(true);
    expect(out.brake).toBeGreaterThan(0);
    out = run(r, [], 1, 0, { ...at(gate - RIVAL_CONFIG.pitStop, 0.5), health: 0.5 });
    expect(out.brake).toBe(1);
    expect(out.throttle).toBe(0);
    out = run(r, [], 0.1, 0, { ...at(gate - RIVAL_CONFIG.pitStop, 0), health: RIVAL_CONFIG.pitUntil });
    expect(r.pitting).toBe(false);
    expect(out.throttle).toBeGreaterThan(0);
  });

  it('the careful driver pits sooner than the speed demon', () => {
    expect(byName('Mirage').style.pitAt).toBeGreaterThan(byName('Viper').style.pitAt);
    expect(byName('Rusty').style.pitAt).toBeLessThan(BASE_STYLE.pitAt);
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
    const r = new RivalDriver(path, steering, profile); // plain style: rams straight at it
    r.provoke(7, 12);
    expect(r.angerAt(7)).toBeGreaterThan(RIVAL_CONFIG.fightAt);
    const out = run(r, [victim], 0.1);
    expect(r.target).toBe(7);
    expect(out.throttle).toBe(1);
    expect(out.brake).toBe(0);
    // Steering toward the target, which is to the left (+X): steer < 0.
    expect(out.steer).toBeLessThan(0);
    run(r, [victim], 40);
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

  it('landing a big hit on the target is revenge: anger drops, bullies back off for a while', () => {
    const viper = new RivalDriver(path, steering, byName('Viper'));
    viper.provoke(7, 10);
    run(viper, [victim], 0.1);
    viper.rammed(7, 20);
    expect(viper.angerAt(7)).toBeLessThanOrEqual(RIVAL_CONFIG.fightUntil);
    run(viper, [victim], 0.1);
    expect(viper.target).toBeNull();

    const bully = new RivalDriver(path, steering, byName('Scorpion'));
    const inFront = { id: 3, x: 1, z: 236, vx: 0, vz: 25 };
    run(bully, [inFront], 0.1);
    bully.rammed(3, RIVAL_CONFIG.solidHit);
    run(bully, [inFront], 1);
    expect(bully.target).toBeNull();
    run(bully, [inFront], RIVAL_CONFIG.bullyCooldown);
    expect(bully.target).toBe(3);
  });

  it('a rub or a glancing hit does not end the hunt', () => {
    const viper = new RivalDriver(path, steering, byName('Viper'));
    viper.provoke(7, 10);
    run(viper, [victim], 0.1);
    viper.rammed(7, 2);
    viper.rammed(7, 3);
    run(viper, [victim], 0.1);
    expect(viper.target).toBe(7);
  });

  it('a hard hit keeps a normal driver hunting for a good while', () => {
    const viper = new RivalDriver(path, steering, byName('Viper'));
    viper.provoke(7, 10);
    run(viper, [victim], 8);
    expect(viper.target).toBe(7);
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

describe('attackPoint', () => {
  // The prey drives +Z at 25 m/s from the origin; its left is +X.
  const prey: OtherCar = { id: 1, x: 0, z: 0, vx: 0, vz: 25 };
  const lead = 25 * RIVAL_CONFIG.ramLead;

  it('ram: straight at where it will be', () => {
    expect(attackPoint('ram', { x: 3, z: -20 }, prey)).toEqual({ x: 0, z: lead });
  });

  it('spin: from straight behind, first lines up beside its rear', () => {
    const p = attackPoint('spin', { x: 0, z: -15 }, prey);
    expect(p.z).toBeCloseTo(lead - RIVAL_CONFIG.spinRear);
    expect(Math.abs(p.x)).toBeCloseTo(RIVAL_CONFIG.spinBeside);
  });

  it('spin: once beside its rear, cuts across the rear quarter', () => {
    const p = attackPoint('spin', { x: 2.2, z: -3 }, prey);
    expect(p.z).toBeCloseTo(lead - RIVAL_CONFIG.spinRear);
    expect(p.x).toBeLessThan(0); // past its centreline, away from our side
  });

  it('shove: lines up on the road-centre side, then leans in to push it off the road', () => {
    const nearLeftEdge = { ...prey, lateral: 5 };
    // Coming from behind on its left (the edge side): go round to its right first.
    expect(attackPoint('shove', { x: 2, z: -10 }, nearLeftEdge).x).toBeLessThan(-1);
    // Alongside on its right: lean left into it, toward the edge.
    expect(attackPoint('shove', { x: -2.5, z: 0 }, nearLeftEdge).x).toBeGreaterThan(0);
  });
});

describe('RivalDriver: rivalries', () => {
  it('pride: being overtaken stings the proud, not the smooth operator', () => {
    const viper = new RivalDriver(path, steering, byName('Viper'));
    const mirage = new RivalDriver(path, steering, byName('Mirage'));
    for (const r of [viper, mirage]) {
      run(r, [{ id: 4, x: 3, z: 215, vx: 0, vz: 32, ahead: -5 }], 0.1);
      run(r, [{ id: 4, x: 3, z: 225, vx: 0, vz: 32, ahead: 5 }], 0.1);
    }
    expect(viper.angerAt(4)).toBeGreaterThan(0.25);
    expect(mirage.angerAt(4)).toBe(0);
  });

  it('being held up winds up the hothead into a fight; the smooth operator stays patient', () => {
    const blocker = { id: 5, x: 0, z: 230, vx: 0, vz: 20 };
    const rusty = new RivalDriver(path, steering, byName('Rusty'));
    const mirage = new RivalDriver(path, steering, byName('Mirage'));
    run(rusty, [blocker], 2);
    run(mirage, [blocker], 2);
    expect(rusty.target).toBe(5);
    expect(mirage.target).toBeNull();
  });

  it('personalities attack their own way', () => {
    expect(byName('Viper').style.attack).toBe('spin');
    expect(byName('Scorpion').style.attack).toBe('shove');
    expect(byName('Rusty').style.attack).toBe('ram');
  });
});
