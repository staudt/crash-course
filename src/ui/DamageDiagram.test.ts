import { describe, expect, it } from 'vitest';
import { damageColor } from './DamageDiagram';

describe('damageColor', () => {
  it('hits the stops', () => {
    expect(damageColor(1)).toBe('rgb(54,209,122)');
    expect(damageColor(0)).toBe('rgb(255,59,48)');
    expect(damageColor(1 / 3)).toBe('rgb(255,138,42)');
    expect(damageColor(2 / 3)).toBe('rgb(255,210,63)');
  });
  it('interpolates between stops', () => {
    expect(damageColor(1 / 6)).toBe('rgb(255,99,45)');
  });
  it('clamps', () => {
    expect(damageColor(5)).toBe(damageColor(1));
    expect(damageColor(-2)).toBe(damageColor(0));
  });
  it('null is none', () => {
    expect(damageColor(null)).toBe('none');
  });
});
