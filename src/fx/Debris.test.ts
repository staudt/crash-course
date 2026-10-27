import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { Physics } from '../core/Physics';
import { Debris } from './Debris';

const zero = { x: 0, y: 0, z: 0 };
const half = new THREE.Vector3(0.5, 0.2, 0.2);
const makeMesh = (): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 0.4), new THREE.MeshBasicMaterial());

beforeAll(async () => {
  await RAPIER.init();
});

describe('Debris', () => {
  it('caps the live count and removes bodies', () => {
    const physics = new Physics();
    const scene = new THREE.Scene();
    const debris = new Debris(scene, physics, 60);
    for (let i = 0; i < 70; i++) debris.spawn(makeMesh(), half, zero, zero);
    expect(debris.count).toBe(60);
    expect(physics.world.bodies.len()).toBe(60);
    expect(scene.children.length).toBe(60);
    debris.clear();
    expect(debris.count).toBe(0);
    expect(physics.world.bodies.len()).toBe(0);
  });

  it('starts at the mesh world position', () => {
    const physics = new Physics();
    const scene = new THREE.Scene();
    const debris = new Debris(scene, physics);
    const group = new THREE.Group();
    group.position.set(10, 5, -3);
    group.rotation.y = Math.PI / 2;
    scene.add(group);
    const mesh = makeMesh();
    mesh.position.set(1, 0, 2);
    group.add(mesh);
    group.updateMatrixWorld(true);
    const expected = mesh.getWorldPosition(new THREE.Vector3());
    debris.spawn(mesh, half, zero, zero);
    expect(mesh.parent).toBe(scene);
    expect(mesh.position.distanceTo(expected)).toBeLessThan(1e-5);
    const body = physics.world.bodies.get(0);
    const t = body!.translation();
    expect(new THREE.Vector3(t.x, t.y, t.z).distanceTo(expected)).toBeLessThan(1e-5);
  });

  it('mesh follows the falling body', () => {
    const physics = new Physics();
    const scene = new THREE.Scene();
    const debris = new Debris(scene, physics);
    const mesh = makeMesh();
    mesh.position.set(0, 20, 0);
    scene.add(mesh);
    debris.spawn(mesh, half, zero, zero);
    for (let i = 0; i < 30; i++) physics.step();
    debris.update(30 / 60);
    expect(mesh.position.y).toBeLessThan(19);
  });
});
