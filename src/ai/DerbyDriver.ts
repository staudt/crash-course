import type { DriveInput } from '../core/types';
import type { CarVariant } from '../vehicle/CarBuilder';
import type { StatModifier } from '../vehicle/CarStats';
import { pursuitSteer, type AutopilotCar, type SteeringModel } from './Autopilot';
import { attackPoint } from './Rival';

/**
 * A destruction-derby AI: no track, just an arena of radius R centred on the origin and the
 * other cars. Each driver picks a victim (by its taste: the nearest, the weakest, the player)
 * and hits it its own way: `nose` charges straight in, `rear` turns its tail to the victim and
 * reverses in (protecting the front), `spin` goes for the rear quarter to spin it. After a hit
 * it backs off for a run-up and comes again. Cautious drivers circle the edge, dodge cars
 * coming at them and only pick on wrecks-in-waiting, until the field thins out (pressure).
 * Pure apart from types: the director owns the cars.
 */
export type DerbyAttack = 'nose' | 'rear' | 'spin';
/** Who a driver likes to hit. */
export type DerbyPrey = 'near' | 'weak' | 'player';

export interface DerbyStyle {
  attack: DerbyAttack;
  prey: DerbyPrey;
  /** 0..1: will to go after a car at all (survivors are low). */
  aggression: number;
  /** 0..1: urge to dodge cars driving at us. */
  caution: number;
  /** Grudge gained per m/s of a hit taken, and lost per second. */
  temper: number;
  calm: number;
  /** Extra urge to hit the player. */
  dirty: number;
  /** Speed (m/s) it charges in at. */
  chargeSpeed: number;
  /** Distance (m) it backs off to for the next run. */
  runUp: number;
}

export interface DerbyProfile {
  name: string;
  title: string;
  color: string;
  variant: CarVariant;
  car: StatModifier[];
  style: DerbyStyle;
}

const BASE: DerbyStyle = { attack: 'nose', prey: 'near', aggression: 0.6, caution: 0, temper: 0.12, calm: 0.04, dirty: 0, chargeSpeed: 22, runUp: 28 };

export const DERBY_RIVALS: DerbyProfile[] = [
  {
    // A heavy armoured pickup that flattens whatever is closest.
    name: 'Scorpion',
    title: 'Juggernaut',
    color: '#3fae6a',
    variant: 'pickup',
    car: [{ stat: 'mass', mul: 1.4 }, { stat: 'engineForce', mul: 1.3 }, { stat: 'toughness', mul: 1.5 }, { stat: 'maxHealth', mul: 1.25 }],
    style: { ...BASE, aggression: 0.95, chargeSpeed: 21, runUp: 24 },
  },
  {
    // One bump and it's personal, for a long time.
    name: 'Rusty',
    title: 'Hothead',
    color: '#7a4fc9',
    variant: 'sedan',
    car: [{ stat: 'toughness', mul: 1.15 }],
    style: { ...BASE, aggression: 0.6, temper: 0.35, calm: 0.015, dirty: 0.25, chargeSpeed: 24 },
  },
  {
    // Fast, and goes for the back corner: its victims spin out.
    name: 'Viper',
    title: 'Spinner',
    color: '#d8432f',
    variant: 'sedan',
    car: [{ stat: 'engineForce', mul: 1.2 }, { stat: 'gripAccel', mul: 1.05 }],
    style: { ...BASE, attack: 'spin', aggression: 0.7, chargeSpeed: 25 },
  },
  {
    // Keeps its engine safe: tail to the enemy and reverses in, hard.
    name: 'Tailgunner',
    title: 'Rear-ender',
    color: '#e07b2f',
    variant: 'pickup',
    car: [{ stat: 'reverseForce', mul: 1.5 }, { stat: 'toughness', mul: 1.15 }],
    style: { ...BASE, attack: 'rear', aggression: 0.75, runUp: 22 },
  },
  {
    // Backs into the weakest car it can find.
    name: 'Crawdad',
    title: 'Backs in',
    color: '#c94f8a',
    variant: 'sedan',
    car: [{ stat: 'reverseForce', mul: 1.4 }],
    style: { ...BASE, attack: 'rear', prey: 'weak', aggression: 0.6, caution: 0.3, runUp: 20 },
  },
  {
    // Circles the fights and finishes off whatever is smoking.
    name: 'Vulture',
    title: 'Finisher',
    color: '#5a6f7d',
    variant: 'sedan',
    car: [{ stat: 'engineForce', mul: 1.1 }],
    style: { ...BASE, prey: 'weak', aggression: 0.55, caution: 0.4, chargeSpeed: 25, runUp: 32 },
  },
  {
    // Glides round the edge out of trouble, and only clips the tail of a passing car.
    name: 'Mirage',
    title: 'Dodger',
    color: '#2f9fd8',
    variant: 'sedan',
    car: [{ stat: 'gripAccel', mul: 1.15 }],
    style: { ...BASE, attack: 'spin', prey: 'weak', aggression: 0.2, caution: 1, temper: 0.05 },
  },
  {
    // Hard to kill: tough, wary, and in no hurry.
    name: 'Cockroach',
    title: 'Survivor',
    color: '#e8c547',
    variant: 'pickup',
    car: [{ stat: 'toughness', mul: 1.35 }, { stat: 'maxHealth', mul: 1.15 }],
    style: { ...BASE, prey: 'weak', aggression: 0.12, caution: 0.9, temper: 0.06, chargeSpeed: 20 },
  },
  {
    // Here for the crowd: wants the player's scalp above all.
    name: 'Bandit',
    title: 'Glory hunter',
    color: '#2b2f36',
    variant: 'sedan',
    car: [],
    style: { ...BASE, prey: 'player', aggression: 0.6, dirty: 0.3, chargeSpeed: 25 },
  },
];

