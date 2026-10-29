/**
 * A car's damage by zone, for the HUD's damage map. Each value is 1 (like new) .. 0 (about to go),
 * or null once the part has come off. `chassis` is the overall health: what wrecks the car. The engine has
 * no HP of its own: its power falls with that same health, and it only dies with the car (the hood
 * over it is just a panel, so it isn't on the map).
 */
export interface DamageReport {
  chassis: number;
  bumperFront: number | null;
  /** 0 once wrecked, otherwise the overall health (engine power falls with it). */
  engine: number;
  doorLeft: number | null;
  doorRight: number | null;
  bumperRear: number | null;
  /** In WHEEL_ORDER: front-left, front-right, rear-left, rear-right. */
  wheels: [number | null, number | null, number | null, number | null];
  wrecked: boolean;
}
