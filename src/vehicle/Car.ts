import * as THREE from 'three';
import { RAPIER, type Physics } from '../core/Physics';
import { NEUTRAL_INPUT, type DriveInput, type Vec3Like } from '../core/types';
import type { CarModel, CarPart } from './CarModel';
import type { DamageReport } from './DamageReport';
import { DEFAULT_DIMS, type CarDims, type CarStats } from './CarStats';
import { knockAmount, ramFactor } from './Crash';
import { applyDent } from './Deformer';
import { repairStep } from './Repair';

export interface CarEvents {
  /** A part's HP hit 0. Its mesh is still attached; the listener should hand it to Debris. */
  onPartDetached?(car: Car, part: CarPart, linvel: Vec3Like, angvel: Vec3Like): void;
  /** A hard hit. World-space point and outward normal; strength in m/s above threshold. */
  onImpact?(car: Car, point: THREE.Vector3, normal: THREE.Vector3, strength: number): void;
  onWrecked?(car: Car): void;
  /** This car felt a jolt of `impact` m/s (≥ CAR_CONTACT_MIN) while touching `other`. Fired from each car's own point of view. */
  onCarContact?(car: Car, other: Car, impact: number): void;
  /** Sliding along a wall at `speed` m/s this step (world-space contact point, normal pointing out of the car). */
  onScrape?(car: Car, point: THREE.Vector3, normal: THREE.Vector3, speed: number): void;
}

/** Smallest jolt (m/s) between two cars that counts as a contact for `onCarContact` (bumps, not brushes). */
export const CAR_CONTACT_MIN = 1.5;

/** Smooth walls: the unit outward normal (ground plane) of a wall collider's outline at (x, z), or null if it isn't one. */
export type WallFn = (collider: RAPIER.Collider, x: number, z: number) => { x: number; z: number } | null;

/** Sand softness (0 = firm, 1 = deep soft sand) of whatever a wheel is touching. */
export type SurfaceFn = (ground: RAPIER.Collider, x: number, z: number) => number;

export interface SpawnPose {
  position: Vec3Like;
  yaw: number;
}

/** Contact-force events below this don't even get recorded. The velocity-change check does the real filtering. */
const CONTACT_EVENT_THRESHOLD = 1500;
/** Metres ahead the chassis looks for contacts (Rapier soft CCD). */
const SOFT_CCD = 1.5;
const CHASSIS_FRICTION = 0.5;
/** A wrecked car under repair drives again once its health is back to this fraction. */
const UNWRECK_HEALTH = 0.2;
/** s without repair() that counts as having driven off: the next part refit starts its wait over. */
const REPAIR_GAP = 0.15;
/** How far beyond a part's bounding box a dent can reach it. */
const PART_REACH = 0.25;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _w = new THREE.Vector3();
const _r = new THREE.Vector3();
const _up2 = new THREE.Vector3();

/** Signed angle (radians) from a to b around `axis` (right-handed: + = counter-clockwise seen from above). */
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.atan2(cx * axis.x + cy * axis.y + cz * axis.z, a.dot(b));
}

/**
 * A drivable, destructible car: one dynamic chassis body driven by Rapier's
 * raycast vehicle controller, with arcade assists on top. Damage is visual
 * (vertex dents) plus HP per detachable part plus overall health.
 */
