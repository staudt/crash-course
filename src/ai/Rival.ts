import type { DriveInput } from '../core/types';
import { RACE_CONFIG } from '../race/Race';
import type { TrackPath } from '../race/TrackPath';
import type { CarVariant } from '../vehicle/CarBuilder';
import type { StatModifier } from '../vehicle/CarStats';
import { Autopilot, type AutopilotCar, type SteeringModel } from './Autopilot';

/**
 * An AI racer's brain: an Autopilot plus a personality. Everyone races to win; the
 * personality decides how (late braking, smooth apex-cutting lines, sand-running) and how
 * they react to contact: getting hit builds anger toward whoever hit them, and an angry
 * driver hunts that car down and rams it while it is within reach. Bullies ram whatever
 * gets in front of them, angry or not. Pure apart from types: Game owns the Car.
 */
/**
 * How a driver hits the car it's after. ram: straight at it. spin: up beside its rear, then into the
 * rear quarter so it spins out. shove: alongside from the road-centre side, then lean into it to push it off the road.
 */
export type AttackStyle = 'ram' | 'spin' | 'shove';

export interface DrivingStyle {
  /** Multiplies the corner speed the driver trusts (Autopilot lateralGrip). */
  cornerGrip: number;
  /** Multiplies the braking the driver plans with: > 1 brakes later and harder. */
  lateBraking: number;
  /** Multiplies the pursuit look-ahead: > 1 takes rounder, smoother lines. */
  smoothness: number;
  /** 0..1: how far toward the inside of an upcoming bend the line moves (apex cutting). */
  apexCut: number;
  /** Fraction of grip the driver trusts on open sand. */
  sandGrip: number;
  /** Top speed the driver aims for on straights (m/s). */
  maxSpeed: number;
  /** 0..1: urge to ram any car close in front, without being provoked. */
  aggression: number;
  /** Anger gained per m/s of impact when hit by another car (and, scaled by blockedAnger, per second stuck behind one). */
  temper: number;
  /** Anger lost per second. */
  calm: number;
  /** Anger gained each time a car overtakes us. */
  pride: number;
  attack: AttackStyle;
  /** Health fraction below which the driver pulls into the next repair station. */
  pitAt: number;
  /** 0..1: urge to attack the player whenever close (alongside or just ahead), on top of any anger. */
  dirty: number;
}

export interface RivalProfile {
  name: string;
  /** Short personality tag for the HUD. */
  title: string;
  color: string;
  variant: CarVariant;
  /** 0 = cautious .. 1 = on the limit (base corner/brake confidence). */
  skill: number;
  /** Preferred lateral offset (m, positive = left) when the road ahead is clear. */
  lane: number;
  /** The car, tuned to match the driver. */
  car: StatModifier[];
  style: DrivingStyle;
}

export const BASE_STYLE: DrivingStyle = { cornerGrip: 1, lateBraking: 1, smoothness: 1, apexCut: 0, sandGrip: 0.8, maxSpeed: 90, aggression: 0, temper: 0.1, calm: 0.035, pride: 0, attack: 'ram', pitAt: 0.4, dirty: 0.2 };

