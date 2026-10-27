import * as THREE from 'three';

/**
 * A flat arrow showing the way to the next checkpoint. In the overhead view it lies on the
 * ground near the edge of the screen, in that direction as seen from the player's car; in the
 * chase view it floats ahead of the car, tilted up toward the camera. It also previews the next sharp
 * bend: the shaft curves the way the road will turn, by about as much as it turns, and the
 * colour warns how tight it is (yellow fast, orange medium, red hairpin). Drawn on top of
 * everything, and scaled by its distance from the camera so it keeps the same size on screen.
 */
const CONFIG = {
  /** The arrow sits where the car→route direction meets this inset box (normalised device coords). */
  edgeX: 0.78,
  edgeTop: 0.6,
  edgeBottom: -0.72,
  /** Shaft: straight lead-in, then an arc turning by the bend's angle (capped), drawn over `arcLength`. */
  shaftWidth: 1.3,
  leadIn: 1.2,
  arcLength: 3,
  maxTurn: (160 * Math.PI) / 180,
  headLength: 1.8,
  headWidth: 3.2,
  /** Geometry is cached per turn step (radians). */
  turnStep: (10 * Math.PI) / 180,
  /** Chase view: distance ahead of the car (m), height above the ground, and tilt toward the camera (rad). */
  aheadDistance: 9,
  aheadLift: 2.2,
  aheadTilt: 0.75,
  /** Chase view size relative to the overhead one (it is seen edge-on and against a busy horizon). */
  aheadScale: 2,
  /** Distance from the camera at which the arrow has its nominal size. */
  refDistance: 55,
  /** Height above the ground under the arrow. */
  lift: 0.4,
  /** Colour by the bend's tightest radius (m): ≥ fast = calm, ≤ hairpin = alarm. */
  fastRadius: 120,
  hairpinRadius: 35,
  colors: { calm: '#ffd23f', medium: '#ff9a1f', alarm: '#ff3b30' },
  opacity: 0.9,
  /** Opacity pulse (Hz) so it reads as a guide, not scenery. */
  pulse: 1.4,
  /** How fast the arrow swings to a new direction (1/s). */
  turnRate: 6,
};

