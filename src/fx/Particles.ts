import * as THREE from 'three';

/** Tunables for one particle type. */
interface PoolConfig {
  capacity: number;
  gravity: number;
  /** Velocity damping per second (exponential). */
  drag: number;
  /** Fraction of life spent growing before shrinking. */
  growFrac: number;
  /** Align the instance along its velocity, stretched. */
  stretch: boolean;
  castShadow: boolean;
}

const DUST_COLORS = [0xd9773f, 0xc96a35, 0xe08550, 0xa8502a];
/** Grey: a damaged car still running. Black: a wreck, so you can tell from across the arena. */
const SMOKE_COLORS = [0x8c8c90, 0x9f9fa4, 0xb4b4b8];
const WRECK_SMOKE_COLORS = [0x18181a, 0x222225, 0x2e2e32];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Ring-buffer pool backed by one InstancedMesh and typed arrays. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly spin: Float32Array;
  private readonly cfg: PoolConfig;
  private head = 0;
  private live = 0;
  private dirty = false;
  private colorDirty = false;
  private ground: ((x: number, z: number) => number) | null = null;
  private readonly obj = new THREE.Object3D();
  private readonly dir = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, cfg: PoolConfig) {
    this.cfg = cfg;
    const n = cfg.capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.mesh = new THREE.InstancedMesh(geometry, material, n);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = cfg.castShadow;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) {
      this.mesh.setMatrixAt(i, ZERO);
      this.mesh.setColorAt(i, this.color.set(0xffffff));
    }
  }

  get capacity(): number {
    return this.cfg.capacity;
  }

  setGround(fn: ((x: number, z: number) => number) | null): void {
    this.ground = fn;
  }

  emit(
    p: THREE.Vector3, vx: number, vy: number, vz: number,
    life: number, size: number, spin: number, color: number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cfg.capacity;
    if (this.life[i] <= 0 || this.age[i] >= this.life[i]) this.live++;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.spin[i] = spin;
    this.mesh.setColorAt(i, this.color.set(color));
    this.colorDirty = true;
    this.dirty = true;
  }

  update(dt: number): void {
    if (this.live === 0 && !this.dirty) return;
    const { gravity, drag, growFrac, stretch } = this.cfg;
    const damp = Math.exp(-drag * dt);
    const o = this.obj;
    for (let i = 0; i < this.cfg.capacity; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = (this.age[i] += dt);
      if (age >= life) {
        this.life[i] = 0;
        this.live--;
        this.mesh.setMatrixAt(i, ZERO);
        this.dirty = true;
        continue;
      }
      const k = i * 3;
      const vel = this.vel;
      vel[k + 1] += gravity * dt;
      vel[k] *= damp; vel[k + 1] *= damp; vel[k + 2] *= damp;
      this.pos[k] += vel[k] * dt;
      this.pos[k + 1] += vel[k + 1] * dt;
      this.pos[k + 2] += vel[k + 2] * dt;
      if (this.ground) {
        const gy = this.ground(this.pos[k], this.pos[k + 2]) + this.size[i] * 0.3;
        if (this.pos[k + 1] < gy) {
          this.pos[k + 1] = gy;
          vel[k] *= 0.6; vel[k + 2] *= 0.6;
          vel[k + 1] = Math.max(0, -vel[k + 1] * 0.2);
        }
      }
      const t = age / life;
      const g = t < growFrac ? t / growFrac : 1 - (t - growFrac) / (1 - growFrac);
      const s = this.size[i] * g;
      o.position.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      if (stretch) {
        const speed = Math.hypot(vel[k], vel[k + 1], vel[k + 2]);
        if (speed > 1e-4) this.dir.set(vel[k], vel[k + 1], vel[k + 2]).divideScalar(speed);
        o.quaternion.setFromUnitVectors(Z_AXIS, this.dir);
        o.scale.set(s * 0.4, s * 0.4, s * (0.8 + speed * 0.12));
      } else {
        o.rotation.set(age * this.spin[i], age * this.spin[i] * 0.7, 0);
        o.scale.setScalar(s);
      }
      o.updateMatrix();
      this.mesh.setMatrixAt(i, o.matrix);
      this.dirty = true;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.dirty = false;
      this.colorDirty = false;
    }
  }
}

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = (arr: number[]): number => arr[Math.floor(Math.random() * arr.length)];