export const RIVALS: RivalProfile[] = [
  {
    // Lives for the straights: big engine, brakes at the last moment, scrappy in the corners.
    name: 'Viper',
    title: 'Speed demon',
    color: '#d8432f',
    variant: 'sedan',
    skill: 0.8,
    lane: 1.5,
    car: [{ stat: 'engineForce', mul: 1.25 }, { stat: 'topSpeed', mul: 1.1 }, { stat: 'gripAccel', mul: 0.88 }, { stat: 'brakeDecel', mul: 1.15 }],
    style: { ...BASE_STYLE, cornerGrip: 0.88, lateBraking: 1.35, maxSpeed: 100, pride: 0.3, attack: 'spin', pitAt: 0.3, dirty: 0.35 },
  },
  {
    // Clean and precise: grippy car, rounds every corner off and clips the apex. Rarely loses its cool.
    name: 'Mirage',
    title: 'Smooth operator',
    color: '#2f9fd8',
    variant: 'sedan',
    skill: 0.8,
    lane: 0,
    car: [{ stat: 'gripAccel', mul: 1.15 }, { stat: 'engineForce', mul: 0.92 }, { stat: 'driftMaxSlip', mul: 0.8 }],
    style: { ...BASE_STYLE, cornerGrip: 1.1, lateBraking: 0.9, smoothness: 1.4, apexCut: 0.8, temper: 0.04, calm: 0.08, attack: 'spin', pitAt: 0.55, dirty: 0.05 },
  },
  {
    // A heavy, armoured pickup that shoves anything in its way and holds a grudge.
    name: 'Scorpion',
    title: 'Bully',
    color: '#3fae6a',
    variant: 'pickup',
    skill: 0.5,
    lane: -1,
    car: [{ stat: 'mass', mul: 1.4 }, { stat: 'engineForce', mul: 1.3 }, { stat: 'toughness', mul: 1.6 }, { stat: 'maxHealth', mul: 1.3 }],
    style: { ...BASE_STYLE, aggression: 0.9, temper: 0.15, calm: 0.025, pride: 0.15, attack: 'shove', pitAt: 0.35, dirty: 0.15 },
  },
  {
    // Born in the dunes: a pickup set up for sand, flat out where others lift.
    name: 'Dune Rat',
    title: 'Sand runner',
    color: '#e8c547',
    variant: 'pickup',
    skill: 0.6,
    lane: -2,
    car: [{ stat: 'sandDrag', mul: 0.5 }, { stat: 'sandSlip', mul: 0.4 }],
    style: { ...BASE_STYLE, sandGrip: 1.05, aggression: 0.1, pride: 0.1, attack: 'shove', dirty: 0.25 },
  },
  {
    // Not the quickest, with the shortest fuse on the grid: one bump and it's personal, for a long time.
    name: 'Rusty',
    title: 'Hothead',
    color: '#7a4fc9',
    variant: 'sedan',
    skill: 0.35,
    lane: 0.5,
    car: [{ stat: 'toughness', mul: 1.2 }],
    style: { ...BASE_STYLE, aggression: 0.2, temper: 0.3, calm: 0.015, pride: 0.3, pitAt: 0.25, dirty: 0.4 },
  },
];

