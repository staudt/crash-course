import * as THREE from 'three';
import type { SteeringModel } from '../ai/Autopilot';
import { DERBY_RIVALS, DerbyDriver, type DerbyOther, type DerbySelf } from '../ai/DerbyDriver';
import { wasHit } from '../ai/Rival';
import type { Input } from '../core/Input';
import { DERBY_CONFIG, derbyPressure, DerbyRound, healthLossAt, type DerbyEvent } from '../derby/DerbyRound';
import { DerbyHud, type DerbyResultRow } from '../ui/DerbyHud';
import { ordinal } from '../ui/RaceHud';
import type { Car, SpawnPose } from '../vehicle/Car';
import { applyModifiers, cloneStats, DEFAULT_DIMS } from '../vehicle/CarStats';
import { ArenaWall } from '../world/ArenaWall';
import { BOWL_CONFIG } from '../world/Bowl';
import type { Director } from './Director';
import { GAME_CONFIG, type Game } from './Game';

/**
 * Destruction derby in the bowl: the player and the DERBY_RIVALS start on a ring facing the
 * centre, and it's last car running. Wrecked (or disabled) cars are out and stay where they
 * died; once the player is out the camera spectates the survivors until a winner is left.
 */
export const DERBY_DIRECTOR_CONFIG = {
  /** Starting ring radius (m): everyone faces the centre. */
  gridRadius: 60,
  /** R (flip upright, keeping the damage) at most this often (s). */
  flipCooldown: 3,
};

/** Red marker over a rival that is coming for the player. */
const MARKER_GEO = new THREE.ConeGeometry(0.7, 1.4, 4).rotateX(Math.PI);
const MARKER_MAT = new THREE.MeshBasicMaterial({ color: '#ff3b30' });

interface Fighter {
  id: number;
  name: string;
  title?: string;
  color: string;
  car: Car;
  /** null for the player. */
  driver: DerbyDriver | null;
  marker?: THREE.Mesh;
  /** Health at the last frame, to credit the damage taken since. */
  lastHealth: number;
  /** Was hunting the player last frame (to announce new hunts). */
  hunting?: boolean;
}

const _f = new THREE.Vector3();

export class DerbyDirector implements Director {
  readonly fighters: Fighter[] = [];
  readonly round: DerbyRound;
  readonly hud: DerbyHud;
  private readonly game: Game;
  private readonly steering: SteeringModel;
  /** Fighter being watched once the player is out. */
  private watching: Fighter | null = null;
  private lastAction = 0;
  private suddenDeath = false;
  private lastFlip = -Infinity;
  private time = 0;

  constructor(game: Game, container: HTMLElement) {
    this.game = game;
    new ArenaWall(game.scene, game.physics, BOWL_CONFIG, (x, z) => game.terrain.heightAt(x, z));
    this.hud = new DerbyHud(container, BOWL_CONFIG.floorRadius);
    this.round = new DerbyRound(DERBY_RIVALS.length + 1);
    const stats = game.playerStats;
    this.steering = { maxSteer: stats.maxSteer, steerFadeSpeed: stats.steerFadeSpeed, wheelbase: 2 * DEFAULT_DIMS.wheelZ, reverseSteer: stats.reverseSteer };
  }

  get player(): Fighter {
    return this.fighters[0]!;
  }

  get viewCar(): Car {
    return this.watching?.car ?? this.game.player;
  }

  restart(): void {
    const g = this.game;
    for (const f of this.fighters) {
      if (!f.driver) continue;
      g.removeCar(f.car);
      if (f.marker) g.scene.remove(f.marker);
    }
    this.fighters.length = 0;
    // A different starting order every round: who faces whom across the ring changes.
    const order = DERBY_RIVALS.map((p) => p).sort(() => Math.random() - 0.5);
    const n = order.length + 1;
    g.spawnPlayer(this.gridPose(0, n));
    g.player.healthLoss = DERBY_CONFIG.healthLoss;
    this.fighters.push({ id: 0, name: 'You', color: GAME_CONFIG.playerColor, car: g.player, driver: null, lastHealth: 1 });
    order.forEach((profile, k) => {
      const id = k + 1;
      const car = g.spawnCar(profile.color, profile.variant, this.gridPose(id, n), applyModifiers(cloneStats(), profile.car));
      car.healthLoss = DERBY_CONFIG.healthLoss;
      const driver = new DerbyDriver(profile, this.steering, BOWL_CONFIG.floorRadius, id % 2 ? 1 : -1);
      driver.playerId = 0;
      const marker = new THREE.Mesh(MARKER_GEO, MARKER_MAT);
      marker.visible = false;
      g.scene.add(marker);
      this.fighters.push({ id, name: profile.name, title: profile.title, color: profile.color, car, driver, marker, lastHealth: 1 });
    });
    this.round.restart();
    this.watching = null;
    this.lastAction = 0;
    this.suddenDeath = false;
    this.lastFlip = -Infinity;
    this.hud.hideResults();
    g.snapCamera();
  }

