import { describe, expect, it } from 'vitest';
import { TrackPath, type TrackDef } from '../race/TrackPath';
import { FRAMING_CONFIG, cameraFraming } from './CameraFraming';

const square: TrackDef = {
  id: 'sq',
  name: 'Square',
  halfWidth: 8,
  checkpoints: 4,
  corners: [
    { x: 0, z: 0, r: 30 },
    { x: 0, z: 800, r: 30 },
    { x: 800, z: 800, r: 30 },
    { x: 800, z: 0, r: 30 },
  ],
};
const path = new TrackPath(square);
// s = 0 is (0, 400) heading +Z; the first bend starts 370 m later.
const onStraight = { x: 0, z: 400 };

describe('cameraFraming', () => {
  it('does nothing on an empty straight', () => {
    const f = cameraFraming(path, 0, onStraight, 40, []);
    expect(f).toEqual({ zoom: 0, lookX: 0, lookZ: 0 });
  });

  it('zooms in on a rival right beside you', () => {
    const f = cameraFraming(null, 0, onStraight, 40, [{ x: 4, z: 402 }]);
    expect(f.zoom).toBeCloseTo(FRAMING_CONFIG.closeZoom, 6);
    expect(Math.hypot(f.lookX, f.lookZ)).toBeLessThan(0.01);
  });

  it('widens and leans toward a rival further off, and ignores far ones', () => {
    const f = cameraFraming(null, 0, onStraight, 40, [{ x: 0, z: 460 }, { x: 0, z: 300 + 400 }]);
    expect(f.zoom).toBeGreaterThan(10);
    expect(f.lookZ).toBeGreaterThan(5);
    const far = cameraFraming(null, 0, onStraight, 40, [{ x: 0, z: 400 + FRAMING_CONFIG.frameRange + 1 }]);
    expect(far).toEqual({ zoom: 0, lookX: 0, lookZ: 0 });
  });

  it('leans toward a sharp bend ahead at speed, more as it gets closer', () => {
    const far = cameraFraming(path, 370 - 140, { x: 0, z: 630 }, 40, []);
    const near = cameraFraming(path, 370 - 30, { x: 0, z: 740 }, 40, []);
    expect(far.zoom).toBeGreaterThan(0);
    expect(near.zoom).toBeGreaterThan(far.zoom);
    // The bend turns toward +X (left, seen from a car heading +Z): the view leans ahead and to +X.
    expect(near.lookZ).toBeGreaterThan(0);
    expect(near.lookX).toBeGreaterThan(0);
    // Crawling: no lean.
    expect(cameraFraming(path, 370 - 30, { x: 0, z: 740 }, 0, []).zoom).toBe(0);
  });

  it('caps the total lean', () => {
    const f = cameraFraming(path, 370 - 10, { x: 0, z: 760 }, 60, [{ x: 50, z: 820 }]);
    expect(Math.hypot(f.lookX, f.lookZ)).toBeLessThanOrEqual(FRAMING_CONFIG.maxShift + 1e-9);
  });
});
