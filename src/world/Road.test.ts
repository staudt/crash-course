import { describe, expect, it } from 'vitest';
import { TrackPath } from '../race/TrackPath';
import { DUNE_LOOP } from '../race/tracks';
import { ROAD_CONFIG, buildElevation, carveRoad } from './Road';
import { generateTerrain, sampleHeight, sampleSoftness } from './TerrainData';

describe('Road carving', () => {
  const path = new TrackPath(DUNE_LOOP);
  const natural = generateTerrain({ n: 769, size: 2048 });
  const data = generateTerrain({ n: 769, size: 2048 });
  buildElevation(path, data);
  carveRoad(data, path);
  const onSand = (s: number) => path.sandAt(s) > 0;
  const nearJump = (s: number) => path.jumps.some((j) => Math.abs(path.wrap(s - j + path.length / 2) - path.length / 2) < 45);

  it('road profile is grade-limited away from jumps and sand', () => {
    let maxGrade = 0;
    for (let i = 0; i < path.count; i++) {
      if (nearJump(i * path.step) || onSand(i * path.step) || onSand((i + 1) * path.step)) continue;
      const j = (i + 1) % path.count;
      maxGrade = Math.max(maxGrade, Math.abs(path.elevation[j]! - path.elevation[i]!) / path.step);
    }
    expect(maxGrade).toBeLessThanOrEqual(ROAD_CONFIG.maxGrade + 1e-6);
  });

  it('crests and sags are gentle enough for 200+ km/h', () => {
    let worst = 0;
    for (let i = 0; i < path.count; i++) {
      if (nearJump(i * path.step) || onSand((i - 1) * path.step) || onSand((i + 1) * path.step)) continue;
      const a = path.elevation[(i + path.count - 1) % path.count]!;
      const b = path.elevation[i]!;
      const c = path.elevation[(i + 1) % path.count]!;
      worst = Math.max(worst, Math.abs(a - 2 * b + c) / path.step ** 2);
    }
    // Vertical curvature (1/m). At 60 m/s, 0.002 is 7 m/s² of extra load or lift (gravity is 20).
    expect(worst).toBeLessThan(0.002);
  });

  it('jumps rise to a lip', () => {
    const { jumpRun: run, jumpDrop: drop, jumpHeight } = ROAD_CONFIG;
    for (const s of path.jumps) {
      // Height above the straight line joining the kicker's foot and landing (cancels the underlying grade).
      const base = (path.heightAt(s - run) * drop + path.heightAt(s + drop) * run) / (run + drop);
      expect(path.heightAt(s) - base).toBeGreaterThan(jumpHeight * 0.6);
    }
  });

  it('terrain is flat across the road and matches the profile', () => {
    const t = { x: 0, z: 0 };
    const q = { x: 0, z: 0 };
    let worst = 0;
    for (let s = 0; s < path.length; s += 7) {
      path.pointAt(s, q);
      path.tangentAt(s, t);
      const road = path.heightAt(s);
      for (const off of [-path.halfWidth, 0, path.halfWidth]) {
        const h = sampleHeight(data, q.x + t.z * off, q.z - t.x * off);
        worst = Math.max(worst, Math.abs(h - road));
      }
    }
    // Grid cells are 2.67 m, so allow a little interpolation error on crests and kickers.
    expect(worst).toBeLessThan(0.35);
  });

  it('open sand rides the dunes but stays drivable', () => {
    let maxGrade = 0;
    let rough = 0;
    for (let i = 0; i < path.count; i++) {
      if (path.sandiness[i]! < 1) continue;
      const j = (i + 1) % path.count;
      maxGrade = Math.max(maxGrade, Math.abs(path.elevation[j]! - path.elevation[i]!) / path.step);
      rough = Math.max(rough, Math.abs(path.elevation[(i + path.count - 1) % path.count]! - 2 * path.elevation[i]! + path.elevation[j]!) / path.step ** 2);
    }
    expect(maxGrade).toBeLessThanOrEqual(ROAD_CONFIG.sandMaxGrade + 1e-6);
    // Noticeably rougher than the road (0.002), but no sags that act like walls at 120 km/h.
    expect(rough).toBeGreaterThan(0.004);
    expect(rough).toBeLessThan(0.007);
  });

  it('road is firm, open sand loose, the far desert untouched', () => {
    const q = { x: 0, z: 0 };
    let sandSamples = 0;
    for (let s = 0; s < path.length; s += 25) {
      path.pointAt(s, q);
      const soft = sampleSoftness(data, q.x, q.z);
      if (path.sandAt(s) === 0) expect(soft).toBeLessThan(0.08);
      if (path.sandAt(s) === 1) {
        expect(soft).toBeGreaterThan(ROAD_CONFIG.sandSoftness - 0.05);
        sandSamples++;
      }
    }
    expect(sandSamples).toBeGreaterThan(40);
    // Far from any road: identical to the uncarved terrain.
    for (const [x, z] of [[0, 400], [-900, -900], [500, 0]] as const) {
      if (path.project(x, z).distance < 80) continue;
      expect(sampleHeight(data, x, z)).toBeCloseTo(sampleHeight(natural, x, z), 5);
    }
  });
});
