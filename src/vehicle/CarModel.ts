import type * as THREE from 'three';
import type { PartKind } from './CarStats';

/** Wheel order used everywhere: front-left, front-right, rear-left, rear-right. */
export const WHEEL_ORDER = ['FL', 'FR', 'RL', 'RR'] as const;

export interface CarPart {
  kind: PartKind;
  /**
   * The part mesh. A direct child of `CarModel.root` (wheel meshes are the
   * exception: children of their wheel pivot). Unrotated relative to root, with
   * `mesh.position` at the part's centre and geometry centred on it, so a
   * root-local point p maps to part-local space as `p - mesh.position`.
   * Geometry is indexed BufferGeometry, subdivided enough to dent.
   */
  mesh: THREE.Mesh;
  /** Half extents of the part's bounding box, used for its debris collider. */
  halfExtents: THREE.Vector3;
  /** 0..3 for wheels (see WHEEL_ORDER), otherwise -1. */
  wheelIndex: number;
}

export interface CarModel {
  /** Root group. Its origin = the chassis rigid body origin. Forward is +Z. */
  root: THREE.Group;
  parts: CarPart[];
  /**
   * One pivot per wheel in WHEEL_ORDER, child of root. Car positions the pivot
   * at the suspension contact (y) and rotates it about Y for steering; the wheel
   * mesh inside spins about the pivot's local X axis.
   */
  wheelPivots: THREE.Object3D[];
}
