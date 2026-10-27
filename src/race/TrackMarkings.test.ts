import { describe, expect, it } from 'vitest';
import { TrackPath } from './TrackPath';
import { DUNE_LOOP } from './tracks';
import { jumpSpots } from './TrackMarkings';

describe('jumpSpots', () => {
  it('marks every jump', () => {
    const path = new TrackPath(DUNE_LOOP);
    expect(jumpSpots(path)).toEqual(path.jumps);
  });
});