  handleActions(input: Input): void {
    if (input.consume('Enter')) this.restart();
    // R: back on the wheels (keeping the damage: there are no repairs in the bowl).
    if (input.consume('KeyR') && !this.round.isOut(0) && this.round.phase === 'fighting' && this.time - this.lastFlip > DERBY_DIRECTOR_CONFIG.flipCooldown) {
      this.game.player.flipUpright();
      this.lastFlip = this.time;
    }
    if (this.watching) {
      const step = input.consume('ArrowRight') || input.consume('KeyD') ? 1 : input.consume('ArrowLeft') || input.consume('KeyA') ? -1 : 0;
      if (step) this.watch(this.nextRunning(this.watching.id, step));
    }
  }

  notify(text: string, color: string): void {
    this.hud.notify(text, color);
  }

  beforePhysics(dt: number): void {
    // The tuning panel can swap in a fresh player car.
    const you = this.fighters[0];
    if (you && you.car !== this.game.player) {
      you.car = this.game.player;
      you.car.healthLoss = healthLossAt(this.round.time);
    }
    const counting = this.round.phase === 'countdown';
    const running = this.fighters.filter((f) => !this.round.isOut(f.id));
    const others = running.map((f) => this.other(f));
    for (const o of others) o.hunters = running.filter((f) => f.driver?.target === o.id && f.driver.mode === 'hunt').length;
    const pressure = this.pressure();
    for (const f of this.fighters) {
      const inp = f.car.input;
      if (counting || this.round.isOut(f.id)) {
        inp.throttle = 0;
        inp.steer = 0;
        inp.brake = 1;
        inp.boost = false;
        continue;
      }
      if (f.driver) f.driver.drive(this.self(f.car), others.filter((o) => o.id !== f.id), pressure, dt, inp);
    }
  }

  afterPhysics(dt: number): void {
    const g = this.game;
    this.time += dt;
    for (const f of this.fighters) {
      const health = f.car.health / f.car.stats.maxHealth;
      if (health < f.lastHealth) this.round.damage(f.id, (f.lastHealth - health) * f.car.stats.maxHealth);
      f.lastHealth = health;
    }
    const states = this.fighters.map((f) => {
      const t = f.car.body.translation();
      return { x: t.x, z: t.z, wrecked: f.car.wrecked };
    });
    for (const e of this.round.update(dt, states)) this.onEvent(e);
    const loss = healthLossAt(this.round.time);
    for (const f of this.fighters) f.car.healthLoss = loss;
    if (loss > DERBY_CONFIG.healthLoss && !this.suddenDeath && this.round.phase === 'fighting') {
      this.suddenDeath = true;
      this.hud.flash('SUDDEN DEATH', '#ff3b30');
      this.hud.notify('EVERY HIT HURTS MORE', '#ff3b30');
    }
    g.rig.setFraming(0, 0, 0);
    this.updateHud();
  }

  lateUpdate(dt: number): void {
    for (const f of this.fighters) {
      if (!f.driver || !f.marker) continue;
      const hunting = f.driver.target === 0 && f.driver.mode === 'hunt' && !this.round.isOut(f.id) && !this.round.isOut(0) && this.round.phase === 'fighting';
      f.marker.visible = hunting;
      f.marker.position.copy(f.car.model.root.position);
      f.marker.position.y += 3.2 + Math.sin(this.time * 6) * 0.25;
      f.marker.rotation.y = this.time * 3;
      if (hunting && !f.hunting) this.hud.notify(`${f.name.toUpperCase()} IS COMING FOR YOU`, f.color);
      f.hunting = hunting;
    }
    void dt;
  }

  /** Grudges (the AI victim of a hit gets angry at whoever drove into it), and who touched whom for the takedown and damage credit. */
  onCarContact(felt: Car, other: Car, impact: number): void {
    const me = this.fighters.find((f) => f.car === felt);
    const them = this.fighters.find((f) => f.car === other);
    if (!me || !them || this.round.phase !== 'fighting') return;
    this.round.contact(me.id, them.id);
    if (impact >= DERBY_CONFIG.actionImpact) this.lastAction = this.round.time;
    if (!me.driver) return;
    if (me.driver.target !== them.id && wasHit(motion(felt), motion(other))) me.driver.provoke(them.id, impact);
    else me.driver.rammed(them.id, impact);
  }

  /** 0..1: fewer cars left and nobody fighting push every AI to engage. */
  private pressure(): number {
    return derbyPressure(this.fighters.length, this.round.alive, this.round.time, this.lastAction);
  }

