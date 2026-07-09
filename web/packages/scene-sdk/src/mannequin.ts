// mannequin.ts — the built-in poseable figure (a body-kun style art doll),
// zero assets.
//
// Purpose-built for the previz→video-generation path: a NEUTRAL articulated
// silhouette the agent (or a human, via presets + per-joint controls) POSES.
// Neutrality is the point — no face, no clothes, no character semantics that
// would steer a video model's understanding of the conditioning frame; just
// readable human blocking, the same figure LibTV-style consoles use. Unlike a
// pose-only tool, every joint angle is an Animatable — a pose can be
// keyframed, so the mannequin also MOVES.
//
// Built like an articulated figure: sculpted rigid segments (chest shell,
// abdomen, hip block, guarded limbs, boots) joined by visible darker ball
// joints, so every articulation reads at a glance. Each segment hangs under a
// joint Group whose origin sits at the anatomical pivot; joint rotation =
// Group rotation — no skinning, fully deterministic, and gaze (head) /
// attachTo (hands) work through plain node names.

import type * as THREE from 'three';

/** Poseable joints. Euler degrees [x, y, z]: x = pitch (bend forward/back),
 *  y = yaw (twist), z = roll (spread sideways). The spine bends in three
 *  places (torso = waist, chest = upper spine, neck) for natural curvature. */
export const MANNEQUIN_JOINTS = [
  'torso',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'shoulderR',
  'elbowL',
  'elbowR',
  'wristL',
  'wristR',
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
  'ankleL',
  'ankleR',
] as const;
export type MannequinJoint = (typeof MANNEQUIN_JOINTS)[number];

export type PoseAngles = Partial<Record<MannequinJoint, [number, number, number]>>;

/** A preset also carries the root-height offset (meters) that keeps the pose
 *  grounded — sitting drops the pelvis to seat height without the author
 *  doing position.y math (a chair/box prop is still the author's job). */
export type PosePreset = PoseAngles & { rootY?: number };

/** Pose presets — joint-angle dictionaries (degrees), the same model LibTV-
 *  style consoles use. A preset is a starting point; per-joint values in the
 *  spec override on top. */
