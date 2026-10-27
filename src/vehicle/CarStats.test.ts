import { describe, expect, it } from 'vitest';
import { DEFAULT_STATS, applyModifiers, cloneStats } from './CarStats';

describe('applyModifiers', () => {
  it('applies adds before muls regardless of order', () => {
    const out = applyModifiers(DEFAULT_STATS, [
      { stat: 'mass', mul: 2 },
      { stat: 'mass', add: 100 },
    ]);
    expect(out.mass).toBe((DEFAULT_STATS.mass + 100) * 2);
  });

  it('does not mutate the base', () => {
    const before = JSON.stringify(DEFAULT_STATS);
    applyModifiers(DEFAULT_STATS, [{ stat: 'topSpeed', add: 5, mul: 3 }]);
    expect(JSON.stringify(DEFAULT_STATS)).toBe(before);
  });

  it('returns a fresh partHp object', () => {
    const out = applyModifiers(DEFAULT_STATS, []);
    expect(out.partHp).not.toBe(DEFAULT_STATS.partHp);
    out.partHp.hood = 1;
    expect(DEFAULT_STATS.partHp.hood).toBe(60);
  });

  it('leaves untouched stats unchanged', () => {
    const out = applyModifiers(DEFAULT_STATS, [{ stat: 'engineForce', mul: 1.5 }]);
    expect(out.mass).toBe(DEFAULT_STATS.mass);
    expect(out.engineForce).toBe(DEFAULT_STATS.engineForce * 1.5);
  });
});

describe('cloneStats', () => {
  it('equals the defaults but is a distinct object', () => {
    const c = cloneStats();
    expect(c).toEqual(DEFAULT_STATS);
    expect(c).not.toBe(DEFAULT_STATS);
  });
});
