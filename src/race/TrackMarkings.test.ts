import { describe, expect, it } from 'vitest';
import { TrackPath } from './TrackPath';
import { CROSSOVER, DUNE_LOOP } from './tracks';
import { jumpSpots, pavedMarkings } from './TrackMarkings';

describe('jumpSpots', () => {
  it('marks every jump', () => {
    const path = new TrackPath(DUNE_LOOP);
    expect(jumpSpots(path)).toEqual(path.jumps);
  });
});

describe('pavedMarkings', () => {
  it('paints triangles on a paved track but keeps the crossing clear', () => {
    const { pos, col } = pavedMarkings(new TrackPath(CROSSOVER));
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.length % 9).toBe(0);
    expect(col.length).toBe(pos.length);
    for (let i = 0; i < pos.length; i += 3) expect(Math.hypot(pos[i]!, pos[i + 2]!)).toBeGreaterThan(5);
  });
  it('paints nothing on a sand track', () => {
    expect(pavedMarkings(new TrackPath(DUNE_LOOP)).pos).toEqual([]);
  });
});
