import * as THREE from 'three';
import { Autopilot, type SteeringModel } from '../ai/Autopilot';
import { RIVALS, RivalDriver, wasHit, type OtherCar } from '../ai/Rival';
import { GuideArrow } from '../race/GuideArrow';
import { Race, rankRacers, type BestLap, type RaceEvent } from '../race/Race';
import { ordinal, type ResultRow } from '../ui/RaceHud';
import type { Car, SpawnPose } from '../vehicle/Car';
import { applyModifiers, cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { cameraFraming } from './CameraFraming';
import { GAME_CONFIG, type Game } from './Game';

/**
 * Runs the race on top of the Game world: the grid, the player's and rivals' Race
 * trackers, AI driving and rescues, standings, the finish and the results screen.
 * 'race' = the player against the RIVALS over DIRECTOR_CONFIG.laps; 'timetrial' = alone, endless laps.
 */
export type RaceMode = 'race' | 'timetrial';

export const DIRECTOR_CONFIG = {
  laps: 2,
  /** Grid: two staggered columns behind the line. */
  gridOffset: 12,
  gridRow: 10,
  gridStagger: 5,
  gridLane: 3.5,
  /** Player's grid slot (0 = pole). */
  playerSlot: 3,
  /** After the finish the player's car drives itself at this pace while the results show. */
  cooldownPace: 0.6,
  /** The guide arrow follows the route this far ahead of the player (or points at the gate when closer). */
  guideAhead: 45,
  /** The arrow previews bends tighter than bendRadius (m) starting within bendLook (m). */
  bendLook: 150,
  bendRadius: 150,
  /** Respawn spots tried across the road (lateral m), and the clearance each needs from other cars. */
  respawnLanes: [0, 4, -4, 6.5, -6.5],
  respawnClear: 6,
  /** Contact blame: the car closing on the other faster by more than this (m/s) is the attacker, and only its victim gets angry. */
  blameMargin: 1,
};

/** Red marker hovering over a rival that is out for revenge (or bullying). */
const MARKER_GEO = new THREE.ConeGeometry(0.7, 1.4, 4).rotateX(Math.PI);
const MARKER_MAT = new THREE.MeshBasicMaterial({ color: '#ff3b30' });

interface Racer {
  /** Index in `racers` for this race; rivals keep grudges by id. */
  id: number;
  name: string;
  /** Personality tag (rivals). */
  title?: string;
  color: string;
  car: Car;
  race: Race;
  /** null for the player. */
  driver: RivalDriver | null;
  prev: { x: number; z: number };
  finishTime: number | null;
  /** Angry marker (rivals). */
  marker?: THREE.Mesh;
  /** Who this rival was hunting last frame, to announce new hunts on the player. */
  lastTarget?: number | null;
}

const _f = new THREE.Vector3();

export class RaceDirector {
  mode: RaceMode = 'race';
  readonly racers: Racer[] = [];
  readonly player: Racer;
  private readonly game: Game;
  private readonly steering: SteeringModel;
  private readonly cooldown: Autopilot;
  private readonly arrow: GuideArrow;
  private standings: number[] = [];
  private resultsShown = false;
  private time = 0;

  constructor(game: Game) {
    this.game = game;
    const stats = game.playerStats;
    this.steering = { maxSteer: stats.maxSteer, steerFadeSpeed: stats.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ };
    this.cooldown = new Autopilot(game.track, this.steering);
    this.cooldown.pace = DIRECTOR_CONFIG.cooldownPace;
    this.arrow = new GuideArrow(game.scene);
    this.player = {
      id: 0,
      name: 'You',
      color: GAME_CONFIG.playerColor,
      car: game.player,
      race: new Race(game.track, loadBest(game.track.def.id)),
      driver: null,
      prev: { x: 0, z: 0 },
      finishTime: null,
    };
  }

  get playerRace(): Race {
    return this.player.race;
  }

  /** Fresh grid, cars and countdown, in `mode` (default: the current one). */
  restart(mode: RaceMode = this.mode): void {
    const g = this.game;
    this.mode = mode;
    for (const r of this.racers) {
      if (!r.driver) continue;
      g.removeCar(r.car);
      if (r.marker) g.scene.remove(r.marker);
    }
    this.racers.length = 0;

    if (mode === 'timetrial') {
      this.placePlayer(this.gridPose(-1));
    } else {
      let next = 0;
      for (let slot = 0; slot <= RIVALS.length; slot++) {
        if (slot === DIRECTOR_CONFIG.playerSlot) {
          this.placePlayer(this.gridPose(slot));
          continue;
        }
        const profile = RIVALS[next++]!;
        const car = g.spawnCar(profile.color, profile.variant, this.gridPose(slot), applyModifiers(cloneStats(), profile.car));
        const marker = new THREE.Mesh(MARKER_GEO, MARKER_MAT);
        marker.visible = false;
        g.scene.add(marker);
        this.racers.push({
          id: 0,
          name: profile.name,
          title: profile.title,
          color: profile.color,
          car,
          race: new Race(g.track),
          driver: new RivalDriver(g.track, this.steering, profile),
          prev: { x: 0, z: 0 },
          finishTime: null,
          marker,
          lastTarget: null,
        });
      }
    }
    this.racers.forEach((r, i) => {
      r.id = i;
      r.race.restart();
      r.finishTime = null;
      r.driver?.forgetAll();
      this.syncPrev(r);
    });
    this.cooldown.reset();
    this.arrow.reset();
    this.resultsShown = false;
    g.raceHud.hideResults();
    g.trackProps.resetStakes();
    g.trackProps.setNextCheckpoint(this.player.race.next);
    g.snapCamera();
  }

  /** R: the player's car, fresh, just past their last checkpoint. */
  respawnPlayer(): void {
    if (this.player.finishTime !== null) return;
    this.respawn(this.player);
    this.arrow.reset();
    this.game.snapCamera();
  }

  /** Before physics: hold everyone during the countdown, drive the rivals (and the player after the finish). */
  beforePhysics(dt: number): void {
    const counting = this.player.race.phase === 'countdown';
    for (const r of this.racers) {
      const inp = r.car.input;
      if (counting) {
        inp.throttle = 0;
        inp.steer = 0;
        inp.brake = 1;
        continue;
      }
      if (r.driver) r.driver.drive(this.state(r.car), this.others(r), this.player.race.progress - r.race.progress, dt, inp);
      else if (r.finishTime !== null) this.cooldown.drive(this.state(r.car), inp);
    }
  }

  /** After physics: gates, laps, finishes, rescues, standings and the race HUD. */
  afterPhysics(dt: number): void {
    const g = this.game;
    for (const r of this.racers) {
      const t = r.car.body.translation();
      const v = r.car.body.linvel();
      for (const e of r.race.update(dt, r.prev, t, v)) this.onEvent(r, e);
      r.prev.x = t.x;
      r.prev.z = t.z;
      if (r.driver && r.race.phase === 'racing' && r.driver.needsRescue(r.car.speed, r.car.wrecked, dt, r.race.pastNextGate)) this.respawn(r);
    }
    this.standings = rankRacers(this.racers.map((r) => ({ progress: r.race.progress, finishTime: r.finishTime })));
    if (this.resultsShown) this.showResults();

    const race = this.player.race;
    const pt = g.player.body.translation();
    const others = this.racers.filter((r) => r !== this.player).map((r) => xz(r.car));
    const frame = cameraFraming(g.track, race.s, pt, g.player.forwardSpeed, others);
    g.rig.setFraming(frame.zoom, frame.lookX, frame.lookZ);
    const f = g.player.forward(_f);
    const isRace = this.mode === 'race';
    g.raceHud.update({
      phase: race.phase,
      countdown: race.countdown,
      lap: race.lap,
      lapTime: race.lapTime,
      bestLap: race.best?.time ?? null,
      lastLap: race.lastLap,
      nextCheckpoint: race.next,
      checkpointCount: race.checkpointCount,
      wrongWay: race.wrongWay && this.player.finishTime === null,
      car: { x: pt.x, z: pt.z, heading: Math.atan2(f.x, f.z) },
      position: isRace ? this.standings.indexOf(this.racers.indexOf(this.player)) + 1 : undefined,
      racers: isRace ? this.racers.length : undefined,
      totalLaps: isRace ? DIRECTOR_CONFIG.laps : undefined,
      opponents: this.racers.filter((r) => r.driver).map((r) => ({ ...xz(r.car), color: r.color })),
    });
  }

  /** After the camera has moved: the guide arrow is placed in screen space. */
  lateUpdate(dt: number): void {
    const g = this.game;
    this.arrow.visible = this.player.finishTime === null;
    const race = this.player.race;
    const target = race.guidePoint(DIRECTOR_CONFIG.guideAhead, { x: 0, z: 0 });
    const bend = g.track.nextBend(race.s, DIRECTOR_CONFIG.bendLook, DIRECTOR_CONFIG.bendRadius);
    const placement = g.rig.mode === 'chase' ? 'ahead' : 'edge';
    this.arrow.update(dt, g.rig.camera, placement, g.rig.viewYaw, g.player.model.root.position, target, bend, (x, z) => g.terrain.heightAt(x, z));

    this.time += dt;
    for (const r of this.racers) {
      if (!r.driver || !r.marker) continue;
      const hunting = r.driver.target;
      r.marker.visible = hunting !== null && r.finishTime === null;
      r.marker.position.copy(r.car.model.root.position);
      r.marker.position.y += 3.2 + Math.sin(this.time * 6) * 0.25;
      r.marker.rotation.y = this.time * 3;
      if (hunting === this.player.id && r.lastTarget !== this.player.id && this.player.finishTime === null) {
        g.raceHud.notify(`${r.name.toUpperCase()} IS COMING FOR YOU`, r.color);
      }
      r.lastTarget = hunting;
    }
  }

  /**
   * Two racers touched (from `felt`'s point of view, with the jolt it felt). The car that drove into
   * the other is the attacker: its victim, if an AI, gets angry at it, and an AI attacker that got
   * the car it was after has its revenge. A mutual crash angers both.
   */
  onCarContact(felt: Car, other: Car, impact: number): void {
    const me = this.racers.find((r) => r.car === felt);
    const them = this.racers.find((r) => r.car === other);
    if (!me?.driver || !them || this.player.race.phase !== 'racing') return;
    if (wasHit(motion(felt), motion(other), DIRECTOR_CONFIG.blameMargin)) me.driver.provoke(them.id, impact);
    else me.driver.rammed(them.id);
  }

  private onEvent(r: Racer, e: RaceEvent): void {
    const g = this.game;
    const isPlayer = r === this.player;
    if (e.type === 'lap' && this.mode === 'race' && e.lap === DIRECTOR_CONFIG.laps && r.finishTime === null) {
      r.finishTime = r.race.totalTime;
      if (isPlayer) {
        this.cooldown.reset();
        this.resultsShown = true;
      }
    }
    if (!isPlayer) return;
    if (e.type === 'checkpoint') g.raceHud.flashSplit(e.delta);
    if (e.type === 'lap') {
      if (!this.resultsShown) g.raceHud.flashLap(e.time, e.best);
      if (e.best && r.race.best) saveBest(g.track.def.id, r.race.best);
    }
    g.trackProps.setNextCheckpoint(r.race.next);
  }

  private showResults(): void {
    const rows: ResultRow[] = this.standings.map((i, k) => {
      const r = this.racers[i]!;
      return { position: k + 1, name: r.title ? `${r.name} · ${r.title}` : r.name, color: r.color, time: r.finishTime, isPlayer: r === this.player, status: r.finishTime === null ? `lap ${r.race.lap}` : undefined };
    });
    const place = this.standings.indexOf(this.racers.indexOf(this.player)) + 1;
    this.game.raceHud.showResults(place === 1 ? 'YOU WIN!' : `${ordinal(place).toUpperCase()} PLACE`, rows, 'Enter: race again · T: time trial');
  }

  private placePlayer(pose: SpawnPose): void {
    this.game.spawnPlayer(pose);
    this.player.car = this.game.player;
    this.racers.push(this.player);
  }

  private respawn(r: Racer): void {
    const g = this.game;
    // First spot across the road with no car on it, so two cars rescued together don't spawn inside each other.
    const others = this.racers.filter((o) => o !== r).map((o) => xz(o.car));
    let p = r.race.respawnPose();
    for (const lateral of DIRECTOR_CONFIG.respawnLanes) {
      p = r.race.respawnPose(lateral);
      if (others.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > DIRECTOR_CONFIG.respawnClear)) break;
    }
    const pose = { position: { x: p.x, y: 0, z: p.z }, yaw: p.yaw };
    if (r === this.player) {
      g.spawnPlayer(pose);
      r.car = g.player;
    } else {
      g.removeCar(r.car);
      const profile = r.driver!.profile;
      r.car = g.spawnCar(profile.color, profile.variant, pose, applyModifiers(cloneStats(), profile.car));
      r.driver!.reset();
    }
    this.syncPrev(r);
  }

  /** Grid slot pose (slot -1 = alone on the centreline). */
  private gridPose(slot: number): SpawnPose {
    const c = DIRECTOR_CONFIG;
    const track = this.game.track;
    const row = Math.floor(Math.max(0, slot) / 2);
    const col = slot < 0 ? -1 : slot % 2;
    const s = -c.gridOffset - row * c.gridRow - (col === 1 ? c.gridStagger : 0);
    const lat = col < 0 ? 0 : col === 0 ? c.gridLane : -c.gridLane;
    const q = track.pointAt(s, { x: 0, z: 0 });
    const t = track.tangentAt(s, { x: 0, z: 0 });
    return { position: { x: q.x + t.z * lat, y: 0, z: q.z - t.x * lat }, yaw: track.headingAt(s) };
  }

  private state(car: Car): { x: number; z: number; fx: number; fz: number; speed: number } {
    const t = car.body.translation();
    const f = car.forward(_f).setY(0).normalize();
    return { x: t.x, z: t.z, fx: f.x, fz: f.z, speed: car.forwardSpeed };
  }

  private others(self: Racer): OtherCar[] {
    const mine = self.race.progress;
    return this.racers
      .filter((r) => r !== self)
      .map((r) => {
        const v = r.car.body.linvel();
        return { id: r.id, ...xz(r.car), vx: v.x, vz: v.z, ahead: r.race.progress - mine, offTrack: r.race.distance };
      });
  }

  private syncPrev(r: Racer): void {
    const t = r.car.body.translation();
    r.prev.x = t.x;
    r.prev.z = t.z;
  }
}

const motion = (car: Car) => {
  const t = car.body.translation();
  const v = car.body.linvel();
  return { x: t.x, z: t.z, vx: v.x, vz: v.z };
};

const xz = (car: Car) => {
  const t = car.body.translation();
  return { x: t.x, z: t.z };
};

const bestKey = (id: string) => `desert.best.${id}`;
function loadBest(id: string): BestLap | null {
  try {
    const raw = localStorage.getItem(bestKey(id));
    const best = raw ? (JSON.parse(raw) as BestLap) : null;
    return best && typeof best.time === 'number' && Array.isArray(best.splits) ? best : null;
  } catch {
    return null;
  }
}
function saveBest(id: string, best: BestLap): void {
  try {
    localStorage.setItem(bestKey(id), JSON.stringify(best));
  } catch {
    // Storage unavailable (private mode): the best lap lasts for this session only.
  }
}
