import * as THREE from 'three';
import { Autopilot, type SteeringModel } from '../ai/Autopilot';
import { RIVALS, RivalDriver, wasHit, type OtherCar, type RivalSelf } from '../ai/Rival';
import { CAMERA_CONFIG } from '../core/CameraRig';
import type { Input } from '../core/Input';
import { CheckpointBeacon } from '../race/CheckpointBeacon';
import { GuideArrow } from '../race/GuideArrow';
import { Race, rankRacers, type BestLap, type RaceEvent } from '../race/Race';
import { TrackMarkings } from '../race/TrackMarkings';
import type { TrackPath } from '../race/TrackPath';
import { TrackProps } from '../race/TrackProps';
import { ordinal, RaceHud, type RaceHudState, type ResultRow } from '../ui/RaceHud';
import type { Car, SpawnPose } from '../vehicle/Car';
import { applyModifiers, cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { ConcreteWall } from '../world/ArenaWall';
import { TRACK_WALL_CONFIG, trackWallBlocks } from '../world/TrackWalls';
import { cameraFraming } from './CameraFraming';
import type { Director } from './Director';
import { GAME_CONFIG, type Game } from './Game';

/**
 * Runs the race on top of the Game world: the grid, the player's and rivals' Race
 * trackers, AI driving and rescues, standings, the finish and the results screen.
 * 'race' = the player against the RIVALS over `laps` (the track's, or DIRECTOR_CONFIG.laps); 'timetrial' = alone, endless laps.
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
  /** Parked cars: this many (unless the track says), this far off the road edge, spread around the lap. */
  parkedCount: 8,
  parkedOffset: 7,
  parkedColors: ['#d8432f', '#2f9fd8', '#e8c547', '#f2ede1', '#3fae6a', '#7a4fc9', '#e07b2f', '#5a6f7d'],
  /** Rivals get no rescues: one that gains less than stallProgress m in stallTime s is out of the race (a last resort). */
  stallProgress: 20,
  stallTime: 45,
  /** A rival's anger at the player rising past this shows "<NAME> IS ANGRY" (it fights from RIVAL_CONFIG.fightAt). */
  angryNotice: 0.3,
};

/** Why a rival is out of the race. */
type Retired = 'WRECKED' | 'STUCK';

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
  /** Out of the race (rivals only; the player has R). */
  out?: Retired | null;
  /** Stall watch: best progress so far and seconds since it last grew by stallProgress. */
  stall?: { best: number; time: number };
  /** Angry marker (rivals). */
  marker?: THREE.Mesh;
  /** Who this rival was hunting last frame, to announce new hunts on the player. */
  lastTarget?: number | null;
  /** Its anger at the player was over DIRECTOR_CONFIG.angryNotice (announced once per rise). */
  angry?: boolean;
}

const _f = new THREE.Vector3();

export class RaceDirector implements Director {
  mode: RaceMode = 'race';
  readonly racers: Racer[] = [];
  readonly player: Racer;
  readonly track: TrackPath;
  readonly trackProps: TrackProps;
  readonly raceHud: RaceHud;
  readonly parked: Car[] = [];
  private readonly game: Game;
  private readonly steering: SteeringModel;
  private readonly cooldown: Autopilot;
  private readonly arrow: GuideArrow;
  /** Marks the next checkpoint on tracks guided by checkpoints (the arrow's bend preview is for long tracks). */
  private readonly beacon: CheckpointBeacon | null;
  private standings: number[] = [];
  private resultsShown = false;
  private time = 0;
  /** The player's car was mending last frame (to announce when it's done). */
  private repairing = false;

  constructor(game: Game, track: TrackPath, container: HTMLElement) {
    this.game = game;
    this.track = track;
    this.trackProps = new TrackProps(game.scene, game.physics, track);
    new TrackMarkings(game.scene, track);
    if (track.def.walls) new ConcreteWall(game.scene, game.physics, trackWallBlocks(track), TRACK_WALL_CONFIG, (x, z) => game.terrain.heightAt(x, z));
    this.raceHud = new RaceHud(container);
    const d = CAMERA_CONFIG.direction;
    const view = Math.hypot(d.x, d.z);
    this.raceHud.setTrack(
      Array.from({ length: track.count }, (_, i) => ({ x: track.xs[i]!, z: track.zs[i]! })),
      track.checkpoints.map((s) => track.pointAt(s, { x: 0, z: 0 })),
      { x: -d.x / view, z: -d.z / view },
    );
    const stats = game.playerStats;
    this.steering = { maxSteer: stats.maxSteer, steerFadeSpeed: stats.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ, reverseSteer: stats.reverseSteer };
    this.cooldown = new Autopilot(this.track, this.steering);
    this.cooldown.pace = DIRECTOR_CONFIG.cooldownPace;
    this.arrow = new GuideArrow(game.scene);
    this.beacon = track.def.guide === 'checkpoints' ? new CheckpointBeacon(game.scene) : null;
    this.player = {
      id: 0,
      name: 'You',
      color: GAME_CONFIG.playerColor,
      car: game.player,
      race: new Race(this.track, loadBest(this.track.def.id)),
      driver: null,
      prev: { x: 0, z: 0 },
      finishTime: null,
    };
  }

