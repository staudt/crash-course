import * as THREE from 'three';
import { CAMERA_CONFIG, CAMERA_MODES, CameraRig, type CameraMode } from '../core/CameraRig';
import { Input } from '../core/Input';
import { Physics } from '../core/Physics';
import { BoostFlame } from '../fx/BoostFlame';
import { Debris } from '../fx/Debris';
import { Particles } from '../fx/Particles';
import { TrackMarkings } from '../race/TrackMarkings';
import { TrackPath } from '../race/TrackPath';
import { TrackProps } from '../race/TrackProps';
import { DUNE_LOOP } from '../race/tracks';
import { Hud } from '../ui/Hud';
import { RaceHud } from '../ui/RaceHud';
import { Car, type CarEvents, type SpawnPose, type SurfaceFn } from '../vehicle/Car';
import { buildCarModel, type CarVariant } from '../vehicle/CarBuilder';
import { cloneStats, type CarStats } from '../vehicle/CarStats';
import { Environment } from '../world/Environment';
import { buildElevation, carveRoad } from '../world/Road';
import { Rocks } from '../world/Rocks';
import { Terrain } from '../world/Terrain';
import { generateTerrain } from '../world/TerrainData';
import { RaceDirector } from './RaceDirector';

export const GAME_CONFIG = {
  seed: 1337,
  /** World: 2048 m square at ~2.7 m per heightfield cell. */
  terrainN: 769,
  terrainSize: 2048,
  playerColor: '#2b2f36',
  parkedCount: 8,
  /** Parked cars sit this far off the road edge, spread around the lap. */
  parkedOffset: 7,
  parkedColors: ['#d8432f', '#2f9fd8', '#e8c547', '#f2ede1', '#3fae6a', '#7a4fc9', '#e07b2f', '#5a6f7d'],
  maxSubsteps: 5,
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

const CAMERA_KEY = 'desert.camera.v2';
const CAMERA_NAMES: Record<CameraMode, string> = { chase: 'CHASE CAMERA', cockpit: 'COCKPIT CAMERA', fixed: 'OVERHEAD CAMERA' };
function loadCameraMode(): CameraMode {
  try {
    const saved = localStorage.getItem(CAMERA_KEY);
    return CAMERA_MODES.find((m) => m === saved) ?? 'chase';
  } catch {
    return 'chase';
  }
}
function saveCameraMode(mode: CameraMode): void {
  try {
    localStorage.setItem(CAMERA_KEY, mode);
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly physics = new Physics();
  readonly rig: CameraRig;
  readonly input = new Input();
  readonly env: Environment;
  readonly terrain: Terrain;
  readonly particles: Particles;
  readonly debris: Debris;
  readonly hud: Hud;
  readonly raceHud: RaceHud;
  readonly track: TrackPath;
  readonly trackProps: TrackProps;
  readonly director: RaceDirector;
  /** Base stats for the player car. Edits apply to the next spawned car (and live via Tuning). */
  readonly playerStats: CarStats = cloneStats();

  player!: Car;
  readonly parked: Car[] = [];
  private readonly cars: Car[] = [];
  private readonly flames = new Map<Car, BoostFlame>();
  private readonly carEvents: CarEvents;
  /** Terrain sand is soft per the softness map; rocks, cars and debris are firm. */
  private readonly surface: SurfaceFn = (ground, x, z) => (ground === this.terrain.collider ? this.terrain.softnessAt(x, z) : 0);
  private accumulator = 0;
  private lastTime = performance.now();
  private readonly frameListeners: ((dt: number) => void)[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(container.clientWidth / container.clientHeight);
    this.rig.setMode(loadCameraMode());
    this.env = new Environment(this.scene, this.renderer);
    this.track = new TrackPath(DUNE_LOOP);
    const data = generateTerrain({ seed: GAME_CONFIG.seed, n: GAME_CONFIG.terrainN, size: GAME_CONFIG.terrainSize });
    buildElevation(this.track, data);
    carveRoad(data, this.track);
    this.terrain = new Terrain(this.scene, this.physics, data);
    this.rig.setGround((x, z) => this.terrain.heightAt(x, z));
    new Rocks(this.scene, this.physics, this.terrain, GAME_CONFIG.seed, (x, z) => this.track.project(x, z).distance, this.track.halfWidth);
    this.trackProps = new TrackProps(this.scene, this.physics, this.track);
    new TrackMarkings(this.scene, this.track);

    this.particles = new Particles(this.scene);
    this.particles.setGround((x, z) => this.terrain.heightAt(x, z));
    this.debris = new Debris(this.scene, this.physics);
    this.hud = new Hud(container);
    this.raceHud = new RaceHud(container);
    const d = CAMERA_CONFIG.direction;
    const view = Math.hypot(d.x, d.z);
    this.raceHud.setTrack(
      Array.from({ length: this.track.count }, (_, i) => ({ x: this.track.xs[i]!, z: this.track.zs[i]! })),
      this.track.checkpoints.map((s) => this.track.pointAt(s, { x: 0, z: 0 })),
      { x: -d.x / view, z: -d.z / view },
    );

    this.carEvents = {
      onPartDetached: (_car, part, linvel, angvel) => this.debris.spawn(part.mesh, part.halfExtents, linvel, angvel),
      onImpact: (_car, point, normal, strength) => this.particles.emitImpact(point, normal, Math.min(1, strength / 10)),
      onCarContact: (car, other, impact) => this.director?.onCarContact(car, other, impact),
      onWrecked: (car) => {
        if (car === this.player) this.hud.showMessage('WRECKED: press R', 3);
      },
    };

    this.physics.onContactForce(({ a, b }) => {
      const ca = this.physics.ownerOf(a);
      const cb = this.physics.ownerOf(b);
      if (ca instanceof Car) ca.recordContact(b);
      if (cb instanceof Car) cb.recordContact(a);
    });

    this.spawnPlayer();
    this.director = new RaceDirector(this);
    this.director.restart();
    this.respawnParked();

    window.addEventListener('resize', () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.renderer.setSize(w, h);
      this.rig.setAspect(w / h);
    });
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Jump the camera to the player (behind it, in the chase view), e.g. after a respawn. Reads the physics body, which may be ahead of the rendered model. */
  snapCamera(): void {
    const b = this.player.body;
    const t = b.translation();
    const r = b.rotation();
    this.rig.snap(_w.set(t.x, t.y, t.z), this.playerHeading(), _q.set(r.x, r.y, r.z, r.w));
  }

  private playerHeading(): number {
    const f = this.player.forward(_v);
    return Math.atan2(f.x, f.z);
  }

  /** Called every rendered frame (after physics, before render). For debug tools. */
  onFrame(fn: (dt: number) => void): void {
    this.frameListeners.push(fn);
  }

  spawnCar(color: string, variant: CarVariant, pose: SpawnPose, stats: CarStats = cloneStats()): Car {
    const ground = this.terrain.heightAt(pose.position.x, pose.position.z);
    const p = { position: { x: pose.position.x, y: ground + 1.3, z: pose.position.z }, yaw: pose.yaw };
    const car = new Car(this.physics, buildCarModel({ color, variant }), stats, p, this.carEvents);
    car.surface = this.surface;
    this.scene.add(car.model.root);
    this.cars.push(car);
    this.flames.set(car, new BoostFlame(car.model.root));
    return car;
  }

  removeCar(car: Car): void {
    this.flames.get(car)?.dispose();
    this.flames.delete(car);
    car.dispose();
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  /** Replaces the player car with a fresh one (keeps the stats object for live tuning). */
  spawnPlayer(pose?: SpawnPose): void {
    if (this.player) {
      const t = this.player.body.translation();
      const f = this.player.forward(_v);
      pose ??= { position: { x: t.x, y: t.y, z: t.z }, yaw: Math.atan2(f.x, f.z) };
      this.removeCar(this.player);
    }
    this.player = this.spawnCar(GAME_CONFIG.playerColor, 'sedan', pose ?? { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, this.playerStats);
  }

  respawnParked(): void {
    for (const car of this.parked) this.removeCar(car);
    this.parked.length = 0;
    const n = GAME_CONFIG.parkedCount;
    const q = { x: 0, z: 0 };
    const t = { x: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      // Spread around the lap, alternating sides, clear of the gates.
      const s = ((i + 0.5) / n) * this.track.length;
      const side = i % 2 ? 1 : -1;
      const off = side * (this.track.halfWidth + GAME_CONFIG.parkedOffset);
      this.track.pointAt(s, q);
      this.track.tangentAt(s, t);
      const pose = { position: { x: q.x + t.z * off, y: 0, z: q.z - t.x * off }, yaw: this.track.headingAt(s) + side * (0.4 + (i % 3) * 0.3) };
      const color = GAME_CONFIG.parkedColors[i % GAME_CONFIG.parkedColors.length];
      const car = this.spawnCar(color, i % 3 === 2 ? 'pickup' : 'sedan', pose);
      car.input.brake = 1; // parked: brakes on, so they don't roll down dunes
      this.parked.push(car);
    }
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.handleActions();
    this.input.read(this.player.input);
    this.director.beforePhysics(dt);

    // Fixed-timestep physics.
    const step = this.physics.dt;
    this.accumulator = Math.min(this.accumulator + dt, step * GAME_CONFIG.maxSubsteps);
    while (this.accumulator >= step) {
      for (const car of this.cars) car.fixedUpdate(step);
      this.physics.step();
      for (const car of this.cars) car.postStep();
      this.accumulator -= step;
    }
    const alpha = this.accumulator / step;
    for (const car of this.cars) car.render(alpha);

    this.director.afterPhysics(dt);
    this.trackProps.update();

    this.debris.update(dt);
    this.emitCarEffects(dt);
    this.particles.update(dt);

    const p = this.player;
    const lv = p.body.linvel();
    this.rig.update(dt, p.model.root.position, _w.set(lv.x, lv.y, lv.z), p.speed / p.stats.topSpeed, this.playerHeading(), p.model.root.quaternion);
    this.env.update(p.model.root.position);
    this.director.lateUpdate(dt);
    this.hud.update({
      speedKmh: Math.abs(p.forwardSpeed) * 3.6,
      health: p.health / p.stats.maxHealth,
      partsLost: p.partsLost,
      boost: p.boostCharge,
      boosting: p.boosting,
      boostEmpty: p.boostEmpty,
    });
    for (const fn of this.frameListeners) fn(dt);

    this.renderer.render(this.scene, this.rig.camera);
    this.input.endFrame();
  }

  private handleActions(): void {
    // R = a fresh, repaired car at the last checkpoint (the lost time is the penalty).
    // Getting stuck upside down auto-flips the car in place without repairing it.
    if (this.input.consume('KeyR')) this.director.respawnPlayer();
    if (this.input.consume('Enter')) this.director.restart();
    if (this.input.consume('KeyT')) this.director.restart(this.director.mode === 'race' ? 'timetrial' : 'race');
    if (this.input.consume('KeyC')) {
      const mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.rig.mode) + 1) % CAMERA_MODES.length]!;
      this.rig.setMode(mode);
      this.snapCamera();
      saveCameraMode(mode);
      this.raceHud.notify(CAMERA_NAMES[mode], '#ffffff');
    }
  }

  private emitCarEffects(dt: number): void {
    for (const car of this.cars) {
      const speed = car.speed;
      if (speed > 3) {
        const lv = car.body.linvel();
        car.forEachGroundedWheel((point, slip) => {
          // Soft sand sprays more; firm hardpan only puffs.
          const amount = (Math.min(1, (speed - 3) / 30) * 0.5 + slip * 0.7) * (0.35 + car.surfaceSoftness);
          if (Math.random() < amount * dt * 25) {
            _v.set(-lv.x * 0.15, 1.5 + speed * 0.05, -lv.z * 0.15);
            this.particles.emitDust(point, _v, amount);
          }
        });
      }
      const damage = 1 - car.health / car.stats.maxHealth;
      if (damage > 0.45 && Math.random() < (damage - 0.3) * dt * 12) {
        // Smoke from the engine bay.
        _v.set(0, 0.6, 1.4).applyQuaternion(car.model.root.quaternion).add(car.model.root.position);
        this.particles.emitSmoke(_v, damage);
      }
      this.flames.get(car)?.update(dt, car.boosting);
    }
  }
}
