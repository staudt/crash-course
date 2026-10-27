import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

/** A contact-force event between two colliders, already filtered by the colliders' thresholds. */
export interface ContactForce {
  a: RAPIER.Collider;
  b: RAPIER.Collider;
  /** Total force magnitude (N) over the step. */
  force: number;
}

export type ContactForceHandler = (ev: ContactForce) => void;

let initPromise: Promise<void> | null = null;

/** Loads the Rapier WASM. Safe to call many times. */
export function initPhysics(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/**
 * Thin wrapper over a Rapier world: fixed timestep, contact-force dispatch and
 * a collider → owner map so game code can find which entity a collider belongs to.
 */
export class Physics {
  readonly world: RAPIER.World;
  readonly dt: number;
  private readonly events: RAPIER.EventQueue;
  private readonly owners = new Map<number, unknown>();
  private readonly handlers: ContactForceHandler[] = [];

  constructor(dt = 1 / 60, gravity = -20) {
    // Gravity is stronger than real for snappier, less floaty arcade jumps.
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = dt;
    this.dt = dt;
    this.events = new RAPIER.EventQueue(true);
  }

  step(): void {
    this.world.step(this.events);
    if (this.handlers.length === 0) {
      this.events.clear();
      return;
    }
    this.events.drainContactForceEvents((e) => {
      const a = this.world.getCollider(e.collider1());
      const b = this.world.getCollider(e.collider2());
      if (!a || !b) return;
      const ev: ContactForce = { a, b, force: e.totalForceMagnitude() };
      for (const h of this.handlers) h(ev);
    });
  }

  onContactForce(handler: ContactForceHandler): void {
    this.handlers.push(handler);
  }

  setOwner(collider: RAPIER.Collider, owner: unknown): void {
    this.owners.set(collider.handle, owner);
  }

  ownerOf(collider: RAPIER.Collider): unknown {
    return this.owners.get(collider.handle);
  }

  removeBody(body: RAPIER.RigidBody): void {
    for (let i = 0; i < body.numColliders(); i++) this.owners.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }
}