export const DERBY_AI = {
  /** Go after the best-scoring car once its score reaches engageAt; keep a target at least keepTarget s unless another beats it by switchMargin. */
  engageAt: 0.55,
  keepTarget: 3,
  switchMargin: 0.3,
  /** Distance (m) that halves how attractive the nearest-car bonus is. */
  preyRange: 80,
  /** Score lost per other driver already hunting a car. */
  ganging: 0.35,
  /** Every driver smells blood: bonus × the target's damage fraction. */
  blood: 0.3,
  /** Pressure (0..1, from the director: fewer cars left, nobody fighting) adds this much will to fight and takes this fraction of caution away. */
  pressureFight: 0.8,
  pressureCalm: 0.7,
  maxAnger: 1.5,
  /** Grudge settled per m/s of a hit we land on our target. */
  revenge: 0.05,
  /** Most lead (s) on the target's velocity when charging (aimed at where we'd meet it). */
  lead: 1.5,
  /** Charging: a target more than handbrakeAt rad off the nose above handbrakeSpeed m/s gets a handbrake turn, held until it's within handbrakeEnd rad. */
  handbrakeAt: 1.3,
  handbrakeEnd: 0.5,
  handbrakeSpeed: 7,
  /**
   * Turning for a target more than cornerAngle rad off the nose: slow to cornerSpeed (m/s), and further toward
   * pivotSpeed as it gets right behind us (a tight pivot, so two cars chasing each other's tails don't circle forever).
   */
  cornerAngle: 0.9,
  cornerSpeed: 13,
  pivotSpeed: 5,
  /** Boost when charging straight (|steer| < boostSteer) more than boostGap m out. */
  boostGap: 18,
  boostSteer: 0.25,
  /** Arena: aim points stay wallMargin m inside the floor; heading for the wall within wallLook s at speed: turn away. */
  wallMargin: 8,
  wallLook: 1.1,
  /** Within wallNear m of the floor's edge, heading outward at any speed: turn back in. */
  wallNear: 7,
  /** Aim point more than turnLatch rad off the nose: keep turning the same way at full lock. */
  turnLatch: 2.5,
  /** Target more than tailChaseAngle rad off the nose for tailChaseTime s: reverse into it for up to backInTime s. */
  tailChaseAngle: 2,
  tailChaseTime: 2.5,
  backInTime: 4,
  /** At this pressure spinners stop finessing and ram. */
  ramPressure: 0.7,
  /**
   * Rear attack: within reverseRange m (or with the target behind us at any range) reverse at it, swinging the tail
   * round at reverseSwing m/s until the tail points within reverseLined rad of it, then backing in at up to reverseSpeed.
   */
  reverseRange: 55,
  reverseLined: 0.6,
  reverseSwing: 7,
  reverseSpeed: 17,
  /** Rear-enders' taste for slow targets: ± this much score from a parked car to one doing 20 m/s. */
  slowPrey: 0.8,
  /** Back-off after a hit: reverse out first if slower than pinnedSpeed, for unpinTime s; then run away to runUp m (at most backoffTime s). */
  pinnedSpeed: 4,
  unpinTime: 0.8,
  backoffTime: 3,
  backoffAngle: 0.6,
  /** Dodging: a car faster than threatSpeed that will pass within threatMiss m in under threatTime s. */
  threatSpeed: 7,
  threatMiss: 5,
  threatTime: 2.2,
  /** Dodge when caution (after pressure and damage) is at least dodgeAt. */
  dodgeAt: 0.45,
  /** Damage makes everyone warier: caution + hurt × (1 − health). */
  hurt: 0.35,
  /** Lurking (no target): circle at lurkRadius × R at lurkSpeed, steering clear of cars within crowd m. */
  lurkRadius: 0.62,
  lurkSpeed: 14,
  crowd: 25,
  /** Stuck: slower than stuckSpeed for stuckTime s with the throttle on → drive the other way for unstickTime s. */
  stuckSpeed: 2,
  stuckTime: 1.2,
  unstickTime: 1.2,
};

