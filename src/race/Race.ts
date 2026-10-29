import type { TrackPath } from './TrackPath';

/**
 * Time-trial race state: countdown, checkpoint gates crossed in order, lap and split
 * times, best lap and wrong-way detection. Pure (no three): Game feeds it the
 * player's position each frame and turns the returned events into HUD flashes.
 */
export const RACE_CONFIG = {
  countdown: 3,
  /** A gate counts if crossed within this distance of the centreline (posts stand at halfWidth + 2.5). */
  gateMargin: 10,
  /** Respawn this far past the last checkpoint. */
  respawnAhead: 4,
  /** Wrong way: moving against the track faster than this (m/s) for longer than wrongWayDelay (s). */
  wrongWaySpeed: 4,
  wrongWayDelay: 1,
  /** Repair station: the road within this many metres either side of each checkpoint gate... */
  repairReach: 15,
  /** ...and no further than this beyond halfWidth from the centreline (the gate posts stand at +2.5). */
  repairMargin: 2,
};

export interface BestLap {
  time: number;
  /** Lap time at each checkpoint (index 0 unused). */
  splits: number[];
}

export type RaceEvent =
  | { type: 'go' }
  /** delta: split minus the best lap's split at this checkpoint (null without a best lap). */
  | { type: 'checkpoint'; index: number; split: number; delta: number | null }
  | { type: 'lap'; lap: number; time: number; best: boolean };

interface XZ {
  x: number;
  z: number;
}

export class Race {
  readonly path: TrackPath;
  phase: 'countdown' | 'racing' = 'countdown';
  countdown = RACE_CONFIG.countdown;
  /** 1-based lap in progress. */
  lap = 1;
  lapTime = 0;
  /** Seconds since GO. */
  totalTime = 0;
  /** Checkpoint to cross next; 0 = the finish line, which completes the lap. */
  next = 1;
  /** Last checkpoint crossed (respawn point). */
  lastPassed = 0;
  lastLap: number | null = null;
  best: BestLap | null;
  wrongWay = false;
  /** Track position (s) and distance from the centreline, from the last update. */
  s = 0;
  distance = 0;
  /** Signed offset from the centreline (m, + = left of the travel direction), from the last update. */
  lateral = 0;
  private splits: number[] = [];
  private wrongTimer = 0;
  private hint = -1;

  constructor(path: TrackPath, best: BestLap | null = null) {
    this.path = path;
    this.best = best;
  }

  get checkpointCount(): number {
    return this.path.checkpoints.length;
  }

  /** Back to the countdown on lap 1 (keeps the best lap). */
  restart(): void {
    this.phase = 'countdown';
    this.countdown = RACE_CONFIG.countdown;
    this.lap = 1;
    this.lapTime = 0;
    this.totalTime = 0;
    this.next = 1;
    this.lastPassed = 0;
    this.lastLap = null;
    this.s = 0;
    this.splits = [];
    this.wrongWay = false;
    this.wrongTimer = 0;
    this.hint = -1;
  }

