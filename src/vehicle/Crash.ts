/**
 * Pure crash rules on top of the measured jolt (see Car.postStep). Physics already shares a car-car
 * jolt by mass (the heavier car is shoved less); these rules decide who the damage favours.
 */

/**
 * Damage multiplier for one car in a car-car crash. `myPush` and `theirPush` are how fast (m/s) each
 * car was driving into the other just before the hit (≥ 0). The faster car deals the damage, weighed by
 * speed squared (like crash energy): equal pushes give 1, a car hitting a parked one gives
 * 1 - advantage (attacker) and 1 + advantage (victim).
 */
export function ramFactor(myPush: number, theirPush: number, advantage: number): number {
  const a = Math.max(0, myPush) ** 2;
  const b = Math.max(0, theirPush) ** 2;
  const share = (b + 1) / (a + b + 2); // my share of the damage: 0.5 when even
  return 1 + advantage * (2 * share - 1);
}

/** How knocked-off-line (0..1) a jolt of `impact` m/s leaves a car: 0 below `threshold`, 1 from `full`. */
export function knockAmount(impact: number, threshold: number, full: number): number {
  return Math.max(0, Math.min(1, (impact - threshold) / Math.max(1e-6, full - threshold)));
}