export interface DerbySelf extends AutopilotCar {
  /** Health fraction 0..1. */
  health: number;
}

export interface DerbyOther {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Unit forward direction on the ground. */
  fx: number;
  fz: number;
  health: number;
  /** How many other drivers are going after it right now (gangs spread out). */
  hunters?: number;
}

export type DerbyMode = 'hunt' | 'backoff' | 'lurk' | 'dodge' | 'unstick';

export class DerbyDriver {
  readonly profile: DerbyProfile;
  /** Id of the car it is going after, or null. */
  target: number | null = null;
  /** The player's id: `dirty` and the 'player' prey taste go for it. */
  playerId: number | null = null;
  mode: DerbyMode = 'lurk';
  private readonly steering: SteeringModel;
  private readonly radius: number;
  private readonly anger = new Map<number, number>();
  private targetTime = 0;
  private backoff = 0;
  private unpin = 0;
  private backFrom: number | null = null;
  /** Rear attack lined up and backing in (for debugging and tests). */
  reversingIn = false;
  private stuck = 0;
  private unstick = 0;
  private unstickDir = -1;
  private unstickSteer = 1;
  /** Latched full-lock direction while the aim point is behind us (0 = none). */
  private turn = 0;
  /** Holding a handbrake turn. */
  private whipping = false;
  /** Seconds the target has been behind us, and seconds left backing into it after a tail chase. */
  private behind = 0;
  private backIn = 0;
  /** Lurking direction round the arena: +1 counter-clockwise (seen from above), −1 clockwise. */
  private orbit: number;

  constructor(profile: DerbyProfile, steering: SteeringModel, arenaRadius: number, orbit = 1) {
    this.profile = profile;
    this.steering = steering;
    this.radius = arenaRadius;
    this.orbit = orbit;
  }

  angerAt(id: number): number {
    return this.anger.get(id) ?? 0;
  }

  /** We were hit by car `id` with a jolt of `impact` m/s. */
  provoke(id: number, impact: number): void {
    this.anger.set(id, Math.min(DERBY_AI.maxAnger, this.angerAt(id) + impact * this.profile.style.temper));
  }

  /** We hit car `id` (a jolt of `impact` m/s): if it was our target, settle some of the grudge and back off for another run. */
  rammed(id: number, impact: number): void {
    if (id !== this.target || this.mode !== 'hunt') return;
    this.anger.set(id, Math.max(0, this.angerAt(id) - impact * DERBY_AI.revenge));
    this.mode = 'backoff';
    this.backIn = this.behind = 0;
    this.backFrom = id;
    this.backoff = DERBY_AI.backoffTime;
    this.unpin = 0;
    this.reversingIn = false;
  }