export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly model: CarModel;
  readonly dims: CarDims;
  stats: CarStats;
  readonly input: DriveInput = { ...NEUTRAL_INPUT };
  /** Future abilities (dash etc.) hook in here. */
  readonly abilities: unknown[] = [];
  /** Ground softness lookup. Unset = everything is firm. */
  surface: SurfaceFn | null = null;
  /** Average softness under the wheels last step, 0..1 (airborne wheels count as 0). */
  surfaceSoftness = 0;
  /** Smooth-wall lookup (glancing contact slides along, see `glance`). Unset = walls are like any other obstacle. */
  walls: WallFn | null = null;
  /** Asphalt lookup (0..1 paved). Unset = nothing is paved. */
  paving: SurfaceFn | null = null;
  /** How much of the ground under the grounded wheels was asphalt last step, 0..1. */
  surfacePaved = 0;

  health: number;
  partsLost = 0;
  wrecked = false;
  /** Boost bar 0..1: drains while boosting, recharges slowly otherwise. */
  boostCharge = 1;
  /** Ran dry: boost stays off until the bar recharges to stats.boostRestart. */
  boostEmpty = false;
  /** Boost active this step (held, throttle on, charge left). */
  boosting = false;
  /** Multiplies engine force and top speed (1 = stock). The race director sets it for AI catch-up and rage. */
  powerScale = 1;
  /** Level multiplier on the health a hit takes (the derby lowers it so cars take many more hits; dents and lost parts are unchanged). */
  healthLoss = 1;
  /** Handbrake spin direction (+1 = nose swinging left), latched when the handbrake goes on. */
  private spinDir = 0;
  /** A spin carried on after the handbrake was released (see stats.spinCommit). */
  private spinning = false;
  private wasHandbraking = false;
  /** How far (rad) the car has rotated in the spin direction since the handbrake went on. */
  private spinTurned = 0;
  /** Seconds of knock left after a big hit (see stats.knockTime). */
  private knockTimer = 0;

  private readonly physics: Physics;
  private readonly events: CarEvents;
  private readonly originals = new Map<CarPart, Float32Array>();
  private readonly partHp = new Map<CarPart, number>();
  /** Pristine copy of each part (not in the scene) and where it hangs, for refitting it after it broke off. */
  private readonly spares = new Map<CarPart, { mesh: THREE.Mesh; parent: THREE.Object3D }>();
  /** Parts whose vertices have moved from their originals. */
  private readonly dented = new Set<CarPart>();
  /** Detached parts, in the order they came off. */
  private readonly lostParts: CarPart[] = [];
  /** Seconds of continuous repair since the last refit. */
  private refitClock = 0;
  /** Metres slid along a wall since the last scratch. */
  private scrapeDist = 0;
  /** Seconds since repair() was last called. */
  private sinceRepair = Infinity;
  private readonly wheelLost = [false, false, false, false];
  private steerAngle = 0;
  /** The input with the steering cut down for lost front wheels. */
  private readonly limpInput: DriveInput = { ...NEUTRAL_INPUT };
  /** Multiplier on grip: handbrakeGrip while the handbrake is held, easing back to 1. */
  private gripScale = 1;
  private upsideDownTime = 0;
  private readonly prevVel = new THREE.Vector3();
  private readonly prevAngvel = new THREE.Vector3();
  private readonly contacts = new Set<RAPIER.Collider>();

  // Render interpolation between the last two physics states.
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly prevRot = new THREE.Quaternion();
  private readonly currRot = new THREE.Quaternion();

  constructor(physics: Physics, model: CarModel, stats: CarStats, pose: SpawnPose, events: CarEvents = {}, dims: CarDims = DEFAULT_DIMS) {
    this.physics = physics;
    this.model = model;
    this.stats = stats;
    this.events = events;
    this.dims = dims;
    this.health = stats.maxHealth;

    const world = physics.world;
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pose.position.x, pose.position.y, pose.position.z)
        .setRotation(rot)
        .setLinearDamping(0.05)
        .setAngularDamping(0.6)
        .setCcdEnabled(true)
        // The chassis box is thin (0.64 m): at ~200 km/h closing speed two cars overlap deeper than
        // that in one step, get pushed apart vertically and pass through each other. Soft CCD
        // catches the contact a step early.
        .setSoftCcdPrediction(SOFT_CCD),
    );

    const { halfWidth: hx, halfHeight: hy, halfLength: hz } = dims;
    const m = stats.mass;
    // Box inertia, padded a little for stability. Centre of mass lowered for arcade-stable handling.
    const k = 1.3 * (m / 3);
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setMassProperties(m, { x: 0, y: -stats.comDrop, z: 0 }, { x: k * (hy * hy + hz * hz), y: k * (hx * hx + hz * hz), z: k * (hx * hx + hy * hy) }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(CHASSIS_FRICTION)
        .setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(CONTACT_EVENT_THRESHOLD),
      this.body,
    );
    physics.setOwner(this.collider, this);

    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      this.controller.addWheel(
        { x: sx * dims.wheelX, y: dims.wheelY, z: sz * dims.wheelZ },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        stats.suspensionRestLength,
        dims.wheelRadius,
      );
    }
    this.applyWheelStats();

    for (const part of model.parts) {
      const pos = part.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      this.originals.set(part, (pos.array as Float32Array).slice());
      const spare = part.mesh.clone();
      spare.geometry = part.mesh.geometry.clone();
      this.spares.set(part, { mesh: spare, parent: part.mesh.parent ?? model.root });
      const hp = stats.partHp[part.kind];
      if (Number.isFinite(hp)) this.partHp.set(part, hp);
    }

    this.capture();
    this.prevPos.copy(this.currPos);
    this.prevRot.copy(this.currRot);
    this.render(1);
  }

  /**
   * Re-applies suspension stats (call after editing `stats` live). Rapier's wheels only do
   * suspension and ground contact: no tyre friction, since drive and grip are our arcade model.
   */
  applyWheelStats(): void {
    const s = this.stats;
    for (let i = 0; i < 4; i++) {
      if (this.wheelLost[i]) continue;
      const c = this.controller;
      c.setWheelSuspensionRestLength(i, s.suspensionRestLength);
      c.setWheelSuspensionStiffness(i, s.suspensionStiffness);
      c.setWheelSuspensionCompression(i, s.suspensionCompression);
      c.setWheelSuspensionRelaxation(i, s.suspensionRelaxation);
      c.setWheelMaxSuspensionTravel(i, s.maxSuspensionTravel);
      c.setWheelMaxSuspensionForce(i, s.mass * 60);
      c.setWheelFrictionSlip(i, 0);
      c.setWheelSideFrictionStiffness(i, 0);
      c.setWheelEngineForce(i, 0);
      c.setWheelBrake(i, 0);
    }
  }

  /** Signed speed along the car's forward axis (m/s). */
  get forwardSpeed(): number {
    const v = this.body.linvel();
    this.forward(_fwd);
    return v.x * _fwd.x + v.y * _fwd.y + v.z * _fwd.z;
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  /** Angle (radians, 0..π) between the direction of travel and the car's nose, ignoring vertical. 0 when slow. */
  get slipAngle(): number {
    const v = this.body.linvel();
    const sp = Math.hypot(v.x, v.z);
    if (sp < 3) return 0;
    this.forward(_fwd);
    const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (v.x * _fwd.x + v.z * _fwd.z) / (sp * fl))));
  }

  /** Signed slip angle (radians): + when the car is travelling to the left of where its nose points. */
  get signedSlipAngle(): number {
    const v = this.body.linvel();
    const local = _v.set(v.x, v.y, v.z).applyQuaternion(_q.copy(this.currRot).invert());
    if (Math.hypot(local.x, local.z) < 3) return 0;
    return Math.atan2(local.x, local.z);
  }

  get groundedWheels(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (!this.wheelLost[i] && this.controller.wheelIsInContact(i)) n++;
    return n;
  }

  /** 0..1: how knocked off line the car is after a hit. Grip and yaw control are loosened by this much. */
  get knock(): number {
    return Math.min(1, this.knockTimer / this.stats.knockTime);
  }

  /** Anything to repair: health, dents or lost parts. */
  get damaged(): boolean {
    return this.health < this.stats.maxHealth || this.dented.size > 0 || this.lostParts.length > 0;
  }

  isWheelLost(i: number): boolean {
    return this.wheelLost[i];
  }

  /** Damage by zone for the HUD's damage map: each breakable part's HP left (null once it's off), the wheels, overall health. */
  damageReport(): DamageReport {
    const s = this.stats;
    const left = (part: CarPart): number | null => {
      const hp = this.partHp.get(part);
      return hp === undefined ? null : Math.max(0, Math.min(1, hp / s.partHp[part.kind]));
    };
    const report: DamageReport = {
      chassis: Math.max(0, this.health / s.maxHealth),
      bumperFront: null,
      engine: this.wrecked ? 0 : Math.max(0, this.health / s.maxHealth),
      doorLeft: null,
      doorRight: null,
      bumperRear: null,
      wheels: [null, null, null, null],
      wrecked: this.wrecked,
    };
    for (const part of this.model.parts) {
      if (part.wheelIndex >= 0) report.wheels[part.wheelIndex] = left(part);
      else if (part.kind === 'bumperFront' || part.kind === 'bumperRear' || part.kind === 'doorLeft' || part.kind === 'doorRight') report[part.kind] = left(part);
    }
    return report;
  }

  /** Fraction of the steering left: each lost front wheel takes half (no front wheels, no turning, handbrake turns included). */
  get steerable(): number {
    return ((this.wheelLost[0] ? 0 : 1) + (this.wheelLost[1] ? 0 : 1)) / 2;
  }

  /** Runs before each physics step. */
  fixedUpdate(dt: number): void {
    const s = this.stats;
    const steerable = this.steerable;
    let inp: DriveInput = this.wrecked ? NEUTRAL_INPUT : this.input;
    if (steerable < 1 && inp.steer !== 0) inp = Object.assign(this.limpInput, inp, { steer: inp.steer * steerable });
    const vf = this.forwardSpeed;

    // Steering lock shrinks with speed (hyperbolically, like real cars), so gentle steering stays
    // within grip at any speed while full lock asks for more than the tyres have: drifts come from
    // cornering speed. Positive steer = right = negative wheel angle about +Y.
    const lock = Math.max(s.highSpeedSteer, s.maxSteer / (1 + Math.abs(vf) / s.steerFadeSpeed));
    const maxSteer = vf < 0 ? lock * s.reverseSteer : lock;
    const target = -inp.steer * maxSteer;
    const step = s.steerRate * dt;
    this.steerAngle += Math.max(-step, Math.min(step, target - this.steerAngle));

    // Grip drops instantly on the handbrake and recovers gradually after release, so a flick
    // turns into a held drift.
    if (inp.handbrake) this.gripScale = s.handbrakeGrip;
    else this.gripScale = Math.min(1, this.gripScale + s.gripRecovery * dt);
    this.knockTimer = Math.max(0, this.knockTimer - dt);
    this.sinceRepair += dt;
    if (this.sinceRepair > REPAIR_GAP) this.refitClock = 0;

    const c = this.controller;
    for (let i = 0; i < 2; i++) if (!this.wheelLost[i]) c.setWheelSteering(i, this.steerAngle);
    c.updateVehicle(dt); // suspension + ground contact only

    this.updateBoost(dt, inp);
    const ground = this.groundedWheels / 4;
    this.applySandDrag(dt);
    if (ground > 0) {
      this.up(_up);
      this.applyDrive(dt, inp, vf, ground);
      this.applyGrip(dt, inp, vf, ground);
    }
    this.applyAssists(dt, inp);
    const v = this.body.linvel();
    this.prevVel.set(v.x, v.y, v.z);
    const w = this.body.angvel();
    this.prevAngvel.set(w.x, w.y, w.z);
    this.contacts.clear();
  }

  /**
   * Engine, brakes and rolling resistance as forces on the chassis. Thrust goes along the nose and
   * never uses up tyre grip, so throttle can't break traction. Mid-drift the nose points into the
   * turn, so throttle powers the car through the drift.
   */
  /** Boost drains the bar while held with throttle; otherwise it recharges. Running dry locks it until boostRestart. */
  private updateBoost(dt: number, inp: DriveInput): void {
    const s = this.stats;
    if (this.boostEmpty && this.boostCharge >= s.boostRestart) this.boostEmpty = false;
    this.boosting = inp.boost && inp.throttle > 0 && !this.boostEmpty && !this.wrecked;
    this.boostCharge += this.boosting ? -dt / s.boostDuration : dt / s.boostRecharge;
    this.boostCharge = Math.min(1, Math.max(0, this.boostCharge));
    if (this.boostCharge === 0) {
      this.boostEmpty = true;
      this.boosting = false;
    }
  }

  private applyDrive(dt: number, inp: DriveInput, vf: number, ground: number): void {
    const s = this.stats;
    const b = this.body;
    const m = b.mass();
    const top = s.topSpeed * (this.boosting ? s.boostTopSpeed : 1) * this.powerScale;
    const engine = s.engineForce * (this.boosting ? s.boostForce : 1) * this.powerScale;
    const speedFrac = Math.min(1, Math.abs(vf) / top);
    const healthFactor = 0.45 + 0.55 * Math.max(0, this.health / s.maxHealth);

    let thrust = 0; // N along the nose
    let brake = inp.brake; // 0..1 of brakeDecel, opposing motion
    if (inp.throttle > 0) {
      // Throttle while rolling backwards brakes, but not mid handbrake spin: past 90° the car is "rolling
      // backwards" too, and braking there stopped every held spin dead.
      if (vf < -1) brake = inp.handbrake || this.spinning ? brake : Math.max(brake, inp.throttle);
      else thrust = inp.throttle * engine * Math.max(0, 1 - speedFrac * speedFrac) * healthFactor;
    } else if (inp.throttle < 0) {
      if (vf > 1) brake = Math.max(brake, -inp.throttle);
      else if (vf > -s.topSpeed * 0.35) thrust = inp.throttle * s.reverseForce * healthFactor;
    }

    // Locked rear wheels don't drive: the throttle can't power the car round in endless donuts.
    if (inp.handbrake) thrust *= s.handbrakeThrust;
    const f = this.forwardOnPlane(_fwd);
    if (thrust !== 0) {
      const j = thrust * ground * dt;
      b.applyImpulse({ x: f.x * j, y: f.y * j, z: f.z * j }, true);
    }

    let decel = brake * s.brakeDecel + (inp.throttle === 0 ? s.rollingDecel : 0) + (inp.handbrake ? s.handbrakeDecel : 0);
    decel *= ground;
    if (decel > 0) {
      const v = b.linvel();
      const vp = _w.set(v.x, v.y, v.z).addScaledVector(_up, -(v.x * _up.x + v.y * _up.y + v.z * _up.z));
      const sp = vp.length();
      if (sp > 1e-3) {
        const dv = Math.min(sp, decel * dt);
        b.applyImpulse({ x: (-vp.x / sp) * dv * m, y: (-vp.y / sp) * dv * m, z: (-vp.z / sp) * dv * m }, true);
      }
    }
  }

  /**
   * Arcade tyre grip. Instead of cancelling sideways speed (which scrubs speed), grip ROTATES the
   * velocity toward the nose at a limited rate (gripAccel / speed), keeping its magnitude. So the
   * faster you go, the slower your path can bend while the body follows the steering, and the car
   * drifts wide because of its speed. Body yaw follows the steering geometry, capped so the slide
   * angle can't exceed driftMaxSlip: a held drift, not a spin. Countersteering lowers the yaw target
   * below the path's turn rate, so the nose comes back.
   */
  private applyGrip(dt: number, inp: DriveInput, vf: number, ground: number): void {
    const s = this.stats;
    const b = this.body;
    const m = b.mass();
    const up = _up;

    const v = b.linvel();
    const vn = v.x * up.x + v.y * up.y + v.z * up.z;
    const vp = _w.set(v.x - up.x * vn, v.y - up.y * vn, v.z - up.z * vn); // velocity in the ground plane
    const sp = vp.length();
    const nose = this.forwardOnPlane(_fwd);
    const reversing = vf < 0;
    const aim = reversing ? _v.copy(nose).negate() : _v.copy(nose);

    const knock = this.knock;
    const paved = this.surfacePaved;
    const aGrip = s.gripAccel * ground * this.gripScale * (1 - knock * (1 - s.knockGrip)) * (1 - s.sandSlip * this.surfaceSoftness) * (1 + (s.asphaltGrip - 1) * paved);
    let pathRate = 0; // how fast the velocity direction is turning this step (rad/s, + = left)
    let slip = 0; // signed angle from velocity to aim (+ = nose is left of travel)

    if (sp < 0.5) {
      // Nearly stopped: just hold against sideways creep (e.g. on a slope).
      this.right(_right);
      const lat = vp.dot(_right);
      const dv = Math.max(-aGrip * dt, Math.min(aGrip * dt, -lat));
      b.applyImpulse({ x: _right.x * dv * m, y: _right.y * dv * m, z: _right.z * dv * m }, true);
    } else {
      slip = signedAngle(vp, aim, up);
      const maxTurn = (aGrip * dt) / sp;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, slip));
      pathRate = turn / dt;
      // Rotate the planar velocity about `up` by `turn`, keeping its length, then apply drift drag.
      const rotated = _r.copy(vp).applyAxisAngle(up, turn);
      rotated.multiplyScalar(Math.max(0, 1 - s.driftDrag * Math.abs(Math.sin(slip)) * dt));
      // Sliding sideways with the rear locked (or mid-spin) scrubs speed hard.
      if (inp.handbrake || this.spinning) {
        const side = Math.abs(Math.sin(signedAngle(vp, nose, up)));
        const len = rotated.length();
        if (len > 1e-3) rotated.multiplyScalar(Math.max(0, len - s.spinScrub * ground * side * dt) / len);
      }
      b.applyImpulse({ x: (rotated.x - vp.x) * m, y: (rotated.y - vp.y) * m, z: (rotated.z - vp.z) * m }, true);
    }

    // Yaw: follow the steering geometry (bicycle model), bounded by the slide-angle and spin caps.
    const wheelbase = 2 * this.dims.wheelZ;
    let target = (vf * Math.tan(this.steerAngle)) / wheelbase;
    // Handbrake turns swing at a fixed rate from the steering input, independent of the (speed-reduced)
    // steering lock, so they whip round at any speed. The swing is scaled by the speed over the ground
    // (not along the nose, which falls to zero as the car turns sideways and used to stall it at 90°),
    // and its direction is latched when the handbrake goes on (forward speed changes sign past 90°).
    const travelSlip = sp < 0.5 ? 0 : Math.abs(signedAngle(vp, nose, up)); // 0 = going where it points, π = going backwards
    // Past sideways the swing eases off, so the second half of the 180 takes longer than the first.
    const late = Math.max(0, Math.min(1, (travelSlip - s.spinLateFrom) / 0.44));
    const spinRate = s.handbrakeYawRate * Math.min(1, sp / 6) * (1 - late * (1 - s.spinLateRate));
    if (inp.handbrake && !this.wasHandbraking) {
      this.spinDir = 0;
      this.spinTurned = 0;
    }
    const w0 = b.angvel();
    if (this.spinDir !== 0) this.spinTurned += (w0.x * up.x + w0.y * up.y + w0.z * up.z) * this.spinDir * dt;
    // About a half turn per press: past spinMaxTurn the handbrake stops forcing rotation and the car just slides.
    const spinRoom = this.spinTurned < s.spinMaxTurn;
    if (inp.handbrake && inp.steer !== 0) {
      if (this.spinDir === 0) this.spinDir = -Math.sign(inp.steer) * Math.sign(vf || 1);
      target = spinRoom ? this.spinDir * spinRate : 0;
    }
    // Let go after swinging past spinCommit: the momentum carries the car on round to spinEnd
    // (a 180), unless the driver countersteers. A shorter flick settles into a normal drift.
    if (this.wasHandbraking && !inp.handbrake && this.spinDir !== 0 && travelSlip >= s.spinCommit) this.spinning = true;
    if (this.spinning) {
      // Steering right (+) spins right (−yaw), so steer with the same sign as the spin is steering against it.
      const counter = Math.abs(inp.steer) > 0.3 && Math.sign(inp.steer) === this.spinDir;
      if (inp.handbrake || counter || travelSlip >= s.spinEnd || !spinRoom || sp < 2) this.spinning = false;
      else target = this.spinDir * spinRate;
    }
    this.wasHandbraking = inp.handbrake;
    // Self-aligning: with the wheel centred, the nose only swings toward the direction of travel
    // (+slip = nose left of travel, so rotate right) while grip swings the travel toward the nose,
    // so they meet and the car runs straight. (Following pathRate here made them chase each other.)
    if (!inp.handbrake && Math.abs(inp.steer) < 0.1) target = -slip * s.selfAlign;
    const maxSlip = inp.handbrake || this.spinning || knock > 0 ? Math.PI : s.driftMaxSlip * (1 + (s.asphaltSlip - 1) * paved);
    if (slip > maxSlip && target > pathRate) target = pathRate;
    if (slip < -maxSlip && target < pathRate) target = pathRate;
    target = Math.max(-s.maxYawRate, Math.min(s.maxYawRate, target));

    const w = b.angvel();
    const wy = w.x * up.x + w.y * up.y + w.z * up.z;
    // A knocked car's yaw is left to the crash: control returns as the knock wears off.
    const maxChange = s.yawResponse * ground * (1 - knock) * dt;
    const dw = Math.max(-maxChange, Math.min(maxChange, target - wy));
    if (dw !== 0) b.setAngvel({ x: w.x + up.x * dw, y: w.y + up.y * dw, z: w.z + up.z * dw }, true);
  }

  /** Soft sand bogs the car down: a horizontal drag proportional to speed and softness under the wheels. Also samples the asphalt. */
  private applySandDrag(dt: number): void {
    this.surfaceSoftness = 0;
    this.surfacePaved = 0;
    if (!this.surface && !this.paving) return;
    const c = this.controller;
    let soft = 0;
    let paved = 0;
    let grounded = 0;
    for (let i = 0; i < 4; i++) {
      if (this.wheelLost[i] || !c.wheelIsInContact(i)) continue;
      const ground = c.wheelGroundObject(i);
      const p = c.wheelContactPoint(i);
      if (!ground || !p) continue;
      grounded++;
      if (this.surface) soft += this.surface(ground, p.x, p.z);
      if (this.paving) paved += this.paving(ground, p.x, p.z);
    }
    this.surfaceSoftness = soft / 4;
    // Grip already scales with the grounded wheels, so this is the share of those on asphalt.
    this.surfacePaved = grounded > 0 ? paved / grounded : 0;
    const k = this.stats.sandDrag * this.surfaceSoftness * this.stats.mass * dt;
    if (k <= 0) return;
    const v = this.body.linvel();
    this.body.applyImpulse({ x: -v.x * k, y: 0, z: -v.z * k }, true);
  }

  private applyAssists(dt: number, inp: DriveInput): void {
    const s = this.stats;
    const b = this.body;
    this.up(_up);
    const grounded = this.groundedWheels;

    if (grounded > 0) {
      // Downforce keeps the car planted over dune crests.
      const v = b.linvel();
      const f = s.downforce * (v.x * v.x + v.y * v.y + v.z * v.z) * dt * (grounded / 4);
      b.applyImpulse({ x: -_up.x * f, y: -_up.y * f, z: -_up.z * f }, true);
    } else {
      // Air control: throttle pitches, steer yaws and rolls.
      this.right(_right);
      this.forward(_fwd);
      const a = s.airControl * dt;
      const pitch = inp.throttle * a;
      const yaw = -inp.steer * a * 0.8;
      const roll = inp.steer * a * 0.5;
      b.applyTorqueImpulse({
        x: _right.x * -pitch + _up.x * yaw + _fwd.x * roll,
        y: _right.y * -pitch + _up.y * yaw + _fwd.y * roll,
        z: _right.z * -pitch + _up.z * yaw + _fwd.z * roll,
      }, true);
    }

    // Auto-right after being stuck on the side/roof for a while, or lying steeply tilted on fewer
    // than three wheels (on its side against a dune) where it can't drive off.
    if ((_up.y < 0.25 || (_up.y < 0.7 && grounded < 3)) && this.speed < 3) {
      this.upsideDownTime += dt;
      if (this.upsideDownTime > 1.6) this.flipUpright();
    } else {
      this.upsideDownTime = 0;
    }
  }

  /** The car's nose direction projected onto its ground plane (perpendicular to its up), normalised. */
  private forwardOnPlane(out: THREE.Vector3): THREE.Vector3 {
    this.forward(out);
    this.up(_up2);
    out.addScaledVector(_up2, -out.dot(_up2));
    return out.normalize();
  }

  /** Called by the game's contact dispatcher during the physics step. */
  recordContact(other: RAPIER.Collider): void {
    this.contacts.add(other);
  }

  /** Runs after each physics step: interpolation bookkeeping + impact damage. */
  postStep(): void {
    this.capture();
    if (this.contacts.size === 0) return;
    if (this.glance()) {
      this.scrape();
      return;
    }

    const v = this.body.linvel();
    const g = this.physics.world.gravity;
    const dt = this.physics.dt;
    const dv = _v.set(v.x - this.prevVel.x - g.x * dt, v.y - this.prevVel.y - g.y * dt, v.z - this.prevVel.z - g.z * dt);
    // dv in chassis space: the car was shoved along +dv, so the hit came from the -dv side.
    const invRot = _q.copy(this.currRot).invert();
    const dvLocal = dv.clone().applyQuaternion(invRot);
    // Shoved up through the floor = a hard landing or bottoming out: mostly absorbed, not a crash.
    if (dvLocal.y > 0) dvLocal.y *= this.stats.bottomOutDamage;
    const impact = dvLocal.length();
    if (impact >= CAR_CONTACT_MIN && this.events.onCarContact) {
      for (const other of this.contacts) {
        const owner = this.physics.ownerOf(other);
        if (owner instanceof Car && owner !== this) this.events.onCarContact(this, owner, impact);
      }
    }
    const scale = this.hitScale();
    const s = this.stats;
    this.scrape();
    const k = knockAmount(Math.hypot(dvLocal.x, dvLocal.z) * scale, s.knockThreshold, s.knockFull);
    this.knockTimer = Math.max(this.knockTimer, k * s.knockTime);
    this.spinFromHit(dvLocal, scale);
    const strength = (impact * scale - s.dentThreshold) / s.toughness;
    if (strength <= 0) return;
    dvLocal.normalize();

    let applied = 0;
    for (const other of this.contacts) {
      this.physics.world.contactPair(this.collider, other, (manifold, flipped) => {
        const n = manifold.numContacts();
        if (n === 0) return;
        const ln = flipped ? manifold.localNormal2() : manifold.localNormal1();
        // Average the manifold's contact points (chassis-local).
        const p = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          const cp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
          if (cp) p.add(_v.set(cp.x, cp.y, cp.z));
        }
        p.divideScalar(n);
        this.hit(p, new THREE.Vector3(-ln.x, -ln.y, -ln.z), strength / this.contacts.size);
        applied++;
      });
    }
    if (applied === 0) {
      // No manifold (already separated): infer the point from the velocity change.
      const d = this.dims;
      const p = dvLocal.clone().multiplyScalar(-1);
      const k = 1 / Math.max(Math.abs(p.x) / d.halfWidth, Math.abs(p.y) / d.halfHeight, Math.abs(p.z) / d.halfLength, 1e-6);
      p.multiplyScalar(k);
      this.hit(p, dvLocal, strength);
    }
  }

  /**
   * A glancing touch on a smooth wall (`walls`), moving into it at less than scrapeAngle: slide along it.
   * The solver's own answer can't be trusted there: pressed into a wall made of several colliders, the chassis
   * sinks a little, and near a joint the next collider pushes it out backwards through its end, stopping it dead.
   * So the step's result is replaced: the velocity along the wall's smooth outline (less scrapeDrag), nothing into
   * it, the yaw rate from before the step plus a swing of the nose toward parallel. No jolt, so no crash; the
   * scrape effects still apply. Anything else touching us (a car, debris) leaves it to the solver.
   */
  private glance(): boolean {
    if (!this.walls) return false;
    const t = this.body.translation();
    let n: { x: number; z: number } | null = null;
    for (const other of this.contacts) {
      if (this.physics.ownerOf(other) instanceof Car || !other.parent()?.isFixed()) return false;
      n ??= this.walls(other, t.x, t.z);
    }
    if (!n) return false;
    const s = this.stats;
    const v = this.prevVel;
    const sp = Math.hypot(v.x, v.z);
    const into = -(v.x * n.x + v.z * n.z);
    if (sp < s.scrapeSpeed || into > sp * Math.sin(s.scrapeAngle)) return false;
    const keep = 1 - s.scrapeDrag * this.physics.dt;
    const off = Math.max(0, into);
    const now = this.body.linvel();
    this.body.setLinvel({ x: (v.x + n.x * off) * keep, y: now.y, z: (v.z + n.z * off) * keep }, true);
    const f = this.forwardOnPlane(_fwd);
    const nose = f.x * n.x + f.z * n.z; // < 0: pointing into the wall
    const w = this.prevAngvel;
    // Turning left (+yaw) swings the nose toward its left side, (fz, -fx).
    const left = f.z * n.x - f.x * n.z;
    const swing = nose < 0 && f.dot(_w.set(v.x, 0, v.z)) > 0 ? Math.sign(left) * s.scrapeAlign * -nose : 0;
    this.body.setAngvel({ x: w.x, y: w.y + swing, z: w.z }, true);
    return true;
  }

  /**
   * Rubbing along a wall (a static collider touching the side or an end of the chassis, not its floor)
   * while moving: sparks every step, a little wear, and a light scratch dent every scrapeEvery metres.
   * Hits are still judged by the jolt in postStep; a glancing slide along a smooth wall has almost none.
   */
  private scrape(): void {
    const s = this.stats;
    const speed = this.speed;
    if (speed < s.scrapeSpeed) return;
    for (const other of this.contacts) {
      if (!other.parent()?.isFixed()) continue;
      let point: THREE.Vector3 | null = null;
      let normal: THREE.Vector3 | null = null;
      this.physics.world.contactPair(this.collider, other, (manifold, flipped) => {
        const n = manifold.numContacts();
        const ln = flipped ? manifold.localNormal2() : manifold.localNormal1();
        // Only a wall beside us: not our floor (landings, lying on the roof), and not the ground (a car sliding on its side).
        if (n === 0 || Math.abs(ln.y) > 0.5 || Math.abs(_w.set(ln.x, ln.y, ln.z).applyQuaternion(this.currRot).y) > 0.5) return;
        point = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          const cp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
          if (cp) point.add(_w.set(cp.x, cp.y, cp.z));
        }
        point.divideScalar(n);
        normal = new THREE.Vector3(ln.x, ln.y, ln.z);
      });
      if (!point || !normal) continue;
      const p: THREE.Vector3 = point;
      const ln: THREE.Vector3 = normal;
      const dt = this.physics.dt;
      this.health = Math.max(0, this.health - s.scrapeWear * dt * this.healthLoss);
      this.scrapeDist += speed * dt;
      if (this.scrapeDist >= s.scrapeEvery) {
        this.scrapeDist = 0;
        this.dent(p, ln.clone().negate(), s.scrapeDent); // cosmetic: the wear above is the cost
      }
      if (this.events.onScrape) {
        const wp = p.clone().applyQuaternion(this.currRot).add(this.currPos);
        this.events.onScrape(this, wp, ln.applyQuaternion(this.currRot), speed);
      }
      if (this.health <= 0 && !this.wrecked) {
        this.wrecked = true;
        this.events.onWrecked?.(this);
      }
      return;
    }
  }

  /**
   * Arcade spin-out: a car hit away from our centre (a shove on the tail) adds a yaw kick by the
   * leverage of the jolt `dvLocal` (chassis space) at the contact point, scaled like the damage, and
   * knocks us so the grip model doesn't straighten it out at once.
   */
  private spinFromHit(dvLocal: THREE.Vector3, scale: number): void {
    const s = this.stats;
    for (const other of this.contacts) {
      if (!(this.physics.ownerOf(other) instanceof Car)) continue;
      const p = this.contactPoint(other);
      if (!p) continue;
      const lever = (p.z * dvLocal.x - p.x * dvLocal.z) / (this.dims.halfLength * this.dims.halfLength);
      const kick = Math.max(-s.hitSpinMax, Math.min(s.hitSpinMax, s.hitSpin * scale * lever));
      if (Math.abs(kick) < 0.3) return;
      this.up(_up);
      const w = this.body.angvel();
      this.body.setAngvel({ x: w.x + _up.x * kick, y: w.y + _up.y * kick, z: w.z + _up.z * kick }, true);
      this.knockTimer = Math.max(this.knockTimer, (Math.abs(kick) / s.hitSpinMax) * s.knockTime);
      return;
    }
  }

  /** Average chassis-local contact point with `other` this step, or null if they are apart. */
  private contactPoint(other: RAPIER.Collider): THREE.Vector3 | null {
    let p: THREE.Vector3 | null = null;
    this.physics.world.contactPair(this.collider, other, (manifold, flipped) => {
      const n = manifold.numContacts();
      if (n === 0) return;
      p = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const cp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
        if (cp) p.add(_w.set(cp.x, cp.y, cp.z));
      }
      p.divideScalar(n);
    });
    return p;
  }

  /**
   * How much this step's jolt counts, by what we hit. Static world: worldDamage. Another car:
   * carDamage, shifted toward whichever car was driving into the other more slowly (ramFactor);
   * mass is already in the jolt. Anything else (stakes, debris): 1. A car contact wins over the rest.
   */
  private hitScale(): number {
    const s = this.stats;
    let car = 0;
    let world = true;
    const me = this.body.translation();
    for (const other of this.contacts) {
      const owner = this.physics.ownerOf(other);
      if (owner instanceof Car && owner !== this) {
        const t = owner.body.translation();
        const dx = t.x - me.x;
        const dz = t.z - me.z;
        const d = Math.hypot(dx, dz) || 1;
        // Closing speeds just before the step (prevVel is the velocity the step started from).
        const myPush = (this.prevVel.x * dx + this.prevVel.z * dz) / d;
        const theirPush = -(owner.prevVel.x * dx + owner.prevVel.z * dz) / d;
        car = Math.max(car, s.carDamage * ramFactor(myPush, theirPush, s.ramAdvantage));
      } else if (!other.parent()?.isFixed()) {
        world = false;
      }
    }
    if (car > 0) return car;
    return world ? s.worldDamage : 1;
  }

  /**
   * Applies one impact in chassis-local space. `dir` is the direction metal is pushed (into the car).
   * Public so debug tools and tests can dent cars directly.
   */
  hit(pointLocal: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    const s = this.stats;
    this.dent(pointLocal, dir, strength, true);
    this.health = Math.max(0, this.health - strength * s.damageScale * this.healthLoss);

    if (this.events.onImpact) {
      const wp = pointLocal.clone().applyQuaternion(this.currRot).add(this.currPos);
      const wn = dir.clone().negate().applyQuaternion(this.currRot);
      this.events.onImpact(this, wp, wn, strength);
    }
    if (this.health <= 0 && !this.wrecked) {
      this.wrecked = true;
      this.events.onWrecked?.(this);
    }
  }

  /** Dents the bodywork at a chassis-local point and, for a hit (`hit`), costs nearby parts and wheels HP. No health loss. */
  private dent(pointLocal: THREE.Vector3, dir: THREE.Vector3, strength: number, hit = false): void {
    const s = this.stats;
    const depth = Math.min(s.maxDent * 1.2, s.dentDepthScale * strength);
    const radius = s.dentRadius * Math.min(1.8, 0.8 + 0.08 * strength);
    const params = { radius, depth, maxDent: s.maxDent, noise: 0.45 };
    const local = new THREE.Vector3();
    const detach: CarPart[] = [];

    for (const part of this.model.parts) {
      const he = part.halfExtents;
      if (part.wheelIndex >= 0) {
        // Wheels don't dent, but take HP damage when hit nearby.
        if (!hit || this.wheelLost[part.wheelIndex]) continue;
        const pivot = this.model.wheelPivots[part.wheelIndex];
        const d = pivot.position.distanceTo(pointLocal);
        const near = 1 - d / (radius + he.y + PART_REACH);
        if (near > 0) this.damagePart(part, strength * s.wheelDamage * near, detach);
        continue;
      }
      if (!part.mesh.parent) continue; // already detached
      local.copy(pointLocal).sub(part.mesh.position);
      const reach = radius + PART_REACH;
      if (Math.abs(local.x) > he.x + reach || Math.abs(local.y) > he.y + reach || Math.abs(local.z) > he.z + reach) continue;

      const geom = part.mesh.geometry;
      const pos = geom.getAttribute('position') as THREE.BufferAttribute;
      const moved = applyDent(pos.array as Float32Array, this.originals.get(part)!, local, dir, params);
      if (moved > 0) {
        pos.needsUpdate = true;
        geom.computeBoundingSphere();
        this.dented.add(part);
        if (hit) this.damagePart(part, moved * 1.5 + strength * 2, detach);
      }
    }

    for (const part of detach) this.detach(part);
  }

  private damagePart(part: CarPart, amount: number, detach: CarPart[]): void {
    const hp = this.partHp.get(part);
    if (hp === undefined) return;
    const left = hp - amount;
    if (left <= 0) {
      this.partHp.delete(part);
      detach.push(part);
    } else {
      this.partHp.set(part, left);
    }
  }

  /**
   * One step of repair at a station (call every frame or step while inside it; a gap longer than
   * REPAIR_GAP restarts the wait for the next refit). Health, part HP
   * and every dent ease back to new along the repair curve: most of it in the first ~10 s, all of it
   * by stats.repairTime. Lost parts are refitted one per stats.repairRefit s, wheels first.
   */
  repair(dt: number): void {
    const s = this.stats;
    const step = (remaining: number) => repairStep(remaining, dt, s.repairTau, s.repairTime);
    this.health = s.maxHealth * (1 - step(1 - this.health / s.maxHealth));
    if (this.wrecked && this.health >= s.maxHealth * UNWRECK_HEALTH) this.wrecked = false;
    for (const [part, hp] of this.partHp) {
      const full = s.partHp[part.kind];
      this.partHp.set(part, full * (1 - step(1 - hp / full)));
    }
    for (const part of this.dented) if (!this.undent(part, step)) this.dented.delete(part);
    this.sinceRepair = 0;
    if (this.lostParts.length === 0) return;
    this.refitClock += dt;
    if (this.refitClock >= s.repairRefit) {
      this.refitClock = 0;
      this.refit();
    }
  }

  /** Eases a part's vertices back toward their originals. Returns false once it is fully restored. */
  private undent(part: CarPart, step: (remaining: number) => number): boolean {
    const geom = part.mesh.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const o = this.originals.get(part)!;
    const max = this.stats.maxDent;
    let left = false;
    for (let i = 0; i < a.length; i += 3) {
      const dx = a[i]! - o[i]!;
      const dy = a[i + 1]! - o[i + 1]!;
      const dz = a[i + 2]! - o[i + 2]!;
      const d = Math.hypot(dx, dy, dz);
      if (d === 0) continue;
      // Each vertex follows the curve by its own depth, so seam duplicates (same offset) stay together.
      const k = (step(Math.min(1, d / max)) * max) / d;
      if (k > 0) left = true;
      a[i] = o[i]! + dx * k;
      a[i + 1] = o[i + 1]! + dy * k;
      a[i + 2] = o[i + 2]! + dz * k;
    }
    pos.needsUpdate = true;
    geom.computeBoundingSphere();
    return left;
  }

  /** Fits a fresh copy of a lost part, wheels first. */
  private refit(): void {
    const w = this.lostParts.findIndex((p) => p.wheelIndex >= 0);
    const [part] = this.lostParts.splice(w >= 0 ? w : 0, 1);
    if (!part) return;
    const spare = this.spares.get(part)!;
    const mesh = spare.mesh.clone();
    mesh.geometry = spare.mesh.geometry.clone();
    spare.parent.add(mesh);
    part.mesh = mesh;
    this.partHp.set(part, this.stats.partHp[part.kind]);
    this.partsLost--;
    if (part.wheelIndex >= 0) {
      this.wheelLost[part.wheelIndex] = false;
      this.controller.setWheelRadius(part.wheelIndex, this.dims.wheelRadius);
      this.applyWheelStats();
      if (!this.wheelLost.includes(true)) {
        this.collider.setFriction(CHASSIS_FRICTION);
        this.collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
      }
    }
  }

  private detach(part: CarPart): void {
    this.partsLost++;
    this.lostParts.push(part);
    this.dented.delete(part);
    if (part.wheelIndex >= 0) {
      const i = part.wheelIndex;
      this.wheelLost[i] = true;
      // Rapier can't remove wheels: make this one useless instead, so the corner drags.
      const c = this.controller;
      c.setWheelRadius(i, 0.01);
      c.setWheelSuspensionRestLength(i, 0.01);
      c.setWheelFrictionSlip(i, 0);
      c.setWheelEngineForce(i, 0);
      c.setWheelSteering(i, 0);
      // The bare corner scrapes along (Min, so the mud's grip doesn't win): a car on three wheels limps on.
      this.collider.setFriction(this.stats.rimFriction);
      this.collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    }
    if (!this.events.onPartDetached) {
      part.mesh.removeFromParent();
      return;
    }
    // Velocity of the part = chassis velocity at its location, plus a kick outward.
    const wp = part.mesh.getWorldPosition(new THREE.Vector3());
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const r = wp.clone().sub(this.currPos);
    const tangential = new THREE.Vector3(av.x, av.y, av.z).cross(r);
    const kick = r.clone().setY(0).normalize().multiplyScalar(2 + Math.random() * 2);
    this.events.onPartDetached(
      this,
      part,
      { x: lv.x + tangential.x + kick.x, y: lv.y + tangential.y + 2 + Math.random() * 2, z: lv.z + tangential.z + kick.z },
      { x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8 },
    );
  }

  /** Sets visuals from interpolated physics state (alpha in [0,1] between the last two steps). */
  render(alpha: number): void {
    const root = this.model.root;
    root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    root.quaternion.slerpQuaternions(this.prevRot, this.currRot, alpha);

    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      if (this.wheelLost[i]) continue;
      const pivot = this.model.wheelPivots[i];
      const len = c.wheelSuspensionLength(i) ?? this.stats.suspensionRestLength;
      pivot.position.y = this.dims.wheelY - len;
      pivot.rotation.y = c.wheelSteering(i) ?? 0;
      const wheel = pivot.children[0];
      if (wheel) wheel.rotation.x = c.wheelRotation(i) ?? 0;
    }
  }

  /** World-space contact points of grounded wheels, with a 0..1 slip estimate (for dust). */
  forEachGroundedWheel(cb: (point: THREE.Vector3, slip: number, index: number) => void): void {
    const c = this.controller;
    const p = new THREE.Vector3();
    // Slip from the car's actual sideways speed (tyre impulses drop when grip is cut, so they'd
    // undercount drifts). Locked rear wheels under the handbrake count as slipping too.
    const v = this.body.linvel();
    this.right(_right);
    const lateral = Math.abs(v.x * _right.x + v.y * _right.y + v.z * _right.z);
    const baseSlip = Math.min(1, lateral / 7);
    for (let i = 0; i < 4; i++) {
      if (this.wheelLost[i] || !c.wheelIsInContact(i)) continue;
      const cp = c.wheelContactPoint(i);
      if (!cp) continue;
      p.set(cp.x, cp.y, cp.z);
      const locked = i >= 2 && this.input.handbrake ? 0.5 : 0;
      cb(p, Math.min(1, baseSlip + locked), i);
    }
  }

  /** Puts the car back on its wheels a little above where it is, keeping damage. */
  flipUpright(): void {
    const t = this.body.translation();
    this.forward(_fwd);
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    this.teleport({ position: { x: t.x, y: t.y + 2, z: t.z }, yaw });
  }

  teleport(pose: SpawnPose): void {
    const b = this.body;
    b.setTranslation(pose.position, true);
    b.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw), true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.upsideDownTime = 0;
    this.knockTimer = 0;
    this.capture();
    this.prevPos.copy(this.currPos);
    this.prevRot.copy(this.currRot);
  }

  applyImpulse(impulse: Vec3Like): void {
    this.body.applyImpulse(impulse, true);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(0, 0, 1).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }

  up(out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }

  /** Car's right (−X local). */
  right(out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(-1, 0, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }

  /** Removes the body, controller and visuals. Detached debris is owned by Debris and left alone. */
  dispose(): void {
    this.physics.world.removeVehicleController(this.controller);
    this.physics.removeBody(this.body);
    this.model.root.removeFromParent();
    for (const part of this.model.parts) if (part.mesh.parent) part.mesh.geometry.dispose();
    for (const spare of this.spares.values()) spare.mesh.geometry.dispose();
  }

  private capture(): void {
    this.prevPos.copy(this.currPos);
    this.prevRot.copy(this.currRot);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currRot.set(r.x, r.y, r.z, r.w);
  }
}
