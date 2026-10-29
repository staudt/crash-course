import * as THREE from 'three';
import { CAMERA_MODES, CameraRig, type CameraMode } from '../core/CameraRig';
import { Input } from '../core/Input';
import { Physics } from '../core/Physics';
import { BoostFlame } from '../fx/BoostFlame';
import { Debris } from '../fx/Debris';
import { Particles } from '../fx/Particles';
import { TrackPath } from '../race/TrackPath';
import { Hud } from '../ui/Hud';
import { Car, type CarEvents, type SpawnPose, type SurfaceFn, type WallFn } from '../vehicle/Car';
import { buildCarModel, type CarVariant } from '../vehicle/CarBuilder';
import { cloneStats, type CarStats } from '../vehicle/CarStats';
import { ConcreteWall } from '../world/ArenaWall';
import { BOWL_CONFIG, carveBowl } from '../world/Bowl';
import { CIRCUIT_CONFIG, carveCircuit } from '../world/Circuit';
import { Environment } from '../world/Environment';
import { buildElevation, carveRoad } from '../world/Road';
import { Rocks } from '../world/Rocks';
import { Terrain } from '../world/Terrain';
import { generateTerrain } from '../world/TerrainData';
import { DerbyDirector } from './DerbyDirector';
import type { Director } from './Director';
import type { LevelDef } from './levels';
import { RaceDirector } from './RaceDirector';