export const RIVAL_CONFIG = {
  /** Autopilot settings at skill 0 and skill 1 (before the style multipliers). */
  gripMin: 10.5,
  gripMax: 13.8,
  brakeMin: 11,
  brakeMax: 15,
  /** Overtaking: react to a car up to `look` m ahead within `width` m of our line, by moving `step` m aside. */
  look: 30,
  width: 3.2,
  step: 4.5,
  /** Don't rear-end (unless we mean to): brake for a slower car closer than `gap` m ahead within `gapWidth` m. */
  gap: 14,
  gapWidth: 2.6,
  /** How fast the followed line slides sideways (m/s). */
  offsetRate: 3,
  /** Apex cutting: bends within this distance ahead pull the line toward their inside. */
  apexLook: 60,
  /** Rubber band: up to ±pace change when `range` m behind/ahead of the player. */
  rubberBand: 0.1,
  rubberRange: 400,
  /**
   * Keep the pack around the player (Car.powerScale): engine power and top speed rise by up to catchUp when catchRange m
   * behind the player, and fall by up to holdBack when that far ahead.
   */
  catchUp: 0.3,
  holdBack: 0.2,
  catchRange: 300,
  /** Hunting a car ahead: rage adds this much power, and boost is used on straights (|steer| < boostSteer) when more than boostGap m from it. */
  rage: 0.15,
  boostGap: 8,
  boostSteer: 0.25,
  /** Racing: boost on straights when this far (m) behind the player. */
  boostBehind: 150,
  /** Everyone's favourite target: anger toward the player builds this much faster. */
  playerGrudge: 1.5,
  /** Keep after a target this far (m) when it is ahead of us (we're racing that way anyway). */
  chaseRange: 150,
  /** Dirty play reaches from this far (m) behind the player's centre (alongside) to bullyRange ahead. */
  alongside: 4,
  /** Fighting: start at `fightAt` anger (or aggression urge), give up below `fightUntil`. */
  fightAt: 0.5,
  fightUntil: 0.2,
  maxAnger: 1.5,
  /** Only fight cars within this distance, and never one more than `fightBehind` m behind us on the track (winning comes first). */
  fightRange: 60,
  fightBehind: 25,
  /**
   * Only cars on our stretch of road: one whose gap along the track (any lap) is more than
   * `roadDetour` × the straight-line distance + `roadSlack` m is round a bend or across a crossing,
   * and chasing straight at it would cut through walls (on a figure 8, drive down the other road).
   */
  roadDetour: 1.5,
  roadSlack: 20,
  /** Unprovoked ramming (aggression): a car within this distance ahead and `bullyWidth` m to the side. */
  bullyRange: 22,
  bullyWidth: 8,
  /** Lead (s) on the target's velocity when ramming. */
  ramLead: 0.35,
  /** Stuck braking behind a slower car: anger at it grows by temper × blockedAnger per second. */
  blockedAnger: 1.5,
  /** Overtaken (pride): only counts for a car passing within this distance. */
  passRange: 25,
  /**
   * Spin attack: line up `spinBeside` m beside the target's rear (its centre is `spinRear` m ahead of that). Once
   * our centre is within `spinReach` m behind that point and at least `spinSide` m out, cut `spinCut` m across it,
   * `spinPush` m/s faster than it.
   */
  spinRear: 1.8,
  spinBeside: 2.8,
  spinReach: 1.5,
  spinSide: 2,
  spinCut: 3,
  spinPush: 4,
  /** Shove attack: line up `shoveBeside` m beside it, then lean `shoveCut` m into it. */
  shoveBeside: 2.6,
  shoveCut: 2,
  /** Shove lined up: no more than `strikeBehind` m behind it and at least `strikeSide` m out to the side. */
  strikeBehind: 3,
  strikeSide: 1,
  /** Spin/shove speed matching: the target's speed plus `closeRate` per m we are behind the aim point, within closeMin..closeMax. */
  closeRate: 0.8,
  closeMin: -8,
  closeMax: 10,
  /** Too far off the track while fighting (us or the target): calm down and get back to racing. */
  fightMaxOffTrack: 14,
  /** Landing a hit on the target settles `revenge` anger per m/s of the jolt: a rub barely counts, a big ram ends the feud. */
  revenge: 0.05,
  /** A hit of at least `solidHit` m/s on its target satisfies a bully for `bullyCooldown` s. */
  solidHit: 5,
  bullyCooldown: 10,
  /** No rescues: a car slower than stuckSpeed for stuckTime with the throttle on backs out for reverseTime. */
  stuckSpeed: 3,
  stuckTime: 1.5,
  reverseTime: 1.3,
  /** Drove this far past a gate without crossing it (missed it): turn back to `turnBackTo` m before it until back behind it. */
  missedGate: 25,
  turnBackTo: 15,
  turnBackSpeed: 12,
  /** Pitting: head for a station when one is within pitLook m; stop pitStop m before its gate, pitLane m in from the right road edge. */
  pitLook: 300,
  pitStop: 5,
  pitLane: 2.5,
  /** Planned braking into the pit stop (m/s²). */
  pitDecel: 7,
  /** Leave the station at this health fraction. */
  pitUntil: 0.9,
};

/** What a rival knows about its own car and race besides position (all optional: defaults = healthy, on course). */
export interface RivalSelf extends AutopilotCar {
  /** Health fraction 0..1. */
  health?: number;
  /** How far past the gate it must cross next (m; Race.pastNextGate). */
  pastGate?: number;
}

export interface OtherCar {
  /** Stable id of the other racer (anger is kept per id). */
  id: number;
  x: number;
  z: number;
  /** Velocity on the ground plane (m/s); without it the car counts as stopped. */
  vx?: number;
  vz?: number;
  /** How far ahead of us it is in the race (m, negative = behind). */
  ahead?: number;
  /** Its distance from the track centreline (m). */
  offTrack?: number;
  /** Out of the race (a wreck left on the track): an obstacle to drive round, never a target. */
  out?: boolean;
  /** Its signed offset from the centreline (m, + = left); the shove attack pushes it outward. */
  lateral?: number;
}

