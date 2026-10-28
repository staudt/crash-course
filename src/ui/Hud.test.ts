import { describe, expect, it } from 'vitest';
import { boostStyle } from './Hud';

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
