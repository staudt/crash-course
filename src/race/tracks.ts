import chicagoTrack from '../city/chicago-track.json';
import type { ChicagoTrack } from '../city/osm';
import { TrackPath, type Corner, type TrackDef } from './TrackPath';

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

/**
 * Corners of a figure 8: two straights crossing at the origin, joined at each end by a lobe of
 * `radius` around (±lobeX, 0). Each lobe is `perLobe` corners of one circumscribed polygon, rounded
 * with arcs slightly tighter than the circle so the straights between them stay positive.
 * Corner 0 → 1 is the straight from the left lobe to the right one (heading +X); the right lobe
 * turns left and the left one right. Also returns the lap fractions of the two mid-lobe apexes.
 */
export function figureEight(lobeX: number, radius: number, perLobe = 3): { corners: Corner[]; apex: [number, number]; start: number } {
  const theta = Math.asin(radius / lobeX);
  const delta = (Math.PI + 2 * theta) / perLobe;
  const rho = radius / Math.cos(delta / 2);
  const r = radius - 0.5;
  // Heading h faces (sin h, cos h); the left normal is (cos h, -sin h).
  const hA = Math.PI / 2 - theta;
  const hB = theta - Math.PI / 2;
  const right: Corner[] = [];
  const left: Corner[] = [];
  for (let j = 0; j < perLobe; j++) {
    const m = hA + (j + 0.5) * delta; // turning left: the centre is on the left
    right.push({ x: lobeX - rho * Math.cos(m), z: rho * Math.sin(m), r });
    const n = hB - (j + 0.5) * delta; // turning right: the centre is on the right
    left.push({ x: -lobeX + rho * Math.cos(n), z: -rho * Math.sin(n), r });
  }
  const corners = [left[perLobe - 1]!, ...right, ...left.slice(0, perLobe - 1)];
  // Lap fractions (the layout is point-symmetric, so the second half repeats the first).
  const reach = r * Math.tan(delta / 2);
  const straight = 2 * Math.hypot(right[0]!.x, right[0]!.z) - 2 * reach;
  const lobe = perLobe * r * delta + (perLobe - 1) * (2 * rho * Math.sin(delta / 2) - 2 * reach);
  const lap = 2 * straight + 2 * lobe;
  // s = 0 midway from the crossing to the right lobe; its apex is a quarter-straight plus half a lobe on.
  const apex = (straight / 4 + lobe / 2) / lap;
  return { corners, apex: [apex, 0.5 + apex], start: 0.75 };
}

const EIGHT = figureEight(82, 28);

/**
 * "Crossover": a short asphalt figure 8 (234 m end to end, 524 m a lap). Two fast 155 m straights cross
 * in the middle at 40° (at grade: cross traffic), with walls close along them so the only way through
 * is over the crossing, and a run-off on the outside of the two tight (28 m) loops.
 * Checkpoints: midway from the crossing to each loop (the start/finish is on the first), and each
 * loop's apex, so nobody can U-turn back through the crossing.
 */
export const CROSSOVER: TrackDef = {
  id: 'crossover',
  name: 'Crossover',
  halfWidth: 7,
  corners: EIGHT.corners,
  start: EIGHT.start,
  checkpoints: 4,
  checkpointAt: [0, EIGHT.apex[0], 0.5, EIGHT.apex[1]],
  stations: [0, 2],
  surface: 'asphalt',
  walls: { straight: 3, inside: 3, outside: 9 },
  laps: 5,
  parked: 0,
  guide: 'checkpoints',
};

/**
 * A street circuit from OpenStreetMap (scripts/osm-chicago.ts → src/city/chicago-track.json): the start line
 * `startBefore` m up the street from the first junction, and gates at fixed places along the streets.
 */
export function streetCircuit(t: ChicagoTrack, base: Omit<TrackDef, 'corners' | 'corridor' | 'halfWidth' | 'checkpoints' | 'start' | 'checkpointAt'>, gates: [street: number, at: number][]): TrackDef {
  const core = { ...base, corners: t.corners, corridor: t.corridor, halfWidth: t.halfWidth, checkpoints: 1 };
  // With start 0 the whole first straight comes first: its length, and how far the arc reaches back from the junction.
  const probe = new TrackPath({ ...core, start: 0 });
  const first = probe.bends.find((b) => b.corner === 1)!;
  const reach = first.radius * Math.tan(Math.abs(first.turn) / 2);
  const start = Math.min(0.95, Math.max(0.05, 1 - (t.startBefore - reach) / first.start));
  const path = new TrackPath({ ...core, start });
  /** Distance along the lap `at` (0..1) of the way down straight i (between its two arcs; straight 0 is split by the line). */
  const along = (i: number, at: number): number => {
    const n = t.corners.length;
    const from = path.bends.find((b) => b.corner === i)!;
    const to = path.bends.find((b) => b.corner === (i + 1) % n)!;
    const a = from.end;
    const len = path.wrap(to.start - a);
    return path.wrap(a + len * at);
  };
  const checkpointAt = [0, ...gates.map(([i, at]) => along(i, at) / path.length)];
  return { ...core, start, checkpoints: checkpointAt.length, checkpointAt };
}

/**
 * "Chicago Loop": downtown Chicago, clockwise round real streets (OpenStreetMap data): south down LaSalle toward
 * the Board of Trade, west on Jackson past Willis Tower, north up Wacker along the river's south branch, round
 * the 333 W Wacker bend, east on Wacker along the main branch and the Riverwalk. The building line is the wall:
 * sidewalks are drivable, side streets are barricaded, the river side is a balustrade over the drop.
 */
export const CHICAGO: TrackDef = streetCircuit(
  chicagoTrack as ChicagoTrack,
  { id: 'chicago', name: 'Chicago Loop', surface: 'asphalt', stations: [0, 3], laps: 3, parked: 0, guide: 'bends' },
  [
    [1, 0.5], // Jackson
    [2, 0.33], // Wacker, south branch
    [2, 0.67],
    [4, 0.5], // Wacker, main branch
    [0, 0.4], // north LaSalle
  ],
);
