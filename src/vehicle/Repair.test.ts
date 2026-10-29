import { describe, expect, it } from 'vitest';
import { repairStep } from './Repair';

const repairFor = (seconds: number, from = 1) => {
  let d = from;
  for (let i = 0; i < seconds * 60; i++) d = repairStep(d, 1 / 60, 7, 20);
  return d;
};

describe('repairStep', () => {
  it('fixes most of a wreck in 10 s and all of it in about 20 s', () => {
    expect(repairFor(10)).toBeLessThan(0.22);
    expect(repairFor(10)).toBeGreaterThan(0.12);
    expect(repairFor(19)).toBeGreaterThan(0);
    expect(repairFor(20.1)).toBe(0);
  });

  it('light damage is fixed sooner', () => {
    expect(repairFor(11, 0.2)).toBe(0); // vs ~20 s from a wreck
  });

  it('never goes below zero or undoes itself', () => {
    expect(repairStep(0, 1, 7, 20)).toBe(0);
    expect(repairStep(0.5, 1 / 60, 7, 20)).toBeLessThan(0.5);
  });
});
