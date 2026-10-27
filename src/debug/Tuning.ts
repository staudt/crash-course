import GUI from 'lil-gui';
import * as THREE from 'three';
import { CAMERA_CONFIG } from '../core/CameraRig';
import { FRAMING_CONFIG } from '../game/CameraFraming';
import type { Game } from '../game/Game';
import { DEFAULT_STATS, type CarStats } from '../vehicle/CarStats';

const STORAGE_KEY = 'desert.tuning.v2';

type NumKey = { [K in keyof CarStats]: CarStats[K] extends number ? K : never }[keyof CarStats];
type CamKey = 'fov' | 'distance' | 'speedZoom' | 'lookAhead' | 'followRate';
const CAM_KEYS: readonly CamKey[] = ['fov', 'distance', 'speedZoom', 'lookAhead', 'followRate'];

interface Saved {
  stats: Partial<Record<NumKey, number>>;
  camera: Partial<Record<CamKey | 'pitch', number>>;
}

/** [key, min, max, step] */
type Spec = readonly [NumKey, number, number, number];

const GROUPS: ReadonlyArray<{ name: string; wheel: boolean; specs: readonly Spec[] }> = [
  {
    name: 'Drive',
    wheel: false,
    specs: [
      ['engineForce', 0, 30000, 100],
      ['reverseForce', 0, 15000, 100],
      ['topSpeed', 10, 150, 1],
      ['brakeDecel', 0, 60, 0.5],
      ['rollingDecel', 0, 5, 0.05],
    ],
  },
  {
    name: 'Steering',
    wheel: false,
    specs: [
      ['maxSteer', 0.1, 1.2, 0.01],
      ['highSpeedSteer', 0.02, 0.6, 0.01],
      ['steerFadeSpeed', 2, 40, 0.5],
      ['steerRate', 1, 15, 0.1],
    ],
  },
  {
    // Arcade grip model: read every physics step.
    name: 'Grip / drift',
    wheel: false,
    specs: [
      ['gripAccel', 2, 40, 0.5],
      ['driftMaxSlip', 0.1, 1.4, 0.01],
      ['driftDrag', 0, 2, 0.01],
      ['yawResponse', 1, 40, 0.5],
      ['selfAlign', 0, 10, 0.1],
      ['maxYawRate', 1, 8, 0.1],
      ['sandSlip', 0, 1, 0.01],
    ],
  },
  {
    name: 'Handbrake',
    wheel: false,
    specs: [
      ['handbrakeGrip', 0.02, 1, 0.01],
      ['gripRecovery', 0.5, 20, 0.1],
      ['handbrakeYawRate', 0.5, 8, 0.05],
      ['handbrakeDecel', 0, 20, 0.1],
    ],
  },
  {
    name: 'Suspension',
    wheel: true,
    specs: [
      ['suspensionRestLength', 0.1, 0.9, 0.01],
      ['suspensionStiffness', 5, 80, 0.5],
      ['suspensionCompression', 0.5, 10, 0.1],
      ['suspensionRelaxation', 0.5, 10, 0.1],
      ['maxSuspensionTravel', 0.05, 0.9, 0.01],
    ],
  },
  {
    name: 'Assists',
    wheel: false,
    specs: [
      ['downforce', 0, 8, 0.05],
      ['airControl', 0, 6000, 50],
      ['sandDrag', 0, 0.3, 0.005],
    ],
  },
];

const DAMAGE_SPECS: readonly Spec[] = [
  ['toughness', 0.1, 10, 0.05],
  ['dentThreshold', 0, 15, 0.1],
  ['bottomOutDamage', 0, 1, 0.05],
  ['damageScale', 0, 30, 0.1],
  ['dentRadius', 0.2, 2.5, 0.05],
  ['dentDepthScale', 0, 0.3, 0.005],
  ['maxDent', 0, 1, 0.01],
  ['maxHealth', 50, 2000, 10],
];

const ALL_KEYS: readonly NumKey[] = [
  'mass',
  'comDrop',
  ...GROUPS.flatMap((g) => g.specs.map((s) => s[0])),
  ...DAMAGE_SPECS.map((s) => s[0]),
];

const DEG = 180 / Math.PI;

/** Live lil-gui tuning panel (Backquote toggles). Edits apply to the player's stats object and CAMERA_CONFIG. */
export class Tuning {
  private readonly gui: GUI;
  private readonly camDefaults: Record<CamKey, number>;
  private readonly camDirDefault = CAMERA_CONFIG.direction.clone();
  private readonly camProxy = { pitch: 0 };

