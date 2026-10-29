/**
 * Pure repair curve. Remaining damage (0..1 of full) decays exponentially with time constant `tau`
 * plus a small linear term sized so full damage is gone exactly at `fullTime`:
 * fast at first, so a short stop fixes most of it.
 */
export function repairStep(remaining: number, dt: number, tau: number, fullTime: number): number {
  if (remaining <= 0) return 0;
  const e = Math.exp(-fullTime / tau);
  const linear = e / (tau * (1 - e)); // solves d' = -d/tau - linear with d(0) = 1, d(fullTime) = 0
  return Math.max(0, remaining * Math.exp(-dt / tau) - linear * dt);
}