export const POSE_PRESETS: Record<string, PosePreset> = {
  standing: {
    shoulderL: [0, 0, 6],
    shoulderR: [0, 0, -6],
    elbowL: [8, 0, 0],
    elbowR: [8, 0, 0],
    wristL: [6, 0, 0],
    wristR: [6, 0, 0],
  },
  tpose: { shoulderL: [0, 0, 90], shoulderR: [0, 0, -90] },
  walking: {
    chest: [4, 0, 0],
    shoulderL: [-25, 0, 5],
    shoulderR: [25, 0, -5],
    elbowL: [15, 0, 0],
    elbowR: [25, 0, 0],
    wristL: [8, 0, 0],
    wristR: [8, 0, 0],
    hipL: [22, 0, 0],
    hipR: [-16, 0, 0],
    kneeL: [8, 0, 0],
    kneeR: [32, 0, 0],
    ankleL: [-12, 0, 0],
    ankleR: [14, 0, 0],
  },
  running: {
    torso: [10, 0, 0],
    chest: [8, 0, 0],
    shoulderL: [-45, 0, 5],
    shoulderR: [45, 0, -5],
    elbowL: [85, 0, 0],
    elbowR: [95, 0, 0],
    wristL: [20, 0, 0],
    wristR: [20, 0, 0],
    hipL: [42, 0, 0],
    hipR: [-30, 0, 0],
    kneeL: [22, 0, 0],
    kneeR: [95, 0, 0],
    ankleL: [-18, 0, 0],
    ankleR: [30, 0, 0],
  },
  sitting: {
    rootY: -0.42,
    torso: [-4, 0, 0],
    chest: [4, 0, 0],
    hipL: [-85, 0, 4],
    hipR: [-85, 0, -4],
    kneeL: [85, 0, 0],
    kneeR: [85, 0, 0],
    ankleL: [-4, 0, 0],
    ankleR: [-4, 0, 0],
    shoulderL: [-15, 0, 6],
    shoulderR: [-15, 0, -6],
    elbowL: [28, 0, 0],
    elbowR: [28, 0, 0],
    wristL: [10, 0, 0],
    wristR: [10, 0, 0],
  },
  squat: {
    rootY: -0.55,
    torso: [18, 0, 0],
    chest: [10, 0, 0],
    hipL: [-110, 0, 9],
    hipR: [-110, 0, -9],
    kneeL: [125, 0, 0],
    kneeR: [125, 0, 0],
    ankleL: [-22, 0, 0],
    ankleR: [-22, 0, 0],
    shoulderL: [-40, 0, 6],
    shoulderR: [-40, 0, -6],
    elbowL: [32, 0, 0],
    elbowR: [32, 0, 0],
  },
  kneeling: {
    rootY: -0.46,
    torso: [3, 0, 0],
    chest: [3, 0, 0],
    hipL: [-90, 0, 4],
    kneeL: [90, 0, 0],
    ankleL: [-4, 0, 0],
    hipR: [10, 0, -4],
    kneeR: [110, 0, 0],
    ankleR: [42, 0, 0],
  },
  bow: {
    torso: [28, 0, 0],
    chest: [16, 0, 0],
    neck: [8, 0, 0],
    head: [12, 0, 0],
    shoulderL: [13, 0, -7],
    shoulderR: [3, 0, -5],
    elbowL: [6, 0, 0],
    elbowR: [6, 0, 0],
  },
  thinking: {
    torso: [3, 0, 0],
    chest: [3, 5, 0],
    neck: [4, 8, 4],
    head: [6, 8, 5],
    shoulderR: [-35, 0, -10],
    elbowR: [120, 0, 0],
    wristR: [28, 0, 0],
    shoulderL: [0, 0, 6],
  },
  fighting: {
    torso: [6, 14, 0],
    chest: [5, 8, 0],
    shoulderL: [-30, 0, 20],
    shoulderR: [-40, 0, -15],
    elbowL: [95, 0, 0],
    elbowR: [110, 0, 0],
    wristL: [30, 0, 0],
    wristR: [30, 0, 0],
    hipL: [10, 0, 8],
    hipR: [-5, 0, -8],
    kneeL: [15, 0, 0],
    kneeR: [10, 0, 0],
  },
  wave: {
    chest: [0, 0, -3],
    shoulderR: [0, 0, -155],
    elbowR: [25, 0, 0],
    wristR: [0, 0, -12],
    neck: [0, -6, 3],
    head: [0, -6, 3],
    shoulderL: [0, 0, 6],
  },
  reaching: {
    torso: [5, 0, 0],
    chest: [4, 0, 0],
    shoulderR: [-85, 0, 0],
    elbowR: [6, 0, 0],
    wristR: [-14, 0, 0],
    shoulderL: [0, 0, 6],
  },
  armscrossed: {
    chest: [-3, 0, 0],
    shoulderL: [-35, 0, -25],
    shoulderR: [-35, 0, 25],
    elbowL: [115, 25, 0],
    elbowR: [115, -25, 0],
    wristL: [18, 0, 0],
    wristR: [18, 0, 0],
  },
  phone: {
    neck: [10, 0, 0],
    head: [14, 0, 0],
    shoulderR: [-30, 0, -12],
    elbowR: [125, 0, 0],
    wristR: [32, 0, 0],
    shoulderL: [0, 0, 6],
  },
};

export interface Mannequin {
  root: THREE.Group;
  /** Joint name → the Group whose rotation poses it. */
  joints: Map<MannequinJoint, THREE.Group>;
  /** Overall height, meters. */
  heightM: number;
}

