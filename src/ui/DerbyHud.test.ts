import { describe, expect, it } from 'vitest';
import { arenaProject, rosterOrder, type DerbyHudCar } from './DerbyHud';

const car = (name: string, health: number, out: string | null = null): DerbyHudCar => ({
  name, color: '#fff', health, out, isPlayer: false, huntingPlayer: false, x: 0, z: 0,
});

describe('rosterOrder', () => {
  it('puts running cars first by health, then out cars in given order', () => {
    const cars = [car('a', 0.2), car('x', 0, 'WRECKED'), car('b', 0.9), car('y', 0.5, 'DISABLED'), car('c', 0.5)];
    const order = rosterOrder(cars).map((c) => c.name);
    expect(order).toEqual(['b', 'c', 'a', 'x', 'y']);
  });
  it('does not mutate the input', () => {
    const cars = [car('a', 0.1), car('b', 0.9)];
    rosterOrder(cars);
    expect(cars.map((c) => c.name)).toEqual(['a', 'b']);
  });
});

describe('arenaProject', () => {
  it('maps the centre to the origin', () => {
    const p = arenaProject(0, 0, 75, 1.3);
    expect(p.u).toBeCloseTo(0);
    expect(p.v).toBeCloseTo(0);
  });
  it('puts a point straight ahead at the top', () => {
    const p = arenaProject(0, 30, 75, 0);
    expect(p.v).toBeCloseTo(-0.4);
    expect(p.u).toBeCloseTo(0);
  });
  it('puts the viewer\'s left on the left (+X at heading 0)', () => {
    expect(arenaProject(10, 0, 75, 0).u).toBeLessThan(0);
    expect(arenaProject(-10, 0, 75, 0).u).toBeGreaterThan(0);
  });
  it('rotates with the heading', () => {
    // Facing +X (heading pi/2): a point at +X is ahead.
    const p = arenaProject(30, 0, 75, Math.PI / 2);
    expect(p.v).toBeCloseTo(-0.4);
    expect(p.u).toBeCloseTo(0);
    // Facing +X, left is -Z... check: left of heading h is (cos h, -sin h) = (0,-1).
    expect(arenaProject(0, -10, 75, Math.PI / 2).u).toBeLessThan(0);
    // Facing +Z reversed (heading pi): +Z is behind.
    expect(arenaProject(0, 30, 75, Math.PI).v).toBeGreaterThan(0);
  });
  it('maps the arena edge to length ~1', () => {
    for (const h of [0, 0.7, 2.5, -1.9]) {
      const p = arenaProject(75 * Math.cos(0.4), 75 * Math.sin(0.4), 75, h);
      expect(Math.hypot(p.u, p.v)).toBeCloseTo(1);
    }
  });
});
