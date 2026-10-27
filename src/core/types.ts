/** Control signals for a car. Keyboard, gamepad and (later) AI all produce this. */
export interface DriveInput {
  /** -1 (reverse) .. 1 (full throttle) */
  throttle: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0 .. 1 */
  brake: number;
  handbrake: boolean;
}

export const NEUTRAL_INPUT: Readonly<DriveInput> = { throttle: 0, steer: 0, brake: 0, handbrake: false };

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
