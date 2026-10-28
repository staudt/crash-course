import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../core/Physics';
import { Car } from './Car';
import { buildCarModel } from './CarBuilder';
import { cloneStats } from './CarStats';

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
  const spawn = (x: number, z: number, yaw = 0) => {
    const car = new Car(physics, buildCarModel({ color: '#c33' }), cloneStats(), { position: { x, y: 1.2, z }, yaw });
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
    function spin(hb: number, afterSteer: number) {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
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
        expect(car.speed).toBeLessThan(5); // scrubbed down, not orbiting
      }
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
    /** Enter at `speed` m/s, then hold `steer` and `throttle` for 1.5 s. */
    function corner(speed: number, steer: number, throttle: number) {
      const { spawn, run } = setup();
      const car = spawn(0, 0);
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
