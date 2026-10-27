/**
 * All car tunables in one plain-data object. Upgrades (roguelike, later) are
 * StatModifiers applied on top of a base; the lil-gui panel edits these live.
 */

export type PartKind =
  | 'body'
  | 'cabin'
  | 'hood'
  | 'bumperFront'
  | 'bumperRear'
  | 'doorLeft'
  | 'doorRight'
  | 'wheel';

export const DETACHABLE_PARTS: readonly PartKind[] = [
  'hood',
  'bumperFront',
  'bumperRear',
  'doorLeft',
  'doorRight',
  'wheel',
];

/**
 * Car geometry in chassis-local space (metres). Forward is +Z, up is +Y,
 * right is -X (so left is +X). The chassis rigid body origin sits at the
 * centre of the chassis collider.
 */
export interface CarDims {
  /** Half extents of the chassis collider cuboid. */
  halfWidth: number;
  halfHeight: number;
  halfLength: number;
  /** Wheel attachment points: x = ±wheelX, y = wheelY, z = ±wheelZ. */
  wheelX: number;
  wheelY: number;
  wheelZ: number;
  wheelRadius: number;
  wheelWidth: number;
}

export const DEFAULT_DIMS: Readonly<CarDims> = {
  halfWidth: 0.95,
  halfHeight: 0.32,
  halfLength: 2.05,
  wheelX: 0.92,
  wheelY: -0.12,
  wheelZ: 1.35,
  wheelRadius: 0.42,
  wheelWidth: 0.34,
};

export interface CarStats {
  // Mass & drive
  mass: number;
  engineForce: number;
  reverseForce: number;
  topSpeed: number; // m/s, engine force fades to 0 approaching it
  brakeDecel: number; // m/s² at full brake
  handbrakeDecel: number; // m/s² extra slowdown while the handbrake is held
  rollingDecel: number; // m/s² coasting slowdown with no throttle
  // Steering
  maxSteer: number; // radians at standstill
  highSpeedSteer: number; // radians: minimum steering lock at very high speed
  steerRate: number; // radians/sec the wheels turn toward target
  steerFadeSpeed: number; // m/s: steering lock = maxSteer / (1 + speed / steerFadeSpeed)
  // Grip / drift (arcade model, see Car.applyGrip)
  gripAccel: number; // m/s²: how hard tyres can bend the car's path. Lower = drifts start at lower speeds
  driftMaxSlip: number; // radians: max slide angle in a normal (non-handbrake) drift
  driftDrag: number; // 1/s: speed lost while sliding, scaled by sin(slide angle); throttle overcomes it
  yawResponse: number; // rad/s²: how quickly the body's rotation follows the steering
  selfAlign: number; // 1/s: with the wheel centred, how fast the nose swings back to the travel direction
  sandSlip: number; // 0..1: fraction of grip lost on fully soft sand
  handbrakeGrip: number; // grip multiplier while handbraking
  gripRecovery: number; // per second, how fast grip returns after releasing the handbrake
  handbrakeYawRate: number; // rad/s body rotation at full steer while handbraking
  // Suspension
  suspensionRestLength: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionTravel: number;
  // Arcade assists
  downforce: number; // N per (m/s)^2
  airControl: number; // torque scale while airborne
  sandDrag: number; // 1/s: horizontal speed lost per second on fully soft sand (scaled by surface softness)
  maxYawRate: number; // rad/s spin cap on the ground, keeps drifts controllable
  comDrop: number; // how far below the chassis centre the centre of mass sits
  // Damage
  toughness: number; // divides incoming impact strength
  /**
   * Impacts are measured as the chassis' sudden velocity change in one physics
   * step (m/s), minus gravity. Below this nothing dents. Steady contact (resting
   * on the roof, scraping along a wall) produces ~0 and so never dents.
   */
  dentThreshold: number;
  bottomOutDamage: number; // fraction of an upward jolt through the floor (hard landings, bottoming out) that counts as damage
  damageScale: number; // health lost per m/s of impact above the threshold
  dentRadius: number;
  dentDepthScale: number; // metres of dent per unit of normalised impact
  maxDent: number; // max per-vertex displacement from the original shape
  partHp: Record<PartKind, number>;
  maxHealth: number;
}

export const DEFAULT_STATS: Readonly<CarStats> = {
  mass: 1200,
  engineForce: 13200,
  reverseForce: 6000,
  topSpeed: 126,
  brakeDecel: 24,
  handbrakeDecel: 3,
  rollingDecel: 0.8,
  maxSteer: 0.6,
  highSpeedSteer: 0.08,
  steerRate: 4,
  steerFadeSpeed: 8,
  gripAccel: 16,
  driftMaxSlip: 0.55,
  driftDrag: 0.25,
  yawResponse: 14,
  selfAlign: 0,
  sandSlip: 0.3,
  handbrakeGrip: 0.25,
  gripRecovery: 5,
  handbrakeYawRate: 4.5,
  suspensionRestLength: 0.38,
  suspensionStiffness: 28,
  suspensionCompression: 2.6,
  suspensionRelaxation: 3.2,
  maxSuspensionTravel: 0.32,
  downforce: 2.2,
  airControl: 1800,
  sandDrag: 0.07,
  maxYawRate: 4.5,
  comDrop: 0.35,
  toughness: 1,
  dentThreshold: 2.5,
  bottomOutDamage: 0.1,
  damageScale: 6,
  dentRadius: 0.9,
  dentDepthScale: 0.07,
  maxDent: 0.35,
  partHp: {
    body: Infinity,
    cabin: Infinity,
    hood: 60,
    bumperFront: 40,
    bumperRear: 40,
    doorLeft: 55,
    doorRight: 55,
    wheel: 90,
  },
  maxHealth: 300,
};

type NumericKey = { [K in keyof CarStats]: CarStats[K] extends number ? K : never }[keyof CarStats];

export interface StatModifier {
  stat: NumericKey;
  add?: number;
  mul?: number;
}

/** Applies all `add`s first, then all `mul`s, returning a fresh stats object. */
export function applyModifiers(base: Readonly<CarStats>, mods: readonly StatModifier[]): CarStats {
  const out: CarStats = { ...base, partHp: { ...base.partHp } };
  for (const m of mods) if (m.add !== undefined) out[m.stat] += m.add;
  for (const m of mods) if (m.mul !== undefined) out[m.stat] *= m.mul;
  return out;
}

export function cloneStats(base: Readonly<CarStats> = DEFAULT_STATS): CarStats {
  return applyModifiers(base, []);
}