  /** Advance by dt; the car moved from `prev` to `cur` this frame with velocity `vel`. */
  update(dt: number, prev: XZ, cur: XZ, vel: XZ): RaceEvent[] {
    const events: RaceEvent[] = [];
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown > 0) return events;
      this.phase = 'racing';
      this.countdown = 0;
      events.push({ type: 'go' });
      return events;
    }
    this.lapTime += dt;
    this.totalTime += dt;

    if (this.crossed(this.next, prev, cur)) {
      const index = this.next;
      if (index === 0) {
        const time = this.lapTime;
        const best = !this.best || time < this.best.time;
        if (best) this.best = { time, splits: this.splits.slice() };
        events.push({ type: 'lap', lap: this.lap, time, best });
        this.lastLap = time;
        this.lap++;
        this.lapTime = 0;
        this.splits = [];
      } else {
        const split = this.lapTime;
        const ref = this.best?.splits[index];
        this.splits[index] = split;
        events.push({ type: 'checkpoint', index, split, delta: ref === undefined ? null : split - ref });
      }
      this.lastPassed = index;
      this.next = (index + 1) % this.checkpointCount;
    }

    const p = this.path.project(cur.x, cur.z, this.hint);
    this.hint = p.index;
    this.s = p.s;
    this.distance = p.distance;
    this.lateral = p.lateral;
    const t = this.path.tangentAt(p.s, { x: 0, z: 0 });
    const along = vel.x * t.x + vel.z * t.z;
    if (along < -RACE_CONFIG.wrongWaySpeed) this.wrongTimer += dt;
    else if (along > 1) this.wrongTimer = 0;
    this.wrongWay = this.wrongTimer > RACE_CONFIG.wrongWayDelay;
    return events;
  }

  /**
   * Distance raced (m), for standings: whole laps plus how far past the last checkpoint crossed,
   * capped at the next one so cutting across never counts as being ahead.
   */
  get progress(): number {
    const cps = this.path.checkpoints;
    const L = this.path.length;
    const from = cps[this.lastPassed]!;
    const seg = this.path.wrap((this.next === 0 ? L : cps[this.next]!) - from) || L;
    const u = this.path.wrap(this.s - from);
    // Behind the last checkpoint (e.g. waiting on the grid) counts as zero, not as nearly a whole segment.
    const along = u > seg + (L - seg) / 2 ? 0 : Math.min(u, seg);
    const done = this.lastPassed === 0 ? 0 : from;
    return (this.lap - 1) * L + done + along;
  }

  /**
   * The car is known to be at track position s (placed on the grid): track it from there. Where the
   * track crosses itself, a search from scratch could pick the other road.
   */
  placeAt(s: number): void {
    this.hint = this.path.indexAt(s);
  }

  /** The checkpoint whose repair station the car is in (any gate with a station, crossed or not), or -1. */
  get repairStation(): number {
    if (this.distance > this.path.halfWidth + RACE_CONFIG.repairMargin) return -1;
    const cps = this.path.checkpoints;
    const L = this.path.length;
    for (let i = 0; i < cps.length; i++) {
      if (!this.path.hasStation(i)) continue;
      const u = this.path.wrap(this.s - cps[i]!);
      if (Math.min(u, L - u) <= RACE_CONFIG.repairReach) return i;
    }
    return -1;
  }

  /** How far (m) the car is along the track past the gate it still has to cross (it missed it); 0 if not past. */
  get pastNextGate(): number {
    const u = this.path.wrap(this.s - this.path.checkpoints[this.next]!);
    return u < this.path.length / 2 ? u : 0;
  }

  /**
   * Where the guide arrow points: `ahead` metres further along the track from the car,
   * or the next gate itself once it is closer than that.
   */
  guidePoint(ahead: number, out: XZ): XZ {
    const gate = this.path.checkpoints[this.next]!;
    const toGate = this.path.wrap(gate - this.s);
    return this.path.pointAt(toGate < ahead ? gate : this.s + ahead, out);
  }

  /** Just past the last checkpoint crossed, `lateral` m left of the centreline, facing along the track. */
  respawnPose(lateral = 0): { x: number; z: number; yaw: number } {
    const s = this.path.checkpoints[this.lastPassed]! + RACE_CONFIG.respawnAhead;
    const q = this.path.pointAt(s, { x: 0, z: 0 });
    const t = this.path.tangentAt(s, { x: 0, z: 0 });
    this.hint = this.path.indexAt(s);
    return { x: q.x + t.z * lateral, z: q.z - t.x * lateral, yaw: this.path.headingAt(s) };
  }

  /** Forward crossing of checkpoint `i`'s gate line between two positions. */
  private crossed(i: number, a: XZ, b: XZ): boolean {
    const s = this.path.checkpoints[i]!;
    const c = this.path.pointAt(s, { x: 0, z: 0 });
    const t = this.path.tangentAt(s, { x: 0, z: 0 });
    const da = (a.x - c.x) * t.x + (a.z - c.z) * t.z;
    const db = (b.x - c.x) * t.x + (b.z - c.z) * t.z;
    if (!(da < 0 && db >= 0)) return false;
    const f = da / (da - db);
    const x = a.x + (b.x - a.x) * f - c.x;
    const z = a.z + (b.z - a.z) * f - c.z;
    // Lateral offset along the left normal (tz, -tx).
    return Math.abs(x * t.z - z * t.x) <= this.path.halfWidth + RACE_CONFIG.gateMargin;
  }
}

/** Standings order (indices): finishers by finish time, then everyone else by distance raced. */
export function rankRacers(racers: readonly { progress: number; finishTime: number | null }[]): number[] {
  return racers
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = racers[a]!;
      const rb = racers[b]!;
      if (ra.finishTime !== null || rb.finishTime !== null) {
        if (ra.finishTime === null) return 1;
        if (rb.finishTime === null) return -1;
        return ra.finishTime - rb.finishTime;
      }
      return rb.progress - ra.progress;
    });
}