  reset(): void {
    this.anger.clear();
    this.target = this.backFrom = null;
    this.mode = 'lurk';
    this.targetTime = this.backoff = this.unpin = this.stuck = this.unstick = this.turn = this.behind = this.backIn = 0;
    this.reversingIn = false;
  }

  /** One control decision. `others` are the cars still running; `pressure` 0..1 pushes everyone to fight. */
  drive(me: DerbySelf, others: readonly DerbyOther[], pressure: number, dt: number, out: DriveInput): DriveInput {
    const c = DERBY_AI;
    const st = this.profile.style;
    for (const [id, a] of this.anger) {
      const left = a - st.calm * dt;
      if (left <= 0) this.anger.delete(id);
      else this.anger.set(id, left);
    }
    out.boost = false;
    out.handbrake = false;
    out.brake = 0;

    // Stuck against something (or pinned in a pile): drive the other way for a moment.
    if (this.unstick > 0) {
      this.unstick -= dt;
      out.throttle = this.unstickDir;
      out.steer = this.unstickSteer;
      return out;
    }
    this.stuck = Math.abs(out.throttle) > 0.5 && Math.abs(me.speed) < c.stuckSpeed ? this.stuck + dt : 0;
    if (this.stuck > c.stuckTime) {
      this.stuck = 0;
      this.unstick = c.unstickTime;
      this.unstickDir = out.throttle > 0 ? -1 : 1;
      // Opposite lock swings the car toward where we were steering, whichever way we go.
      this.unstickSteer = -(Math.sign(out.steer) || 1);
      this.backFrom = null;
      this.reversingIn = false;
    }

    const caution = Math.min(1, st.caution * (1 - c.pressureCalm * pressure) + c.hurt * (1 - me.health));
    const threat = caution >= c.dodgeAt ? this.threat(me, others) : null;
    const prey = this.pickTarget(me, others, pressure, dt);
    if (threat && threat.id !== prey?.id) {
      this.mode = 'dodge';
      return this.dodge(me, threat, out);
    }

    if (this.mode === 'backoff') {
      const from = others.find((o) => o.id === this.backFrom);
      this.backoff -= dt;
      if (from && this.backoff > 0 && Math.hypot(from.x - me.x, from.z - me.z) < st.runUp) return this.backOff(me, from, dt, out);
      this.mode = 'hunt';
    }

    this.target = prey?.id ?? null;
    if (!prey) {
      this.mode = 'lurk';
      return this.lurk(me, others, out);
    }
    this.mode = 'hunt';
    if (st.attack === 'rear') return this.rearAttack(me, prey, out);
    // Chasing tails (it stays behind us however we turn): stop turning and back into it.
    const off = Math.abs(Math.atan2(me.fz * (prey.x - me.x) - me.fx * (prey.z - me.z), me.fx * (prey.x - me.x) + me.fz * (prey.z - me.z)));
    if (this.backIn > 0) {
      this.backIn -= dt;
      return this.rearAttack(me, prey, out);
    }
    this.behind = off > c.tailChaseAngle ? this.behind + dt : 0;
    if (this.behind > c.tailChaseTime) {
      this.behind = 0;
      this.backIn = c.backInTime;
    }
    return this.charge(me, prey, out, st.attack === 'spin' && pressure < c.ramPressure);
  }

