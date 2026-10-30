import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../core/Physics';
import { Car } from './Car';
import { buildCarModel } from './CarBuilder';
import { applyModifiers, cloneStats, DEFAULT_DIMS, DEFAULT_STATS, type CarStats } from './CarStats';

beforeAll(async () => {
  await RAPIER.init();
});

function setup() {
  const physics = new Physics();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0).setFriction(0.9), ground);
  const cars: Car[] = [];
  physics.onContactForce(({ a, b }) => {
    const ca = physics.ownerOf(a);
    const cb = physics.ownerOf(b);
    if (ca instanceof Car) ca.recordContact(b);
    if (cb instanceof Car) cb.recordContact(a);
  });
  const spawn = (x: number, z: number, yaw = 0, stats: CarStats = cloneStats()) => {
    const car = new Car(physics, buildCarModel({ color: '#c33' }), stats, { position: { x, y: 1.2, z }, yaw });
    cars.push(car);
    return car;
  };
  const run = (seconds: number, before?: () => void) => {
    for (let i = 0; i < seconds * 60; i++) {
      before?.();
      for (const c of cars) c.fixedUpdate(physics.dt);
      physics.step();
      for (const c of cars) c.postStep();
    }
  };
  return { physics, spawn, run };
}

describe('Car', () => {
  it('settles on its wheels on flat ground', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(2);
    expect(car.groundedWheels).toBe(4);
    expect(car.speed).toBeLessThan(0.2);
    const y = car.body.translation().y;
    // Chassis should ride above the ground, not resting on it.
    expect(y).toBeGreaterThan(car.dims.halfHeight + 0.05);
    expect(car.up(new THREE.Vector3()).y).toBeGreaterThan(0.99);
  });

  it('throttle drives forward (+Z), reverse backs up', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(1);
    car.input.throttle = 1;
    run(3);
    expect(car.forwardSpeed).toBeGreaterThan(8);
    expect(car.body.translation().z).toBeGreaterThan(5);

    const car2 = setup();
    const c2 = car2.spawn(0, 0);
    car2.run(1);
    c2.input.throttle = -1;
    car2.run(2);
    expect(c2.forwardSpeed).toBeLessThan(-2);
  });

  it('reversing turns tighter than driving forward at the same speed (reverseSteer)', () => {
    const radius = (throttle: number) => {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      run(1);
      car.input.throttle = throttle;
      car.input.steer = 1;
      let t = 0;
      while (car.speed < 6 && t < 5) { run(1 / 60); t += 1 / 60; }
      return car.speed / Math.abs(car.body.angvel().y);
    };
    expect(radius(-1)).toBeLessThan(radius(1) * 0.85);
  });

  it('steer right turns toward -X (car right)', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(1);
    car.input.throttle = 1;
    run(1);
    car.input.steer = 1;
    run(1.5);
    expect(car.body.translation().x).toBeLessThan(-1);
  });

  it('a high-speed crash into a wall dents the front and damages the car', () => {
    const { physics, spawn, run } = setup();
    const wall = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 3, 0.5).setTranslation(0, 3, 80), wall);
    const car = spawn(0, 0);
    run(1);
    const snapshot = car.model.parts.map((p) => (p.mesh.geometry.getAttribute('position').array as Float32Array).slice());
    car.input.throttle = 1;
    let speedAtImpact = 0;
    for (let i = 0; i < 600 && car.health === car.stats.maxHealth; i++) {
      speedAtImpact = car.forwardSpeed;
      run(1 / 60);
    }
    expect(speedAtImpact).toBeGreaterThan(15);
    expect(car.body.translation().z).toBeGreaterThan(75); // the damage happened at the wall
    expect(car.health).toBeLessThan(car.stats.maxHealth);
    run(0.5);

    // Some front part (bumper/hood/body) moved backwards (-Z) in its local space.
    let maxPush = 0;
    car.model.parts.forEach((p, k) => {
      if (p.wheelIndex >= 0) return;
      const now = p.mesh.geometry.getAttribute('position').array as Float32Array;
      for (let i = 2; i < now.length; i += 3) maxPush = Math.max(maxPush, snapshot[k][i] - now[i]);
    });
    expect(maxPush).toBeGreaterThan(0.05);
  });

  it('flat-out repeated crashes knock parts off', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    const detached: string[] = [];
    (car as any).events.onPartDetached = (_c: Car, part: { kind: string; mesh: { removeFromParent(): void } }) => {
      detached.push(part.kind);
      part.mesh.removeFromParent();
    };
    run(0.5);
    // Direct hits on the front-left corner.
    for (let i = 0; i < 6; i++) car.hit(new THREE.Vector3(0.8, 0, 2.05), new THREE.Vector3(0, 0, -1), 12);
    expect(detached.length).toBeGreaterThan(0);
    expect(car.partsLost).toBe(detached.length);
  });

  describe('handbrake', () => {
    /** From 72 km/h: steer right with the handbrake held for `hb` seconds, keep steering briefly, then straighten out. */
    function handbrakeTurn(hb: number) {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      run(1);
      car.body.setLinvel({ x: 0, y: 0, z: 20 }, true);
      car.input.throttle = 1;
      run(1 / 3);
      car.input.steer = 1;
      car.input.handbrake = hb > 0;
      let maxSlip = 0;
      const track = () => { maxSlip = Math.max(maxSlip, car.slipAngle); };
      for (let i = 0; i < hb * 60; i++) { run(1 / 60); track(); }
      car.input.handbrake = false;
      for (let i = 0; i < 20; i++) { run(1 / 60); track(); }
      car.input.steer = 0;
      run(2);
      const f = car.forward(new THREE.Vector3());
      return { turned: Math.abs(Math.atan2(f.x, f.z)), maxSlip, slipAfter: car.slipAngle, speed: car.speed };
    }

    it('a short tap turns much tighter than steering alone, and keeps speed', () => {
      const plain = handbrakeTurn(0);
      const tap = handbrakeTurn(0.2);
      expect(tap.turned).toBeGreaterThan(plain.turned * 1.8);
      expect(tap.speed).toBeGreaterThan(15); // still moving briskly afterwards (m/s)
    });

    it('a longer pull swings the tail out into a big slide', () => {
      const pull = handbrakeTurn(0.4);
      expect(pull.maxSlip).toBeGreaterThan(0.6); // > ~35° sideways
      expect(pull.turned).toBeGreaterThan(Math.PI / 2);
    });

    it('grip comes back after a flick: the car straightens out and drives on', () => {
      // 0.3 s: below spinCommit at release, so it settles into a drift instead of spinning round.
      const pull = handbrakeTurn(0.3);
      expect(pull.slipAfter).toBeLessThan(0.05); // under ~3° within 2 s of centring the wheel
      expect(pull.speed).toBeGreaterThan(20); // and keeps going, not scrubbed to a halt
    });

    /** From 72 km/h, full right steer with the handbrake for `hb` s, then release and keep (or counter) steering. */
    function spin(hb: number, afterSteer: number, paved = false) {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      if (paved) car.paving = () => 1;
      run(1);
      car.body.setLinvel({ x: 0, y: 0, z: 20 }, true);
      run(1 / 6);
      car.input.steer = 1;
      car.input.handbrake = true;
      run(hb);
      const yaw = () => {
        const f = car.forward(new THREE.Vector3());
        return Math.abs(Math.atan2(f.x, f.z));
      };
      const atRelease = yaw();
      car.input.handbrake = false;
      car.input.steer = afterSteer;
      let most = atRelease;
      for (let i = 0; i < 90; i++) {
        run(1 / 60);
        most = Math.max(most, yaw());
      }
      return { atRelease, most, spinRate: Math.abs(car.body.angvel().y) };
    }

    it('one short press (~0.4 s) whips the car round to face back the way it came', () => {
      const r = spin(0.42, 1);
      expect(r.atRelease).toBeLessThan(Math.PI / 2); // released well before 90°...
      expect(r.most).toBeGreaterThan((150 * Math.PI) / 180); // ...and it carried on round
      expect(r.spinRate).toBeLessThan(1.5); // and the spin has ended, not a runaway donut
    });

    it('on grippy asphalt one press still whips the car round', () => {
      const r = spin(0.42, 1, true);
      expect(r.most).toBeGreaterThan((150 * Math.PI) / 180);
      expect(r.spinRate).toBeLessThan(1.5);
    });

    it('holding the handbrake keeps it rotating past 90° (no stall)', () => {
      const r = spin(0.8, 1);
      expect(r.atRelease).toBeGreaterThan((120 * Math.PI) / 180);
    });

    it('holding the handbrake with throttle gives about a half turn, not endless donuts', () => {
      for (const kmh of [60, 120]) {
        const { spawn, run } = setup();
        const car = spawn(0, 0);
        run(1);
        car.body.setLinvel({ x: 0, y: 0, z: kmh / 3.6 }, true);
        car.input.throttle = 0.8;
        run(1 / 6);
        car.input.steer = 1;
        car.input.handbrake = true;
        let total = 0;
        let prev = 0;
        for (let i = 0; i < 4 * 60; i++) {
          run(1 / 60);
          const f = car.forward(new THREE.Vector3());
          const y = Math.atan2(f.x, f.z);
          total += Math.atan2(Math.sin(y - prev), Math.cos(y - prev));
          prev = y;
        }
        expect(Math.abs(total)).toBeGreaterThan((160 * Math.PI) / 180);
        expect(Math.abs(total)).toBeLessThan((240 * Math.PI) / 180);
        expect(car.speed).toBeLessThan((0.4 * kmh) / 3.6); // scrubbed down, not orbiting
      }
    });

    it('a held spin hangs past sideways: the second 90° takes longer than the first, and the car slides on', () => {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      run(1);
      car.body.setLinvel({ x: 0, y: 0, z: 20 }, true);
      car.input.throttle = 1;
      run(1 / 6);
      car.input.steer = 1;
      car.input.handbrake = true;
      let t = 0;
      let at90 = 0;
      let at170 = 0;
      while (t < 3 && !at170) {
        run(1 / 60);
        t += 1 / 60;
        const f = car.forward(new THREE.Vector3());
        const deg = (Math.abs(Math.atan2(f.x, f.z)) * 180) / Math.PI;
        if (!at90 && deg >= 90) at90 = t;
        if (!at170 && deg >= 170) at170 = t;
      }
      expect(at170).toBeGreaterThan(0); // still gets round
      expect(at170 - at90).toBeGreaterThan(at90); // the back 80° take longer than the first 90° (they used to whip by in 0.3 s)
      expect(car.speed).toBeGreaterThan(8); // throttle mid-spin doesn't brake it to a stop
    });

    it('countersteering catches a committed spin', () => {
      const carried = spin(0.42, 1);
      const caught = spin(0.42, -1);
      expect(caught.most).toBeLessThan(carried.most - 0.4);
    });

    it('spin rate stays capped on the ground', () => {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      run(1);
      car.body.setLinvel({ x: 0, y: 0, z: 25 }, true);
      car.input.steer = 1;
      car.input.handbrake = true;
      let maxW = 0;
      for (let i = 0; i < 90; i++) { run(1 / 60); maxW = Math.max(maxW, Math.abs(car.body.angvel().y)); }
      expect(maxW).toBeLessThanOrEqual(car.stats.maxYawRate + 0.3);
    });
  });

  describe('cornering (arcade drift model)', () => {
    /** Enter at `speed` m/s, then hold `steer` and `throttle` for 1.5 s (on asphalt when `paved`). */
    function corner(speed: number, steer: number, throttle: number, paved = false) {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      if (paved) car.paving = () => 1;
      run(1);
      car.body.setLinvel({ x: 0, y: 0, z: speed }, true);
      car.input.throttle = throttle;
      run(1 / 6);
      const entry = car.speed;
      car.input.steer = steer;
      let slipSum = 0;
      let n = 0;
      for (let i = 0; i < 90; i++) {
        run(1 / 60);
        if (i >= 20) { slipSum += car.slipAngle; n++; }
      }
      return { keep: car.speed / entry, slip: slipSum / n };
    }

    it('accelerating through a fast corner does not scrub speed', () => {
      expect(corner(35, 1, 1).keep).toBeGreaterThan(1);
      expect(corner(25, 0.5, 1).keep).toBeGreaterThan(1);
    });

    it('lifting off mid-drift slows the car more than staying on the throttle', () => {
      expect(corner(35, 1, 0).keep).toBeLessThan(corner(35, 1, 1).keep - 0.15);
    });

    it('throttle does not break traction: no extra slide from power at speed', () => {
      expect(corner(35, 1, 1).slip).toBeLessThan(corner(35, 1, 0).slip + 0.05);
    });

    it('slides come from cornering speed: same steering grips slow, drifts fast', () => {
      expect(corner(15, 0.5, 0).slip).toBeLessThan(0.05); // ~54 km/h: grips
      expect(corner(35, 0.5, 0).slip).toBeGreaterThan(0.12); // ~126 km/h: drifts
      expect(corner(35, 1, 0).slip).toBeGreaterThan(corner(35, 0.5, 0).slip);
    });

    it('drifts are held, not spins: slide angle stays bounded on full lock', () => {
      expect(corner(35, 1, 1).slip).toBeLessThan(0.75);
    });

    it('asphalt grips: steering alone never slides, even on full lock', () => {
      expect(corner(25, 0.5, 1).slip).toBeGreaterThan(0.12); // ~90 km/h on sand: a 9° drift
      expect(corner(25, 0.5, 1, true).slip).toBeLessThan(0.03); // on asphalt: grips
      expect(corner(35, 0.5, 1, true).slip).toBeLessThan(0.03); // even at 126 km/h
      for (const v of [15, 25, 35, 45]) expect(Math.abs(corner(v, 1, 1, true).slip)).toBeLessThan(0.04); // full lock: ~2° (~29° on sand)
    });

    it('asphalt still turns: the tight slide cap does not stop the nose following the steering', () => {
      // A slide cap of 0 would: the nose could never lead the path, and full lock barely turned the car.
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      car.paving = () => 1;
      run(1);
      car.body.setLinvel({ x: 0, y: 0, z: 25 }, true);
      car.input.throttle = 1;
      run(1 / 6);
      car.input.steer = 1;
      run(1);
      expect(Math.abs(car.body.angvel().y)).toBeGreaterThan(0.85); // rad/s at 90 km/h (0.17 with a cap of 0)
    });
  });

  describe('sand', () => {
    function drive(softness: number, throttleSeconds: number, coastSeconds = 0) {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      car.surface = () => softness;
      run(1);
      car.input.throttle = 1;
      run(throttleSeconds);
      const atThrottleEnd = car.speed;
      car.input.throttle = 0;
      run(coastSeconds);
      return { atThrottleEnd, end: car.speed, softness: car.surfaceSoftness };
    }

    it('soft sand lowers the speed reached on throttle', () => {
      const firm = drive(0, 12);
      const soft = drive(1, 12);
      expect(soft.atThrottleEnd).toBeLessThan(firm.atThrottleEnd * 0.8);
      expect(soft.atThrottleEnd).toBeGreaterThan(firm.atThrottleEnd * 0.4); // slowed, not bogged to a halt
    });

    it('coasting bleeds speed faster in soft sand', () => {
      const firm = drive(0, 4, 3);
      const soft = drive(1, 4, 3);
      expect(firm.end / firm.atThrottleEnd).toBeGreaterThan(soft.end / soft.atThrottleEnd + 0.1);
    });

    it('reports the softness under the wheels', () => {
      expect(drive(0.6, 1).softness).toBeCloseTo(0.6, 2);
    });
  });

  it('resting upside down does not keep denting', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    car.teleport({ position: { x: 0, y: 1, z: 0 }, yaw: 0 });
    car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true); // roof down
    car.stats.dentThreshold = 2.5;
    run(1);
    const h = car.health;
    run(1);
    // Either it's been auto-righted or it's sitting still — either way no steady damage.
    expect(car.health).toBeGreaterThanOrEqual(h - 1);
  });
});