/**
 * Where `attack` steers to hit `prey` from `me` (prey heading from its velocity, or from us toward it when slow),
 * and for spin/shove the speed to drive at: matched to the prey so we line up beside it instead of overshooting.
 */
export function attackPoint(attack: AttackStyle, me: { x: number; z: number }, prey: OtherCar): { x: number; z: number; speed?: number } {
  const c = RIVAL_CONFIG;
  const vx = prey.vx ?? 0;
  const vz = prey.vz ?? 0;
  const px = prey.x + vx * c.ramLead;
  const pz = prey.z + vz * c.ramLead;
  if (attack === 'ram') return { x: px, z: pz };
  const sp = Math.hypot(vx, vz);
  let fx = vx / sp;
  let fz = vz / sp;
  if (!(sp > 3)) {
    const d = Math.hypot(prey.x - me.x, prey.z - me.z) || 1;
    fx = (prey.x - me.x) / d;
    fz = (prey.z - me.z) / d;
  }
  const lx = fz; // its left: (fz, -fx)
  const lz = -fx;
  const rx = me.x - prey.x;
  const rz = me.z - prey.z;
  const along = rx * fx + rz * fz; // + = we're ahead of it
  const lat = rx * lx + rz * lz; // + = we're on its left
  if (attack === 'spin') {
    const side = Math.sign(lat) || 1;
    const bx = px - fx * c.spinRear;
    const bz = pz - fz * c.spinRear;
    const lined = along > -c.spinRear - c.spinReach && lat * side > c.spinSide;
    const k = lined ? -side * c.spinCut : side * c.spinBeside;
    return { x: bx + lx * k, z: bz + lz * k, speed: lined ? sp + c.spinPush : matchSpeed(sp, -c.spinRear - along) };
  }
  // Shove: from the side nearer the road centre, so the push goes outward.
  const side = prey.lateral !== undefined && Math.abs(prey.lateral) > 0.5 ? -Math.sign(prey.lateral) : Math.sign(lat) || 1;
  const lined = along > -c.strikeBehind && lat * side > c.strikeSide;
  const k = lined ? -side * c.shoveCut : side * c.shoveBeside;
  return { x: px + lx * k, z: pz + lz * k, speed: matchSpeed(sp, -along) };
}

/** The prey's speed, plus a closing speed for `gap` m (along its heading) still to make up. */
function matchSpeed(preySpeed: number, gap: number): number {
  const c = RIVAL_CONFIG;
  return Math.max(0, preySpeed + Math.max(c.closeMin, Math.min(c.closeMax, gap * c.closeRate)));
}

export class RivalDriver {
  readonly profile: RivalProfile;
  readonly pilot: Autopilot;
  /** Id of the car being hunted, or null while just racing. */
  target: number | null = null;
  /** The player's id, if racing against one: anger toward it builds faster, and `dirty` drivers go for it. */
  playerId: number | null = null;
  /** Engine power and top speed multiplier this driver wants (catch-up and rage), for Car.powerScale. */
  power = 1;
  private readonly anger = new Map<number, number>();
  /** Each car's `ahead` last decision, to notice it overtaking us. */
  private readonly lastAhead = new Map<number, number>();
  private cooldown = 0;
  /** Heading for (or stopped in) a repair station. */
  pitting = false;
  /** Driving back to a gate it missed. */
  turningBack = false;
  private stuck = 0;
  /** Seconds of backing out left, and the steering for it. */
  private reversing = 0;
  private reverseSteer = 1;

  constructor(path: TrackPath, steering: SteeringModel, profile: RivalProfile) {
    const c = RIVAL_CONFIG;
    const st = profile.style;
    const k = Math.min(1, Math.max(0, profile.skill));
    this.profile = profile;
    this.pilot = new Autopilot(path, steering, {
      lateralGrip: (c.gripMin + (c.gripMax - c.gripMin) * k) * st.cornerGrip,
      brakeDecel: (c.brakeMin + (c.brakeMax - c.brakeMin) * k) * st.lateBraking,
      lookahead: 7 * st.smoothness,
      lookaheadPerSpeed: 0.4 * st.smoothness,
      sandGrip: st.sandGrip,
      maxSpeed: st.maxSpeed,
    });
    this.pilot.offset = profile.lane;
  }

