import type { DriveInput } from '../core/types';
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
  /** Anger gained per m/s of impact when hit by another car. */
  temper: number;
  /** Anger lost per second. */
  calm: number;
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

export const BASE_STYLE: DrivingStyle = { cornerGrip: 1, lateBraking: 1, smoothness: 1, apexCut: 0, sandGrip: 0.8, maxSpeed: 90, aggression: 0, temper: 0.06, calm: 0.08 };

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
    style: { ...BASE_STYLE, cornerGrip: 0.88, lateBraking: 1.35, maxSpeed: 100 },
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
    style: { ...BASE_STYLE, cornerGrip: 1.1, lateBraking: 0.9, smoothness: 1.4, apexCut: 0.8, temper: 0.03, calm: 0.15 },
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
    style: { ...BASE_STYLE, aggression: 0.9, temper: 0.12, calm: 0.04 },
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
    style: { ...BASE_STYLE, sandGrip: 1.05, aggression: 0.1 },
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
    style: { ...BASE_STYLE, aggression: 0.2, temper: 0.25, calm: 0.03 },
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
  rubberBand: 0.06,
  rubberRange: 400,
  /** Fighting: start at `fightAt` anger (or aggression urge), give up below `fightUntil`. */
  fightAt: 0.5,
  fightUntil: 0.2,
  maxAnger: 1.5,
  /** Only fight cars within this distance, and never one more than `fightBehind` m behind us on the track (winning comes first). */
  fightRange: 45,
  fightBehind: 15,
  /** Unprovoked ramming (aggression): a car within this distance ahead and `bullyWidth` m to the side. */
  bullyRange: 22,
  bullyWidth: 8,
  /** Lead (s) on the target's velocity when ramming. */
  ramLead: 0.35,
  /** Too far off the track while fighting (us or the target): calm down and get back to racing. */
  fightMaxOffTrack: 14,
  /** After landing a hit on its target: anger left (fraction), and how long a bully leaves everyone alone (s). */
  revengeLeft: 0.3,
  bullyCooldown: 10,
  /** Rescue (respawn at the last checkpoint) when slower than stuckSpeed for stuckTime, off the track for lostTime, or wrecked for wreckedTime. */
  stuckSpeed: 3,
  stuckTime: 3,
  /** Drove this far past a gate without crossing it (missed it): rescue straight away. */
  missedGate: 25,
  lostDistance: 30,
  lostTime: 3,
  wreckedTime: 2.5,
};

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
}

export class RivalDriver {
  readonly profile: RivalProfile;
  readonly pilot: Autopilot;
  /** Id of the car being hunted, or null while just racing. */
  target: number | null = null;
  private readonly anger = new Map<number, number>();
  private cooldown = 0;
  private stuck = 0;
  private lost = 0;
  private wreck = 0;

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
    const a = this.angerAt(id) + impact * this.profile.style.temper;
    this.anger.set(id, Math.min(RIVAL_CONFIG.maxAnger, a));
  }

  /** We just hit car `id`. If it was the one we were after, that's revenge: most of the anger goes, and a bully is satisfied for a while. */
  rammed(id: number): void {
    if (id !== this.target) return;
    const c = RIVAL_CONFIG;
    this.anger.set(id, Math.min(this.angerAt(id) * c.revengeLeft, c.fightUntil));
    this.cooldown = c.bullyCooldown;
    this.target = null;
  }

  /** After a respawn: back on the racing line. Grudges survive a respawn. */
  reset(): void {
    this.pilot.reset();
    this.pilot.offset = this.profile.lane;
    this.target = null;
    this.stuck = this.lost = this.wreck = 0;
  }

  /** Fresh race: forget grudges too. */
  forgetAll(): void {
    this.anger.clear();
    this.cooldown = 0;
    this.reset();
  }

  /**
   * One control decision. `others` are the other racers; `behindPlayer` is the player's race progress
   * minus ours (m, positive = we are behind).
   */
  drive(car: AutopilotCar, others: readonly OtherCar[], behindPlayer: number, dt: number, out: DriveInput): DriveInput {
    const c = RIVAL_CONFIG;
    for (const [id, a] of this.anger) {
      const left = a - this.profile.style.calm * dt;
      if (left <= 0) this.anger.delete(id);
      else this.anger.set(id, left);
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
    const band = Math.max(-1, Math.min(1, behindPlayer / c.rubberRange));
    this.pilot.pace = 1 + band * c.rubberBand;

    const prey = this.pickTarget(car, others);
    this.target = prey?.id ?? null;
    if (prey) {
      const lead = c.ramLead;
      return this.pilot.chase(car, prey.x + (prey.vx ?? 0) * lead, prey.z + (prey.vz ?? 0) * lead, out);
    }

    this.pilot.offset = approach(this.pilot.offset, this.wantedOffset(car, others), c.offsetRate * dt);
    this.pilot.drive(car, out);

    // Closing on a slower car right in front: lift and brake in proportion, while the line shifts to pass.
    let brake = 0;
    for (const o of others) {
      const dx = o.x - car.x;
      const dz = o.z - car.z;
      const along = dx * car.fx + dz * car.fz;
      const lat = dx * car.fz - dz * car.fx;
      if (along <= 0 || along > c.gap || Math.abs(lat) > c.gapWidth) continue;
      const closing = car.speed - ((o.vx ?? 0) * car.fx + (o.vz ?? 0) * car.fz);
      if (closing > 0.5) brake = Math.max(brake, Math.min(1, (closing * closing) / (2 * Math.max(1, along - 5)) / 20));
    }
    if (brake > 0) {
      out.throttle = 0;
      out.brake = Math.max(out.brake, brake);
    }
    return out;
  }

  /**
   * Call every frame while racing; true when the car should be put back on the track.
   * `pastGate`: how far it is past a gate it never crossed (Race.pastNextGate).
   */
  needsRescue(speed: number, wrecked: boolean, dt: number, pastGate = 0): boolean {
    const c = RIVAL_CONFIG;
    if (pastGate > c.missedGate) return true;
    this.stuck = Math.abs(speed) < c.stuckSpeed ? this.stuck + dt : 0;
    this.lost = this.pilot.distance > c.lostDistance ? this.lost + dt : 0;
    this.wreck = wrecked ? this.wreck + dt : 0;
    return this.stuck > c.stuckTime || this.lost > c.lostTime || this.wreck > c.wreckedTime;
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
      if (d > c.fightRange || (o.ahead ?? 0) < -c.fightBehind || (o.offTrack ?? 0) > c.fightMaxOffTrack) continue;
      let score = this.angerAt(o.id);
      const along = dx * car.fx + dz * car.fz;
      const lat = dx * car.fz - dz * car.fx;
      if (this.cooldown <= 0 && along > 0 && along < c.bullyRange && Math.abs(lat) < c.bullyWidth) score += this.profile.style.aggression;
      // Keep after the current target until anger drops below fightUntil (hysteresis).
      const needed = o.id === this.target ? c.fightUntil : c.fightAt;
      if (score >= needed && score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    return best;
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