export const GAME_CONFIG = {
  seed: 1337,
  /** Race world: 2048 m square at ~2.7 m per heightfield cell. */
  terrainN: 769,
  terrainSize: 2048,
  /** Derby world (and small circuits): 640 m square at 2 m cells, the bowl in the middle. */
  bowlN: 321,
  bowlSize: 640,
  /** Silver paint (the tyres stay black). */
  playerColor: '#b9bec6',
  /** The bowl's dark mud floor gets more fill light than the desert. */
  bowlFill: 1.45,
  /** Scraping a wall throws a pair of sparks every step at this speed (m/s) and up, proportionally fewer below. */
  scrapeSparkSpeed: 15,
  /** Black smoke puffs (pairs) per second from a wrecked car. */
  wreckSmokeRate: 14,
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
  readonly level: LevelDef;
  readonly director: Director;
  /** Base stats for the player car. Edits apply to the next spawned car (and live via Tuning). */
  readonly playerStats: CarStats = cloneStats();

  player!: Car;
  private readonly cars: Car[] = [];
  private readonly flames = new Map<Car, BoostFlame>();
  private readonly carEvents: CarEvents;
  /** Terrain sand is soft per the softness map; rocks, cars and debris are firm. */
  private readonly surface: SurfaceFn = (ground, x, z) => (ground === this.terrain.collider ? this.terrain.softnessAt(x, z) : 0);
  /** Smooth concrete walls (the track's): a glancing contact slides along them. */
  private readonly walls: WallFn = (collider, x, z) => {
    const owner = this.physics.ownerOf(collider);
    return owner instanceof ConcreteWall && owner.smooth ? owner.normalAt(x, z) : null;
  };
  /** Only the terrain is ever paved (circuit levels). */
  private readonly paving: SurfaceFn = (ground, x, z) => (ground === this.terrain.collider ? this.terrain.pavedAt(x, z) : 0);
  private accumulator = 0;
  private lastTime = performance.now();
  private readonly frameListeners: ((dt: number) => void)[] = [];

  constructor(container: HTMLElement, level: LevelDef) {
    this.level = level;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(container.clientWidth / container.clientHeight);
    this.rig.setMode(loadCameraMode());
    this.env = new Environment(this.scene, this.renderer);
    // The level shapes the ground before the terrain is built from it.
    const race = level.kind === 'race';
    const track = level.track ? new TrackPath(level.track) : null;
    // A walled circuit is small: it sits in the derby-sized world, flattened like the bowl.
    const big = track !== null && !track.def.walls;
    const data = generateTerrain({ seed: GAME_CONFIG.seed, n: big ? GAME_CONFIG.terrainN : GAME_CONFIG.bowlN, size: big ? GAME_CONFIG.terrainSize : GAME_CONFIG.bowlSize });
    if (track?.def.walls) carveCircuit(data, track);
    else if (track) {
      buildElevation(track, data);
      carveRoad(data, track);
    } else {
      carveBowl(data);
      this.env.fill.intensity = GAME_CONFIG.bowlFill;
    }
    this.terrain = new Terrain(this.scene, this.physics, data);
    this.rig.setGround((x, z) => this.terrain.heightAt(x, z));
    if (track?.def.walls) new Rocks(this.scene, this.physics, this.terrain, GAME_CONFIG.seed, (x, z) => track.project(x, z).distance - CIRCUIT_CONFIG.flat, 6, GAME_CONFIG.bowlSize * 0.4);
    else if (track) new Rocks(this.scene, this.physics, this.terrain, GAME_CONFIG.seed, (x, z) => track.project(x, z).distance, track.halfWidth);
    // Bowl: rocks only out among the dunes, well behind the wall.
    else new Rocks(this.scene, this.physics, this.terrain, GAME_CONFIG.seed, (x, z) => Math.hypot(x, z) - BOWL_CONFIG.wallRadius, 6, GAME_CONFIG.bowlSize * 0.4);

    this.particles = new Particles(this.scene);
    this.particles.setGround((x, z) => this.terrain.heightAt(x, z));
    this.debris = new Debris(this.scene, this.physics);
    this.hud = new Hud(container, race ? 'R: back to checkpoint · Enter: restart · T: race / time trial' : 'R: back on your wheels · Enter: restart');

    this.carEvents = {
      onPartDetached: (_car, part, linvel, angvel) => this.debris.spawn(part.mesh, part.halfExtents, linvel, angvel),
      onImpact: (_car, point, normal, strength) => this.particles.emitImpact(point, normal, Math.min(1, strength / 10)),
      onCarContact: (car, other, impact) => this.director?.onCarContact(car, other, impact),
      // Grinding along a wall: a steady trickle of sparks, more the faster it slides.
      onScrape: (_car, point, normal, speed) => {
        if (Math.random() < Math.min(1, speed / GAME_CONFIG.scrapeSparkSpeed)) this.particles.emitSparks(point, normal, 2);
      },
      onWrecked: (car) => {
        if (car === this.player && race) this.hud.showMessage('WRECKED: press R', 3);
      },
    };

    this.physics.onContactForce(({ a, b }) => {
      const ca = this.physics.ownerOf(a);
      const cb = this.physics.ownerOf(b);
      if (ca instanceof Car) ca.recordContact(b);
      if (cb instanceof Car) cb.recordContact(a);
    });

    this.spawnPlayer();
    this.director = track ? new RaceDirector(this, track, container) : new DerbyDirector(this, container);
    this.director.restart();

    window.addEventListener('resize', () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.renderer.setSize(w, h);
      this.rig.setAspect(w / h);
    });
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** The car the camera follows: the player's, or another one while spectating. */
  get viewCar(): Car {
    return this.director?.viewCar ?? this.player;
  }

  /** Jump the camera to the view car (behind it, in the chase view), e.g. after a respawn. Reads the physics body, which may be ahead of the rendered model. */
  snapCamera(): void {
    const car = this.viewCar;
    const b = car.body;
    const t = b.translation();
    const r = b.rotation();
    this.rig.snap(_w.set(t.x, t.y, t.z), heading(car), _q.set(r.x, r.y, r.z, r.w));
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
    car.paving = this.paving;
    car.walls = this.walls;
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

    this.debris.update(dt);
    this.emitCarEffects(dt);
    this.particles.update(dt);

    const p = this.viewCar;
    const lv = p.body.linvel();
    this.rig.update(dt, p.model.root.position, _w.set(lv.x, lv.y, lv.z), p.speed / p.stats.topSpeed, heading(p), p.model.root.quaternion);
    this.env.update(p.model.root.position);
    this.director.lateUpdate(dt);
    this.hud.update({
      speedKmh: Math.abs(p.forwardSpeed) * 3.6,
      health: p.health / p.stats.maxHealth,
      partsLost: p.partsLost,
      damage: p.damageReport(),
      boost: p.boostCharge,
      boosting: p.boosting,
      boostEmpty: p.boostEmpty,
    });
    for (const fn of this.frameListeners) fn(dt);

    this.renderer.render(this.scene, this.rig.camera);
    this.input.endFrame();
  }

  private handleActions(): void {
    // Esc: back to the level menu (it opens on load, on the level picked last).
    if (this.input.consume('Escape')) location.reload();
    this.director.handleActions(this.input);
    if (this.input.consume('KeyC')) {
      const mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.rig.mode) + 1) % CAMERA_MODES.length]!;
      this.rig.setMode(mode);
      this.snapCamera();
      saveCameraMode(mode);
      this.director.notify(CAMERA_NAMES[mode], '#ffffff');
    }
  }

  private emitCarEffects(dt: number): void {
    for (const car of this.cars) {
      const speed = car.speed;
      if (speed > 3) {
        const lv = car.body.linvel();
        car.forEachGroundedWheel((point, slip) => {
          // Soft sand sprays more; firm hardpan only puffs, and asphalt hardly at all.
          const amount = (Math.min(1, (speed - 3) / 30) * 0.5 + slip * 0.7) * (0.35 + car.surfaceSoftness) * (1 - 0.85 * car.surfacePaved);
          if (Math.random() < amount * dt * 25) {
            _v.set(-lv.x * 0.15, 1.5 + speed * 0.05, -lv.z * 0.15);
            this.particles.emitDust(point, _v, amount);
          }
        });
      }
      // Smoke from the engine bay: grey while the car runs, a thick black column once it's wrecked.
      const damage = 1 - car.health / car.stats.maxHealth;
      const wreck = car.wrecked && Math.random() < dt * GAME_CONFIG.wreckSmokeRate;
      if (wreck || (damage > 0.45 && Math.random() < (damage - 0.3) * dt * 12)) {
        _v.set(0, 0.6, 1.4).applyQuaternion(car.model.root.quaternion).add(car.model.root.position);
        if (wreck) this.particles.emitWreckSmoke(_v);
        else this.particles.emitSmoke(_v, damage);
      }
      this.flames.get(car)?.update(dt, car.boosting);
    }
  }
}

function heading(car: Car): number {
  const f = car.forward(_v);
  return Math.atan2(f.x, f.z);
}
