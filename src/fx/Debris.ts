import * as THREE from 'three';
import { RAPIER, type Physics } from '../core/Physics';
import type { Vec3Like } from '../core/types';

const LIFETIME = 25;
const FADE = 1;
const MIN_HALF = 0.05;
/** kg/m^3: a bumper-sized piece comes out around 20-60 kg. */
const DENSITY = 250;

interface Piece {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  age: number;
  baseScale: THREE.Vector3;
}

export class Debris {
  private readonly pieces: Piece[] = [];
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly max = 60,
  ) {}

  get count(): number {
    return this.pieces.length;
  }

  spawn(mesh: THREE.Mesh, halfExtents: THREE.Vector3, linvel: Vec3Like, angvel: Vec3Like): void {
    mesh.updateWorldMatrix(true, false);
    mesh.matrixWorld.decompose(this.pos, this.quat, this.scale);
    this.scene.add(mesh); // re-parents from any previous parent
    mesh.position.copy(this.pos);
    mesh.quaternion.copy(this.quat);
    mesh.scale.copy(this.scale);
    mesh.updateMatrix();

    const world = this.physics.world;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.pos.x, this.pos.y, this.pos.z)
        .setRotation(this.quat)
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel(angvel)
        .setCcdEnabled(true),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        Math.max(MIN_HALF, halfExtents.x),
        Math.max(MIN_HALF, halfExtents.y),
        Math.max(MIN_HALF, halfExtents.z),
      )
        .setDensity(DENSITY)
        .setFriction(0.8)
        .setRestitution(0.15),
      body,
    );
    this.physics.setOwner(collider, this);
    this.pieces.push({ mesh, body, age: 0, baseScale: this.scale.clone() });
    while (this.pieces.length > this.max) this.remove(0);
  }

  update(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      if (p.age >= LIFETIME) {
        this.remove(i);
        continue;
      }
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const left = LIFETIME - p.age;
      if (left < FADE) p.mesh.scale.copy(p.baseScale).multiplyScalar(left / FADE);
    }
  }

  clear(): void {
    while (this.pieces.length > 0) this.remove(this.pieces.length - 1);
  }

  private remove(index: number): void {
    const [p] = this.pieces.splice(index, 1);
    this.physics.removeBody(p.body);
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
  }
}
