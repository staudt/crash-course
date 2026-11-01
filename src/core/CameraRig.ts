import * as THREE from 'three';

export const CAMERA_CONFIG = {
  fov: 30,
  /** Direction from target to camera. Fixed: the camera never rotates. */
  direction: new THREE.Vector3(-0.6, 0.62, -0.75).normalize(),
  distance: 52,
  /** Extra distance at top speed. */
  speedZoom: 14,
  lookAhead: 0.45, // seconds of velocity to lead the target by
  maxLookAhead: 12,
  followRate: 5, // 1/s, higher = tighter horizontal follow
  heightRate: 2.5, // vertical follow is softer so dune bumps don't shake the view
  minDistance: 20,
  /** Cap (m) on velocity lead + framing lean together, so the car never drifts to the screen edge. */
  maxLean: 16,
};

/** The traditional chase view: behind the car, turning with it. */
export const CHASE_CONFIG = {
  fov: 60,
  /** Extra field of view at top speed, for a sense of speed. */
  speedFov: 12,
  distance: 9,
  /** Extra distance at top speed. */
  speedDistance: 4,
  height: 3.3,
  /** The camera looks at a point this far ahead of the car, this high. */
  lookAhead: 6,
  lookHeight: 1.1,
  /** How fast the view swings round behind the car (1/s). */
  yawRate: 4.5,
  /** How much the view follows the direction of travel instead of the nose (0..1): shows drifts. */
  followVelocity: 0.4,
  heightRate: 6,
  /** Minimum height above the ground under the camera. */
  clearance: 1.2,
};

/** First person: the driver's eye, in car-local coordinates (+Z forward, +X left, +Y up). */
export const COCKPIT_CONFIG = {
  fov: 72,
  speedFov: 10,
  eye: new THREE.Vector3(0.32, 0.7, 0.05),
  /** Slight look down over the hood (rad). */
  pitch: 0.06,
  /** How fast the view follows the car's rotation (1/s): filters suspension jitter, keeps the bumps. */
  followRate: 14,
};

/** Player zoom (+/- keys, mouse wheel) for the chase and overhead views: a multiplier on the camera distance. */
export const ZOOM_CONFIG = {
  min: { chase: 0.5, fixed: 0.4 },
  max: { chase: 3, fixed: 2.5 },
  /** Zoom factor per wheel notch. */
  wheelStep: 1.12,
  /** Zoom rate while +/- is held (e-folds per second). */
  keyRate: 1.2,
  /** How fast the view eases to the new zoom (1/s). */
  rate: 10,
};

export type CameraMode = 'chase' | 'cockpit' | 'fixed';
export type ZoomMode = keyof typeof ZOOM_CONFIG.min;

/** The order C cycles through. */
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'cockpit', 'fixed'];

const NEAR: Record<CameraMode, number> = { chase: 0.3, cockpit: 0.05, fixed: 1 };
const _view = new THREE.Vector3();
const _turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _pitch = new THREE.Quaternion();
const _q = new THREE.Quaternion();

