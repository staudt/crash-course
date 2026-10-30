import { describe, expect, it } from 'vitest';
import { boostStyle, FpsMeter } from './Hud';

describe('boostStyle', () => {
  it('ready, boosting and recharging look different', () => {
    const ready = boostStyle(false, false);
    const boosting = boostStyle(true, false);
    const empty = boostStyle(false, true);
    expect(new Set([ready.color, boosting.color, empty.color]).size).toBe(3);
    expect(boosting.glow).toBe(true);
    expect(ready.glow).toBe(false);
  });

  it('running dry says so, even with boost held', () => {
    expect(boostStyle(true, true).label).toMatch(/RECHARGING/);
    expect(boostStyle(false, false).label).toBe('BOOST');
  });
});

describe('FpsMeter', () => {
  it('reads frames per second of wall-clock time, once per window', () => {
    const m = new FpsMeter();
    expect(m.frame(0)).toBeNull();
    const readings: number[] = [];
    // 60 Hz for a second and a half.
    for (let i = 1; i <= 90; i++) {
      const r = m.frame((i * 1000) / 60);
      if (r !== null) readings.push(r);
    }
    expect(readings.length).toBe(3); // at 0.5, 1 and 1.5 s
    for (const r of readings) expect(r).toBeCloseTo(60, 0);
    // A hitch: 4 frames in the next 500 ms.
    let r: number | null = null;
    for (let i = 1; i <= 4; i++) r = m.frame(1500 + i * 125) ?? r;
    expect(r).toBeCloseTo(8, 0);
  });
});