  /** How angry we are at car `id` (0 = calm). */
  angerAt(id: number): number {
    return this.anger.get(id) ?? 0;
  }

  /** We were hit by car `id` with a jolt of `impact` m/s. */
  provoke(id: number, impact: number): void {
    this.annoy(id, impact * this.profile.style.temper);
  }

  private annoy(id: number, amount: number): void {
    if (id === this.playerId) amount *= RIVAL_CONFIG.playerGrudge;
    if (amount > 0) this.anger.set(id, Math.min(RIVAL_CONFIG.maxAnger, this.angerAt(id) + amount));
  }

  /**
   * We just hit car `id` with a jolt of `impact` m/s. If it was the one we were after, that's revenge
   * in proportion to the hit: a rub keeps the hunt on, a big ram ends it, and a solid hit satisfies a bully for a while.
   */
  rammed(id: number, impact: number): void {
    if (id !== this.target) return;
    const c = RIVAL_CONFIG;
    const left = Math.max(0, this.angerAt(id) - impact * c.revenge);
    this.anger.set(id, left);
    if (impact >= c.solidHit) this.cooldown = c.bullyCooldown;
    if (left < c.fightUntil && this.cooldown > 0) this.target = null;
  }

  /** After a respawn: back on the racing line. Grudges survive a respawn. */
  reset(): void {
    this.pilot.reset();
    this.pilot.offset = this.profile.lane;
    this.target = null;
    this.pitting = this.turningBack = false;
    this.stuck = this.reversing = 0;
  }

  /** Fresh race: forget grudges too. */
  forgetAll(): void {
    this.anger.clear();
    this.lastAhead.clear();
    this.cooldown = 0;
    this.reset();
  }