  constructor(private readonly game: Game) {
    this.camDefaults = {} as Record<CamKey, number>;
    for (const k of CAM_KEYS) this.camDefaults[k] = CAMERA_CONFIG[k];
    this.camProxy.pitch = this.pitchOf(CAMERA_CONFIG.direction);

    const saved = this.load();
    this.apply(saved);

    const gui = (this.gui = new GUI({ title: 'Tuning', width: 300 }));
    gui.domElement.style.display = 'none';
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Backquote') return;
      e.preventDefault();
      const el = gui.domElement;
      el.style.display = el.style.display === 'none' ? '' : 'none';
    });

    this.buildHandling();
    this.buildDamage();
    this.buildCamera();
    this.buildActions();
  }

  private get stats(): CarStats {
    return this.game.playerStats;
  }

  private pitchOf(d: THREE.Vector3): number {
    return Math.atan2(d.y, Math.hypot(d.x, d.z)) * DEG;
  }

  /** Rebuilds the camera direction at a new pitch, keeping the horizontal heading. */
  private setPitch(deg: number): void {
    const d = CAMERA_CONFIG.direction;
    const h = Math.hypot(d.x, d.z) || 1;
    const r = (deg / DEG);
    const k = Math.cos(r) / h;
    d.set(d.x * k, Math.sin(r), d.z * k).normalize();
  }

  private load(): Saved | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      const s: Saved = { stats: {}, camera: {} };
      for (const k of ALL_KEYS) s.stats[k] = this.stats[k];
      for (const k of CAM_KEYS) s.camera[k] = CAMERA_CONFIG[k];
      s.camera.pitch = this.camProxy.pitch;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  }

  private apply(saved: Saved | null): void {
    if (!saved) return;
    const st = this.stats;
    let respawn = false;
    for (const k of ALL_KEYS) {
      const v = saved.stats?.[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if ((k === 'mass' || k === 'comDrop') && v !== st[k]) respawn = true;
      st[k] = v;
    }
    for (const k of CAM_KEYS) {
      const v = saved.camera?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) CAMERA_CONFIG[k] = v;
    }
    const p = saved.camera?.pitch;
    if (typeof p === 'number' && Number.isFinite(p)) {
      this.camProxy.pitch = p;
      this.setPitch(p);
    }
    this.game.rig.camera.fov = CAMERA_CONFIG.fov;
    this.game.rig.camera.updateProjectionMatrix();
    if (respawn) this.game.spawnPlayer();
    else this.game.player.applyWheelStats();
  }

  private addSpec(folder: GUI, spec: Spec, onChange?: () => void): void {
    const [key, min, max, step] = spec;
    folder
      .add(this.stats, key, min, max, step)
      .onChange(() => {
        onChange?.();
        this.save();
      });
  }

  private buildHandling(): void {
    const folder = this.gui.addFolder('Car handling');
    const body = folder.addFolder('Body (respawns car)');
    for (const [key, min, max, step] of [
      ['mass', 300, 4000, 10],
      ['comDrop', 0, 0.6, 0.01],
    ] as const) {
      body.add(this.stats, key, min, max, step).onFinishChange(() => {
        this.save();
        this.game.spawnPlayer();
      });
    }
    for (const g of GROUPS) {
      const sub = folder.addFolder(g.name);
      for (const s of g.specs) this.addSpec(sub, s, g.wheel ? () => this.game.player.applyWheelStats() : undefined);
    }
  }

  private buildDamage(): void {
    const folder = this.gui.addFolder('Damage').close();
    for (const s of DAMAGE_SPECS) this.addSpec(folder, s);
  }

  private buildCamera(): void {
    const folder = this.gui.addFolder('Camera').close();
    const ranges: Record<CamKey, [number, number, number]> = {
      fov: [10, 90, 1],
      distance: [10, 150, 1],
      speedZoom: [0, 60, 0.5],
      lookAhead: [0, 2, 0.01],
      followRate: [0.5, 20, 0.1],
    };
    for (const k of CAM_KEYS) {
      const [min, max, step] = ranges[k];
      folder.add(CAMERA_CONFIG, k, min, max, step).onChange(() => {
        if (k === 'fov') {
          this.game.rig.camera.fov = CAMERA_CONFIG.fov;
          this.game.rig.camera.updateProjectionMatrix();
        }
        this.save();
      });
    }
    folder
      .add(this.camProxy, 'pitch', 15, 75, 1)
      .name('pitch')
      .onChange((v: number) => {
        this.setPitch(v);
        this.save();
      });
    // Live only (not saved): how the view reacts to nearby rivals and upcoming bends.
    const framing = folder.addFolder('Framing').close();
    framing.add(FRAMING_CONFIG, 'closeZoom', -40, 0, 1);
    framing.add(FRAMING_CONFIG, 'farZoom', 0, 120, 1);
    framing.add(FRAMING_CONFIG, 'frameRange', 20, 200, 5);
    framing.add(FRAMING_CONFIG, 'rivalLean', 0, 0.6, 0.01);
    framing.add(FRAMING_CONFIG, 'curveLook', 0, 300, 5);
    framing.add(FRAMING_CONFIG, 'curveRadius', 20, 300, 5);
    framing.add(FRAMING_CONFIG, 'curveShift', 0, 50, 1);
    framing.add(FRAMING_CONFIG, 'curveZoom', 0, 80, 1);
  }

  private buildActions(): void {
    const g = this.game;
    const folder = this.gui.addFolder('Actions').close();
    folder.add({ f: () => g.spawnPlayer() }, 'f').name('Repair car here');
    folder.add({ f: () => g.director.restart() }, 'f').name('Restart race (Enter)');
    folder.add({ f: () => g.director.restart(g.director.mode === 'race' ? 'timetrial' : 'race') }, 'f').name('Race / time trial (T)');
    folder.add({ f: () => g.respawnParked() }, 'f').name('Respawn parked cars');
    folder.add({ f: () => g.debris.clear() }, 'f').name('Clear debris');
    folder
      .add({ f: () => g.player.hit(new THREE.Vector3(0.5, 0.1, 2.1), new THREE.Vector3(0, 0, -1), 5) }, 'f')
      .name('Test dent (front)');
    folder.add({ f: () => this.reset() }, 'f').name('Reset to defaults');
  }

  private reset(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    for (const k of ALL_KEYS) this.stats[k] = DEFAULT_STATS[k];
    for (const k of CAM_KEYS) CAMERA_CONFIG[k] = this.camDefaults[k];
    CAMERA_CONFIG.direction.copy(this.camDirDefault);
    this.camProxy.pitch = this.pitchOf(this.camDirDefault);
    this.game.rig.camera.fov = CAMERA_CONFIG.fov;
    this.game.rig.camera.updateProjectionMatrix();
    this.game.spawnPlayer();
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
}
