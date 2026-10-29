import type { DriveInput } from '../core/types';
import type { TrackPath } from '../race/TrackPath';

/**
 * Drives a car around a TrackPath through the same DriveInput a player uses.
 * Steering is pure pursuit on a point ahead on the centreline; speed is the
 * lowest of the corner speeds ahead, each raised by the braking distance to it.
 * Used by the lap-time test today, and the seed for AI opponents later.
 */
export const AUTOPILOT_CONFIG = {
  /** Pursuit point distance (m) = lookahead + lookaheadPerSpeed * speed. */
  lookahead: 7,
  lookaheadPerSpeed: 0.4,
  /** Lateral acceleration (m/s²) the driver is willing to corner at (the car grips up to ~16). */
  lateralGrip: 13,
  /** Fraction of lateralGrip trusted on open sand (the car loses grip with softness). */
  sandGrip: 0.8,
  /** Multiplier on lateralGrip on a paved track (the car grips CarStats.asphaltGrip 2.2× there). */
  asphaltGrip: 2.0,
  /** Deceleration (m/s²) the driver plans its braking with (the car brakes at ~24). */
  brakeDecel: 14,
  /** How far ahead (m) corners are considered. */
  horizon: 200,
  maxSpeed: 90,
  /** Facing the wrong way along the track (spun, or after turning back): slow to this (m/s) before turning round. */
  uTurnSpeed: 8,
};

/** Chasing a car, the driver pushes this much past its planned corner speeds. */
const CHASE_OVERSPEED = 1.08;

export interface AutopilotCar {
  x: number;
  z: number;
  /** Unit forward direction on the ground plane. */
  fx: number;
  fz: number;
  /** Signed forward speed (m/s). */
  speed: number;
}

/** What the driver needs to know about the car's steering (from CarStats / CarDims). */
export interface SteeringModel {
  maxSteer: number;
  steerFadeSpeed: number;
  wheelbase: number;
  /** Steering lock multiplier while reversing (CarStats.reverseSteer); 1 if omitted. */
  reverseSteer?: number;
}

export type AutopilotTuning = typeof AUTOPILOT_CONFIG;

export class Autopilot {
  readonly path: TrackPath;
  /** This driver's settings (defaults from AUTOPILOT_CONFIG; AI racers vary them for skill). */
  readonly tune: AutopilotTuning;
  /** Lateral offset (m, positive = left) of the line followed, for lanes and overtaking. */
  offset = 0;
  /** Multiplies every target speed (rubber-banding). */
  pace = 1;
  /** Last target speed (m/s), for debugging. */
  targetSpeed = 0;
  /** Last projection onto the track: distance along it, and from the centreline. */
  s = 0;
  distance = 0;
  private readonly steering: SteeringModel;
  private hint = -1;

  constructor(path: TrackPath, steering: SteeringModel, tune: Partial<AutopilotTuning> = {}) {
    this.path = path;
    this.steering = steering;
    this.tune = { ...AUTOPILOT_CONFIG, ...tune };
  }

  /** Forget the track position (after a teleport), or track it from `s` when the car is known to be there. */
  reset(s?: number): void {
    this.hint = s === undefined ? -1 : this.path.indexAt(s);
  }

  drive(car: AutopilotCar, out: DriveInput): DriveInput {
    const cfg = this.tune;
    const v = Math.max(0, car.speed);
    const proj = this.path.project(car.x, car.z, this.hint);
    this.hint = proj.index;
    this.s = proj.s;
    this.distance = proj.distance;

    // Pure pursuit on a point ahead on the line we follow.
    const ahead = proj.s + cfg.lookahead + cfg.lookaheadPerSpeed * v;
    const target = this.path.pointAt(ahead, { x: 0, z: 0 });
    const t = this.path.tangentAt(ahead, { x: 0, z: 0 });
    this.steerAt(car, target.x + t.z * this.offset - car.x, target.z - t.x * this.offset - car.z, out);
    let want = this.plannedSpeed(proj.s);
    const here = this.path.tangentAt(proj.s, { x: 0, z: 0 });
    if (car.fx * here.x + car.fz * here.z < 0) want = Math.min(want, cfg.uTurnSpeed);
    this.holdSpeed(v, want, out);
    return out;
  }

  /** The speed (m/s) to be doing at track position `s`: the slowest bend ahead, raised by the braking distance to it (× pace). */
  plannedSpeed(s: number): number {
    const cfg = this.tune;
    let want = cfg.maxSpeed;
    for (let d = 0; d <= cfg.horizon; d += 4) {
      const k = Math.abs(this.path.curvatureAt(s + d));
      if (k < 1e-4) continue;
      const grip = cfg.lateralGrip * (this.path.paved ? cfg.asphaltGrip : 1) * (1 - (1 - cfg.sandGrip) * this.path.sandAt(s + d));
      want = Math.min(want, Math.sqrt(grip / k + 2 * cfg.brakeDecel * Math.max(0, d - 10)));
    }
    return want * this.pace;
  }

  /** Throttle toward `want` (m/s), braking when well over it. */
  private holdSpeed(v: number, want: number, out: DriveInput): void {
    this.targetSpeed = want;
    const err = want - v;
    out.throttle = err > 0 ? Math.min(1, 0.3 + err * 0.5) : 0;
    out.brake = err < -1.5 ? Math.min(1, -err * 0.25) : 0;
    out.handbrake = false;
  }

  /** Flat out at a world point (ramming), steering by pure pursuit on it. Keeps the track position up to date. */
  /** Steer at a point (x, z) instead of the line, flat out but still slowing for the bends ahead on the track. */
  chase(car: AutopilotCar, x: number, z: number, out: DriveInput, maxSpeed = Infinity): DriveInput {
    const proj = this.path.project(car.x, car.z, this.hint);
    this.hint = proj.index;
    this.s = proj.s;
    this.distance = proj.distance;
    this.steerAt(car, x - car.x, z - car.z, out);
    this.holdSpeed(Math.max(0, car.speed), Math.min(maxSpeed, this.plannedSpeed(proj.s) * CHASE_OVERSPEED), out);
    return out;
  }

  private steerAt(car: AutopilotCar, dx: number, dz: number, out: DriveInput): void {
    out.steer = pursuitSteer(car, dx, dz, this.steering);
  }
}

/**
 * Pure pursuit: the curvature of the arc through (dx, dz) from the car, then the steer input (-1 left .. 1 right)
 * for that wheel angle. A target behind the car gets full lock toward its side: pure pursuit's sin(alpha) would fade
 * to nothing there and drive straight away from it (spun cars, turning back).
 */
export function pursuitSteer(car: AutopilotCar, dx: number, dz: number, steering: SteeringModel): number {
  const v = Math.max(0, car.speed);
  const dist = Math.hypot(dx, dz) || 1;
  const alphaLeft = Math.atan2(car.fz * dx - car.fx * dz, car.fx * dx + car.fz * dz);
  if (Math.abs(alphaLeft) > Math.PI / 2) return alphaLeft > 0 ? -1 : 1;
  const curvature = (2 * Math.sin(alphaLeft)) / dist;
  const wheel = Math.atan(curvature * steering.wheelbase);
  const lock = steering.maxSteer / (1 + v / steering.steerFadeSpeed);
  return Math.max(-1, Math.min(1, -wheel / lock));
}
