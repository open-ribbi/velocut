// mannequin.ts — the built-in poseable figure (an art mannequin), zero assets.
//
// Purpose-built for the previz→video-generation path: a neutral humanoid
// silhouette the agent (or a human, via presets + per-joint controls) POSES,
// so a shot's blocking and body language condition the generator without any
// styled model getting in the way. Unlike a pose-only tool, every joint angle
// is an Animatable — a pose can be keyframed, so the mannequin also MOVES.
//
// Built as a rigid segment hierarchy (like a real wooden mannequin): each
// body part is a mesh parented under a joint Group whose origin sits at the
// anatomical pivot. Joint rotation = Group rotation — no skinning, fully
// deterministic, and gaze (head)/attachTo (hands) work through plain node
// names.

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
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
] as const;
export type MannequinJoint = (typeof MANNEQUIN_JOINTS)[number];

export type PoseAngles = Partial<Record<MannequinJoint, [number, number, number]>>;

/** Pose presets — joint-angle dictionaries (degrees), the same model LibTV-
 *  style consoles use. A preset is a starting point; per-joint values in the
 *  spec override on top. */
export const POSE_PRESETS: Record<string, PoseAngles> = {
  standing: { shoulderL: [0, 0, 5], shoulderR: [0, 0, -5], elbowL: [5, 0, 0], elbowR: [5, 0, 0] },
  tpose: { shoulderL: [0, 0, 90], shoulderR: [0, 0, -90] },
  walking: {
    shoulderL: [-25, 0, 5],
    shoulderR: [25, 0, -5],
    elbowL: [15, 0, 0],
    elbowR: [20, 0, 0],
    hipL: [20, 0, 0],
    hipR: [-15, 0, 0],
    kneeL: [10, 0, 0],
    kneeR: [30, 0, 0],
  },
  running: {
    torso: [12, 0, 0],
    shoulderL: [-45, 0, 5],
    shoulderR: [45, 0, -5],
    elbowL: [80, 0, 0],
    elbowR: [90, 0, 0],
    hipL: [40, 0, 0],
    hipR: [-30, 0, 0],
    kneeL: [25, 0, 0],
    kneeR: [90, 0, 0],
  },
  sitting: { hipL: [-85, 0, 3], hipR: [-85, 0, -3], kneeL: [85, 0, 0], kneeR: [85, 0, 0], shoulderL: [-15, 0, 5], shoulderR: [-15, 0, -5], elbowL: [25, 0, 0], elbowR: [25, 0, 0] },
  squat: {
    torso: [25, 0, 0],
    hipL: [-110, 0, 8],
    hipR: [-110, 0, -8],
    kneeL: [125, 0, 0],
    kneeR: [125, 0, 0],
    shoulderL: [-40, 0, 5],
    shoulderR: [-40, 0, -5],
    elbowL: [30, 0, 0],
    elbowR: [30, 0, 0],
  },
  kneeling: { hipL: [-90, 0, 3], kneeL: [90, 0, 0], hipR: [10, 0, -3], kneeR: [110, 0, 0], torso: [5, 0, 0] },
  bow: { torso: [45, 0, 0], head: [20, 0, 0], shoulderL: [13, 0, -7], shoulderR: [3, 0, -5], elbowL: [5, 0, 0], elbowR: [5, 0, 0] },
  thinking: { head: [10, 15, 8], shoulderR: [-35, 0, -10], elbowR: [120, 0, 0], shoulderL: [0, 0, 5], torso: [5, 0, 0] },
  fighting: { torso: [10, 20, 0], shoulderL: [-30, 0, 20], shoulderR: [-40, 0, -15], elbowL: [95, 0, 0], elbowR: [110, 0, 0], hipL: [10, 0, 8], hipR: [-5, 0, -8], kneeL: [15, 0, 0], kneeR: [10, 0, 0] },
  wave: { shoulderR: [0, 0, -155], elbowR: [25, 0, 0], head: [0, -10, 5], shoulderL: [0, 0, 5] },
  reaching: { shoulderR: [-85, 0, 0], elbowR: [5, 0, 0], torso: [8, 0, 0], shoulderL: [0, 0, 5] },
  armscrossed: { shoulderL: [-35, 0, -25], shoulderR: [-35, 0, 25], elbowL: [115, 25, 0], elbowR: [115, -25, 0] },
  phone: { head: [22, 0, 0], shoulderR: [-30, 0, -12], elbowR: [125, 0, 0], shoulderL: [0, 0, 5] },
};

export interface Mannequin {
  root: THREE.Group;
  /** Joint name → the Group whose rotation poses it. */
  joints: Map<MannequinJoint, THREE.Group>;
  /** Overall height, meters. */
  heightM: number;
}

