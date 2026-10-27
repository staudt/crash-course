import type { TrackDef } from './TrackPath';

/**
 * "Dune Loop": the first circuit. Mixed character: a long start straight, fast sweepers,
 * S-bends, two handbrake hairpins, a chicane, three kicker jumps, and two stretches of open
 * sand with no road. ~3 min a lap.
 * Corners are in world metres (x, z); the world is 2048 m square, keep within ±800.
 */
export const DUNE_LOOP: TrackDef = {
  id: 'dune-loop',
  name: 'Dune Loop',
  halfWidth: 8,
  checkpoints: 12,
  // Open sand: the S-bends through the middle, the bottom stretch with the second hairpin,
  // and the sweepers on the left side. About a third of the lap.
  sand: [
    [5, 8],
    [13, 16],
    [18, 20],
  ],
  corners: [
    { x: -650, z: -700, r: 70 },
    { x: 250, z: -700, r: 350, jump: 0.5 },
    { x: 700, z: -520, r: 120 },
    { x: 720, z: -150, r: 30 },
    { x: 640, z: -90, r: 30 },
    { x: 450, z: -380, r: 140 },
    { x: 250, z: -300, r: 140 },
    { x: 180, z: 0, r: 200 },
    { x: 380, z: 250, r: 60 },
    { x: 720, z: 300, r: 90, jump: 0.55 },
    { x: 700, z: 720, r: 80 },
    { x: 350, z: 650, r: 40 },
    { x: 250, z: 720, r: 40 },
    { x: -100, z: 650, r: 250 },
    { x: -300, z: 300, r: 28 },
    { x: -380, z: 360, r: 28 },
    { x: -450, z: 700, r: 150 },
    { x: -750, z: 650, r: 100, jump: 0.5 },
    { x: -700, z: 200, r: 220 },
    { x: -500, z: -100, r: 180 },
    { x: -750, z: -400, r: 100 },
  ],
};
