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

export type CameraMode = 'fixed' | 'chase';

/** Follow camera: the fixed-orientation 3/4 overhead view, or a traditional chase view (C toggles). */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'fixed';
  private readonly target = new THREE.Vector3();
  private distance = CAMERA_CONFIG.distance;
  private readonly tmp = new THREE.Vector3();
  /** Extra zoom and look offset from the race director (see CameraFraming), smoothed here. Fixed mode only. */
  private readonly framing = { zoom: 0, lookX: 0, lookZ: 0 };
  /** Chase view: smoothed yaw (car convention: 0 faces +Z) and camera height. */
  private chaseYaw = 0;
  private chaseY = 0;
  private groundAt: (x: number, z: number) => number = () => -Infinity;

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
    if (this.mode === 'chase') return this.chaseYaw;
    const d = CAMERA_CONFIG.direction;
    return Math.atan2(-d.x, -d.z);
  }

  /** Terrain height lookup, so the chase view never dips into a dune. */
  setGround(fn: (x: number, z: number) => number): void {
    this.groundAt = fn;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.camera.fov = mode === 'chase' ? CHASE_CONFIG.fov : CAMERA_CONFIG.fov;
    this.camera.updateProjectionMatrix();
  }

  /** Jump straight to a position (and, for the chase view, behind `heading`) with no smoothing. */
  snap(pos: THREE.Vector3, heading = this.chaseYaw): void {
    this.target.copy(pos);
    this.chaseYaw = heading;
    this.chaseY = pos.y + CHASE_CONFIG.height;
    if (this.mode === 'chase') this.applyChase(pos, 0);
    else this.applyFixed();
  }

  /** Extra zoom (m, negative = closer) and ground-plane look offset on top of the follow. */
  setFraming(zoom: number, lookX: number, lookZ: number): void {
    this.framing.zoom = zoom;
    this.framing.lookX = lookX;
    this.framing.lookZ = lookZ;
  }

  /** `heading` is the car's yaw (0 faces +Z). */
  update(dt: number, pos: THREE.Vector3, vel: THREE.Vector3, speedFraction: number, heading: number): void {
    const sf = Math.min(1, Math.max(0, speedFraction));
    if (this.mode === 'chase') {
      this.updateChase(dt, pos, vel, sf, heading);
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

    const goalDist = Math.max(c.minDistance, c.distance + c.speedZoom * sf + this.framing.zoom);
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
    const back = c.distance + c.speedDistance * sf;
    const x = pos.x - fx * back;
    const z = pos.z - fz * back;
    const wantY = pos.y + c.height;
    this.chaseY = dt > 0 ? this.chaseY + (wantY - this.chaseY) * (1 - Math.exp(-c.heightRate * dt)) : wantY;
    const y = Math.max(this.chaseY, this.groundAt(x, z) + c.clearance);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(pos.x + fx * c.lookAhead, pos.y + c.lookHeight, pos.z + fz * c.lookAhead);
  }

  private applyFixed(): void {
    this.camera.position.copy(CAMERA_CONFIG.direction).multiplyScalar(this.distance).add(this.target);
    this.camera.lookAt(this.target);
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