describe('boost bar', () => {
  it('boost pulls harder and drains the bar; letting go recharges it slowly', () => {
    const { spawn, run } = setup();
    const plain = spawn(-20, 0);
    const boosted = spawn(20, 0);
    run(1);
    expect(boosted.boostCharge).toBe(1);
    plain.input.throttle = 1;
    boosted.input.throttle = 1;
    boosted.input.boost = true;
    run(3);
    expect(boosted.boosting).toBe(true);
    expect(boosted.forwardSpeed).toBeGreaterThan(plain.forwardSpeed * 1.2);
    expect(boosted.boostCharge).toBeCloseTo(1 - 3 / boosted.stats.boostDuration, 2);
    expect(plain.boostCharge).toBe(1);
    boosted.input.boost = false;
    const drained = boosted.boostCharge;
    run(3);
    expect(boosted.boostCharge).toBeCloseTo(drained + 3 / boosted.stats.boostRecharge, 2);
  });

  it('boost really accelerates: 0-100 km/h in under half the time', () => {
    const time100 = (boost: boolean) => {
      const { spawn, run } = setup();
      const car = spawn(0, -400);
      run(0.5);
      car.input.throttle = 1;
      car.input.boost = boost;
      let t = 0;
      while (car.forwardSpeed < 100 / 3.6 && t < 10) {
        run(1 / 60);
        t += 1 / 60;
      }
      return t;
    };
    const plain = time100(false);
    const boosted = time100(true);
    expect(plain).toBeLessThan(3); // measured 2.77 s
    expect(boosted).toBeLessThan(0.5 * plain); // measured 1.25 s
  });

  it('needs throttle to boost', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(1);
    car.input.boost = true;
    run(1);
    expect(car.boosting).toBe(false);
    expect(car.boostCharge).toBe(1);
  });

  it('a full bar lasts boostDuration; running dry locks boost until it recharges to boostRestart', () => {
    const { spawn, run } = setup();
    const car = spawn(0, -400);
    run(1);
    car.input.throttle = 1;
    car.input.boost = true;
    run(car.stats.boostDuration - 1);
    expect(car.boosting).toBe(true);
    run(1.5);
    expect(car.boostEmpty).toBe(true);
    expect(car.boosting).toBe(false);
    // Still holding boost: it recharges (no boosting) until boostRestart, then fires again.
    run(car.stats.boostRestart * car.stats.boostRecharge - 1);
    expect(car.boosting).toBe(false);
    // The restart charge only lasts a moment, so step until it unlocks rather than overshooting.
    let waited = 0;
    while (car.boostEmpty && waited < 2) {
      run(1 / 60);
      waited += 1 / 60;
    }
    expect(car.boostEmpty).toBe(false);
    run(1 / 60);
    expect(car.boosting).toBe(true);
  });
});

