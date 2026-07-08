// mannequin.ts — the built-in poseable figure (an art mannequin), zero assets.
//
// Purpose-built for the previz→video-generation path: a neutral humanoid
// silhouette the agent (or a human, via presets + per-joint controls) POSES,
// so a shot's blocking and body language condition the generator without any
// styled model getting in the way. Unlike a pose-only tool, every joint angle
// is an Animatable — a pose can be keyframed, so the mannequin also MOVES.
//
// Built like a real wooden drawing mannequin: tapered rigid segments joined
// by visible ball joints, so a bent elbow reads as an articulation instead of
// a broken tube. Each segment hangs under a joint Group whose origin sits at
// the anatomical pivot; joint rotation = Group rotation — no skinning, fully
// deterministic, and gaze (head)/attachTo (hands) work through plain node
// names. A small nose wedge marks the facing direction (readable blocking).

import type * as THREE from 'three';

/** Poseable joints. Euler degrees [x, y, z]: x = pitch (bend forward/back),
 *  y = yaw (twist), z = roll (spread sideways). */
export const MANNEQUIN_JOINTS = [
  'torso',
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
    torso: [14, 0, 0],
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
    torso: [25, 0, 0],
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
    torso: [5, 0, 0],
    hipL: [-90, 0, 4],
    kneeL: [90, 0, 0],
    ankleL: [-4, 0, 0],
    hipR: [10, 0, -4],
    kneeR: [110, 0, 0],
    ankleR: [42, 0, 0],
  },
  bow: {
    torso: [45, 0, 0],
    head: [20, 0, 0],
    shoulderL: [13, 0, -7],
    shoulderR: [3, 0, -5],
    elbowL: [6, 0, 0],
    elbowR: [6, 0, 0],
  },
  thinking: {
    torso: [5, 0, 0],
    head: [10, 15, 8],
    shoulderR: [-35, 0, -10],
    elbowR: [120, 0, 0],
    wristR: [28, 0, 0],
    shoulderL: [0, 0, 6],
  },
  fighting: {
    torso: [10, 20, 0],
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
    shoulderR: [0, 0, -155],
    elbowR: [25, 0, 0],
    wristR: [0, 0, -12],
    head: [0, -10, 5],
    shoulderL: [0, 0, 6],
  },
  reaching: {
    torso: [8, 0, 0],
    shoulderR: [-85, 0, 0],
    elbowR: [6, 0, 0],
    wristR: [-14, 0, 0],
    shoulderL: [0, 0, 6],
  },
  armscrossed: {
    shoulderL: [-35, 0, -25],
    shoulderR: [-35, 0, 25],
    elbowL: [115, 25, 0],
    elbowR: [115, -25, 0],
    wristL: [18, 0, 0],
    wristR: [18, 0, 0],
  },
  phone: {
    head: [22, 0, 0],
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

// Proportions (meters) for a ~1.7 m figure.
const H = {
  pelvisY: 0.94, // pelvis center height
  hipDrop: 0.05, // pelvis center → hip pivot
  legUpper: 0.42, // hip → knee
  legLower: 0.4, // knee → ankle
  torsoJoint: 0.05, // pelvis center → waist pivot
  torsoLen: 0.47, // waist → neck base
  headJoint: 0.48, // waist → head (neck) pivot
  armUpper: 0.29, // shoulder → elbow
  armLower: 0.25, // elbow → wrist
  shoulderHalf: 0.19,
  hipHalf: 0.095,
};

export const MANNEQUIN_DEFAULT_COLOR = '#d8d3cb'; // warm light grey (wood/clay)

/** Build the segmented figure: tapered limbs + visible ball joints. */
export function buildMannequin(three: typeof THREE, color: string | undefined): Mannequin {
  const bodyColor = new three.Color(color ?? MANNEQUIN_DEFAULT_COLOR);
  const mat = new three.MeshStandardMaterial({ color: bodyColor, roughness: 0.5 });
  // Joints a shade darker, so every articulation reads at a glance.
  const jointMat = new three.MeshStandardMaterial({
    color: bodyColor.clone().multiplyScalar(0.62),
    roughness: 0.35,
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

  const root = new three.Group();

  // Pelvis block (root of the body).
  const pelvis = new three.Group();
  pelvis.position.y = H.pelvisY;
  root.add(pelvis);
  const pelvisMesh = mesh(new three.SphereGeometry(0.13, 24, 18));
  pelvisMesh.scale.set(1.22, 0.72, 0.86);
  pelvis.add(pelvisMesh);

  // Torso: a lathed shell (waist → chest → shoulders), bending at the waist.
  const torso = jointAt('torso', pelvis, 0, H.torsoJoint, 0, 0.105);
  const torsoProfile: Array<[number, number]> = [
    [0.093, 0],
    [0.103, 0.07],
    [0.118, 0.17],
    [0.142, 0.3],
    [0.148, 0.36],
    [0.122, 0.42],
    [0.06, 0.46],
    [0.04, H.torsoLen],
  ];
  torso.add(mesh(new three.LatheGeometry(torsoProfile.map(([r, y]) => new three.Vector2(r, y)), 28)));

  // Head on a short neck (the neck rotates with the head — a nod bends here).
  const head = jointAt('head', torso, 0, H.headJoint, 0);
  const neck = mesh(new three.CylinderGeometry(0.038, 0.042, 0.07, 16));
  neck.position.y = 0.02;
  head.add(neck);
  const skull = mesh(new three.SphereGeometry(0.112, 28, 22));
  skull.scale.set(0.88, 1.1, 0.96);
  skull.position.y = 0.155;
  head.add(skull);
  // Nose wedge: makes the facing direction readable from any angle.
  const nose = mesh(new three.ConeGeometry(0.018, 0.05, 12));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.145, 0.108);
  head.add(nose);

  // Arms: shoulder ball → tapered upper → elbow ball → tapered forearm →
  // wrist ball → paddle hand (the attachTo slot lives at the palm).
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const shoulder = jointAt(`shoulder${side}`, torso, s * H.shoulderHalf, 0.395, 0, 0.056);
    shoulder.add(limb(0.045, 0.037, H.armUpper));
    const elbow = jointAt(`elbow${side}`, shoulder, 0, -H.armUpper, 0, 0.045);
    elbow.add(limb(0.035, 0.028, H.armLower));
    const wrist = jointAt(`wrist${side}`, elbow, 0, -H.armLower, 0, 0.034);
    const hand = new three.Group();
    hand.name = `hand${side}`;
    hand.position.y = -0.06;
    const palm = mesh(new three.SphereGeometry(0.052, 16, 12));
    palm.scale.set(0.72, 1.2, 0.45);
    hand.add(palm);
    wrist.add(hand);
  }

  // Legs: hip ball → tapered thigh → knee ball → tapered calf → ankle ball →
  // shoe (heel slightly behind the ankle, sole meeting the ground).
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const hip = jointAt(`hip${side}`, pelvis, s * H.hipHalf, -H.hipDrop, 0, 0.068);
    hip.add(limb(0.062, 0.048, H.legUpper));
    const knee = jointAt(`knee${side}`, hip, 0, -H.legUpper, 0, 0.055);
    knee.add(limb(0.046, 0.036, H.legLower));
    const ankle = jointAt(`ankle${side}`, knee, 0, -H.legLower, 0, 0.04);
    const shoe = mesh(new three.SphereGeometry(0.058, 18, 14));
    shoe.scale.set(0.78, 0.5, 1.95);
    shoe.position.set(0, -0.038, 0.05);
    ankle.add(shoe);
  }

  const heightM = H.pelvisY + H.torsoJoint + H.headJoint + 0.155 + 0.112 * 1.1;
  return { root, joints, heightM };
}