  /** Best car to hit right now, if any is worth it. */
  private pickTarget(me: DerbySelf, others: readonly DerbyOther[], pressure: number, dt: number): DerbyOther | null {
    const c = DERBY_AI;
    const st = this.profile.style;
    let best: DerbyOther | null = null;
    let bestScore = -Infinity;
    let current: DerbyOther | null = null;
    let currentScore = -Infinity;
    for (const o of others) {
      const d = Math.hypot(o.x - me.x, o.z - me.z);
      const near = c.preyRange / (c.preyRange + d);
      let score = st.aggression + this.angerAt(o.id) + c.pressureFight * pressure + c.blood * (1 - o.health);
      if (st.prey === 'near') score += 0.6 * near - 0.3;
      else if (st.prey === 'weak') score += 1.2 * (1 - o.health) + 0.3 * near - 0.45;
      else score += (o.id === this.playerId ? 0.5 : 0) + 0.3 * near - 0.3;
      if (o.id === this.playerId) score += st.dirty;
      // Someone's already on it: look for a fight of our own.
      score -= c.ganging * Math.max(0, (o.hunters ?? 0) - (o.id === this.target ? 1 : 0));
      // Reversing in only works on cars that sit still long enough: rear-enders pick on the slow ones.
      if (st.attack === 'rear') score += c.slowPrey * (Math.max(0, 1 - Math.hypot(o.vx, o.vz) / 10) - 0.5);
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
      if (o.id === this.target) {
        current = o;
        currentScore = score;
      }
    }
    this.targetTime += dt;
    if (current && currentScore >= c.engageAt * 0.8 && (this.targetTime < c.keepTarget || currentScore + c.switchMargin >= bestScore)) return current;
    if (!best || bestScore < c.engageAt) return null;
    if (best.id !== this.target) this.targetTime = 0;
    return best;
  }

  /** Nose-first (or rear-quarter, for spinners) at the target's predicted position. */
  private charge(me: DerbySelf, prey: DerbyOther, out: DriveInput, spin: boolean): DriveInput {
    const c = DERBY_AI;
    const st = this.profile.style;
    const d = Math.hypot(prey.x - me.x, prey.z - me.z);
    const t = intercept(prey.x - me.x, prey.z - me.z, prey.vx, prey.vz, Math.max(10, me.speed), c.lead);
    let x = prey.x + prey.vx * t;
    let z = prey.z + prey.vz * t;
    let speed = st.chargeSpeed;
    if (spin) {
      if (Math.hypot(prey.vx, prey.vz) > 6) {
        const p = attackPoint('spin', me, prey);
        x = p.x;
        z = p.z;
        if (p.speed !== undefined) speed = Math.min(speed, p.speed);
      } else {
        // Parked: hit the back corner on our side so it swings round.
        const lat = (me.x - prey.x) * prey.fz - (me.z - prey.z) * prey.fx;
        const side = Math.sign(lat) || 1;
        x = prey.x - prey.fx * 1.6 + prey.fz * side;
        z = prey.z - prey.fz * 1.6 - prey.fx * side;
      }
    }
    this.forwardTo(me, x, z, speed, out, true);
    if (Math.abs(out.steer) < c.boostSteer && d > c.boostGap && st.aggression >= 0.6 && out.throttle >= 1) out.boost = true;
    return out;
  }

  /**
   * Tail to the target and reverse into it. A target off to the side or in front gets a tight reversing
   * swing first (reverse pursuit is at full lock there, so the tail comes round), slow until lined up.
   */
  private rearAttack(me: DerbySelf, prey: DerbyOther, out: DriveInput): DriveInput {
    const c = DERBY_AI;
    const st = this.profile.style;
    const dx = prey.x - me.x;
    const dz = prey.z - me.z;
    const d = Math.hypot(dx, dz);
    const off = Math.abs(Math.atan2(me.fz * dx - me.fx * dz, me.fx * dx + me.fz * dz));
    if (d > c.reverseRange && off < Math.PI / 2) return this.forwardTo(me, prey.x, prey.z, st.chargeSpeed * 0.75, out, false);
    const tailOff = Math.PI - off;
    this.reversingIn = tailOff < c.reverseLined;
    const t = Math.min(c.lead, d / Math.max(6, -me.speed));
    const lined = Math.max(0, Math.min(1, (2 * c.reverseLined - tailOff) / c.reverseLined));
    return this.reverseTo(me, prey.x + prey.vx * t, prey.z + prey.vz * t, c.reverseSwing + (c.reverseSpeed - c.reverseSwing) * lined, out);
  }

