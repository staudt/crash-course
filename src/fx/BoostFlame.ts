import * as THREE from 'three';

/**
 * Exhaust jet shown while a car boosts: an orange flame with a blue-white core, attached to
 * the car's model so it follows it exactly. Additive and unlit, so it glows against the sand.
 */
const CONFIG = {
  /** Car-local exhaust position (+Z forward, +X left): low on the right, just behind the tail. */
  exhaust: new THREE.Vector3(-0.42, -0.08, -2.12),
  outer: { radius: 0.24, length: 1.6, color: '#ff7a1a', opacity: 0.85 },
  inner: { radius: 0.11, length: 0.95, color: '#cfe8ff', opacity: 0.95 },
  /** Seconds to fade in/out. */
  fade: 0.08,
  /** Length flicker range. */
  flickerMin: 0.75,
  flickerMax: 1.3,
};

/** Cone pointing back along -Z with its base at the origin (the exhaust tip). */
function flameGeometry(radius: number, length: number): THREE.ConeGeometry {
  const g = new THREE.ConeGeometry(radius, length, 10, 1, true);
  g.rotateX(-Math.PI / 2); // tip from +Y to -Z
  g.translate(0, 0, -length / 2);
  return g;
}

const OUTER_GEO = flameGeometry(CONFIG.outer.radius, CONFIG.outer.length);
const INNER_GEO = flameGeometry(CONFIG.inner.radius, CONFIG.inner.length);
const material = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

export class BoostFlame {
  private readonly group = new THREE.Group();
  private readonly outerMat = material(CONFIG.outer.color, CONFIG.outer.opacity);
  private readonly innerMat = material(CONFIG.inner.color, CONFIG.inner.opacity);
  private level = 0;

  constructor(parent: THREE.Object3D) {
    this.group.position.copy(CONFIG.exhaust);
    const outer = new THREE.Mesh(OUTER_GEO, this.outerMat);
    const inner = new THREE.Mesh(INNER_GEO, this.innerMat);
    outer.renderOrder = inner.renderOrder = 5;
    this.group.add(outer, inner);
    this.group.visible = false;
    parent.add(this.group);
  }

  update(dt: number, active: boolean): void {
    this.level = Math.min(1, Math.max(0, this.level + (active ? dt : -dt) / CONFIG.fade));
    this.group.visible = this.level > 0;
    if (!this.group.visible) return;
    const flicker = CONFIG.flickerMin + Math.random() * (CONFIG.flickerMax - CONFIG.flickerMin);
    const width = 0.85 + Math.random() * 0.3;
    this.group.scale.set(width * this.level, width * this.level, flicker * this.level);
    this.outerMat.opacity = CONFIG.outer.opacity * this.level;
    this.innerMat.opacity = CONFIG.inner.opacity * this.level;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.outerMat.dispose();
    this.innerMat.dispose();
  }
}
