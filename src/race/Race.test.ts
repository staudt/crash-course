import { describe, expect, it } from 'vitest';
import { RACE_CONFIG, Race, rankRacers, type RaceEvent } from './Race';
import { TrackPath, type TrackDef } from './TrackPath';

const square: TrackDef = {
  id: 'sq',
  name: 'Square',
  halfWidth: 5,
  checkpoints: 4,
  corners: [
    { x: 0, z: 0, r: 20 },
    { x: 0, z: 200, r: 20 },
    { x: 200, z: 200, r: 20 },
    { x: 200, z: 0, r: 20 },
  ],
};
const path = new TrackPath(square);
const dt = 1 / 60;

/** Drive a point along the centreline at `speed` m/s (negative = backwards) from s0 for `seconds`. */
function drive(race: Race, s0: number, speed: number, seconds: number, lateral = 0): { events: RaceEvent[]; s: number } {
  const events: RaceEvent[] = [];
  let s = s0;
  const at = (s: number) => {
    const p = path.pointAt(s, { x: 0, z: 0 });
    const t = path.tangentAt(s, { x: 0, z: 0 });
    return { x: p.x + t.z * lateral, z: p.z - t.x * lateral, vx: t.x * speed, vz: t.z * speed };
  };
  for (let i = 0; i < seconds * 60; i++) {
    const a = at(s);
    s += speed * dt;
    const b = at(s);
    events.push(...race.update(dt, a, b, { x: b.vx, z: b.vz }));
  }
  return { events, s };
}

describe('Race', () => {
  it('counts down, then GO starts the lap timer', () => {
    const race = new Race(path);
    const { events } = drive(race, -10, 0, RACE_CONFIG.countdown + 0.5);
    expect(events).toEqual([{ type: 'go' }]);
    expect(race.phase).toBe('racing');
    expect(race.lapTime).toBeCloseTo(0.5, 1);
  });

  it('passes checkpoints in order and completes a lap at the finish', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    const speed = 40;
    const { events } = drive(race, -10, speed, (path.length + 20) / speed);
    const kinds = events.map((e) => (e.type === 'checkpoint' ? `cp${e.index}` : e.type));
    expect(kinds).toEqual(['cp1', 'cp2', 'cp3', 'lap']);
    const lap = events[3] as Extract<RaceEvent, { type: 'lap' }>;
    expect(lap.time).toBeCloseTo((path.length + 10) / speed, 1);
    expect(lap.best).toBe(true);
    expect(race.lap).toBe(2);
    expect(race.next).toBe(1);
    expect(race.best?.splits[2]).toBeCloseTo((path.checkpoints[2]! + 10) / speed, 1);
  });

  it('reports split deltas against the best lap', () => {
    const race = new Race(path, { time: 999, splits: [0, 1, 2, 3] });
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    const { events } = drive(race, -10, 50, (path.checkpoints[1]! + 20) / 50);
    const cp = events.find((e) => e.type === 'checkpoint') as Extract<RaceEvent, { type: 'checkpoint' }>;
    expect(cp.delta).toBeCloseTo(cp.split - 1, 6);
  });

  it('ignores gates crossed out of order or far off the road', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    // Skip past checkpoint 1 by teleporting, then cross 2: nothing counts.
    const { events } = drive(race, path.checkpoints[1]! + 5, 40, 3);
    expect(events).toEqual([]);
    expect(race.next).toBe(1);
    // Crossing checkpoint 1 way off to the side doesn't count either.
    const off = drive(race, path.checkpoints[1]! - 10, 40, 1, path.halfWidth + RACE_CONFIG.gateMargin + 5);
    expect(off.events).toEqual([]);
  });

  it('respawns just past the last checkpoint, facing along the track', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    drive(race, -10, 40, (path.checkpoints[2]! + 30) / 40);
    expect(race.lastPassed).toBe(2);
    const pose = race.respawnPose();
    const want = path.pointAt(path.checkpoints[2]! + RACE_CONFIG.respawnAhead, { x: 0, z: 0 });
    expect(pose.x).toBeCloseTo(want.x, 6);
    expect(pose.z).toBeCloseTo(want.z, 6);
    expect(pose.yaw).toBeCloseTo(path.headingAt(path.checkpoints[2]!), 1);
  });

  it('flags wrong way after driving backwards for a moment', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    drive(race, 100, -15, 0.5);
    expect(race.wrongWay).toBe(false);
    drive(race, 90, -15, 1);
    expect(race.wrongWay).toBe(true);
    drive(race, 80, 15, 0.2);
    expect(race.wrongWay).toBe(false);
  });

  it('progress grows steadily from the grid through laps', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    drive(race, -10, 0, 0.1);
    expect(race.progress).toBe(0);
    let last = -1;
    let s = -10;
    for (let k = 0; k < 120; k++) {
      s = drive(race, s, 40, 0.25).s;
      expect(race.progress).toBeGreaterThanOrEqual(last);
      last = race.progress;
    }
    // 120 * 0.25 s * 40 m/s = 1200 m driven from 10 m behind the line.
    expect(race.lap).toBe(2);
    expect(race.progress).toBeCloseTo(1190, -1);
    expect(race.totalTime).toBeCloseTo(30.1, 1);
  });

  it('progress does not reward skipping a checkpoint', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    // Teleport far past checkpoint 1 without crossing it: capped at checkpoint 1.
    drive(race, path.checkpoints[2]! + 20, 30, 0.5);
    expect(race.progress).toBeLessThanOrEqual(path.checkpoints[1]! + 1e-6);
  });

  it('guide point leads along the track, then locks onto the next gate', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    drive(race, 10, 20, 0.05);
    const far = race.guidePoint(40, { x: 0, z: 0 });
    const want = path.pointAt(race.s + 40, { x: 0, z: 0 });
    expect(far.x).toBeCloseTo(want.x, 6);
    expect(far.z).toBeCloseTo(want.z, 6);
    drive(race, path.checkpoints[1]! - 25, 20, 0.05);
    const gate = path.pointAt(path.checkpoints[1]!, { x: 0, z: 0 });
    const near = race.guidePoint(40, { x: 0, z: 0 });
    expect(near.x).toBeCloseTo(gate.x, 6);
    expect(near.z).toBeCloseTo(gate.z, 6);
  });

  it('knows when the car has driven past a gate it missed', () => {
    const race = new Race(path);
    drive(race, -10, 0, RACE_CONFIG.countdown + dt);
    drive(race, -10, 0, 0.05);
    expect(race.pastNextGate).toBe(0);
    // Around the outside of checkpoint 1: passes it without crossing the gate.
    drive(race, path.checkpoints[1]! - 20, 30, 2, path.halfWidth + RACE_CONFIG.gateMargin + 5);
    expect(race.next).toBe(1);
    expect(race.pastNextGate).toBeGreaterThan(30);
  });

  it('restart keeps the best lap', () => {
    const race = new Race(path, { time: 50, splits: [] });
    drive(race, -10, 0, RACE_CONFIG.countdown + 1);
    race.restart();
    expect(race.phase).toBe('countdown');
    expect(race.lapTime).toBe(0);
    expect(race.best?.time).toBe(50);
  });
});

describe('rankRacers', () => {
  it('puts finishers first by time, then the rest by distance raced', () => {
    const order = rankRacers([
      { progress: 500, finishTime: null },
      { progress: 9000, finishTime: 300 },
      { progress: 800, finishTime: null },
      { progress: 9000, finishTime: 290 },
    ]);
    expect(order).toEqual([3, 1, 2, 0]);
  });
});