  /** After a hit: unpin (reverse out) if we're stuck in it, then drive away on a curve for a run-up. */
  private backOff(me: DerbySelf, from: DerbyOther, dt: number, out: DriveInput): DriveInput {
    const c = DERBY_AI;
    const st = this.profile.style;
    if (st.attack !== 'rear' && (this.unpin > 0 || Math.abs(me.speed) < c.pinnedSpeed && this.backoff > c.backoffTime - 0.2)) {
      this.unpin = this.unpin > 0 ? this.unpin - dt : c.unpinTime;
      out.throttle = -1;
      out.steer = 0;
      return out;
    }
    const dx = me.x - from.x;
    const dz = me.z - from.z;
    // Away from it, swung toward the arena centre side so the run-up curves back round.
    const a = Math.atan2(dz, dx) + this.orbit * c.backoffAngle;
    return this.forwardTo(me, from.x + Math.cos(a) * st.runUp * 1.5, from.z + Math.sin(a) * st.runUp * 1.5, st.chargeSpeed * 0.8, out, false);
  }

  /** No one worth hitting: circle the arena, steering clear of the crowd. */
  private lurk(me: DerbySelf, others: readonly DerbyOther[], out: DriveInput): DriveInput {
    const c = DERBY_AI;
    const r = this.radius * c.lurkRadius;
    const a = Math.atan2(me.z, me.x) + this.orbit * 0.5;
    let x = Math.cos(a) * r;
    let z = Math.sin(a) * r;
    for (const o of others) {
      const d = Math.hypot(me.x - o.x, me.z - o.z);
      if (d >= c.crowd || d < 0.1) continue;
      const push = ((c.crowd - d) / c.crowd) * 15;
      x += ((me.x - o.x) / d) * push;
      z += ((me.z - o.z) / d) * push;
    }
    return this.forwardTo(me, x, z, c.lurkSpeed, out, false);
  }

  /** A car about to hit us: swerve off its line, flat out. */
  private dodge(me: DerbySelf, o: DerbyOther, out: DriveInput): DriveInput {
    const sp = Math.hypot(o.vx, o.vz) || 1;
    const ux = o.vx / sp;
    const uz = o.vz / sp;
    // Off to whichever side of its line we already are on.
    const side = Math.sign((me.x - o.x) * uz - (me.z - o.z) * ux) || this.orbit;
    const ex = me.x + uz * side * 20 + me.fx * 10;
    const ez = me.z - ux * side * 20 + me.fz * 10;
    this.forwardTo(me, ex, ez, Infinity, out, false);
    out.boost = Math.abs(out.steer) < 0.5;
    return out;
  }

  /** The car most likely to hit us soon, if one is coming. */
  private threat(me: DerbySelf, others: readonly DerbyOther[]): DerbyOther | null {
    const c = DERBY_AI;
    const vx = me.fx * me.speed;
    const vz = me.fz * me.speed;
    let worst: DerbyOther | null = null;
    let soonest = c.threatTime;
    for (const o of others) {
      if (Math.hypot(o.vx, o.vz) < c.threatSpeed) continue;
      const rx = o.x - me.x;
      const rz = o.z - me.z;
      const wx = o.vx - vx;
      const wz = o.vz - vz;
      const w2 = wx * wx + wz * wz;
      if (w2 < 1) continue;
      const t = -(rx * wx + rz * wz) / w2;
      if (t <= 0 || t >= soonest) continue;
      // It must be driving at us, not just us at it.
      if (o.vx * -rx + o.vz * -rz <= 0) continue;
      if (Math.hypot(rx + wx * t, rz + wz * t) > c.threatMiss) continue;
      worst = o;
      soonest = t;
    }
    return worst;
  }