/** Follow camera: a chase view behind the car (default), first person, or the fixed 3/4 overhead view. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private readonly target = new THREE.Vector3();
  private distance = CAMERA_CONFIG.distance;
  private readonly tmp = new THREE.Vector3();
  /** Extra zoom and look offset from the race director (see CameraFraming), smoothed here. Fixed mode only. */
  private readonly framing = { zoom: 0, lookX: 0, lookZ: 0 };
  /** Chase view: smoothed yaw (car convention: 0 faces +Z) and camera height. */
  private chaseYaw = 0;
  private chaseY = 0;
  /** Cockpit view: smoothed car rotation. */
  private readonly cockpitRot = new THREE.Quaternion();
  private groundAt: (x: number, z: number) => number = () => -Infinity;
  /** Player zoom per view: the goal, and the smoothed value in use. */
  readonly zoom: Record<ZoomMode, number> = { chase: 1, fixed: 1 };
  private readonly zoomNow: Record<ZoomMode, number> = { chase: 1, fixed: 1 };

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_CONFIG.fov, aspect, 1, 1500);
    this.camera.position.copy(CAMERA_CONFIG.direction);
    this.camera.lookAt(0, 0, 0);
  }

  /** Current (smoothed) distance from the look target. */
  get currentDistance(): number {
    return this.distance;
  }

  /** Yaw the camera looks along on the ground plane (car convention: 0 faces +Z). */
  get viewYaw(): number {
    if (this.mode === 'fixed') {
      const d = CAMERA_CONFIG.direction;
      return Math.atan2(-d.x, -d.z);
    }
    this.camera.getWorldDirection(_view);
    return Math.atan2(_view.x, _view.z);
  }

  /** Terrain height lookup, so the chase view never dips into a dune. */
  setGround(fn: (x: number, z: number) => number): void {
    this.groundAt = fn;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.camera.fov = mode === 'chase' ? CHASE_CONFIG.fov : mode === 'cockpit' ? COCKPIT_CONFIG.fov : CAMERA_CONFIG.fov;
    this.camera.near = NEAR[mode];
    this.camera.updateProjectionMatrix();
  }

  /** Jump straight to a car pose (behind `heading` for the chase view, its rotation for the cockpit) with no smoothing. */
  snap(pos: THREE.Vector3, heading: number, rot: THREE.Quaternion): void {
    this.target.copy(pos);
    this.chaseYaw = heading;
    this.chaseY = pos.y + CHASE_CONFIG.height * this.zoomNow.chase;
    this.cockpitRot.copy(rot);
    if (this.mode === 'chase') this.applyChase(pos, 0);
    else if (this.mode === 'cockpit') this.applyCockpit(pos);
    else this.applyFixed();
  }

  /** Multiplies the current view's zoom (> 1 = farther out); false in the cockpit, which has none. */
  zoomBy(factor: number): boolean {
    if (this.mode === 'cockpit') return false;
    const m = this.mode;
    this.zoom[m] = Math.min(ZOOM_CONFIG.max[m], Math.max(ZOOM_CONFIG.min[m], this.zoom[m] * factor));
    return true;
  }

  /** Sets both views' zoom at once (e.g. restored from storage), with no easing. */
  setZoom(z: Partial<Record<ZoomMode, number>>): void {
    for (const m of ['chase', 'fixed'] as const) {
      const v = z[m];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      this.zoom[m] = this.zoomNow[m] = Math.min(ZOOM_CONFIG.max[m], Math.max(ZOOM_CONFIG.min[m], v));
    }
  }

  /** Extra zoom (m, negative = closer) and ground-plane look offset on top of the follow. */
  setFraming(zoom: number, lookX: number, lookZ: number): void {
    this.framing.zoom = zoom;
    this.framing.lookX = lookX;
    this.framing.lookZ = lookZ;
  }

  /** `heading` is the car's yaw (0 faces +Z), `rot` its rotation. */
  update(dt: number, pos: THREE.Vector3, vel: THREE.Vector3, speedFraction: number, heading: number, rot: THREE.Quaternion): void {
    const sf = Math.min(1, Math.max(0, speedFraction));
    const kz = 1 - Math.exp(-ZOOM_CONFIG.rate * dt);
    for (const m of ['chase', 'fixed'] as const) this.zoomNow[m] += (this.zoom[m] - this.zoomNow[m]) * kz;
    if (this.mode === 'chase') {
      this.updateChase(dt, pos, vel, sf, heading);
      return;
    }
    if (this.mode === 'cockpit') {
      this.cockpitRot.slerp(rot, 1 - Math.exp(-COCKPIT_CONFIG.followRate * dt));
      this.camera.fov = COCKPIT_CONFIG.fov + COCKPIT_CONFIG.speedFov * sf;
      this.camera.updateProjectionMatrix();
      this.applyCockpit(pos);
      return;
    }
    const c = CAMERA_CONFIG;
    const lead = this.tmp.set(vel.x, 0, vel.z).multiplyScalar(c.lookAhead);
    if (lead.length() > c.maxLookAhead) lead.setLength(c.maxLookAhead);
    lead.x += this.framing.lookX;
    lead.z += this.framing.lookZ;
    if (lead.length() > c.maxLean) lead.setLength(c.maxLean);
    const goal = lead.add(pos);

    const kh = 1 - Math.exp(-c.followRate * dt);
    const kv = 1 - Math.exp(-c.heightRate * dt);
    this.target.x += (goal.x - this.target.x) * kh;
    this.target.z += (goal.z - this.target.z) * kh;
    this.target.y += (goal.y - this.target.y) * kv;

    const goalDist = Math.max(c.minDistance, c.distance + c.speedZoom * sf + this.framing.zoom) * this.zoomNow.fixed;
    this.distance += (goalDist - this.distance) * (1 - Math.exp(-1.5 * dt));
    this.applyFixed();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private updateChase(dt: number, pos: THREE.Vector3, vel: THREE.Vector3, sf: number, heading: number): void {
    const c = CHASE_CONFIG;
    // Swing toward the nose, partly toward the direction of travel when moving forward (so drifts show).
    let goal = heading;
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 5 && vel.x * Math.sin(heading) + vel.z * Math.cos(heading) > 0) {
      goal = heading + wrapAngle(Math.atan2(vel.x, vel.z) - heading) * c.followVelocity;
    }
    this.chaseYaw += wrapAngle(goal - this.chaseYaw) * (1 - Math.exp(-c.yawRate * dt));
    this.camera.fov = c.fov + c.speedFov * sf;
    this.camera.updateProjectionMatrix();
    this.applyChase(pos, sf, dt);
  }

  private applyChase(pos: THREE.Vector3, sf: number, dt = 0): void {
    const c = CHASE_CONFIG;
    const fx = Math.sin(this.chaseYaw);
    const fz = Math.cos(this.chaseYaw);
    const zoom = this.zoomNow.chase;
    const back = (c.distance + c.speedDistance * sf) * zoom;
    const x = pos.x - fx * back;
    const z = pos.z - fz * back;
    const wantY = pos.y + c.height * zoom;
    this.chaseY = dt > 0 ? this.chaseY + (wantY - this.chaseY) * (1 - Math.exp(-c.heightRate * dt)) : wantY;
    const y = Math.max(this.chaseY, this.groundAt(x, z) + c.clearance);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(pos.x + fx * c.lookAhead, pos.y + c.lookHeight, pos.z + fz * c.lookAhead);
  }

  /** At the driver's eye, looking out along the car's nose (a camera looks down its -Z, so turn it around). */
  private applyCockpit(pos: THREE.Vector3): void {
    const c = COCKPIT_CONFIG;
    this.camera.position.copy(c.eye).applyQuaternion(this.cockpitRot).add(pos);
    _pitch.setFromAxisAngle(_view.set(1, 0, 0), -c.pitch);
    this.camera.quaternion.copy(_q.copy(this.cockpitRot).multiply(_turn).multiply(_pitch));
  }

  private applyFixed(): void {
    this.camera.position.copy(CAMERA_CONFIG.direction).multiplyScalar(this.distance).add(this.target);
    this.camera.lookAt(this.target);
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
