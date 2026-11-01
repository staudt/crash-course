import * as THREE from 'three';
import type { CarDims, PartKind } from '../CarStats';
import {
  archLip, block, box, disc, mapVerts, numberGeo, pane, pieces, rivets, spike, tube, warp,
  type Finish, type Piece,
} from './Kit';

/**
 * The four junkyard body styles. All share CarDims (and so the collider and handling): only the
 * looks differ. Each part is a list of pieces in root-local space that CarBuilder bakes and merges.
 */
export type CarVariant = 'sedan' | 'pickup' | 'muscle' | 'wagon';

/** Bolt-on gear and grime, per car (defaults per style in DEFAULT_KITS). */
export interface CarKit {
  /** 0 = clean .. 1 = rotten: rust patches, fading, mismatched panels, dead lamps, a cracked rear window. */
  rust: number;
  pushBar: boolean;
  bullBar: boolean;
  spikes: boolean;
  rearRam: boolean;
  /** Riveted armour plates on the doors and hood, a ram plate on the front bumper. */
  plating: boolean;
  blower: boolean;
  wing: boolean;
  lightBar: boolean;
  roofRack: boolean;
}

const NO_KIT: CarKit = {
  rust: 0.4, pushBar: false, bullBar: false, spikes: false, rearRam: false, plating: false,
  blower: false, wing: false, lightBar: false, roofRack: false,
};

export const DEFAULT_KITS: Record<CarVariant, CarKit> = {
  sedan: { ...NO_KIT, rust: 0.35, pushBar: true },
  pickup: { ...NO_KIT, rust: 0.45, bullBar: true },
  muscle: { ...NO_KIT, rust: 0.3, blower: true, wing: true },
  wagon: { ...NO_KIT, rust: 0.65, roofRack: true },
};

interface Shape {
  cabin: { w: number; h: number; len: number; cz: number; frontRake: number; rearRake: number };
  /** Side windows per side, front to rear, as [front, rear] fractions of the cabin half-length. */
  windows: [number, number][];
  hoodZ0: number;
  noseDrop: number;
  /** Lower the tail's top edge (three-box and coupe tails; not the pickup bed or the wagon). */
  tailDrop: boolean;
  bed: boolean;
  flare: Finish;
  bumper: Finish;
  rim: Finish;
  knobby: boolean;
  sidePipes: boolean;
}

const SHAPES: Record<CarVariant, Shape> = {
  sedan: {
    cabin: { w: 1.62, h: 0.55, len: 2.0, cz: -0.25, frontRake: 0.42, rearRake: 0.32 },
    windows: [[0.82, 0.06], [-0.06, -0.8]],
    hoodZ0: 0.75, noseDrop: 0.07, tailDrop: true, bed: false,
    flare: 'paint', bumper: 'chrome', rim: 'steel', knobby: false, sidePipes: false,
  },
  pickup: {
    cabin: { w: 1.6, h: 0.52, len: 1.4, cz: 0.25, frontRake: 0.38, rearRake: 0.06 },
    windows: [[0.8, -0.75]],
    hoodZ0: 1.0, noseDrop: 0.05, tailDrop: false, bed: true,
    flare: 'rubber', bumper: 'darkSteel', rim: 'darkSteel', knobby: true, sidePipes: false,
  },
  muscle: {
    cabin: { w: 1.56, h: 0.5, len: 1.9, cz: -0.2, frontRake: 0.45, rearRake: 0.62 },
    windows: [[0.8, -0.55]],
    hoodZ0: 0.75, noseDrop: 0.1, tailDrop: true, bed: false,
    flare: 'paint', bumper: 'darkSteel', rim: 'chrome', knobby: false, sidePipes: true,
  },
  wagon: {
    cabin: { w: 1.62, h: 0.55, len: 2.75, cz: -0.6, frontRake: 0.42, rearRake: 0.04 },
    windows: [[0.86, 0.32], [0.24, -0.3], [-0.38, -0.9]],
    hoodZ0: 0.775, noseDrop: 0.07, tailDrop: false, bed: false,
    flare: 'paint', bumper: 'chrome', rim: 'steel', knobby: false, sidePipes: false,
  },
};

export interface StyleParts {
  parts: Partial<Record<Exclude<PartKind, 'wheel'>, Piece[]>>;
  /** One wheel in its pivot's space (axle along X, centred on the origin). */
  wheel: Piece[];
}