  /** Drive forward toward (x, z) at up to `speed`, kept inside the arena and away from the wall. */
  private forwardTo(me: DerbySelf, x: number, z: number, speed: number, out: DriveInput, attacking: boolean): DriveInput {
    const c = DERBY_AI;
    const R = this.radius - c.wallMargin;
    const r = Math.hypot(x, z);
    if (r > R) {
      x *= R / r;
      z *= R / r;
    }
    // About to run into the wall (or already out by it, heading outward): aim back inward, round the way we're going.
    const ahead = Math.max(0, me.speed) * c.wallLook;
    const px = me.x + me.fx * ahead;
    const pz = me.z + me.fz * ahead;
    const rMe = Math.hypot(me.x, me.z);
    const outward = (me.x * me.fx + me.z * me.fz) / (rMe || 1);
    const nearWall = rMe > this.radius - c.wallNear;
    let wall = false;
    if ((Math.hypot(px, pz) > this.radius - 3 || nearWall) && outward > 0.1) {
      const turn = Math.sign(me.x * me.fz - me.z * me.fx) || this.orbit; // + = we're circling clockwise
      const a = Math.atan2(me.z, me.x) - turn * 0.9;
      x = Math.cos(a) * this.radius * 0.4;
      z = Math.sin(a) * this.radius * 0.4;
      wall = true;
    }
    out.steer = pursuitSteer(me, x - me.x, z - me.z, this.steering);
    // A target (nearly) dead behind: commit to one way round instead of flicking between full left and right;
    // by the wall, the way that turns toward the centre.
    const behind = Math.abs(Math.atan2(me.fz * (x - me.x) - me.fx * (z - me.z), me.fx * (x - me.x) + me.fz * (z - me.z))) > c.turnLatch;
    if (behind) {
      if (this.turn === 0) this.turn = nearWall ? (me.x * me.fz - me.z * me.fx > 0 ? 1 : -1) : Math.sign(out.steer) || this.orbit;
      out.steer = this.turn;
    }
    const off = Math.abs(Math.atan2(me.fz * (x - me.x) - me.fx * (z - me.z), me.fx * (x - me.x) + me.fz * (z - me.z)));
    let want = speed;
    // Charging and it's well off to the side: handbrake round to face it (steering latched the way we're turning).
    this.whipping = attacking && !wall && me.speed > 3 && (this.whipping ? off > c.handbrakeEnd : off > c.handbrakeAt && me.speed > c.handbrakeSpeed);
    if (this.whipping) {
      if (this.turn === 0) this.turn = Math.sign(out.steer) || this.orbit;
      out.steer = this.turn;
      out.handbrake = true;
      out.throttle = 1;
      return out;
    }
    if (off <= c.turnLatch) this.turn = 0;
    // A big turn to make: slow down for it, down to a pivot for a target behind us (a charge commits once lined up).
    if (off > c.cornerAngle) want = Math.min(want, c.pivotSpeed + (c.cornerSpeed - c.pivotSpeed) * ((Math.PI - off) / (Math.PI - c.cornerAngle)));
    if (wall) want = Math.min(want, c.cornerSpeed);
    if (!attacking && wall) want = Math.min(want, c.cornerSpeed * 0.8);
    const err = want - me.speed;
    out.throttle = err > 0 ? Math.min(1, 0.3 + err * 0.5) : 0;
    out.brake = err < -2 ? Math.min(1, -err * 0.15) : 0;
    return out;
  }

  /** Reverse toward (x, z) at up to `speed` m/s backwards. */
  private reverseTo(me: DerbySelf, x: number, z: number, speed: number, out: DriveInput): DriveInput {
    // Steer as if the tail were the nose; reversing, the wheel works the other way round.
    const back = { x: me.x, z: me.z, fx: -me.fx, fz: -me.fz, speed: -me.speed };
    const s = this.steering;
    out.steer = -pursuitSteer(back, x - me.x, z - me.z, { ...s, maxSteer: s.maxSteer * (s.reverseSteer ?? 1) });
    out.throttle = -me.speed > speed ? 0 : -1;
    return out;
  }
}

/** Time (s, at most `max`) until a car at relative position (rx, rz) moving at (vx, vz) can be met by driving at `speed`. */
export function intercept(rx: number, rz: number, vx: number, vz: number, speed: number, max: number): number {
  // |r + v t| = speed · t  →  (v² − s²) t² + 2 (r·v) t + r² = 0
  const a = vx * vx + vz * vz - speed * speed;
  const b = 2 * (rx * vx + rz * vz);
  const cc = rx * rx + rz * rz;
  let t: number;
  if (Math.abs(a) < 1e-6) t = b < 0 ? -cc / b : max;
  else {
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return max;
    const q = Math.sqrt(disc);
    const t1 = (-b - q) / (2 * a);
    const t2 = (-b + q) / (2 * a);
    t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
  }
  return Number.isFinite(t) ? Math.min(max, Math.max(0, t)) : max;
}