  /**
   * One control decision. `others` are the other racers; `behindPlayer` is the player's race progress
   * minus ours (m, positive = we are behind).
   */
  drive(car: RivalSelf, others: readonly OtherCar[], behindPlayer: number, dt: number, out: DriveInput): DriveInput {
    const c = RIVAL_CONFIG;
    for (const [id, a] of this.anger) {
      const left = a - this.profile.style.calm * dt;
      if (left <= 0) this.anger.delete(id);
      else this.anger.set(id, left);
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
    // Pride: a car that was behind us is now ahead, close by: it just overtook us.
    for (const o of others) {
      const was = this.lastAhead.get(o.id);
      if (was !== undefined && was <= 0 && (o.ahead ?? 0) > 0 && Math.hypot(o.x - car.x, o.z - car.z) < c.passRange) this.annoy(o.id, this.profile.style.pride);
      this.lastAhead.set(o.id, o.ahead ?? 0);
    }
    const band = Math.max(-1, Math.min(1, behindPlayer / c.rubberRange));
    this.pilot.pace = 1 + band * c.rubberBand;
    const gap = Math.max(-1, Math.min(1, behindPlayer / c.catchRange));
    this.power = 1 + (gap > 0 ? c.catchUp : c.holdBack) * gap;
    out.boost = false;

    // Getting out of trouble on our own (there are no rescues): back out when stuck, turn back for a missed gate.
    const wasThrottling = out.throttle > 0;
    if (this.reversing > 0) {
      this.reversing -= dt;
      this.target = null;
      out.throttle = -1;
      out.brake = 0;
      out.handbrake = false;
      out.steer = this.reverseSteer;
      return out;
    }
    this.stuck = wasThrottling && Math.abs(car.speed) < c.stuckSpeed ? this.stuck + dt : 0;
    if (this.stuck > c.stuckTime) {
      this.stuck = 0;
      this.reversing = c.reverseTime;
      // Reversing with opposite lock swings the nose toward where we were steering.
      this.reverseSteer = -(Math.sign(out.steer) || 1);
    }
    const pastGate = car.pastGate ?? 0;
    if (pastGate > c.missedGate) this.turningBack = true;
    if (this.turningBack) {
      if (pastGate <= 0) this.turningBack = false;
      else {
        this.target = null;
        const p = this.pilot.path.pointAt(this.pilot.s - pastGate - c.turnBackTo, { x: 0, z: 0 });
        return this.pilot.chase(car, p.x, p.z, out, c.turnBackSpeed);
      }
    }

    // Badly damaged: pull into the next repair station and wait there until mended.
    const health = car.health ?? 1;
    if (health >= c.pitUntil) this.pitting = false;
    else if (health < this.profile.style.pitAt && this.stationAhead() < c.pitLook) this.pitting = true;
    if (this.pitting) return this.pit(car, dt, out);

    const prey = this.pickTarget(car, others);
    this.target = prey?.id ?? null;
    if (prey) {
      const p = attackPoint(this.profile.style.attack, car, prey);
      this.pilot.chase(car, p.x, p.z, out);
      if (p.speed !== undefined && car.speed > p.speed) {
        out.throttle = 0;
        out.brake = Math.min(1, (car.speed - p.speed) / 8);
      }
      // Rage: chasing it down, flat out, boosting on the straights.
      const along = (prey.x - car.x) * car.fx + (prey.z - car.z) * car.fz;
      if (along > 0) {
        this.power += c.rage;
        out.boost = along > c.boostGap && out.throttle >= 1 && Math.abs(out.steer) < c.boostSteer;
      }
      return out;
    }

    this.pilot.offset = approach(this.pilot.offset, this.wantedOffset(car, others), c.offsetRate * dt);
    this.pilot.drive(car, out);

    // Closing on a slower car right in front: lift and brake in proportion, while the line shifts to pass.
    // Being held up winds up the hotheads.
    let brake = 0;
    for (const o of others) {
      const dx = o.x - car.x;
      const dz = o.z - car.z;
      const along = dx * car.fx + dz * car.fz;
      const lat = dx * car.fz - dz * car.fx;
      if (along <= 0 || along > c.gap || Math.abs(lat) > c.gapWidth) continue;
      const closing = car.speed - ((o.vx ?? 0) * car.fx + (o.vz ?? 0) * car.fz);
      if (closing <= 0.5) continue;
      brake = Math.max(brake, Math.min(1, (closing * closing) / (2 * Math.max(1, along - 5)) / 20));
      this.annoy(o.id, this.profile.style.temper * c.blockedAnger * dt);
    }
    if (brake > 0) {
      out.throttle = 0;
      out.brake = Math.max(out.brake, brake);
    }
    out.boost = behindPlayer > c.boostBehind && out.throttle > 0 && Math.abs(out.steer) < c.boostSteer;
    return out;
  }

  /** Distance along the track (m) to the next pit stop point (pitStop m before a gate), from the last known position. */
  private stationAhead(): number {
    const path = this.pilot.path;
    let best = Infinity;
    for (const [i, cp] of path.checkpoints.entries()) {
      if (!path.hasStation(i)) continue;
      // Just past the stop point (still in the station) counts as being there.
      const d = path.wrap(cp - RIVAL_CONFIG.pitStop - this.pilot.s + RACE_CONFIG.repairReach / 2) - RACE_CONFIG.repairReach / 2;
      best = Math.min(best, d);
    }
    return best;
  }

  /** Drive into the station on the right-hand side of the road, brake to a stop there and hold. */
  private pit(car: RivalSelf, dt: number, out: DriveInput): DriveInput {
    const c = RIVAL_CONFIG;
    this.target = null;
    this.pilot.offset = approach(this.pilot.offset, -(this.pilot.path.halfWidth - c.pitLane), c.offsetRate * dt);
    this.pilot.drive(car, out);
    const d = this.stationAhead();
    const vmax = d <= 0.5 ? 0 : Math.sqrt(2 * c.pitDecel * d);
    if (car.speed > vmax) {
      out.throttle = 0;
      out.brake = d <= 0.5 ? 1 : Math.min(1, (car.speed - vmax) / 4 + 0.2);
    }
    return out;
  }

  /**
   * The car worth ramming right now, if any: the one we're angriest at (or, for aggressive drivers,
   * one sitting close in front), as long as it's within reach and not left behind in the race.
   */
  private pickTarget(car: AutopilotCar, others: readonly OtherCar[]): OtherCar | null {
    const c = RIVAL_CONFIG;
    if (this.pilot.distance > c.fightMaxOffTrack) {
      // Chased it into the dunes: let it go and get back to racing.
      for (const [id, a] of this.anger) this.anger.set(id, Math.min(a, c.fightUntil));
      return null;
    }
    let best: OtherCar | null = null;
    let bestScore = 0;
    for (const o of others) {
      const dx = o.x - car.x;
      const dz = o.z - car.z;
      const d = Math.hypot(dx, dz);
      const reach = (o.ahead ?? 0) > 0 ? c.chaseRange : c.fightRange;
      if (o.out || d > reach || (o.ahead ?? 0) < -c.fightBehind || (o.offTrack ?? 0) > c.fightMaxOffTrack) continue;
      if (Math.abs(this.roadGap(o)) > d * c.roadDetour + c.roadSlack) continue;
      let score = this.angerAt(o.id);
      const along = dx * car.fx + dz * car.fz;
      const lat = dx * car.fz - dz * car.fx;
      if (this.cooldown <= 0 && along < c.bullyRange && Math.abs(lat) < c.bullyWidth) {
        // Bullies go for whatever is in front; dirty drivers go for the player alongside too.
        if (along > 0) score += this.profile.style.aggression;
        if (along > -c.alongside && o.id === this.playerId) score += this.profile.style.dirty;
      }
      // Keep after the current target until anger drops below fightUntil (hysteresis).
      const needed = o.id === this.target ? c.fightUntil : c.fightAt;
      if (score >= needed && score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    return best;
  }

  /** Gap (m) along the track to another car, whatever lap either is on: + = it's in front of us on the road. */
  private roadGap(o: OtherCar): number {
    const L = this.pilot.path.length;
    return ((((o.ahead ?? 0) % L) + L * 1.5) % L) - L / 2;
  }

  /** Our lane, a line beside the nearest car ahead on our line, or toward the inside of a bend coming up. */
  private wantedOffset(car: AutopilotCar, others: readonly OtherCar[]): number {
    const c = RIVAL_CONFIG;
    const path = this.pilot.path;
    const limit = path.halfWidth - 2.5;
    let nearest = Infinity;
    let wanted = this.profile.lane;
    const cut = this.profile.style.apexCut;
    if (cut > 0) {
      for (let d = 10; d <= c.apexLook; d += 5) {
        const k = path.curvatureAt(this.pilot.s + d);
        if (Math.abs(k) < 1 / 200) continue;
        // Positive curvature turns left, whose inside is the left (+offset) side.
        wanted = Math.sign(k) * limit * cut * (1 - d / (c.apexLook + 20));
        break;
      }
    }
    for (const o of others) {
      const dx = o.x - car.x;
      const dz = o.z - car.z;
      const along = dx * car.fx + dz * car.fz;
      // Left of our nose is (fz, -fx).
      const lat = dx * car.fz - dz * car.fx;
      if (along <= 0 || along > c.look || along > nearest || Math.abs(lat) > c.width) continue;
      nearest = along;
      // Pass on whichever side gives the most room, relative to where we are on the track.
      const goLeft = lat < 0 || (lat < 0.5 && this.pilot.offset < 0);
      wanted = this.pilot.offset + (goLeft ? c.step : -c.step);
    }
    return Math.max(-limit, Math.min(limit, wanted));
  }
}

/**
 * Contact blame from `felt`'s point of view: true when it was hit (the other car drove into it at
 * least about as hard as it drove into the other), so it has a right to be angry.
 */
export function wasHit(felt: { x: number; z: number; vx: number; vz: number }, other: { x: number; z: number; vx: number; vz: number }, margin = 1): boolean {
  const dx = other.x - felt.x;
  const dz = other.z - felt.z;
  const d = Math.hypot(dx, dz) || 1;
  const feltClosing = (felt.vx * dx + felt.vz * dz) / d;
  const otherClosing = -(other.vx * dx + other.vz * dz) / d;
  return feltClosing <= otherClosing + margin;
}

function approach(from: number, to: number, maxStep: number): number {
  return from + Math.max(-maxStep, Math.min(maxStep, to - from));
}