const SIDES = [1, -1] as const;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Plan-view z of the nose (sgn 1) or tail (-1) surface at lateral offset x (the hull's rounded corners). */
function endZ(d: CarDims, x: number, sgn: number): number {
  const e = Math.abs(x) / d.halfWidth;
  return sgn * (d.halfLength - 0.18 * e * e);
}

function hull(s: Shape, d: CarDims, kit: CarKit, variant: CarVariant, rand: () => number): Piece[] {
  const hh = d.halfHeight - 0.04;
  const hw = d.halfWidth;
  const hl = d.halfLength;
  const shell = box(hw * 2, hh * 2, hl * 2, 10, 6, 20);
  const archX = d.wheelX - d.wheelWidth / 2 - 0.03;
  const archZ = d.wheelRadius + 0.08;
  mapVerts(shell, (v) => {
    const t = (v.y + hh) / (2 * hh); // 0 bottom .. 1 top
    // Tumblehome plus a shoulder crease two thirds up the side.
    const crease = Math.max(0, 1 - Math.abs(t - 0.67) / 0.17);
    v.x *= (1 - 0.08 * t) * (1 + 0.025 * crease);
    const az = Math.abs(v.z);
    const end = Math.max(0, (az - (hl - 0.5)) / 0.5);
    if (end > 0) {
      const edge = Math.abs(v.x) / hw;
      v.z -= Math.sign(v.z) * 0.18 * edge * edge * end;
      if (t > 0.9 && v.z > 0) v.y -= s.noseDrop * end;
      if (t > 0.9 && v.z < 0 && s.tailDrop) v.y -= 0.07 * end;
      if (t < 0.1) v.y += 0.06 * end;
    }
    // Wheel-arch cut: the hull is narrowed so the wheels stay visible.
    if (v.y < 0.2 && Math.abs(az - d.wheelZ) < archZ && Math.abs(v.x) > archX) v.x = Math.sign(v.x) * archX;
  });
  const out: Piece[] = [{ geo: shell, finish: 'paint' }];

  if (s.bed) {
    const wallY = hh + 0.15;
    out.push(...pieces('paint',
      box(0.08, 0.3, 1.45, 1, 3, 6, hw * 0.88, wallY, -1.3),
      box(0.08, 0.3, 1.45, 1, 3, 6, -hw * 0.88, wallY, -1.3),
      box(hw * 1.8, 0.3, 0.08, 6, 3, 1, 0, wallY, -hl + 0.08),
      box(hw * 1.8, 0.36, 0.08, 6, 3, 1, 0, hh + 0.18, -0.62),
    ));
    // Roll bar over the bed, a spare lying in it and a junk crate.
    const bar = 0.04;
    out.push(...pieces('darkSteel',
      tube(v3(0.76, hh, -0.74), v3(0.74, 0.98, -0.74), bar),
      tube(v3(-0.76, hh, -0.74), v3(-0.74, 0.98, -0.74), bar),
      tube(v3(0.74, 0.98, -0.74), v3(-0.74, 0.98, -0.74), bar),
      tube(v3(0.74, 0.98, -0.74), v3(-0.74, hh + 0.08, -0.74), bar * 0.8),
      tube(v3(0.74, 0.9, -0.74), v3(0.74, hh + 0.3, -1.5), bar * 0.8),
      tube(v3(-0.74, 0.9, -0.74), v3(-0.74, hh + 0.3, -1.5), bar * 0.8),
    ));
    const spare = tyre(d, true);
    spare.scale(0.82, 0.82, 0.82);
    spare.translate(0.2, hh + 0.15, -1.48);
    out.push({ geo: spare, finish: 'rubber' }, { geo: block(0.5, 0.3, 0.42, -0.42, hh + 0.15, -1.15), finish: 'wood' });
  }

  for (const sx of SIDES) {
    for (const sz of SIDES) out.push({ geo: archLip(d.wheelRadius + 0.1, 0.055, sx * (hw - 0.04), d.wheelY, sz * d.wheelZ), finish: s.flare });
    // Rocker rails (or chrome side pipes on the muscle car).
    const rz = d.wheelZ - archZ - 0.05;
    if (s.sidePipes) {
      out.push(...pieces('chrome',
        tube(v3(sx * (hw + 0.03), -0.2, -rz), v3(sx * (hw + 0.03), -0.2, rz), 0.055, 8),
        disc(0.04, 0.03, 'z', sx * (hw + 0.03), -0.2, -rz - 0.015, 8),
      ));
      out.push({ geo: disc(0.04, 0.035, 'z', sx * (hw + 0.03), -0.2, -rz - 0.03, 8), finish: 'ink' });
    } else {
      out.push({ geo: tube(v3(sx * (hw - 0.01), -0.22, -rz), v3(sx * (hw - 0.01), -0.22, rz), 0.045), finish: 'steel' });
    }
  }

  // Grille with bars, headlights in chrome bezels (on the body: they stay when the bumper goes).
  out.push({ geo: block(0.96, 0.13, 0.05, 0, 0.14, hl - 0.035), finish: 'trim' });
  for (let i = 0; i < 7; i++) out.push({ geo: block(0.022, 0.12, 0.02, -0.42 + i * 0.14, 0.14, hl - 0.005), finish: 'steel' });
  for (const sx of SIDES) {
    const zN = endZ(d, 0.7, 1);
    out.push({ geo: block(0.2, 0.16, 0.05, sx * 0.7, 0.14, zN - 0.01), finish: 'chrome' });
    const dead = rand() < kit.rust * 0.45;
    out.push({ geo: disc(0.064, 0.03, 'z', sx * 0.7, 0.14, zN + 0.02, 10), finish: dead ? 'lampDead' : 'lamp' });
    // Tail lights: vertical on the wagon's tailgate.
    if (variant === 'wagon') {
      out.push({ geo: block(0.09, 0.2, 0.03, sx * 0.78, 0.1, endZ(d, 0.78, -1) - 0.01), finish: 'tail' });
    } else {
      out.push({ geo: block(0.24, 0.09, 0.03, sx * 0.64, 0.16, endZ(d, 0.64, -1) - 0.01), finish: 'tail' });
    }
    // Twin exhausts under the tail, where BoostFlame puts the flames.
    out.push({ geo: tube(v3(sx * 0.45, -0.27, -1.7), v3(sx * 0.45, -0.27, -hl - 0.17), 0.05, 8), finish: 'rust' });
    out.push({ geo: disc(0.035, 0.01, 'z', sx * 0.45, -0.27, -hl - 0.175, 8), finish: 'ink' });
  }
  // Fuel filler on the left rear quarter.
  out.push({ geo: disc(0.055, 0.025, 'x', hw * 0.97, 0.12, -0.72, 8), finish: 'chrome' });
  if (variant === 'sedan') out.push({ geo: tube(v3(-0.72, hh - 0.05, -1.62), v3(-0.75, 1.35, -1.72), 0.009, 3), finish: 'darkSteel' });
  return out;
}

/** Fractions [front, rear] split at 0, so window panes keep a vertex where the cabin's rake warp kinks. */
function splitAtZero([a, b]: [number, number]): [number, number][] {
  return a > 0 && b < 0 ? [[a, 0], [0, b]] : [[a, b]];
}

function cabin(s: Shape, d: CarDims, kit: CarKit, num: number): Piece[] {
  const hh = d.halfHeight - 0.04;
  const { w, h, len, cz, frontRake, rearRake } = s.cabin;
  const e = 0.012;
  const half = len / 2;
  const y0 = -h / 2 + 0.25 * h;
  const y1 = -h / 2 + 0.875 * h;
  const bh = y1 - y0;
  const by = (y0 + y1) / 2;
  const out: Piece[] = [{ geo: new THREE.BoxGeometry(w, h, len, 6, 8, 10), finish: 'paint' }];

  const front = pane(w * 0.84, bh, 4, 2);
  front.translate(0, by, half + e);
  const rear = pane(w * 0.84, bh, 4, 2);
  rear.rotateY(Math.PI);
  rear.translate(0, by, -half - e);
  out.push(...pieces('glass', front, rear));
  for (const sx of SIDES) {
    for (const win of s.windows) {
      for (const [a, b] of splitAtZero(win)) {
        const g = pane((a - b) * half, bh, 3, 2);
        g.rotateY((sx * Math.PI) / 2);
        g.translate(sx * (w / 2 + e), by, ((a + b) / 2) * half);
        out.push({ geo: g, finish: 'glass' });
      }
    }
  }
  // Window net over the driver's (left) front window.
  const [na, nb] = s.windows[0]!;
  const nz0 = nb * half + 0.05;
  const nz1 = na * half - 0.05;
  const nx = w / 2 + 0.03;
  for (let i = 0; i <= 4; i++) out.push({ geo: block(0.012, bh * 0.9, 0.018, nx, by, nz0 + ((nz1 - nz0) * i) / 4), finish: 'darkSteel' });
  for (let i = 0; i <= 2; i++) out.push({ geo: block(0.012, 0.018, nz1 - nz0, nx, y0 + 0.03 + ((bh - 0.06) * i) / 2, (nz0 + nz1) / 2), finish: 'darkSteel' });
  // A star crack across the rear window of a rotten car.
  if (kit.rust > 0.45) {
    for (let i = 0; i < 5; i++) {
      const g = block(0.22 + 0.06 * (i % 2), 0.007, 0.004);
      g.translate(0.11, 0, 0);
      g.rotateZ(0.4 + i * 1.25);
      g.translate(-0.18, by + 0.02, -half - 2 * e);
      out.push({ geo: g, finish: 'sign' });
    }
  }

  // Rake: the roof is narrower than the sills, windscreen and rear window lean in.
  warp(out, (p) => {
    const t = p.y / h + 0.5;
    p.x *= 1 - 0.12 * t;
    p.z -= Math.sign(p.z) * (p.z > 0 ? frontRake : rearRake) * t * (Math.abs(p.z) / half);
  });
  for (const p of out) p.geo.translate(0, hh - 0.02 + h / 2, cz);

  // Roof gear, placed on the warped roof.
  const roofY = hh - 0.02 + h;
  const zf = cz + half - frontRake;
  const zr = cz - half + rearRake;
  const signZ = s.windows.length > 2 ? zf - 0.42 : (zf + zr) / 2 - 0.02;
  out.push({ geo: box(0.03, 0.24, 0.62, 1, 2, 4, 0, roofY + 0.13, signZ), finish: 'sign' });
  out.push(...pieces('darkSteel', block(0.06, 0.03, 0.06, 0, roofY + 0.01, signZ - 0.22), block(0.06, 0.03, 0.06, 0, roofY + 0.01, signZ + 0.22)));
  for (const sx of SIDES) {
    for (const g of numberGeo(num, 0.16, 0.01)) {
      g.rotateY((sx * Math.PI) / 2);
      g.translate(sx * 0.02, roofY + 0.13, signZ);
      out.push({ geo: g, finish: 'ink' });
    }
  }
  if (kit.lightBar) {
    out.push({ geo: block(1.2, 0.08, 0.12, 0, roofY + 0.05, zf - 0.1), finish: 'darkSteel' });
    for (const x of [-0.45, -0.15, 0.15, 0.45]) out.push({ geo: disc(0.045, 0.02, 'z', x, roofY + 0.05, zf - 0.035, 8), finish: 'lamp' });
  }
  if (kit.roofRack) {
    const r0 = zr + 0.12;
    const r1 = s.windows.length > 2 ? signZ - 0.4 : zf - 0.1;
    const rw = (w / 2) * 0.8;
    for (const sx of SIDES) {
      out.push({ geo: tube(v3(sx * rw, roofY + 0.09, r0), v3(sx * rw, roofY + 0.09, r1), 0.022), finish: 'darkSteel' });
      for (const z of [r0 + 0.04, r1 - 0.04]) out.push({ geo: block(0.04, 0.09, 0.04, sx * rw, roofY + 0.045, z), finish: 'darkSteel' });
    }
    for (let i = 0; i < 4; i++) {
      const z = r0 + ((r1 - r0) * (i + 0.5)) / 4;
      out.push({ geo: tube(v3(rw, roofY + 0.1, z), v3(-rw, roofY + 0.1, z), 0.018), finish: 'darkSteel' });
    }
    const spare = tyre(d, false);
    spare.scale(0.8, 0.8, 0.8);
    spare.translate(0.18, roofY + 0.25, r0 + 0.45);
    out.push({ geo: spare, finish: 'rubber' }, { geo: block(0.42, 0.24, 0.36, -0.3, roofY + 0.23, r1 - 0.35), finish: 'wood' });
  }
  return out;
}

function hood(s: Shape, d: CarDims, kit: CarKit): Piece[] {
  const hh = d.halfHeight - 0.04;
  const z0 = s.hoodZ0;
  const z1 = d.halfLength - 0.1;
  const hw = d.halfWidth - 0.1;
  const g = box(hw * 2, 0.1, z1 - z0, 8, 1, 8, 0, hh + 0.03, (z0 + z1) / 2);
  mapVerts(g, (v) => {
    const top = v.y > hh + 0.03;
    const k = Math.abs(v.x) / hw;
    v.x *= 1 - 0.05 * (v.y - hh) * 10;
    if (top) v.y += 0.06 * (1 - k * k);
    v.y -= 0.06 * (v.z - z0) / (z1 - z0);
  });
  const topY = (x: number, z: number) => hh + 0.08 + 0.06 * (1 - (x / hw) ** 2) - (0.06 * (z - z0)) / (z1 - z0);
  const out: Piece[] = [{ geo: g, finish: 'paint' }];
  for (const sx of SIDES) out.push({ geo: disc(0.03, 0.03, 'y', sx * 0.62, topY(0.62, z1 - 0.14), z1 - 0.14, 6), finish: 'chrome' });
  if (kit.blower) {
    // Supercharger through the hood: it flies off with it.
    const zc = z0 + 0.45;
    const y = topY(0, zc);
    out.push(
      { geo: block(0.42, 0.08, 0.56, 0, y + 0.03, zc), finish: 'darkSteel' },
      { geo: box(0.34, 0.1, 0.44, 2, 1, 4, 0, y + 0.12, zc), finish: 'chrome' },
      { geo: block(0.38, 0.05, 0.2, 0, y + 0.195, zc - 0.05), finish: 'darkSteel' },
      { geo: disc(0.07, 0.04, 'z', 0, y + 0.1, zc + 0.24, 8), finish: 'darkSteel' },
    );
    for (let i = 0; i < 4; i++) out.push({ geo: block(0.3, 0.012, 0.012, 0, y + 0.08 + i * 0.022, zc + 0.225), finish: 'darkSteel' });
  }
  if (kit.plating) {
    const zc = z1 - 0.32;
    const y = topY(0, zc) + 0.008;
    out.push({ geo: box(0.7, 0.014, 0.42, 2, 1, 2, 0, y, zc), finish: 'steel' });
    out.push(...pieces('darkSteel', ...rivets([-0.31, 0, 0.31].flatMap((x) => [v3(x, y + 0.01, zc - 0.18), v3(x, y + 0.01, zc + 0.18)]))));
  }
  return out;
}

function bumper(front: boolean, s: Shape, d: CarDims, kit: CarKit): Piece[] {
  const hw = d.halfWidth - 0.03;
  const hl = d.halfLength;
  const depth = 0.32;
  const sgn = front ? 1 : -1;
  const g = box(hw * 2, 0.3, depth, 8, 2, 2, 0, -0.08, sgn * (hl + 0.12 - depth / 2));
  mapVerts(g, (v) => {
    const e = Math.max(0, (Math.abs(v.x) - hw * 0.7) / (hw * 0.3));
    v.z -= sgn * 0.12 * e * e * Math.max(0, sgn * (v.z - sgn * (hl - 0.1)) > 0 ? 1 : 0.3);
  });
  const out: Piece[] = [{ geo: g, finish: s.bumper }];
  const face = sgn * (hl + 0.12);
  if (front) {
    for (const sx of SIDES) out.push({ geo: block(0.04, 0.06, 0.07, sx * 0.55, -0.25, face - 0.02), finish: 'darkSteel' });
    if (kit.plating) {
      out.push({ geo: box(1.2, 0.2, 0.03, 4, 1, 1, 0, -0.08, face + 0.015), finish: 'steel' });
      out.push(...pieces('darkSteel', ...rivets([-0.55, -0.2, 0.2, 0.55].flatMap((x) => [v3(x, -0.15, face + 0.035), v3(x, -0.01, face + 0.035)]))));
    }
    if (kit.spikes) {
      const base = face + (kit.plating ? 0.03 : 0);
      for (const x of [-0.6, -0.3, 0, 0.3, 0.6]) out.push({ geo: spike(0.04, 0.105, x, -0.08, base - 0.005), finish: 'steel' });
    }
    if (kit.bullBar) {
      const z = face + 0.03;
      const r = 0.04;
      out.push(...pieces('darkSteel',
        tube(v3(0.62, -0.1, z), v3(0.62, 0.32, z - 0.02), r), tube(v3(-0.62, -0.1, z), v3(-0.62, 0.32, z - 0.02), r),
        tube(v3(0.3, -0.05, z), v3(0.3, 0.3, z), r * 0.8), tube(v3(-0.3, -0.05, z), v3(-0.3, 0.3, z), r * 0.8),
        tube(v3(-0.66, 0.32, z - 0.02), v3(0.66, 0.32, z - 0.02), r),
        tube(v3(-0.62, 0.12, z), v3(0.62, 0.12, z), r * 0.8),
        block(0.9, 0.05, 0.28, 0, -0.27, hl - 0.02),
      ));
    } else if (kit.pushBar) {
      const r = 0.035;
      out.push(...pieces('darkSteel',
        tube(v3(0.38, -0.05, face + 0.05), v3(0.38, 0.27, face + 0.01), r),
        tube(v3(-0.38, -0.05, face + 0.05), v3(-0.38, 0.27, face + 0.01), r),
        tube(v3(-0.5, 0.27, face + 0.01), v3(0.5, 0.27, face + 0.01), r),
      ));
    }
    return out;
  }
  if (kit.rearRam) {
    out.push({ geo: box(1.3, 0.28, 0.04, 4, 1, 1, 0, -0.06, face - 0.02), finish: 'steel' });
    for (const y of [0.12, -0.2]) out.push({ geo: tube(v3(-0.7, y, face - 0.07), v3(0.7, y, face - 0.07), 0.035), finish: 'darkSteel' });
    out.push(...pieces('darkSteel', ...rivets([-0.58, -0.2, 0.2, 0.58].map((x) => v3(x, 0.02, face - 0.045)))));
  } else {
    out.push(...pieces('darkSteel', block(0.08, 0.07, 0.12, 0, -0.17, face - 0.04), block(0.06, 0.06, 0.06, 0, -0.12, face - 0.08)));
  }
  return out;
}

function door(left: boolean, variant: CarVariant, d: CarDims, kit: CarKit, num: number): Piece[] {
  const hh = d.halfHeight - 0.04;
  const sgn = left ? 1 : -1;
  const x = (d.halfWidth - 0.02) * sgn;
  const g = box(0.06, hh * 1.4, 1.4, 1, 4, 8, x, -0.02, 0.15);
  mapVerts(g, (v) => {
    const k = Math.abs(v.z - 0.15) / 0.7;
    v.x -= Math.sign(x) * 0.015 * k * k;
  });
  const out: Piece[] = [{ geo: g, finish: 'paint' }];
  const at = (off: number) => x + sgn * off;
  if (variant === 'wagon') {
    // Woodie side panel with chrome trim.
    out.push({ geo: box(0.012, 0.15, 1.2, 1, 1, 4, at(0.035), -0.07, 0.15), finish: 'wood' });
    for (const y of [0.01, -0.15]) out.push({ geo: block(0.014, 0.014, 1.24, at(0.037), y, 0.15), finish: 'chrome' });
  }
  const digits = (finish: Finish, off: number) => {
    for (const geo of numberGeo(num, 0.2, 0.008)) {
      geo.rotateY((sgn * Math.PI) / 2);
      geo.translate(at(off), -0.02, 0.15);
      out.push({ geo, finish });
    }
  };
  if (kit.plating) {
    out.push({ geo: box(0.015, 0.3, 1.15, 1, 2, 6, at(0.04), -0.03, 0.12), finish: 'steel' });
    out.push(...pieces('darkSteel', ...rivets([-0.42, 0.12, 0.66].flatMap((z) => [v3(at(0.05), -0.16, z), v3(at(0.05), 0.1, z)]))));
    digits('sign', 0.051);
  } else {
    out.push({ geo: disc(0.17, 0.03, 'x', at(0.045), -0.02, 0.15, 14), finish: 'sign' });
    digits('ink', 0.064);
  }
  out.push({ geo: block(0.03, 0.03, 0.12, at(0.04), 0.12, -0.42), finish: 'chrome' });
  if (left) {
    out.push(
      { geo: block(0.12, 0.03, 0.03, at(0.08), 0.22, 0.72), finish: 'darkSteel' },
      { geo: block(0.04, 0.09, 0.12, at(0.13), 0.24, 0.72), finish: 'darkSteel' },
    );
  }
  // Welded shut: beads along the front and rear seams.
  if (kit.rust > 0.5) {
    for (const z of [0.84, -0.54]) out.push({ geo: tube(v3(at(0.034), -0.2, z), v3(at(0.034), 0.16, z), 0.013, 4), finish: 'rust' });
  }
  return out;
}

function wing(d: CarDims): Piece[] {
  const hh = d.halfHeight - 0.04;
  const out: Piece[] = [{ geo: box(1.75, 0.035, 0.34, 6, 1, 2, 0, 0.64, -1.95), finish: 'paint' }];
  for (const sx of SIDES) {
    out.push(
      { geo: tube(v3(sx * 0.55, hh - 0.08, -1.8), v3(sx * 0.55, 0.63, -1.92), 0.03), finish: 'darkSteel' },
      { geo: box(0.025, 0.2, 0.4, 1, 1, 2, sx * 0.875, 0.6, -1.95), finish: 'darkSteel' },
    );
  }
  return out;
}

/** The tyre (lathe round the Y axis, outward-facing): rounded shoulders and a tread of alternating blocks. */
function tyre(d: CarDims, knobby: boolean): THREE.BufferGeometry {
  const R = d.wheelRadius;
  const hw = d.wheelWidth / 2;
  const profile = [
    [0.26, -hw], [R - 0.045, -hw], [R - 0.005, -hw + 0.035], [R, -hw * 0.35],
    [R, hw * 0.35], [R - 0.005, hw - 0.035], [R - 0.045, hw], [0.26, hw],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  // A multiple of 4, so the alternating tread is point-symmetric and the wheel stays centred.
  const segments = 16;
  const g = new THREE.LatheGeometry(profile, segments);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const depth = knobby ? 0.03 : 0.012;
  for (let i = 0; i <= segments; i++) {
    if (i % 2 === 0) continue;
    for (let j = 1; j < profile.length - 1; j++) {
      const k = i * profile.length + j;
      const r = Math.hypot(pos.getX(k), pos.getZ(k));
      if (r < R - 0.05) continue;
      const s = (r - depth) / r;
      pos.setXYZ(k, pos.getX(k) * s, pos.getY(k), pos.getZ(k) * s);
    }
  }
  return g;
}

function wheel(s: Shape, d: CarDims): Piece[] {
  const hw = d.wheelWidth / 2;
  const out: Piece[] = [
    { geo: tyre(d, s.knobby), finish: 'rubber' },
    // Dish rim, slightly recessed, with a hub and five lug bolts on each face.
    // Wider than the tyre's bead (0.26) and tucked behind the sidewall: no gap to see through.
    { geo: new THREE.CylinderGeometry(0.275, 0.275, 2 * (hw - 0.02), 12, 1), finish: s.rim },
    { geo: new THREE.CylinderGeometry(0.075, 0.09, 2 * hw - 0.01, 6, 1), finish: 'darkSteel' },
  ];
  for (const sy of SIDES) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      out.push({ geo: block(0.03, 0.03, 0.03, Math.cos(a) * 0.14, sy * (hw - 0.02), Math.sin(a) * 0.14), finish: 'darkSteel' });
    }
  }
  for (const p of out) p.geo.rotateZ(Math.PI / 2);
  return out;
}

export function buildStyle(variant: CarVariant, d: CarDims, kit: CarKit, num: number, rand: () => number): StyleParts {
  const s = SHAPES[variant];
  const parts: StyleParts['parts'] = {
    body: hull(s, d, kit, variant, rand),
    cabin: cabin(s, d, kit, num),
    hood: hood(s, d, kit),
    bumperFront: bumper(true, s, d, kit),
    bumperRear: bumper(false, s, d, kit),
    doorLeft: door(true, variant, d, kit, num),
    doorRight: door(false, variant, d, kit, num),
  };
  if (kit.wing) parts.wing = wing(d);
  return { parts, wheel: wheel(s, d) };
}