describe('crashes', () => {
  /** Sends a car off along its nose at `speed` m/s with the throttle on. */
  const launch = (c: Car, speed: number) => {
    const f = c.forward(new THREE.Vector3());
    c.body.setLinvel({ x: f.x * speed, y: 0, z: f.z * speed }, true);
    c.input.throttle = speed > 0 ? 1 : 0;
  };
  const lost = (c: Car) => c.stats.maxHealth - c.health;
  const KMH100 = 100 / 3.6;

  /** Two cars driving at each other along Z at `va` and `vb` m/s, slightly offset. */
  const headOn = (va: number, vb: number, statsB?: CarStats) => {
    const { spawn, run } = setup();
    const a = spawn(0, 0);
    const b = spawn(0.3, 16, Math.PI, statsB);
    run(0.5);
    launch(a, va);
    launch(b, vb);
    run(1.5);
    return { a, b };
  };

  /** `a` drives at `speed` into the side of `b`, parked across its path. */
  const tBone = (speed: number) => {
    const { spawn, run } = setup();
    const a = spawn(0, 0, Math.PI / 2);
    const b = spawn(8, 0);
    run(0.5);
    launch(a, speed);
    run(1.5);
    return { a, b };
  };

  it('hitting a wall alone hurts much less than being rammed at the same speed', () => {
    const { physics, spawn, run } = setup();
    const wall = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 3, 0.5).setTranslation(0, 3, 12), wall);
    const car = spawn(0, 0);
    run(0.5);
    launch(car, KMH100);
    run(1.5);
    expect(lost(car)).toBeGreaterThan(20);
    expect(lost(car)).toBeLessThan(0.3 * car.stats.maxHealth); // measured ~65 of 450
    expect(lost(tBone(KMH100).b)).toBeGreaterThan(2 * lost(car)); // measured ~159 (210 before carHealthLoss 0.75)
  });

  it('the rammer comes off lightly, the car it T-bones badly', () => {
    const { a, b } = tBone(KMH100);
    expect(lost(a)).toBeGreaterThan(0);
    expect(lost(a)).toBeLessThan(0.2 * lost(b)); // measured 19 vs 159
  });

  it('in a head-on the faster car deals most of the damage', () => {
    const { a: fast, b: slow } = headOn(KMH100, KMH100 / 2);
    expect(lost(fast)).toBeLessThan(0.5 * lost(slow)); // measured 84 vs 218
    const even = headOn(KMH100 * 0.6, KMH100 * 0.6);
    // Roughly even (the spin-out kick makes the follow-up contacts differ a little).
    expect(lost(even.a) / lost(even.b)).toBeGreaterThan(0.8);
    expect(lost(even.a) / lost(even.b)).toBeLessThan(1.25);
  });

  it('car hits take carHealthLoss of their damage off health: a third more hits to wreck, the same dents', () => {
    const ram = (carHealthLoss: number) => {
      const { spawn, run } = setup();
      const stats = { ...cloneStats(), carHealthLoss };
      const a = spawn(0, 0, Math.PI / 2, stats);
      const b = spawn(8, 0, 0, { ...stats });
      run(0.5);
      launch(a, KMH100);
      run(1.5);
      return b;
    };
    const full = ram(1);
    const resisted = ram(0.75);
    expect(lost(resisted) / lost(full)).toBeGreaterThan(0.7);
    expect(lost(resisted) / lost(full)).toBeLessThan(0.8);
    expect(resisted.partsLost).toBe(full.partsLost);
  });

  it('a heavier, tougher car wins an even head-on', () => {
    const heavy = applyModifiers(DEFAULT_STATS, [{ stat: 'mass', mul: 1.4 }, { stat: 'toughness', mul: 1.6 }]);
    const { a, b } = headOn(KMH100 * 0.6, KMH100 * 0.6, heavy);
    expect(lost(b)).toBeLessThan(0.6 * lost(a)); // measured 64 vs 136
  });

  it('cars do not pass through each other in a very fast head-on', () => {
    const { a, b } = headOn(40, 40); // 288 km/h closing
    expect(a.body.translation().z).toBeLessThan(b.body.translation().z);
    expect(lost(a)).toBeGreaterThan(0);
  });

  it('a hit on the side of the tail spins the car out, then control comes back', () => {
    const { spawn, run } = setup();
    // The victim drives +Z at 20 m/s; the attacker crosses from its right into the rear quarter.
    const speed = 60 / 3.6;
    const victim = spawn(0, 0);
    const attacker = spawn(-3 - speed * 0.42, 7, Math.PI / 2);
    run(0.5);
    launch(victim, 20);
    launch(attacker, speed);
    const yaw = () => {
      const f = victim.forward(new THREE.Vector3());
      return Math.atan2(f.x, f.z);
    };
    const y0 = yaw();
    let turned = 0;
    let knocked = 0;
    for (let i = 0; i < 180; i++) {
      run(1 / 60);
      knocked = Math.max(knocked, victim.knock);
      turned = Math.max(turned, Math.abs(Math.atan2(Math.sin(yaw() - y0), Math.cos(yaw() - y0))));
    }
    expect(knocked).toBeGreaterThan(0.5);
    expect(attacker.knock).toBe(0);
    expect(turned).toBeGreaterThan(1.4); // measured ~100° (and a full 180° from 100 km/h)
    expect(victim.knock).toBe(0);
  });

  it('a wheel survives one hard 100 km/h hit right on it', () => {
    const { spawn, run } = setup();
    // 100 km/h into the side of a parked car, right at its front axle.
    const a = spawn(0, 0, Math.PI / 2);
    const b = spawn(8, -DEFAULT_DIMS.wheelZ);
    run(0.5);
    launch(a, KMH100);
    run(1.5);
    expect(lost(b)).toBeGreaterThan(100); // measured ~180 of 450
    expect([0, 1, 2, 3].some((w) => b.isWheelLost(w))).toBe(false); // the wheel nearest the hit keeps ~30 of 120 HP
  });

  it('reports damage by zone: the side that was hit, a lost wheel, overall health', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(0.2);
    const fresh = car.damageReport();
    expect(fresh).toEqual({ chassis: 1, bumperFront: 1, engine: 1, doorLeft: 1, doorRight: 1, bumperRear: 1, wheels: [1, 1, 1, 1], wrecked: false });
    // Front-left corner (left is +X): the left door and the front-left wheel suffer, the right side doesn't.
    for (let i = 0; i < 10 && !car.isWheelLost(0); i++) car.hit(new THREE.Vector3(0.95, -0.1, 1.6), new THREE.Vector3(-1, 0, 0), 14);
    const r = car.damageReport();
    expect(r.wheels[0]).toBeNull();
    expect(r.wheels[3]).toBe(1);
    expect(r.doorRight).toBe(1);
    expect(r.doorLeft ?? 0).toBeLessThan(1);
    expect(r.chassis).toBeLessThan(1);
    // Smash the nose until the hood comes off: the engine is still there while the car runs.
    car.health = car.stats.maxHealth;
    for (let i = 0; i < 6; i++) car.hit(new THREE.Vector3(0, 0.3, 2), new THREE.Vector3(0, 0, -1), 10);
    expect(car.wrecked).toBe(false);
    expect(car.model.parts.find((p) => p.kind === 'hood')!.mesh.parent).toBeNull();
    expect(car.damageReport().engine).toBeGreaterThan(0);
    car.health = 1;
    car.hit(new THREE.Vector3(0, 0.3, 2), new THREE.Vector3(0, 0, -1), 10);
    expect(car.damageReport().engine).toBe(0);
  });

  it('steering needs the front wheels: half with one, none with both gone', () => {
    const turn = (lose: number[]) => {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
      run(0.5);
      // Front left / right wheels (WHEEL_ORDER 0, 1), knocked off by repeated hits on them.
      for (const w of lose) {
        const x = w === 0 ? 0.95 : -0.95;
        for (let i = 0; i < 10 && !car.isWheelLost(w); i++) car.hit(new THREE.Vector3(x, -0.1, 1.6), new THREE.Vector3(-Math.sign(x), 0, 0), 14);
        expect(car.isWheelLost(w)).toBe(true);
      }
      launch(car, 15);
      car.input.steer = 1;
      const f0 = car.forward(new THREE.Vector3());
      run(1);
      const f1 = car.forward(new THREE.Vector3());
      return Math.abs(Math.atan2(f0.x * f1.z - f0.z * f1.x, f0.x * f1.x + f0.z * f1.z));
    };
    const intact = turn([]);
    expect(intact).toBeGreaterThan(0.5);
    expect(turn([0])).toBeLessThan(0.75 * intact);
    expect(turn([0, 1])).toBeLessThan(0.1);
  });

  it('a nose-down jump landing barely hurts', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(0.5);
    car.body.setTranslation({ x: 0, y: 6, z: 0 }, true);
    car.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.35), true);
    car.body.setLinvel({ x: 0, y: -6, z: KMH100 }, true);
    car.input.throttle = 1;
    run(2);
    expect(lost(car)).toBeLessThan(10);
  });
});

