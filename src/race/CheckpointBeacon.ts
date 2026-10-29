import * as THREE from 'three';

/**
 * Marks the next checkpoint on tracks that guide by checkpoints (`TrackDef.guide`): a big yellow
 * diamond (a four-sided cone pointing down) bobbing and spinning above the gate's banner.
 */
export const BEACON_CONFIG = {
  color: '#ffd23f',
  /** The diamond's tip this high above the road, bobbing by `bob` m. */
  height: 9,
  size: 1.8,
  bob: 0.6,
  bobRate: 3,
  spin: 1.5,
};

export class CheckpointBeacon {
  private readonly root = new THREE.Group();
  private readonly diamond: THREE.Mesh;
  private time = 0;

  constructor(scene: THREE.Scene) {
    const c = BEACON_CONFIG;
    // A four-sided cone pointing down at the gate.
    const s = c.size;
    this.diamond = new THREE.Mesh(new THREE.ConeGeometry(s, s * 1.6, 4).rotateX(Math.PI).translate(0, s * 0.8, 0), new THREE.MeshBasicMaterial({ color: c.color }));
    this.root.add(this.diamond);
    this.root.visible = false;
    scene.add(this.root);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /** Put the beacon over the road at (x, y, z): the next gate's centre. */
  place(x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
  }

  update(dt: number): void {
    const c = BEACON_CONFIG;
    this.time += dt;
    this.diamond.position.y = c.height + Math.sin(this.time * c.bobRate) * c.bob;
    this.diamond.rotation.y = this.time * c.spin;
  }
}
