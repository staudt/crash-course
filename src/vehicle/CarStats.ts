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
  | 'wing'
  | 'wheel';

export const DETACHABLE_PARTS: readonly PartKind[] = [
  'hood',
  'bumperFront',
  'bumperRear',
  'doorLeft',
  'doorRight',
  'wing',
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
  boostForce: number; // engine force multiplier while boosting (Shift)
  boostTopSpeed: number; // top speed multiplier while boosting
  boostDuration: number; // s of boosting to drain a full boost bar
  boostRecharge: number; // s for an empty bar to refill while not boosting
  boostRestart: number; // after running dry, boost unlocks again at this charge (0..1)
  brakeDecel: number; // m/s² at full brake
  handbrakeDecel: number; // m/s² extra slowdown while the handbrake is held
  rollingDecel: number; // m/s² coasting slowdown with no throttle
  // Steering
  maxSteer: number; // radians at standstill
  highSpeedSteer: number; // radians: minimum steering lock at very high speed
  steerRate: number; // radians/sec the wheels turn toward target
  steerFadeSpeed: number; // m/s: steering lock = maxSteer / (1 + speed / steerFadeSpeed)
  reverseSteer: number; // steering lock multiplier while reversing: tighter backwards turns
  // Grip / drift (arcade model, see Car.applyGrip)
  gripAccel: number; // m/s²: how hard tyres can bend the car's path. Lower = drifts start at lower speeds
  driftMaxSlip: number; // radians: max slide angle in a normal (non-handbrake) drift
  driftDrag: number; // 1/s: speed lost while sliding, scaled by sin(slide angle); throttle overcomes it
  yawResponse: number; // rad/s²: how quickly the body's rotation follows the steering
  selfAlign: number; // 1/s: with the wheel centred, how fast the nose swings back to the travel direction
  sandSlip: number; // 0..1: fraction of grip lost on fully soft sand
  asphaltGrip: number; // grip multiplier on asphalt (Car.paving)
  asphaltSlip: number; // driftMaxSlip multiplier on asphalt: ~1.6°, so steering alone never slides (only the handbrake swings the tail)
  handbrakeGrip: number; // grip multiplier while handbraking
  gripRecovery: number; // per second, how fast grip returns after releasing the handbrake
  handbrakeYawRate: number; // rad/s body rotation at full steer while handbraking
  spinCommit: number; // radians: releasing the handbrake with the car slid at least this far commits to a spin round to spinEnd
  spinEnd: number; // radians of slide where a committed spin finishes (π = facing back the way it came)
  spinMaxTurn: number; // radians: a handbrake spin (held or committed) stops forcing rotation once the car has turned this far since the press
  spinLateFrom: number; // radians of slide: past this (sideways) a handbrake spin slows down, easing in over the next ~25°...
  spinLateRate: number; // ...to this fraction of handbrakeYawRate, so the back half of a 180 hangs sideways instead of whipping round
  handbrakeThrust: number; // fraction of engine force while the handbrake is held (locked rear wheels don't drive)
  spinScrub: number; // m/s²: extra slowdown while handbraking/spinning, scaled by how sideways the car is sliding
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
  worldDamage: number; // jolt multiplier for hits on static things (terrain, rocks, posts): crashing alone hurts less
  scrapeSpeed: number; // m/s: sliding along a wall faster than this scrapes (sparks, scratches, wear)
  scrapeAngle: number; // rad: meeting a smooth wall (Car.walls) at less than this slides along it instead of crashing
  scrapeDrag: number; // 1/s: speed lost sliding along a wall
  scrapeAlign: number; // rad/s per unit of sin(angle into the wall): how fast a scraping car's nose swings parallel to it
  scrapeWear: number; // health lost per second of scraping
  scrapeEvery: number; // metres slid between scratches (light dents at the contact)
  scrapeDent: number; // strength of one scratch (a cosmetic dent: no health or part HP)
  carDamage: number; // jolt multiplier for car-car hits
  carHealthLoss: number; // share of a car-car hit's damage taken off health (dents, parts and knocks are unchanged)
  ramAdvantage: number; // 0..1: how far a car-car crash's damage shifts onto the slower car (see Crash.ramFactor)
  rimFriction: number; // chassis friction once a wheel is gone (the bare corner scrapes along instead of anchoring the car)
  // Knock: a big hit loosens the arcade grip and yaw control for a moment so the crash's own spin and shove carry
  knockThreshold: number; // m/s of (scaled) sideways/longitudinal jolt before a hit knocks the car
  knockFull: number; // m/s of jolt for a full knock
  knockTime: number; // s a full knock lasts; control returns linearly
  knockGrip: number; // grip multiplier at full knock
  hitSpin: number; // extra yaw kick from an off-centre car hit, per (m from centre × m/s of scaled jolt) / halfLength²: tail hits spin cars out
  hitSpinMax: number; // rad/s cap on that kick; a kick this big is also a full knock
  damageScale: number; // health lost per m/s of impact above the threshold
  dentRadius: number;
  dentDepthScale: number; // metres of dent per unit of normalised impact
  maxDent: number; // max per-vertex displacement from the original shape
  partHp: Record<PartKind, number>;
  wheelDamage: number; // wheel HP lost per unit of impact strength right at the wheel (less further away)
  maxHealth: number;
  // Repair (while inside a checkpoint repair station, see Car.repair)
  repairTime: number; // s to fix a wrecked car completely
  repairTau: number; // s time constant of the repair curve: most of it happens in the first repairTau or two
  repairRefit: number; // s per lost part refitted (wheels first)
}

export const DEFAULT_STATS: Readonly<CarStats> = {
  mass: 1200,
  engineForce: 13200,
  reverseForce: 7500,
  topSpeed: 126,
  boostForce: 2.13,
  boostTopSpeed: 1.25,
  boostDuration: 3.75,
  boostRecharge: 101,
  boostRestart: 0.1,
  brakeDecel: 24,
  handbrakeDecel: 3,
  rollingDecel: 0.8,
  maxSteer: 0.6,
  highSpeedSteer: 0.08,
  steerRate: 4,
  steerFadeSpeed: 8,
  reverseSteer: 1.3,
  gripAccel: 16,
  driftMaxSlip: 0.55,
  driftDrag: 0.25,
  yawResponse: 14,
  selfAlign: 0,
  sandSlip: 0.3,
  asphaltGrip: 2.2,
  asphaltSlip: 0.05,
  handbrakeGrip: 0.25,
  gripRecovery: 5,
  handbrakeYawRate: 4.5,
  spinCommit: 0.87,
  spinEnd: 2.97,
  spinMaxTurn: 3.0,
  spinLateFrom: 1.57,
  spinLateRate: 0.45,
  handbrakeThrust: 0.25,
  spinScrub: 7,
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
  worldDamage: 0.4,
  scrapeSpeed: 3,
  scrapeAngle: 0.3,
  scrapeDrag: 0.4,
  scrapeAlign: 3,
  scrapeWear: 3,
  scrapeEvery: 1.5,
  scrapeDent: 0.4,
  carDamage: 1.3,
  carHealthLoss: 0.75,
  ramAdvantage: 0.7,
  rimFriction: 0.12,
  knockThreshold: 3,
  knockFull: 12,
  knockTime: 1,
  knockGrip: 0.15,
  hitSpin: 2.5,
  hitSpinMax: 4,
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
    wing: 35,
    wheel: 120,
  },
  wheelDamage: 3.5,
  maxHealth: 450,
  repairTime: 20,
  repairTau: 7,
  repairRefit: 2,
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
