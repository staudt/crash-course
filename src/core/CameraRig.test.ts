import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHASE_CONFIG, CameraRig, ZOOM_CONFIG } from './CameraRig';

const pos = new THREE.Vector3(0, 0, 0);
const vel = new THREE.Vector3(0, 0, 0);
const rot = new THREE.Quaternion();

function settle(rig: CameraRig): void {
  for (let i = 0; i < 300; i++) rig.update(1 / 60, pos, vel, 0, 0, rot);
}

describe('CameraRig zoom', () => {
  it('scales the chase distance and clamps to its range', () => {
    const rig = new CameraRig(1);
    settle(rig);
    const base = rig.camera.position.distanceTo(pos);
    expect(rig.zoomBy(2)).toBe(true);
    settle(rig);
    expect(rig.camera.position.distanceTo(pos)).toBeCloseTo(base * 2, 1);
    rig.zoomBy(100);
    expect(rig.zoom.chase).toBe(ZOOM_CONFIG.max.chase);
    rig.zoomBy(1e-6);
    expect(rig.zoom.chase).toBe(ZOOM_CONFIG.min.chase);
    expect(base).toBeCloseTo(Math.hypot(CHASE_CONFIG.distance, CHASE_CONFIG.height), 1);
  });

  it('keeps a zoom per view and none in the cockpit', () => {
    const rig = new CameraRig(1);
    rig.setMode('fixed');
    settle(rig);
    const base = rig.currentDistance;
    rig.zoomBy(1.5);
    settle(rig);
    expect(rig.currentDistance).toBeCloseTo(base * 1.5, 1);
    expect(rig.zoom.chase).toBe(1);
    rig.setMode('cockpit');
    expect(rig.zoomBy(2)).toBe(false);
  });

  it('restores a saved zoom, ignoring junk', () => {
    const rig = new CameraRig(1);
    rig.setZoom({ chase: 1.4, fixed: Number.NaN });
    expect(rig.zoom).toEqual({ chase: 1.4, fixed: 1 });
  });
});