/** What the arrow should say about the road ahead. */
export interface BendPreview {
  /** Signed turn (radians, positive = left). */
  turn: number;
  /** Tightest radius in it (m). */
  radius: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane();
const _ndc = new THREE.Vector2();
const _calm = new THREE.Color(CONFIG.colors.calm);
const _medium = new THREE.Color(CONFIG.colors.medium);
const _alarm = new THREE.Color(CONFIG.colors.alarm);

/**
 * Arrow geometry in the XZ plane, pointing +Z, whose shaft turns by `turn` (positive = left = toward +X,
 * the same convention as the car's yaw). Centred on its bounding box so it stays in frame at the screen edge.
 */
export function turnArrowGeometry(turn: number): THREE.BufferGeometry {
  const c = CONFIG;
  const pts: [number, number, number][] = []; // x, z, heading
  const steps = 12;
  for (let i = 0; i <= 2; i++) pts.push([0, (c.leadIn * i) / 2, 0]);
  const k = turn / c.arcLength;
  for (let i = 1; i <= steps; i++) {
    const u = (c.arcLength * i) / steps;
    // Same arc formula as TrackPath: heading 0 faces +Z, direction (sin h, cos h).
    const x = Math.abs(k) < 1e-6 ? 0 : (1 - Math.cos(k * u)) / k;
    const z = c.leadIn + (Math.abs(k) < 1e-6 ? u : Math.sin(k * u) / k);
    pts.push([x, z, k * u]);
  }
  const pos: number[] = [];
  const side = (p: [number, number, number], w: number): [number, number] => [p[0] + Math.cos(p[2]) * w, p[1] - Math.sin(p[2]) * w];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const [al, ar] = [side(a, c.shaftWidth / 2), side(a, -c.shaftWidth / 2)];
    const [bl, br] = [side(b, c.shaftWidth / 2), side(b, -c.shaftWidth / 2)];
    pos.push(al[0], 0, al[1], br[0], 0, br[1], ar[0], 0, ar[1]);
    pos.push(al[0], 0, al[1], bl[0], 0, bl[1], br[0], 0, br[1]);
  }
  const end = pts[pts.length - 1]!;
  const [hl, hr] = [side(end, c.headWidth / 2), side(end, -c.headWidth / 2)];
  const tip: [number, number] = [end[0] + Math.sin(end[2]) * c.headLength, end[1] + Math.cos(end[2]) * c.headLength];
  pos.push(hl[0], 0, hl[1], tip[0], 0, tip[1], hr[0], 0, hr[1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingBox();
  const centre = geo.boundingBox!.getCenter(new THREE.Vector3());
  geo.translate(-centre.x, 0, -centre.z);
  return geo;
}

/** Where the arrow goes: near the screen edge on the ground (overhead view), or floating ahead of the car (chase view). */
export type ArrowPlacement = 'edge' | 'ahead';

export class GuideArrow {
  /** Positions, tilts and scales the arrow; the mesh inside only turns to point. */
  private readonly pivot = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly shapes = new Map<number, THREE.BufferGeometry>();
  private angle: number | null = null;
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.MeshBasicMaterial({
      color: CONFIG.colors.calm,
      transparent: true,
      opacity: CONFIG.opacity,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.shape(0), this.material);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.pivot.rotation.order = 'YXZ';
    this.pivot.add(this.mesh);
    scene.add(this.pivot);
  }

  set visible(v: boolean) {
    this.pivot.visible = v;
  }

  /**
   * Point from the car toward `target` (world x/z), previewing `bend` (null = no sharp bend ahead).
   * Call after the camera has moved this frame. `viewYaw` is the camera's ground-plane heading,
   * `groundAt` the terrain height.
   */
  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    placement: ArrowPlacement,
    viewYaw: number,
    car: THREE.Vector3,
    target: { x: number; z: number },
    bend: BendPreview | null,
    groundAt: (x: number, z: number) => number,
  ): void {
    const want = Math.atan2(target.x - car.x, target.z - car.z);
    if (this.angle === null) this.angle = want;
    let d = want - this.angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.angle += d * (1 - Math.exp(-CONFIG.turnRate * dt));
    this.time += dt;

    this.mesh.geometry = this.shape(bend?.turn ?? 0);
    const tight = bend ? smoothstep(CONFIG.fastRadius, CONFIG.hairpinRadius, bend.radius) : 0;
    if (tight < 0.5) this.material.color.copy(_calm).lerp(_medium, tight * 2);
    else this.material.color.copy(_medium).lerp(_alarm, tight * 2 - 1);

    this.material.opacity = CONFIG.opacity * (0.75 + 0.25 * Math.sin(this.time * Math.PI * 2 * CONFIG.pulse));
    camera.updateMatrixWorld();

    if (placement === 'ahead') {
      const x = car.x + Math.sin(viewYaw) * CONFIG.aheadDistance;
      const z = car.z + Math.cos(viewYaw) * CONFIG.aheadDistance;
      this.pivot.position.set(x, Math.max(groundAt(x, z), car.y - 1) + CONFIG.aheadLift, z);
      this.pivot.rotation.set(-CONFIG.aheadTilt, viewYaw, 0);
      this.mesh.rotation.set(0, this.angle - viewYaw, 0);
      this.pivot.scale.setScalar((this.pivot.position.distanceTo(camera.position) / CONFIG.refDistance) * CONFIG.aheadScale);
      return;
    }

    // Screen direction of the (smoothed) world direction, starting at the car.
    const c = _a.copy(car).project(camera);
    const p = _b.set(car.x + Math.sin(this.angle) * 10, car.y, car.z + Math.cos(this.angle) * 10).project(camera);
    // Work in pixel-proportional units so the direction isn't skewed by the aspect ratio.
    let dx = (p.x - c.x) * camera.aspect;
    let dy = p.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Walk from the car's screen position to the inset box.
    const sx = dx / camera.aspect;
    const tx = sx > 0 ? (CONFIG.edgeX - c.x) / sx : sx < 0 ? (-CONFIG.edgeX - c.x) / sx : Infinity;
    const ty = dy > 0 ? (CONFIG.edgeTop - c.y) / dy : dy < 0 ? (CONFIG.edgeBottom - c.y) / dy : Infinity;
    const t = Math.max(0, Math.min(tx, ty));
    _ndc.set(c.x + sx * t, c.y + dy * t);

    // Back onto the ground: intersect the view ray with a level plane at the car's ground height.
    _ray.setFromCamera(_ndc, camera);
    _plane.set(_a.set(0, 1, 0), -groundAt(car.x, car.z));
    const hit = _ray.ray.intersectPlane(_plane, _b);
    if (!hit) return;
    this.pivot.position.set(hit.x, groundAt(hit.x, hit.z) + CONFIG.lift, hit.z);
    this.pivot.rotation.set(0, 0, 0);
    this.mesh.rotation.set(0, this.angle, 0);
    this.pivot.scale.setScalar(this.pivot.position.distanceTo(camera.position) / CONFIG.refDistance);
  }

  /** Forget the smoothed direction (after a respawn or restart). */
  reset(): void {
    this.angle = null;
  }

  private shape(turn: number): THREE.BufferGeometry {
    const clamped = Math.max(-CONFIG.maxTurn, Math.min(CONFIG.maxTurn, turn));
    const key = Math.round(clamped / CONFIG.turnStep);
    let geo = this.shapes.get(key);
    if (!geo) {
      geo = turnArrowGeometry(key * CONFIG.turnStep);
      this.shapes.set(key, geo);
    }
    return geo;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
