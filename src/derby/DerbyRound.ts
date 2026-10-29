/**
 * Destruction derby rules, pure: countdown, then everyone fights until one car is left running.
 * A wrecked car is out (WRECKED); so is one that stops getting anywhere (DISABLED: lost wheels,
 * wedged, or hiding, with nobody touching it). The last car to hit a wreck within `creditWindow` s gets the takedown, and
 * health a car loses right after a contact counts as damage dealt by the car it touched.
 */
export const DERBY_CONFIG = {
  countdown: 3,
  creditWindow: 6,
  /** Health lost within this many seconds of a car contact is credited to the other car. */
  damageWindow: 0.5,
  /** A running car that stays within disableMove m of one spot for disableTime s, touching no one, is out. */
  disableMove: 6,
  disableTime: 20,
  /** Every car takes this much of the usual health loss per hit: they crumple and shed parts for longer before they're wrecked. */
  healthLoss: 0.35,
  /** Sudden death: from this round time (s) hits hurt more, +100% every suddenDeathRamp s, so crippled endgames finish. */
  suddenDeath: 150,
  suddenDeathRamp: 30,
  /**
   * Pressure on the AI to fight (0..1): thinOut × how far the field has thinned, plus quietWeight once no one has
   * landed a hit (a contact ≥ actionImpact m/s) for quietTime s, full after another quietRamp s.
   */
  thinOut: 0.5,
  quietTime: 8,
  quietRamp: 20,
  quietWeight: 0.7,
  actionImpact: 3,
};

/** Car.healthLoss at round time `time`: the derby's base, raised in sudden death. */
export function healthLossAt(time: number): number {
  const c = DERBY_CONFIG;
  return c.healthLoss * (1 + Math.max(0, time - c.suddenDeath) / c.suddenDeathRamp);
}

/** AI fight pressure (0..1) with `alive` of `total` cars left and the last real hit at `lastAction` (round time). */
export function derbyPressure(total: number, alive: number, time: number, lastAction: number): number {
  const c = DERBY_CONFIG;
  const thin = Math.max(0, Math.min(1, (total - alive) / Math.max(1, total - 2)));
  const quiet = Math.max(0, Math.min(1, (time - lastAction - c.quietTime) / c.quietRamp));
  return Math.min(1, thin * c.thinOut + quiet * c.quietWeight);
}

export type OutReason = 'WRECKED' | 'DISABLED';
export type DerbyPhase = 'countdown' | 'fighting' | 'over';

export interface Entrant {
  out: OutReason | null;
  /** Round time it went out at. */
  outAt: number | null;
  /** Who took it out (null: nobody hit it recently). */
  by: number | null;
  takedowns: number;
  /** Health taken off other cars. */
  damage: number;
  lastHit: { by: number; time: number } | null;
  /** Disabled watch: where it was when the clock started, and for how long it has stayed near there. */
  anchor: { x: number; z: number } | null;
  still: number;
}

export interface DerbyCarState {
  x: number;
  z: number;
  wrecked: boolean;
}

export type DerbyEvent =
  | { type: 'go' }
  | { type: 'out'; id: number; why: OutReason; by: number | null }
  | { type: 'over'; winner: number | null };

export class DerbyRound {
  phase: DerbyPhase = 'countdown';
  countdown = DERBY_CONFIG.countdown;
  time = 0;
  readonly entrants: Entrant[] = [];

  constructor(count: number) {
    for (let i = 0; i < count; i++) this.entrants.push(blank());
  }

  restart(): void {
    this.phase = 'countdown';
    this.countdown = DERBY_CONFIG.countdown;
    this.time = 0;
    for (let i = 0; i < this.entrants.length; i++) this.entrants[i] = blank();
  }

  get alive(): number {
    return this.entrants.filter((e) => !e.out).length;
  }

  isOut(id: number): boolean {
    return this.entrants[id]?.out != null;
  }

  /** `victim` was just hit by (touched) `attacker`. Fighting in a tight spot isn't being stuck: both disabled clocks restart. */
  contact(victim: number, attacker: number): void {
    if (this.phase !== 'fighting' || this.isOut(victim)) return;
    this.entrants[victim]!.lastHit = { by: attacker, time: this.time };
    this.entrants[victim]!.still = 0;
    if (!this.isOut(attacker)) this.entrants[attacker]!.still = 0;
  }

  /** `victim` lost `amount` health; credited to whoever touched it just now. */
  damage(victim: number, amount: number): void {
    const hit = this.entrants[victim]?.lastHit;
    if (this.phase === 'over' || !hit || amount <= 0 || this.time - hit.time > DERBY_CONFIG.damageWindow) return;
    this.entrants[hit.by]!.damage += amount;
  }

  update(dt: number, cars: readonly DerbyCarState[]): DerbyEvent[] {
    const events: DerbyEvent[] = [];
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown > 0) return events;
      this.countdown = 0;
      this.phase = 'fighting';
      events.push({ type: 'go' });
    }
    if (this.phase === 'over') return events;
    this.time += dt;
    const c = DERBY_CONFIG;
    cars.forEach((car, id) => {
      const e = this.entrants[id]!;
      if (e.out) return;
      if (car.wrecked) {
        events.push(this.knockOut(id, 'WRECKED'));
        return;
      }
      if (!e.anchor || Math.hypot(car.x - e.anchor.x, car.z - e.anchor.z) > c.disableMove) {
        e.anchor = { x: car.x, z: car.z };
        e.still = 0;
      } else if ((e.still += dt) > c.disableTime) {
        events.push(this.knockOut(id, 'DISABLED'));
      }
    });
    if (this.alive <= 1) {
      this.phase = 'over';
      const winner = this.entrants.findIndex((e) => !e.out);
      events.push({ type: 'over', winner: winner >= 0 ? winner : null });
    }
    return events;
  }

  /** Final order: cars still running (the winner) first, then the rest by how long they lasted. */
  standings(): number[] {
    const last = (id: number) => this.entrants[id]!.outAt ?? Infinity;
    return this.entrants.map((_, i) => i).sort((a, b) => last(b) - last(a) || this.entrants[b]!.damage - this.entrants[a]!.damage);
  }

  private knockOut(id: number, why: OutReason): DerbyEvent {
    const e = this.entrants[id]!;
    e.out = why;
    e.outAt = this.time;
    const hit = e.lastHit;
    e.by = hit && this.time - hit.time <= DERBY_CONFIG.creditWindow && !this.isOut(hit.by) ? hit.by : null;
    if (e.by !== null) this.entrants[e.by]!.takedowns++;
    return { type: 'out', id, why, by: e.by };
  }
}

function blank(): Entrant {
  return { out: null, outAt: null, by: null, takedowns: 0, damage: 0, lastHit: null, anchor: null, still: 0 };
}