// Proportions (meters) for a 1.7 m figure.
const H = {
  pelvisY: 0.98, // hip pivot height
  legUpper: 0.44,
  legLower: 0.44,
  footH: 0.1,
  torsoLen: 0.52, // pelvis top → shoulder line
  neck: 0.06,
  headR: 0.115,
  armUpper: 0.3,
  armLower: 0.27,
  handLen: 0.16,
  shoulderHalf: 0.21,
  hipHalf: 0.1,
};

/** Build the segmented figure. All geometry is translated so each segment
 *  hangs DOWN (limbs) or UP (torso/head) from its joint-origin group. */
export function buildMannequin(three: typeof THREE, color: string | undefined): Mannequin {
  const mat = new three.MeshStandardMaterial({ color: new three.Color(color ?? '#4f8ef7'), roughness: 0.45 });
  const joints = new Map<MannequinJoint, THREE.Group>();
  const seg = (radius: number, length: number, dir: 1 | -1): THREE.Mesh => {
    // A capsule whose origin is at one end: dir -1 hangs down, +1 grows up.
    const g = new three.CapsuleGeometry(radius, length, 4, 12);
    g.translate(0, (dir * length) / 2, 0);
    const m = new three.Mesh(g, mat);
    m.castShadow = true;
    return m;
  };
  const jointAt = (name: MannequinJoint, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group => {
    const grp = new three.Group();
    grp.name = name;
    grp.position.set(x, y, z);
    parent.add(grp);
    joints.set(name, grp);
    return grp;
  };

  const root = new three.Group();

  // Pelvis block (root of the body, at hip height).
  const pelvis = new three.Group();
  pelvis.position.y = H.pelvisY;
  root.add(pelvis);
  const pelvisMesh = new three.Mesh(new three.SphereGeometry(0.13, 16, 12), mat);
  pelvisMesh.scale.set(1.3, 0.75, 0.9);
  pelvisMesh.castShadow = true;
  pelvis.add(pelvisMesh);

  // Torso: bends from the pelvis, grows upward; chest bulge on top.
  const torso = jointAt('torso', pelvis, 0, 0.05, 0);
  torso.add(seg(0.11, H.torsoLen - 0.16, 1));
  const chest = new three.Mesh(new three.SphereGeometry(0.15, 16, 12), mat);
  chest.scale.set(1.25, 1.05, 0.85);
  chest.position.y = H.torsoLen - 0.12;
  chest.castShadow = true;
  torso.add(chest);

  // Head on a short neck.
  const head = jointAt('head', torso, 0, H.torsoLen + H.neck, 0);
  const skull = new three.Mesh(new three.SphereGeometry(H.headR, 20, 16), mat);
  skull.scale.set(0.85, 1.1, 0.9);
  skull.position.y = H.headR * 0.9;
  skull.castShadow = true;
  head.add(skull);

  // Arms: shoulder → upper (hangs down) → elbow → lower → hand slot.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const shoulder = jointAt(`shoulder${side}`, torso, s * H.shoulderHalf, H.torsoLen - 0.08, 0);
    shoulder.add(seg(0.05, H.armUpper - 0.05, -1));
    const elbow = jointAt(`elbow${side}`, shoulder, 0, -H.armUpper, 0);
    elbow.add(seg(0.042, H.armLower - 0.05, -1));
    const hand = new three.Group();
    hand.name = `hand${side}`;
    hand.position.y = -(H.armLower + H.handLen * 0.4);
    const palm = new three.Mesh(new three.SphereGeometry(0.05, 12, 10), mat);
    palm.scale.set(0.7, 1.3, 0.9);
    palm.castShadow = true;
    hand.add(palm);
    elbow.add(hand);
  }

  // Legs: hip → upper (down) → knee → lower → foot (forward wedge).
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const hip = jointAt(`hip${side}`, pelvis, s * H.hipHalf, -0.06, 0);
    hip.add(seg(0.065, H.legUpper - 0.07, -1));
    const knee = jointAt(`knee${side}`, hip, 0, -H.legUpper, 0);
    knee.add(seg(0.052, H.legLower - 0.1, -1));
    const foot = new three.Mesh(new three.BoxGeometry(0.09, H.footH * 0.6, 0.24), mat);
    foot.position.set(0, -(H.legLower - 0.02), 0.06);
    foot.castShadow = true;
    knee.add(foot);
  }

  return { root, joints, heightM: H.pelvisY + 0.05 + H.torsoLen + H.neck + H.headR * 2 };
}
