import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateTerrain, sampleHeight, sampleSoftness, toRapierHeights } from './TerrainData';

const opts = { n: 129, size: 600 };

describe('TerrainData', () => {
  it('is deterministic per seed', () => {
    const a = generateTerrain({ ...opts, seed: 5 });
    const b = generateTerrain({ ...opts, seed: 5 });
    const c = generateTerrain({ ...opts, seed: 6 });
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
    expect(Array.from(a.heights)).not.toEqual(Array.from(c.heights));
  });

  it('sampleHeight matches stored heights at grid points', () => {
    const t = generateTerrain(opts);
    const cell = t.size / (t.n - 1);
    for (const [ix, iz] of [[0, 0], [10, 20], [64, 64], [128, 128], [3, 127]] as const) {
      const x = -t.size / 2 + ix * cell;
      const z = -t.size / 2 + iz * cell;
      expect(sampleHeight(t, x, z)).toBeCloseTo(t.heights[iz * t.n + ix]!, 4);
    }
  });

  it('has a gentle but undulating centre arena', () => {
    const t = generateTerrain({ n: 257, size: 600 });
    let maxSlope = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < 2 * Math.PI; a += 0.1) {
      for (let r = 0; r < 30; r += 1) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const e = 0.5;
        const dx = (sampleHeight(t, x + e, z) - sampleHeight(t, x - e, z)) / (2 * e);
        const dz = (sampleHeight(t, x, z + e) - sampleHeight(t, x, z - e)) / (2 * e);
        maxSlope = Math.max(maxSlope, Math.hypot(dx, dz));
        const h = sampleHeight(t, x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    expect(maxSlope).toBeLessThan(0.3);
    expect(hi - lo).toBeGreaterThan(0.5);
    expect(hi - lo).toBeLessThan(4);
  });

  it('has real dunes between 60 and 200 m', () => {
    const t = generateTerrain({ n: 257, size: 600 });
    const cell = t.size / (t.n - 1);
    let best = 0;
    for (let iz = 0; iz < t.n; iz += 2) {
      for (let ix = 0; ix < t.n; ix += 2) {
        const x = -300 + ix * cell;
        const z = -300 + iz * cell;
        const r = Math.hypot(x, z);
        if (r < 60 || r > 200) continue;
        let trough = Infinity;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * 2 * Math.PI;
          trough = Math.min(trough, sampleHeight(t, x + Math.cos(a) * 60, z + Math.sin(a) * 60));
        }
        best = Math.max(best, t.heights[iz * t.n + ix]! - trough);
      }
    }
    expect(best).toBeGreaterThanOrEqual(6);
  });

  it('keeps the playable area drivable and the rim high', () => {
    const t = generateTerrain({ n: 257, size: 600 });
    const cell = t.size / (t.n - 1);
    let steep = 0;
    let total = 0;
    for (let iz = 1; iz < t.n - 1; iz++) {
      for (let ix = 1; ix < t.n - 1; ix++) {
        const x = -300 + ix * cell;
        const z = -300 + iz * cell;
        if (Math.max(Math.abs(x), Math.abs(z)) > 250) continue;
        const dx = (t.heights[iz * t.n + ix + 1]! - t.heights[iz * t.n + ix - 1]!) / (2 * cell);
        const dz = (t.heights[(iz + 1) * t.n + ix]! - t.heights[(iz - 1) * t.n + ix]!) / (2 * cell);
        total++;
        if (Math.atan(Math.hypot(dx, dz)) > (35 * Math.PI) / 180) steep++;
      }
    }
    expect(steep / total).toBeLessThan(0.03);
    expect(sampleHeight(t, 299, 0)).toBeGreaterThan(30);
  });
});

describe('softness', () => {
  it('is in [0,1], deterministic, and matches grid points', () => {
    const a = generateTerrain({ ...opts, seed: 5 });
    const b = generateTerrain({ ...opts, seed: 5 });
    expect(Array.from(a.softness)).toEqual(Array.from(b.softness));
    expect(a.softness.length).toBe(a.n * a.n);
    for (const v of a.softness) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const cell = a.size / (a.n - 1);
    expect(sampleSoftness(a, -300 + 10 * cell, -300 + 20 * cell)).toBeCloseTo(a.softness[20 * a.n + 10]!, 5);
    expect(sampleSoftness(a, 1e5, -1e5)).toBeCloseTo(a.softness[a.n - 1]!, 5);
  });

  it('is firm in the centre arena', () => {
    const t = generateTerrain({ n: 257, size: 600 });
    let sum = 0;
    let c = 0;
    for (let a = 0; a < 2 * Math.PI; a += 0.2) {
      for (let r = 0; r < 30; r += 2) {
        sum += sampleSoftness(t, Math.cos(a) * r, Math.sin(a) * r);
        c++;
      }
    }
    expect(sum / c).toBeLessThan(0.3);
  });

  it('makes dune crests softer than troughs on average', () => {
    const t = generateTerrain({ n: 257, size: 600 });
    const cell = t.size / (t.n - 1);
    const cells: { h: number; s: number }[] = [];
    for (let iz = 0; iz < t.n; iz++) {
      for (let ix = 0; ix < t.n; ix++) {
        const r = Math.hypot(-300 + ix * cell, -300 + iz * cell);
        if (r < 60 || r > 200) continue;
        cells.push({ h: t.heights[iz * t.n + ix]!, s: t.softness[iz * t.n + ix]! });
      }
    }
    cells.sort((p, q) => p.h - q.h);
    const k = Math.floor(cells.length / 5);
    const mean = (xs: { s: number }[]) => xs.reduce((a, v) => a + v.s, 0) / xs.length;
    expect(mean(cells.slice(-k))).toBeGreaterThan(mean(cells.slice(0, k)));
  });
});

describe('Rapier agreement', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('heightfield raycasts match sampleHeight (same ordering and triangulation)', () => {
    const t = generateTerrain({ n: 65, size: 600, seed: 9 });
    const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(t.n - 1, t.n - 1, toRapierHeights(t), { x: t.size, y: 1, z: t.size }),
      body,
    );
    world.step();
    let seed = 42;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 50; i++) {
      const x = (rnd() - 0.5) * 580;
      const z = (rnd() - 0.5) * 580;
      const hit = world.castRay(new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 }), 1000, true);
      expect(hit).not.toBeNull();
      expect(500 - hit!.timeOfImpact).toBeCloseTo(sampleHeight(t, x, z), 2);
    }
  });
});