describe('repair', () => {
  /** Largest distance any part vertex has moved from the car as built. */
  const maxDent = (car: Car, pristine: Float32Array[]) => {
    let worst = 0;
    car.model.parts.forEach((p, k) => {
      if (!p.mesh.parent) return;
      const a = p.mesh.geometry.getAttribute('position').array as Float32Array;
      const o = pristine[k]!;
      for (let i = 0; i < a.length; i += 3) worst = Math.max(worst, Math.hypot(a[i]! - o[i]!, a[i + 1]! - o[i + 1]!, a[i + 2]! - o[i + 2]!));
    });
    return worst;
  };

  it('a smashed rear and a lost wheel are mostly fixed in 10 s and like new in 20 s', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(0.5);
    const pristine = car.model.parts.map((p) => (p.mesh.geometry.getAttribute('position').array as Float32Array).slice());
    const rearLeft = 2; // WHEEL_ORDER
    for (let i = 0; i < 8 && !car.isWheelLost(rearLeft); i++) car.hit(new THREE.Vector3(0.95, -0.1, -1.6), new THREE.Vector3(-0.6, 0, 0.8).normalize(), 14);
    expect(car.isWheelLost(rearLeft)).toBe(true);
    const lostBefore = car.partsLost;
    const damage = car.stats.maxHealth - car.health;
    const dent = maxDent(car, pristine);
    expect(damage).toBeGreaterThan(100);
    expect(dent).toBeGreaterThan(0.2);

    run(10, () => car.repair(1 / 60));
    expect(car.isWheelLost(rearLeft)).toBe(false); // wheels are refitted first
    expect(car.partsLost).toBeLessThan(lostBefore);
    expect(car.stats.maxHealth - car.health).toBeLessThan(0.25 * damage);
    expect(maxDent(car, pristine)).toBeLessThan(0.25 * dent);
    expect(car.damaged).toBe(true);

    run(10.5, () => car.repair(1 / 60));
    expect(car.damaged).toBe(false);
    expect(car.partsLost).toBe(0);
    expect(car.health).toBe(car.stats.maxHealth);
    expect(maxDent(car, pristine)).toBe(0);
    expect(car.model.parts.every((p) => p.mesh.parent)).toBe(true);
    expect(car.groundedWheels).toBe(4);

    // It drives straight again on its refitted wheel.
    car.input.throttle = 1;
    run(3);
    expect(car.forwardSpeed).toBeGreaterThan(15);
    expect(Math.abs(car.body.translation().x)).toBeLessThan(1);
  });

  it('a lost part only comes back after staying put for repairRefit seconds', () => {
    const { spawn, run } = setup();
    const car = spawn(0, 0);
    run(0.5);
    for (let i = 0; i < 8 && car.partsLost === 0; i++) car.hit(new THREE.Vector3(0.8, 0, 2.05), new THREE.Vector3(0, 0, -1), 12);
    expect(car.partsLost).toBeGreaterThan(0);
    const lost = car.partsLost;
    // Repeated short stops don't add up.
    for (let k = 0; k < 4; k++) {
      run(car.stats.repairRefit * 0.8, () => car.repair(1 / 60));
      run(0.2);
    }
    expect(car.partsLost).toBe(lost);
    run(car.stats.repairRefit + 0.1, () => car.repair(1 / 60));
    expect(car.partsLost).toBe(lost - 1);
  });
});
