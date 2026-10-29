import { describe, expect, it } from 'vitest';
import { stepChoice } from './LevelMenu';

describe('stepChoice', () => {
  it('moves and wraps forward', () => {
    expect(stepChoice(0, 1, 2)).toBe(1);
    expect(stepChoice(1, 1, 2)).toBe(0);
    expect(stepChoice(2, 1, 3)).toBe(0);
  });
  it('wraps backward', () => {
    expect(stepChoice(0, -1, 2)).toBe(1);
    expect(stepChoice(0, -1, 3)).toBe(2);
    expect(stepChoice(1, -4, 3)).toBe(0);
  });
  it('handles empty', () => {
    expect(stepChoice(0, 1, 0)).toBe(0);
  });
});
