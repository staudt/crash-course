import type { Input } from '../core/Input';
import type { Car } from '../vehicle/Car';

/** Runs a level's game mode on top of the Game world (RaceDirector, DerbyDirector). Game calls these each frame in this order. */
export interface Director {
  /** Fresh round: cars on the grid, countdown. */
  restart(): void;
  /** One-shot keys the mode handles (R, Enter, ...); camera keys stay with Game. */
  handleActions(input: Input): void;
  beforePhysics(dt: number): void;
  afterPhysics(dt: number): void;
  /** After the camera has moved. */
  lateUpdate(dt: number): void;
  /** Two cars touched, from `felt`'s side, with the jolt it felt (m/s). */
  onCarContact(felt: Car, other: Car, impact: number): void;
  /** A short HUD message. */
  notify(text: string, color: string): void;
  /** The car the camera follows (the player's, unless spectating). */
  readonly viewCar: Car;
}
