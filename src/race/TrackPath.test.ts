import { describe, expect, it } from 'vitest';
import { TrackPath, straightLengths, type TrackDef } from './TrackPath';
import { DUNE_LOOP } from './tracks';

const square: TrackDef = {
  id: 'sq',
  name: 'Square',
  halfWidth: 5,
  checkpoints: 4,
  corners: [
    { x: 0, z: 0, r: 20 },
    { x: 0, z: 200, r: 20 },
    { x: 200, z: 200, r: 20 },
    { x: 200, z: 0, r: 20, jump: 0.25 },
  ],
};

describe('TrackPath', () => {
  it('lays out straights and arcs with the right length', () => {
    const p = new TrackPath(square);
    // 4 straights of 200 - 2r, plus a full circle of radius r.
    expect(p.length).toBeCloseTo(4 * 160 + 2 * Math.PI * 20, 1);
    expect(p.checkpoints).toHaveLength(4);
    expect(p.jumps).toHaveLength(1);
  });

  it('starts halfway along the first straight, heading to corner 1, and closes', () => {
    const p = new TrackPath(square);
    const a = p.pointAt(0, { x: 0, z: 0 });
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.z).toBeCloseTo(100, 6);
    expect(p.headingAt(0)).toBeCloseTo(0, 6);
    const b = p.pointAt(p.length - 1e-6, { x: 0, z: 0 });
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(0.01);
  });

  it('is smooth: no kinks between samples', () => {
    for (const def of [square, DUNE_LOOP]) {
      const p = new TrackPath(def);
      for (let i = 0; i < p.count; i++) {
        const j = (i + 1) % p.count;
        const dot = p.txs[i]! * p.txs[j]! + p.tzs[i]! * p.tzs[j]!;
        // ≤ step / min radius of turn per sample.
        expect(Math.acos(Math.min(1, dot))).toBeLessThan(p.step / 20 + 1e-6);
        expect(Math.hypot(p.xs[j]! - p.xs[i]!, p.zs[j]! - p.zs[i]!)).toBeLessThan(p.step + 1e-6);
      }
    }
  });

  it('projects points to s and signed lateral offset (left positive)', () => {
    const p = new TrackPath(square);
    // At s = 0 the track heads +Z at x = 0; left of +Z is +X.
    const left = p.project(5, 110);
    expect(left.s).toBeCloseTo(10, 4);
    expect(left.lateral).toBeCloseTo(5, 4);
    const right = p.project(-3, 110, left.index);
    expect(right.lateral).toBeCloseTo(-3, 4);
    expect(right.distance).toBeCloseTo(3, 4);
  });

  it('positive curvature turns left', () => {
    const p = new TrackPath(square);
    // Square is driven (0,0)→(0,200)→(200,200): heading +Z then +X, which is a left turn.
    // The corner's arc starts 80 m after the start (200 - 100 - r) and is 31 m long.
    expect(p.curvatureAt(95)).toBeCloseTo(1 / 20, 6);
    expect(p.headingAt(80 + 10 * Math.PI + p.step)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('lists bends and blends sand stretches in and out', () => {
    const p = new TrackPath({ ...square, sand: [[1, 2]] });
    expect(p.bends.map((b) => b.corner)).toEqual([1, 2, 3, 0]);
    for (const b of p.bends) {
      expect(b.radius).toBeCloseTo(20, 6);
      expect(b.turn).toBeCloseTo(Math.PI / 2, 6);
    }
    const [b1, b2] = p.bends;
    const from = (b1!.start + b1!.end) / 2;
    const to = (b2!.start + b2!.end) / 2;
    expect(p.sandAt(from)).toBeLessThan(0.05);
    expect(p.sandAt((from + to) / 2)).toBe(1);
    expect(p.sandAt(to + 5)).toBe(0);
    expect(p.sandAt(0)).toBe(0);
    expect(() => new TrackPath({ ...square, corners: square.corners.map((c, i) => (i === 1 ? { ...c, r: 0 } : c)), sand: [[1, 2]] })).toThrow();
  });

  it('finds the next sharp bend, merging back-to-back ones the same way', () => {
    const p = new TrackPath(square);
    // From the start: the first corner's arc begins 80 m ahead and turns 90° left.
    const b = p.nextBend(0, 150, 50)!;
    expect(b.distance).toBeCloseTo(80, 6);
    expect(b.turn).toBeCloseTo(Math.PI / 2, 6);
    expect(p.nextBend(0, 50, 50)).toBeNull();
    expect(p.nextBend(0, 150, 10)).toBeNull();
    // Inside the arc: distance 0.
    expect(p.nextBend(90, 150, 50)!.distance).toBe(0);
    // Corners 160 m apart are separate, unless the chain gap allows it.
    expect(p.nextBend(0, 150, 50, 200)!.turn).toBeCloseTo(2 * Math.PI, 6);

    const loop = new TrackPath(DUNE_LOOP);
    const c3 = loop.bends.find((x) => x.corner === 3)!;
    const hairpin = loop.nextBend(c3.start - 50, 100, 90)!;
    expect(Math.abs(hairpin.turn)).toBeGreaterThan((140 * Math.PI) / 180);
  });

  describe('Dune Loop', () => {
    const p = new TrackPath(DUNE_LOOP);

    it('is about 7 km, inside the world, with valid straights', () => {
      expect(p.length).toBeGreaterThan(6000);
      expect(p.length).toBeLessThan(8000);
      for (let i = 0; i < p.count; i++) {
        expect(Math.abs(p.xs[i]!)).toBeLessThan(800);
        expect(Math.abs(p.zs[i]!)).toBeLessThan(800);
      }
      for (const l of straightLengths(DUNE_LOOP)) expect(l).toBeGreaterThan(20);
    });

    it('keeps separate parts of the track apart', () => {
      let closest = Infinity;
      for (let i = 0; i < p.count; i += 2) {
        for (let j = i + 2; j < p.count; j += 2) {
          const ring = Math.min(j - i, p.count - (j - i)) * p.step;
          if (ring < 150) continue;
          closest = Math.min(closest, Math.hypot(p.xs[i]! - p.xs[j]!, p.zs[i]! - p.zs[j]!));
        }
      }
      expect(closest).toBeGreaterThan(55);
    });
  });
});
