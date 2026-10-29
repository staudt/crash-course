import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type DriveInput } from '../core/types';
import { cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { DERBY_RIVALS, DerbyDriver, intercept, type DerbyOther, type DerbyProfile, type DerbySelf } from './DerbyDriver';

const stats = cloneStats();
const steering = { maxSteer: stats.maxSteer, steerFadeSpeed: stats.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ };
const profile = (name: string): DerbyProfile => DERBY_RIVALS.find((p) => p.name === name)!;
const me = (o: Partial<DerbySelf> = {}): DerbySelf => ({ x: 0, z: 0, fx: 0, fz: 1, speed: 10, health: 1, ...o });
const car = (id: number, o: Partial<DerbyOther> = {}): DerbyOther => ({ id, x: 0, z: 30, vx: 0, vz: 0, fx: 1, fz: 0, health: 1, ...o });
const input = (): DriveInput => ({ ...NEUTRAL_INPUT });

describe('intercept', () => {
  it('a parked car is met after distance / speed', () => {
    expect(intercept(0, 20, 0, 0, 10, 5)).toBeCloseTo(2);
  });
  it('leads a crossing car', () => {
    // 20 m ahead, crossing at 10 m/s, we drive at 20 m/s: meet when (10t)² + 20² = (20t)².
    expect(intercept(0, 20, 10, 0, 20, 5)).toBeCloseTo(20 / Math.sqrt(300));
  });
  it('caps a car we can never catch', () => {
    expect(intercept(0, 20, 0, 30, 10, 1.5)).toBe(1.5);
  });
});

describe('DerbyDriver', () => {
  it('a juggernaut charges the nearest car', () => {
    const d = new DerbyDriver(profile('Scorpion'), steering, 75);
    const out = d.drive(me(), [car(1, { z: 20 }), car(2, { x: 50, z: 0 })], 0, 1 / 60, input());
    expect(d.target).toBe(1);
    expect(d.mode).toBe('hunt');
    expect(out.throttle).toBeGreaterThan(0.5);
    expect(Math.abs(out.steer)).toBeLessThan(0.2);
  });

  it('a survivor lurks while nobody is weak, and engages once the field thins out', () => {
    const d = new DerbyDriver(profile('Cockroach'), steering, 75);
    const field = [car(1, { x: 30, z: 30 }), car(2, { x: -30, z: 30 })];
    d.drive(me({ x: 40 }), field, 0, 1 / 60, input());
    expect(d.mode).toBe('lurk');
    d.drive(me({ x: 40 }), field, 1, 1 / 60, input());
    expect(d.mode).toBe('hunt');
  });

  it('a vulture goes for the weakest car, not the nearest', () => {
    const d = new DerbyDriver(profile('Vulture'), steering, 75);
    d.drive(me(), [car(1, { z: 15 }), car(2, { x: 40, z: 20, health: 0.15 })], 0, 1 / 60, input());
    expect(d.target).toBe(2);
  });

  it('a cautious driver dodges a car coming straight at it', () => {
    const d = new DerbyDriver(profile('Mirage'), steering, 75);
    // Charging at us from the left at 20 m/s.
    const out = d.drive(me({ speed: 0 }), [car(1, { x: 25, z: 0, vx: -20, vz: 0, fx: -1, fz: 0 })], 0, 1 / 60, input());
    expect(d.mode).toBe('dodge');
    expect(out.throttle).toBeGreaterThan(0.5);
  });

  it('a rear-ender backs in with its tail to a car behind it, and swings round for one in front', () => {
    const d = new DerbyDriver(profile('Tailgunner'), steering, 75);
    const out = d.drive(me({ speed: 0 }), [car(1, { z: -15 })], 0, 1 / 60, input());
    expect(out.throttle).toBe(-1);
    expect(d.reversingIn).toBe(true);
    const d2 = new DerbyDriver(profile('Tailgunner'), steering, 75);
    const out2 = d2.drive(me({ speed: 0 }), [car(1, { x: 8, z: 15 })], 0, 1 / 60, input());
    expect(out2.throttle).toBe(-1);
    expect(d2.reversingIn).toBe(false);
    expect(Math.abs(out2.steer)).toBe(1);
  });

  it('rear-enders prefer a parked car to a fast one', () => {
    const d = new DerbyDriver(profile('Crawdad'), steering, 75);
    d.drive(me({ speed: 0 }), [car(1, { z: 20, vx: 18 }), car(2, { z: -25 })], 0, 1 / 60, input());
    expect(d.target).toBe(2);
  });

  it('leaves a car to the driver already on it', () => {
    const d = new DerbyDriver(profile('Scorpion'), steering, 75);
    d.drive(me(), [car(1, { z: 20, hunters: 3 }), car(2, { x: -30, z: 10 })], 0, 1 / 60, input());
    expect(d.target).toBe(2);
  });

  it('turns back in before the wall instead of driving into it', () => {
    const d = new DerbyDriver(profile('Scorpion'), steering, 75);
    // Heading straight out at 20 m/s, 8 m from the edge, after a car behind it across the arena.
    const out = d.drive(me({ x: 67, z: 0, fx: 1, fz: 0, speed: 20 }), [car(1, { x: 75, z: 5 })], 0, 1 / 60, input());
    expect(Math.abs(out.steer)).toBeGreaterThan(0.3);
    expect(out.throttle).toBe(0);
  });

  it('after hitting its target it backs off for another run', () => {
    const d = new DerbyDriver(profile('Rusty'), steering, 75);
    const field = [car(1, { z: 4 })];
    d.drive(me({ speed: 1 }), field, 0, 1 / 60, input());
    d.rammed(1, 8);
    expect(d.mode).toBe('backoff');
    const out = d.drive(me({ speed: 1 }), field, 0, 1 / 60, input());
    expect(out.throttle).toBe(-1); // pinned against it: reverse out first
  });
});