  private onEvent(e: DerbyEvent): void {
    const hud = this.hud;
    if (e.type === 'out') {
      const f = this.fighters[e.id]!;
      if (f.marker) f.marker.visible = false;
      const by = e.by !== null ? this.fighters[e.by]! : null;
      if (e.id === 0) {
        hud.flash(e.why, '#ff3b30');
        hud.notify(by ? `${by.name.toUpperCase()} TOOK YOU OUT` : `YOU ARE OUT: ${e.why}`, by?.color ?? '#ff3b30');
      } else if (e.by === 0) {
        hud.flash('TAKEDOWN!', '#ffd23f');
        hud.notify(`YOU WRECKED ${f.name.toUpperCase()}`, f.color);
      } else {
        hud.notify(by ? `${by.name.toUpperCase()} WRECKED ${f.name.toUpperCase()}` : `${f.name.toUpperCase()} IS OUT: ${e.why}`, f.color);
      }
      // The player is out: watch whoever did it (or anyone still running). The watched car went out: move on.
      if ((e.id === 0 || this.watching === f) && this.round.phase !== 'over') this.watch(by && !this.round.isOut(by.id) ? by : this.nextRunning(e.id, 1));
    }
    if (e.type === 'over') {
      if (e.winner !== null && this.watching) this.watch(this.fighters[e.winner]!);
      this.showResults(e.winner);
    }
  }

  private showResults(winner: number | null): void {
    const r = this.round;
    const rows: DerbyResultRow[] = r.standings().map((id, k) => {
      const f = this.fighters[id]!;
      const e = r.entrants[id]!;
      const by = e.by !== null ? this.fighters[e.by]!.name : null;
      return {
        place: k + 1,
        name: f.title ? `${f.name} · ${f.title}` : f.name,
        color: f.color,
        isPlayer: id === 0,
        survived: e.outAt ?? r.time,
        takedowns: e.takedowns,
        damage: Math.round(e.damage),
        status: id === winner ? 'WINNER' : e.out === 'WRECKED' && by ? `by ${by}` : (e.out ?? 'RUNNING'),
      };
    });
    const place = r.standings().indexOf(0) + 1;
    this.hud.showResults(winner === 0 ? 'YOU WIN!' : `${ordinal(place).toUpperCase()} PLACE`, rows, 'Enter: go again · Esc: menu');
  }

  private updateHud(): void {
    const r = this.round;
    const view = this.viewCar;
    const t = view.body.translation();
    const f = view.forward(_f);
    this.hud.update({
      phase: r.phase,
      countdown: r.countdown,
      time: r.time,
      alive: r.alive,
      total: this.fighters.length,
      cars: this.fighters.map((x) => {
        const p = x.car.body.translation();
        return {
          name: x.name,
          color: x.color,
          health: Math.max(0, x.car.health / x.car.stats.maxHealth),
          out: r.entrants[x.id]!.out,
          isPlayer: !x.driver,
          huntingPlayer: !!x.hunting,
          x: p.x,
          z: p.z,
        };
      }),
      view: { x: t.x, z: t.z, heading: Math.atan2(f.x, f.z) },
      spectating: this.watching && r.phase !== 'over' ? this.watching.name : null,
    });
  }

  private watch(f: Fighter | null): void {
    this.watching = f;
    if (f) this.game.snapCamera();
  }

  /** The next running fighter after `id` (in `step` direction), or null if none. */
  private nextRunning(id: number, step: number): Fighter | null {
    const n = this.fighters.length;
    for (let k = 1; k <= n; k++) {
      const f = this.fighters[(((id + step * k) % n) + n) % n]!;
      if (f.id !== 0 && !this.round.isOut(f.id)) return f;
    }
    return null;
  }

  /** Slot `i` of `n` on the starting ring, facing the centre; the player (slot 0) starts on the camera's side. */
  private gridPose(i: number, n: number): SpawnPose {
    const a = -Math.PI * 0.75 + (i / n) * Math.PI * 2;
    const x = Math.cos(a) * DERBY_DIRECTOR_CONFIG.gridRadius;
    const z = Math.sin(a) * DERBY_DIRECTOR_CONFIG.gridRadius;
    return { position: { x, y: 0, z }, yaw: Math.atan2(-x, -z) };
  }

  private self(car: Car): DerbySelf {
    const t = car.body.translation();
    const f = car.forward(_f).setY(0).normalize();
    return { x: t.x, z: t.z, fx: f.x, fz: f.z, speed: car.forwardSpeed, health: car.health / car.stats.maxHealth };
  }

  private other(f: Fighter): DerbyOther {
    const t = f.car.body.translation();
    const v = f.car.body.linvel();
    const fw = f.car.forward(_f).setY(0).normalize();
    return { id: f.id, x: t.x, z: t.z, vx: v.x, vz: v.z, fx: fw.x, fz: fw.z, health: f.car.health / f.car.stats.maxHealth };
  }
}

const motion = (car: Car) => {
  const t = car.body.translation();
  const v = car.body.linvel();
  return { x: t.x, z: t.z, vx: v.x, vz: v.z };
};
