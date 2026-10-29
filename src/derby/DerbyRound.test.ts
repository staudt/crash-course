import { describe, expect, it } from 'vitest';
import { DERBY_CONFIG, DerbyRound, type DerbyCarState } from './DerbyRound';

const cars = (n: number): DerbyCarState[] => Array.from({ length: n }, (_, i) => ({ x: i * 20, z: 0, wrecked: false }));
const go = (round: DerbyRound, field: DerbyCarState[]) => round.update(DERBY_CONFIG.countdown + 0.01, field);

describe('DerbyRound', () => {
  it('counts down, then fights', () => {
    const round = new DerbyRound(3);
    expect(round.update(1, cars(3))).toEqual([]);
    expect(round.phase).toBe('countdown');
    expect(go(round, cars(3))).toContainEqual({ type: 'go' });
    expect(round.phase).toBe('fighting');
  });

  it('a wreck is out, and the takedown goes to the car that last hit it', () => {
    const round = new DerbyRound(3);
    const field = cars(3);
    go(round, field);
    round.contact(1, 2);
    round.update(1, field);
    field[1]!.wrecked = true;
    const events = round.update(0.1, field);
    expect(events).toContainEqual({ type: 'out', id: 1, why: 'WRECKED', by: 2 });
    expect(round.entrants[2]!.takedowns).toBe(1);
    expect(round.alive).toBe(2);
  });

  it('a hit too long ago earns no takedown', () => {
    const round = new DerbyRound(3);
    const field = cars(3);
    go(round, field);
    round.contact(1, 2);
    round.update(DERBY_CONFIG.creditWindow + 1, field.map((c) => ({ ...c, x: c.x + 10 })));
    field[1]!.wrecked = true;
    expect(round.update(0.1, field)).toContainEqual({ type: 'out', id: 1, why: 'WRECKED', by: null });
  });

  it('credits damage only right after a contact', () => {
    const round = new DerbyRound(2);
    const field = cars(2);
    go(round, field);
    round.contact(0, 1);
    round.damage(0, 40);
    round.update(1, field);
    round.damage(0, 25); // hit the wall on its own a second later
    expect(round.entrants[1]!.damage).toBe(40);
  });

  it('a car that stays put for too long is disabled', () => {
    const round = new DerbyRound(3);
    const field = cars(3);
    go(round, field);
    let events: ReturnType<DerbyRound['update']> = [];
    for (let t = 0; t < DERBY_CONFIG.disableTime + 1; t += 0.5) {
      field[0]!.x += 1; // keeps moving
      field[2]!.x += 1;
      events = events.concat(round.update(0.5, field));
    }
    expect(events).toContainEqual({ type: 'out', id: 1, why: 'DISABLED', by: null });
    expect(round.isOut(0)).toBe(false);
  });

  it('a car fighting in a tight spot is not disabled', () => {
    const round = new DerbyRound(3);
    const field = cars(3);
    go(round, field);
    for (let t = 0; t < DERBY_CONFIG.disableTime * 2; t += 0.5) {
      if (t % 5 === 0) round.contact(1, 2);
      field[0]!.x += 1;
      expect(round.update(0.5, field).filter((e) => e.type === 'out')).toEqual([]);
    }
  });

  it('ends with the last car running, and ranks the rest by how long they lasted', () => {
    const round = new DerbyRound(3);
    const field = cars(3);
    go(round, field);
    field[2]!.wrecked = true;
    round.update(1, field);
    field[0]!.wrecked = true;
    const events = round.update(1, field);
    expect(events).toContainEqual({ type: 'over', winner: 1 });
    expect(round.phase).toBe('over');
    expect(round.standings()).toEqual([1, 0, 2]);
  });
});