export class Particles {
  private readonly dust: Pool;
  private readonly sparks: Pool;
  private readonly smoke: Pool;
  private readonly tmp = new THREE.Vector3();
  private readonly tan1 = new THREE.Vector3();
  private readonly tan2 = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.dust = new Pool(
      new THREE.IcosahedronGeometry(0.5, 0),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      { capacity: 500, gravity: -6, drag: 1.5, growFrac: 0.2, stretch: false, castShadow: true },
    );
    this.sparks = new Pool(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      { capacity: 250, gravity: -18, drag: 0.5, growFrac: 0.1, stretch: true, castShadow: false },
    );
    this.smoke = new Pool(
      new THREE.IcosahedronGeometry(0.5, 0),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      { capacity: 700, gravity: 0.8, drag: 0.8, growFrac: 0.4, stretch: false, castShadow: false },
    );
    for (const p of [this.dust, this.sparks, this.smoke]) scene.add(p.mesh);
  }

  /** Optional terrain height sampler so dust clumps settle on the ground. */
  setGround(fn: ((x: number, z: number) => number) | null): void {
    this.dust.setGround(fn);
  }

  emitDust(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    const n = Math.ceil(a * 4);
    for (let i = 0; i < n; i++) {
      this.dust.emit(
        pos,
        vel.x * 0.4 + rnd(-1.5, 1.5), vel.y * 0.4 + rnd(1, 3.5), vel.z * 0.4 + rnd(-1.5, 1.5),
        rnd(0.6, 1.2), rnd(0.45, 0.9) * (0.7 + a), rnd(-6, 6), pick(DUST_COLORS),
      );
    }
  }

  emitSparks(pos: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = this.tmp.copy(normal).normalize();
    this.tan1.set(1, 0, 0);
    if (Math.abs(n.x) > 0.9) this.tan1.set(0, 1, 0);
    this.tan1.cross(n).normalize();
    this.tan2.crossVectors(n, this.tan1);
    for (let i = 0; i < count; i++) {
      const sp = rnd(4, 12);
      const u = rnd(-0.8, 0.8);
      const v = rnd(-0.8, 0.8);
      this.sparks.emit(
        pos,
        (n.x + this.tan1.x * u + this.tan2.x * v) * sp,
        (n.y + this.tan1.y * u + this.tan2.y * v) * sp + 2,
        (n.z + this.tan1.z * u + this.tan2.z * v) * sp,
        rnd(0.3, 0.6), rnd(0.08, 0.16), 0, Math.random() < 0.5 ? 0xffd23a : 0xff8a1f,
      );
    }
  }

  emitSmoke(pos: THREE.Vector3, amount: number): void {
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    const n = a > 0.5 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.smoke.emit(
        pos, rnd(-0.4, 0.4), rnd(1.2, 2.2), rnd(-0.4, 0.4),
        rnd(1.3, 1.7), rnd(0.5, 0.9) * (0.6 + a * 0.8), rnd(-2, 2), pick(SMOKE_COLORS),
      );
    }
  }

  /** A wreck's thick black column: bigger, longer-lived puffs that rise higher. */
  emitWreckSmoke(pos: THREE.Vector3): void {
    for (let i = 0; i < 2; i++) {
      this.smoke.emit(
        pos, rnd(-0.6, 0.6), rnd(2.4, 3.8), rnd(-0.6, 0.6),
        rnd(2.4, 3.2), rnd(1.1, 1.7), rnd(-1.5, 1.5), pick(WRECK_SMOKE_COLORS),
      );
    }
  }

  emitImpact(pos: THREE.Vector3, normal: THREE.Vector3, strength: number): void {
    const s = THREE.MathUtils.clamp(strength, 0, 1);
    const dustN = Math.ceil(8 + s * 20);
    for (let i = 0; i < dustN; i++) {
      const sp = rnd(2, 6 + s * 6);
      const ang = Math.random() * Math.PI * 2;
      this.dust.emit(
        pos, Math.cos(ang) * sp + normal.x * 2, rnd(2, 6) + normal.y * 2, Math.sin(ang) * sp + normal.z * 2,
        rnd(0.7, 1.2), rnd(0.35, 0.8), rnd(-6, 6), pick(DUST_COLORS),
      );
    }
    this.emitSparks(pos, normal, Math.ceil(8 + s * 24));
  }

  update(dt: number): void {
    this.dust.update(dt);
    this.sparks.update(dt);
    this.smoke.update(dt);
  }
}