// Proportions (meters) for a ~1.75 m figure.
const H = {
  pelvisY: 0.95, // pelvis center height
  hipDrop: 0.055, // pelvis center → hip pivot
  legUpper: 0.42, // hip → knee
  legLower: 0.4, // knee → ankle
  waist: 0.05, // pelvis center → waist pivot
  chestUp: 0.17, // waist → chest pivot
  neckUp: 0.26, // chest → neck pivot
  headUp: 0.055, // neck → head pivot
  armUpper: 0.28, // shoulder → elbow
  armLower: 0.24, // elbow → wrist
  shoulderHalf: 0.2,
  hipHalf: 0.1,
};

export const MANNEQUIN_DEFAULT_COLOR = '#4a7de8'; // LibTV-style figure blue

/** Build the articulated figure: sculpted segments + visible ball joints. */
export function buildMannequin(three: typeof THREE, color: string | undefined): Mannequin {
  const bodyColor = new three.Color(color ?? MANNEQUIN_DEFAULT_COLOR);
  const mat = new three.MeshStandardMaterial({ color: bodyColor, roughness: 0.55 });
  // Joints and trim a shade darker, so every articulation reads at a glance.
  const jointMat = new three.MeshStandardMaterial({
    color: bodyColor.clone().multiplyScalar(0.55),
    roughness: 0.4,
  });
  const joints = new Map<MannequinJoint, THREE.Group>();

  const mesh = (g: THREE.BufferGeometry, m: THREE.Material = mat): THREE.Mesh => {
    const out = new three.Mesh(g, m);
    out.castShadow = true;
    return out;
  };
  /** Tapered limb segment hanging DOWN from its joint: rTop at the joint,
   *  rBottom at the far end (the next ball joint covers each seam). */
  const limb = (rTop: number, rBottom: number, length: number): THREE.Mesh => {
    const g = new three.CylinderGeometry(rTop, rBottom, length, 20, 1);
    g.translate(0, -length / 2, 0);
    return mesh(g);
  };
  /** Muscle/guard bulge: a squashed sphere overlaid on a limb segment. */
  const bulge = (r: number, sx: number, sy: number, sz: number, y: number): THREE.Mesh => {
    const b = mesh(new three.SphereGeometry(r, 18, 14));
    b.scale.set(sx, sy, sz);
    b.position.y = y;
    return b;
  };
  const ball = (r: number): THREE.Mesh => mesh(new three.SphereGeometry(r, 20, 14), jointMat);
  const jointAt = (
    name: MannequinJoint,
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    ballR?: number,
  ): THREE.Group => {
    const grp = new three.Group();
    grp.name = name;
    grp.position.set(x, y, z);
    if (ballR) grp.add(ball(ballR));
    parent.add(grp);
    joints.set(name, grp);
    return grp;
  };
  const lathe = (profile: Array<[number, number]>, segs = 24): THREE.BufferGeometry =>
    new three.LatheGeometry(profile.map(([r, y]) => new three.Vector2(r, y)), segs);

  const root = new three.Group();

  // Pelvis block: hip shell, wider than deep, with side hip guards.
  const pelvis = new three.Group();
  pelvis.position.y = H.pelvisY;
  root.add(pelvis);
  const pelvisMesh = mesh(new three.SphereGeometry(0.135, 24, 18));
  pelvisMesh.scale.set(1.15, 0.68, 0.82);
  pelvis.add(pelvisMesh);
  for (const s of [1, -1]) {
    const guard = mesh(new three.SphereGeometry(0.06, 16, 12));
    guard.scale.set(0.9, 1.15, 0.95);
    guard.position.set(s * 0.115, -0.02, 0);
    pelvis.add(guard);
  }

  // Abdomen: a short waist segment — the torso joint bends here.
  const torso = jointAt('torso', pelvis, 0, H.waist, 0, 0.095);
  torso.add(mesh(lathe([[0.088, 0], [0.098, 0.06], [0.092, 0.13], [0.08, 0.18]])));

  // Chest shell: broad and flat (wider than deep), clavicle taper on top.
  const chest = jointAt('chest', torso, 0, H.chestUp, 0, 0.085);
  const chestMesh = mesh(lathe([[0.085, -0.02], [0.12, 0.06], [0.135, 0.15], [0.11, 0.22], [0.045, 0.26]]));
  chestMesh.scale.set(1.28, 1, 0.78);
  chest.add(chestMesh);

  // Neck + helmet head with a darker visor band (facing cue without a face).
  const neck = jointAt('neck', chest, 0, H.neckUp, 0, 0.042);
  neck.add(mesh(new three.CylinderGeometry(0.036, 0.042, 0.07, 16)));
  const head = jointAt('head', neck, 0, H.headUp, 0);
  const skull = mesh(new three.SphereGeometry(0.11, 28, 22));
  skull.scale.set(0.88, 1.12, 0.98);
  skull.position.y = 0.1;
  head.add(skull);
  const visor = mesh(new three.SphereGeometry(0.105, 24, 10, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.16), jointMat);
  visor.scale.set(0.9, 1.12, 1.0);
  visor.position.y = 0.1;
  visor.rotation.x = -Math.PI * 0.06;
  head.add(visor);

  // Arms: padded shoulder ball → upper arm → elbow ball → forearm with a
  // wrist-guard flare → wrist ball → mitten hand (attachTo slot at the palm).
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const shoulder = jointAt(`shoulder${side}`, chest, s * H.shoulderHalf, 0.185, 0, 0.052);
    const pad = mesh(new three.SphereGeometry(0.072, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55));
    pad.scale.set(1, 0.9, 1);
    pad.rotation.z = s * -0.35;
    shoulder.add(pad);
    shoulder.add(limb(0.042, 0.036, H.armUpper));
    shoulder.add(bulge(0.048, 1, 1.35, 1, -0.09)); // biceps
    const elbow = jointAt(`elbow${side}`, shoulder, 0, -H.armUpper, 0, 0.042);
    elbow.add(limb(0.034, 0.03, H.armLower));
    elbow.add(bulge(0.04, 1, 1.5, 1, -0.17)); // wrist guard flare
    const wrist = jointAt(`wrist${side}`, elbow, 0, -H.armLower, 0, 0.032);
    const hand = new three.Group();
    hand.name = `hand${side}`;
    hand.position.y = -0.055;
    const palm = mesh(new three.SphereGeometry(0.05, 16, 12));
    palm.scale.set(0.7, 1.2, 0.42);
    hand.add(palm);
    const thumb = mesh(new three.SphereGeometry(0.022, 10, 8));
    thumb.scale.set(0.8, 1.4, 0.8);
    thumb.position.set(s * 0.032, 0.01, 0.015);
    hand.add(thumb);
    wrist.add(hand);
  }

  // Legs: hip ball → thigh → knee ball → calf (muscle bulge + ankle guard) →
  // ankle ball → boot with toe cap.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const hip = jointAt(`hip${side}`, pelvis, s * H.hipHalf, -H.hipDrop, 0, 0.062);
    hip.add(limb(0.06, 0.046, H.legUpper));
    hip.add(bulge(0.065, 1, 1.4, 1, -0.13)); // thigh
    const knee = jointAt(`knee${side}`, hip, 0, -H.legUpper, 0, 0.052);
    knee.add(limb(0.044, 0.032, H.legLower));
    knee.add(bulge(0.05, 1, 1.5, 1, -0.12)); // calf
    knee.add(bulge(0.038, 1, 1.3, 1, -0.34)); // ankle guard
    const ankle = jointAt(`ankle${side}`, knee, 0, -H.legLower, 0, 0.038);
    const boot = mesh(new three.SphereGeometry(0.055, 18, 14));
    boot.scale.set(0.82, 0.55, 1.7);
    boot.position.set(0, -0.036, 0.03);
    ankle.add(boot);
    const toe = mesh(new three.SphereGeometry(0.042, 14, 10));
    toe.scale.set(0.85, 0.5, 1.0);
    toe.position.set(0, -0.045, 0.115);
    ankle.add(toe);
  }

  const heightM = H.pelvisY + H.waist + H.chestUp + H.neckUp + H.headUp + 0.1 + 0.11 * 1.12;
  return { root, joints, heightM };
}
