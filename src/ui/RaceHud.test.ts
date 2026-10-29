import { describe, expect, it } from 'vitest';
import { formatDelta, formatTime, minimapProject, ordinal, repairLabel } from './RaceHud';

describe('formatTime', () => {
  it('formats m:ss.cc', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(83.456)).toBe('1:23.46');
    expect(formatTime(185.2)).toBe('3:05.20');
  });
  it('rounds up across the minute', () => {
    expect(formatTime(59.999)).toBe('1:00.00');
  });
  it('rejects invalid values', () => {
    expect(formatTime(-1)).toBe('--:--.--');
    expect(formatTime(NaN)).toBe('--:--.--');
    expect(formatTime(Infinity)).toBe('--:--.--');
  });
});

describe('formatDelta', () => {
  it('always shows a sign', () => {
    expect(formatDelta(-1.234)).toBe('-1.23');
    expect(formatDelta(0.5)).toBe('+0.50');
    expect(formatDelta(0)).toBe('+0.00');
  });
});

describe('minimapProject', () => {
  it('puts the view direction up the screen', () => {
    const p = minimapProject(0, 10, { x: 0, z: 1 });
    expect(p.u).toBeCloseTo(0);
    expect(p.v).toBeLessThan(0);
  });
  it('maps world -X to screen right for up=(0,1)', () => {
    expect(minimapProject(-10, 0, { x: 0, z: 1 }).u).toBeCloseTo(10);
  });
  it('works for a diagonal view', () => {
    const len = Math.hypot(0.6, 0.75);
    const up = { x: 0.6 / len, z: 0.75 / len };
    const p = minimapProject(up.x * 5, up.z * 5, up);
    expect(p.u).toBeCloseTo(0);
    expect(p.v).toBeLessThan(0);
  });
});

describe('ordinal', () => {
  it('handles st/nd/rd/th', () => {
    expect([1, 2, 3, 4, 10].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '10th']);
  });
  it('handles the teens', () => {
    expect([11, 12, 13, 111, 112, 113].map(ordinal)).toEqual(['11th', '12th', '13th', '111th', '112th', '113th']);
  });
  it('handles larger numbers', () => {
    expect([21, 22, 23, 101, 102].map(ordinal)).toEqual(['21st', '22nd', '23rd', '101st', '102nd']);
  });
});

describe('repairLabel', () => {
  it('hidden outside a station, progress inside one', () => {
    expect(repairLabel(null)).toBeNull();
    expect(repairLabel(undefined)).toBeNull();
    expect(repairLabel({ health: 0.648 })?.text).toBe('REPAIRING · 64%');
  });
});
