import { describe, expect, it } from 'vitest';
import { knockAmount, ramFactor } from './Crash';

describe('ramFactor', () => {
  it('splits an even crash evenly', () => {
    expect(ramFactor(20, 20, 0.7)).toBeCloseTo(1);
    expect(ramFactor(0, 0, 0.7)).toBeCloseTo(1);
  });

  it('a car ramming a parked one deals the damage', () => {
    expect(ramFactor(28, 0, 0.7)).toBeCloseTo(0.3, 2);
    expect(ramFactor(0, 28, 0.7)).toBeCloseTo(1.7, 2);
  });

  it('the faster car takes less, the more so the bigger the gap', () => {
    expect(ramFactor(28, 14, 0.7)).toBeLessThan(ramFactor(28, 24, 0.7));
    expect(ramFactor(28, 24, 0.7)).toBeLessThan(1);
    expect(ramFactor(14, 28, 0.7)).toBeGreaterThan(1);
    // The two shares always balance around 1.
    expect(ramFactor(28, 14, 0.7) + ramFactor(14, 28, 0.7)).toBeCloseTo(2);
  });

  it('moving away from the other car counts as no push', () => {
    expect(ramFactor(-10, 20, 0.7)).toBeCloseTo(ramFactor(0, 20, 0.7));
  });
});

describe('knockAmount', () => {
  it('is 0 below the threshold, 1 from full, linear between', () => {
    expect(knockAmount(2, 3, 12)).toBe(0);
    expect(knockAmount(7.5, 3, 12)).toBeCloseTo(0.5);
    expect(knockAmount(30, 3, 12)).toBe(1);
  });
});