  /** Laps in a race on this track. */
  get laps(): number {
    return this.track.def.laps ?? DIRECTOR_CONFIG.laps;
  }

  get playerRace(): Race {
    return this.player.race;
  }

  get viewCar(): Car {
    return this.game.player;
  }

  handleActions(input: Input): void {
    // R = a fresh, repaired car at the last checkpoint (the lost time is the penalty).
    // Getting stuck upside down auto-flips the car in place without repairing it.
    if (input.consume('KeyR')) this.respawnPlayer();
    if (input.consume('Enter')) this.restart();
    if (input.consume('KeyT')) this.restart(this.mode === 'race' ? 'timetrial' : 'race');
  }

  notify(text: string, color: string): void {
    this.raceHud.notify(text, color);
  }

  respawnParked(): void {
    const g = this.game;
    for (const car of this.parked) g.removeCar(car);
    this.parked.length = 0;
    const c = DIRECTOR_CONFIG;
    const q = { x: 0, z: 0 };
    const t = { x: 0, z: 0 };
    const count = this.track.def.parked ?? c.parkedCount;
    for (let i = 0; i < count; i++) {
      // Spread around the lap, alternating sides, clear of the gates.
      const s = ((i + 0.5) / count) * this.track.length;
      const side = i % 2 ? 1 : -1;
      const off = side * (this.track.halfWidth + c.parkedOffset);
      this.track.pointAt(s, q);
      this.track.tangentAt(s, t);
      const pose = { position: { x: q.x + t.z * off, y: 0, z: q.z - t.x * off }, yaw: this.track.headingAt(s) + side * (0.4 + (i % 3) * 0.3) };
      const car = g.spawnCar(c.parkedColors[i % c.parkedColors.length]!, i % 3 === 2 ? 'pickup' : 'sedan', pose);
      car.input.brake = 1; // parked: brakes on, so they don't roll down dunes
      this.parked.push(car);
    }
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
          race: new Race(this.track),
          driver: new RivalDriver(this.track, this.steering, profile),
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
      // Start tracking each car from its grid spot (on a figure 8 the grid may stand on the crossing).
      // Racers are listed in grid-slot order.
      const s = this.gridS(mode === 'timetrial' ? -1 : i);
      r.race.placeAt(s);
      r.driver?.pilot.reset(s);
      r.finishTime = null;
      r.out = null;
      r.angry = false;
      r.stall = { best: 0, time: 0 };
      r.driver?.forgetAll();
      if (r.driver) r.driver.playerId = this.player.id;
      this.syncPrev(r);
    });
    this.cooldown.reset();
    this.arrow.reset();
    this.resultsShown = false;
    this.raceHud.hideResults();
    this.trackProps.resetStakes();
    this.setNextCheckpoint(this.player.race.next);
    if (this.parked.length === 0) this.respawnParked();
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
    // The tuning panel can swap in a fresh player car (same spot, so the gate tracking holds).
    this.player.car = this.game.player;
    const counting = this.player.race.phase === 'countdown';
    for (const r of this.racers) {
      const inp = r.car.input;
      if (counting || r.out) {
        inp.throttle = 0;
        inp.steer = 0;
        inp.brake = 1;
        continue;
      }
      if (r.driver) {
        r.driver.drive(this.state(r), this.others(r), this.player.race.progress - r.race.progress, dt, inp);
        r.car.powerScale = r.driver.power;
      }
      else if (r.finishTime !== null) this.cooldown.drive(this.state(r), inp);
    }
  }

  /** After physics: gates, laps, finishes, retirements, repairs, standings and the race HUD. */
  afterPhysics(dt: number): void {
    const g = this.game;
    for (const r of this.racers) {
      const t = r.car.body.translation();
      const v = r.car.body.linvel();
      for (const e of r.race.update(dt, r.prev, t, v)) this.onEvent(r, e);
      r.prev.x = t.x;
      r.prev.z = t.z;
      if (r.driver) this.watchRival(r, dt);
    }
    this.trackProps.update();
    const repair = this.updateRepair(dt);
    this.standings = rankRacers(this.racers.map((r) => ({ progress: r.race.progress, finishTime: r.finishTime })));
    if (this.resultsShown) this.showResults();

    const race = this.player.race;
    const pt = g.player.body.translation();
    const others = this.racers.filter((r) => r !== this.player).map((r) => xz(r.car));
    const frame = cameraFraming(this.track, race.s, pt, g.player.forwardSpeed, others);
    g.rig.setFraming(frame.zoom, frame.lookX, frame.lookZ);
    const f = g.player.forward(_f);
    const isRace = this.mode === 'race';
    this.raceHud.update({
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
      totalLaps: isRace ? this.laps : undefined,
      opponents: this.racers.filter((r) => r.driver).map((r) => ({ ...xz(r.car), color: r.color })),
      repair,
    });
  }

  /** No rescues for rivals: a wreck is out of the race, and so (as a last resort) is a car that stopped making progress. */
  private watchRival(r: Racer, dt: number): void {
    if (r.out || r.finishTime !== null || r.race.phase !== 'racing') return;
    if (r.car.wrecked) {
      this.retire(r, 'WRECKED');
      return;
    }
    const stall = (r.stall ??= { best: r.race.progress, time: 0 });
    if (r.race.progress > stall.best + DIRECTOR_CONFIG.stallProgress) {
      stall.best = r.race.progress;
      stall.time = 0;
    } else if ((stall.time += dt) > DIRECTOR_CONFIG.stallTime) {
      this.retire(r, 'STUCK');
    }
  }

  private retire(r: Racer, why: Retired): void {
    r.out = why;
    if (r.marker) r.marker.visible = false;
    if (this.player.finishTime === null) this.raceHud.notify(`${r.name.toUpperCase()} IS OUT: ${why}`, r.color);
  }

  /**
   * Every car still racing mends for as long as it is inside a checkpoint's repair station
   * (Race.repairStation): flat out through it fixes next to nothing, slowing down fixes some, stopping fixes it all.
   * Returns the HUD's repair line state for the player.
   */
  private updateRepair(dt: number): RaceHudState['repair'] {
    let hud: RaceHudState['repair'] = null;
    for (const r of this.racers) {
      const car = r.car;
      const inStation = r.race.phase === 'racing' && r.finishTime === null && !r.out && r.race.repairStation >= 0;
      const fixing = inStation && car.damaged;
      if (fixing) car.repair(dt);
      if (r !== this.player) continue;
      if (this.repairing && inStation && !car.damaged) this.raceHud.notify('CAR REPAIRED', '#36d17a');
      this.repairing = fixing;
      if (fixing) hud = { health: car.health / car.stats.maxHealth };
    }
    return hud;
  }

  /** After the camera has moved: the guide arrow is placed in screen space (or the checkpoint beacon pulses). */
  lateUpdate(dt: number): void {
    const g = this.game;
    const guiding = this.player.finishTime === null;
    this.arrow.visible = guiding && !this.beacon;
    if (this.beacon) {
      this.beacon.visible = guiding;
      this.beacon.update(dt);
    } else {
      const race = this.player.race;
      const target = race.guidePoint(DIRECTOR_CONFIG.guideAhead, { x: 0, z: 0 });
      const bend = this.track.nextBend(race.s, DIRECTOR_CONFIG.bendLook, DIRECTOR_CONFIG.bendRadius);
      const placement = g.rig.mode === 'fixed' ? 'edge' : 'top';
      this.arrow.update(dt, g.rig.camera, placement, g.rig.viewYaw, g.player.model.root.position, target, bend, (x, z) => g.terrain.heightAt(x, z));
    }
    this.updateMarkers(dt);
  }

  /** Red markers over hunting rivals, and the HUD's "ANGRY" / "COMING FOR YOU" notices. */
  private updateMarkers(dt: number): void {
    this.time += dt;
    for (const r of this.racers) {
      if (!r.driver || !r.marker) continue;
      const hunting = r.driver.target;
      r.marker.visible = hunting !== null && r.finishTime === null && !r.out;
      r.marker.position.copy(r.car.model.root.position);
      r.marker.position.y += 3.2 + Math.sin(this.time * 6) * 0.25;
      r.marker.rotation.y = this.time * 3;
      const racing = this.player.finishTime === null && !r.out;
      if (hunting === this.player.id && r.lastTarget !== this.player.id && racing) {
        this.raceHud.notify(`${r.name.toUpperCase()} IS COMING FOR YOU`, r.color);
      }
      r.lastTarget = hunting;
      const anger = r.driver.angerAt(this.player.id);
      if (!r.angry && anger > DIRECTOR_CONFIG.angryNotice && hunting !== this.player.id && racing) this.raceHud.notify(`${r.name.toUpperCase()} IS ANGRY`, r.color);
      r.angry = anger > DIRECTOR_CONFIG.angryNotice * 0.5 ? r.angry || anger > DIRECTOR_CONFIG.angryNotice : false;
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
    // A hunter touching its target got its hit, whichever way the blame goes (a shoved car bounces back into the shover).
    if (me.driver.target !== them.id && wasHit(motion(felt), motion(other), DIRECTOR_CONFIG.blameMargin)) me.driver.provoke(them.id, impact);
    else me.driver.rammed(them.id, impact);
  }

  private onEvent(r: Racer, e: RaceEvent): void {
    const isPlayer = r === this.player;
    if (e.type === 'lap' && this.mode === 'race' && e.lap === this.laps && r.finishTime === null) {
      r.finishTime = r.race.totalTime;
      if (isPlayer) {
        this.cooldown.reset();
        this.resultsShown = true;
      }
    }
    if (!isPlayer) return;
    if (e.type === 'checkpoint') this.raceHud.flashSplit(e.delta);
    if (e.type === 'lap') {
      if (!this.resultsShown) this.raceHud.flashLap(e.time, e.best);
      if (e.best && r.race.best) saveBest(this.track.def.id, r.race.best);
    }
    this.setNextCheckpoint(r.race.next);
  }

  /** The player's next gate: lit up, and the beacon on it. */
  private setNextCheckpoint(i: number): void {
    this.trackProps.setNextCheckpoint(i);
    const s = this.track.checkpoints[i]!;
    const p = this.track.pointAt(s, { x: 0, z: 0 });
    this.beacon?.place(p.x, this.track.heightAt(s), p.z);
  }

  private showResults(): void {
    const rows: ResultRow[] = this.standings.map((i, k) => {
      const r = this.racers[i]!;
      return { position: k + 1, name: r.title ? `${r.name} · ${r.title}` : r.name, color: r.color, time: r.finishTime, isPlayer: r === this.player, status: r.finishTime !== null ? undefined : (r.out ?? `lap ${r.race.lap}`) };
    });
    const place = this.standings.indexOf(this.racers.indexOf(this.player)) + 1;
    this.raceHud.showResults(place === 1 ? 'YOU WIN!' : `${ordinal(place).toUpperCase()} PLACE`, rows, 'Enter: race again · T: time trial');
  }

  private placePlayer(pose: SpawnPose): void {
    this.game.spawnPlayer(pose);
    this.player.car = this.game.player;
    this.racers.push(this.player);
  }

  /** The player's R: a fresh car just past the last checkpoint. Rivals get no rescues. */
  private respawn(r: Racer): void {
    const g = this.game;
    // First spot across the road with no car on it.
    const others = this.racers.filter((o) => o !== r).map((o) => xz(o.car));
    let p = r.race.respawnPose();
    for (const lateral of DIRECTOR_CONFIG.respawnLanes) {
      p = r.race.respawnPose(lateral);
      if (others.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > DIRECTOR_CONFIG.respawnClear)) break;
    }
    g.spawnPlayer({ position: { x: p.x, y: 0, z: p.z }, yaw: p.yaw });
    r.car = g.player;
    this.syncPrev(r);
  }

  /** Track position of a grid slot (slot -1 = alone on the centreline). */
  private gridS(slot: number): number {
    const c = DIRECTOR_CONFIG;
    const row = Math.floor(Math.max(0, slot) / 2);
    const col = slot < 0 ? -1 : slot % 2;
    return -c.gridOffset - row * c.gridRow - (col === 1 ? c.gridStagger : 0);
  }

  /** Grid slot pose (slot -1 = alone on the centreline). */
  private gridPose(slot: number): SpawnPose {
    const c = DIRECTOR_CONFIG;
    const track = this.track;
    const col = slot < 0 ? -1 : slot % 2;
    const s = this.gridS(slot);
    const lat = col < 0 ? 0 : col === 0 ? c.gridLane : -c.gridLane;
    const q = track.pointAt(s, { x: 0, z: 0 });
    const t = track.tangentAt(s, { x: 0, z: 0 });
    return { position: { x: q.x + t.z * lat, y: 0, z: q.z - t.x * lat }, yaw: track.headingAt(s) };
  }

  private state(r: Racer): RivalSelf {
    const car = r.car;
    const t = car.body.translation();
    const f = car.forward(_f).setY(0).normalize();
    return { x: t.x, z: t.z, fx: f.x, fz: f.z, speed: car.forwardSpeed, health: car.health / car.stats.maxHealth, pastGate: r.race.pastNextGate };
  }

  private others(self: Racer): OtherCar[] {
    const mine = self.race.progress;
    return this.racers
      .filter((r) => r !== self)
      .map((r) => {
        const v = r.car.body.linvel();
        return { id: r.id, ...xz(r.car), vx: v.x, vz: v.z, ahead: r.race.progress - mine, offTrack: r.race.distance, lateral: r.race.lateral, out: !!r.out };
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
