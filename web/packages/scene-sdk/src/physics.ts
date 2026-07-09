// physics.ts — deterministic rigid-body physics for SceneSpec props (Rapier).
//
// The stage contract says poseAt(t) must be a PURE function of t (scrubbing,
// export and preview all seek arbitrary frames) — but a physics simulation is
// inherently sequential state. The bridge is a BAKE: buildStage runs the
// whole simulation once at a fixed timestep and records every dynamic body's
// transform into a per-prop track; poseAt then just interpolates the track.
// Same spec → same bake (Rapier compiled to WASM is deterministic for equal
// inputs), so preview, Director playback and frame-exact export agree.
//
// Rapier loads dynamically (WASM embedded in the -compat build, ~2MB) — only
// specs that actually opt into physics pay for it.

import type * as THREE from 'three';
import { sampleAnimatable } from '@velocut/render-sdk/motionspec';
import { sampleVec3 } from './stage.ts';
import type { PropPhysics, SceneProp, SceneSpec } from './types.ts';

type Rapier = typeof import('@dimforge/rapier3d-compat');

/** Bake sample rate. 60 Hz interpolated covers every output fps (≤120) —
 *  neighboring samples are 1/60s apart, so nlerp ≈ slerp on rotations. */
export const PHYSICS_HZ = 60;

/** Simulation length cap, seconds. Beyond it bodies hold their last sample —
 *  in practice everything is asleep long before (see the early-out below);
 *  the cap only bounds bake memory for pathological spec durations. */
export const PHYSICS_MAX_S = 120;

/** One dynamic prop's baked motion: [x,y,z, qx,qy,qz,qw] × count. */
export interface BakeTrack {
  samples: Float32Array;
  count: number;
}

let rapierPromise: Promise<Rapier> | null = null;
function loadRapier(): Promise<Rapier> {
  if (!rapierPromise) {
    rapierPromise = import('@dimforge/rapier3d-compat').then(async (R) => {
      await R.init();
      return R;
    });
    rapierPromise.catch(() => (rapierPromise = null)); // don't poison the cache
  }
  return rapierPromise;
}

/** Normalize the spec's shorthand ('dynamic') to the object form. */
export function propPhysics(p: SceneProp): PropPhysics | null {
  if (p.physics == null) return null;
  return typeof p.physics === 'string' ? { type: p.physics } : p.physics;
}

const scale3 = (s: SceneProp['scale']): [number, number, number] => {
  if (typeof s === 'number') return [s, s, s];
  return [s?.x ?? 1, s?.y ?? 1, s?.z ?? 1];
};

/** Collider matching the prop's visual geometry. Exact primitives where the
 *  shape allows; otherwise a convex hull of the scaled mesh vertices (torus,
 *  hemisphere, lathe, extrude — note a hull fills concavities: a torus
 *  collides as a solid puck). */
function colliderDescFor(R: Rapier, p: SceneProp, mesh: THREE.Mesh) {
  const [sx, sy, sz] = scale3(p.scale);
  if (p.model === 'prop/cube') return R.ColliderDesc.cuboid(0.5 * sx, 0.5 * sy, 0.5 * sz);
  if (p.model === 'prop/sphere' && sx === sy && sy === sz) return R.ColliderDesc.ball(0.5 * sx);
  if (p.model === 'prop/pillar' && sx === sz) return R.ColliderDesc.cylinder(1 * sy, 0.3 * sx);
  if (p.model === 'prop/cone' && sx === sz) return R.ColliderDesc.cone(0.5 * sy, 0.5 * sx);
  const pos = mesh.geometry.getAttribute('position');
  const pts = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    pts[i * 3] = pos.getX(i) * sx;
    pts[i * 3 + 1] = pos.getY(i) * sy;
    pts[i * 3 + 2] = pos.getZ(i) * sz;
  }
  const hull = R.ColliderDesc.convexHull(pts);
  if (hull) return hull;
  // Degenerate geometry (shouldn't happen for built-ins): bounding box.
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  return R.ColliderDesc.cuboid(
    (Math.max(1e-3, bb.max.x - bb.min.x) / 2) * sx,
    (Math.max(1e-3, bb.max.y - bb.min.y) / 2) * sy,
    (Math.max(1e-3, bb.max.z - bb.min.z) / 2) * sz,
  );
}

const yawQuat = (deg: number): { x: number; y: number; z: number; w: number } => {
  const h = (deg * Math.PI) / 360;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
};

/**
 * Run the full simulation for a spec's physics props and return per-prop
 * tracks (aligned with `targets`; null for non-dynamic entries). fixed and
 * kinematic props participate as colliders but stay spec-driven at render
 * time — only dynamic bodies need baked motion.
 */
export async function bakePhysics(
  spec: SceneSpec,
  targets: Array<{ spec: SceneProp; mesh: THREE.Mesh }>,
): Promise<Array<BakeTrack | null>> {
  const R = await loadRapier();
  const g = spec.physics?.gravity ?? 9.81;
  const world = new R.World({ x: 0, y: -g, z: 0 });
  world.timestep = 1 / PHYSICS_HZ;

  try {
    // The visual ground plane is a collider too (env/void has no ground —
    // dynamic bodies there fall forever, which is the honest reading).
    if ((spec.environment ?? 'env/stage') !== 'env/void') {
      const ground = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
      world.createCollider(R.ColliderDesc.cuboid(40, 1, 40), ground);
    }

    interface Body {
      body: InstanceType<Rapier['RigidBody']>;
      phys: PropPhysics;
      spec: SceneProp;
      track: BakeTrack | null;
      released: boolean; // startAt reached (dynamic bodies start held in place)
    }
    const bodies: Array<Body | null> = []; // aligned with targets
    const durationS = spec.durationUs / 1e6;
    const count = Math.min(Math.ceil(durationS * PHYSICS_HZ), PHYSICS_MAX_S * PHYSICS_HZ) + 1;

    for (const { spec: p, mesh } of targets) {
      const phys = propPhysics(p);
      if (!phys) {
        bodies.push(null);
        continue;
      }
      const [x, y, z] = sampleVec3(p.position, 0, 0, 0.5, 0);
      const rotY = sampleAnimatable(p.rotationY, 0, 0);
      const held = phys.type === 'dynamic' && (phys.startAt ?? 0) > 0;
      const desc =
        phys.type === 'fixed'
          ? R.RigidBodyDesc.fixed()
          : phys.type === 'kinematic' || held
            ? R.RigidBodyDesc.kinematicPositionBased()
            : R.RigidBodyDesc.dynamic();
      desc.setTranslation(x, y, z).setRotation(yawQuat(rotY));
      if (phys.type === 'dynamic' && !held) {
        if (phys.velocity) desc.setLinvel(...phys.velocity);
        if (phys.angularVelocity) {
          const D = Math.PI / 180;
          desc.setAngvel({ x: phys.angularVelocity[0] * D, y: phys.angularVelocity[1] * D, z: phys.angularVelocity[2] * D });
        }
      }
      const body = world.createRigidBody(desc);
      const col = colliderDescFor(R, p, mesh)
        .setRestitution(phys.restitution ?? 0.3)
        .setFriction(phys.friction ?? 0.6);
      if (phys.mass != null) col.setMass(phys.mass);
      world.createCollider(col, body);
      const track: BakeTrack | null =
        phys.type === 'dynamic' ? { samples: new Float32Array(count * 7), count } : null;
      bodies.push({ body, phys, spec: p, track, released: !held });
    }

    const live = bodies.filter((b): b is Body => b != null);
    const dynamics = live.filter((b) => b.phys.type === 'dynamic');
    const kinematics = live.filter((b) => b.phys.type === 'kinematic');

    const record = (i: number): void => {
      for (const b of dynamics) {
        const tr = b.body.translation();
        const q = b.body.rotation();
        b.track!.samples.set([tr.x, tr.y, tr.z, q.x, q.y, q.z, q.w], i * 7);
      }
    };
    record(0);

    let recorded = 1;
    for (let i = 1; i < count; i++) {
      const tNext = i / PHYSICS_HZ;
      // Kinematic colliders follow their spec keyframes inside the sim, so a
      // moving platform pushes dynamics exactly as rendered.
      for (const k of kinematics) {
        const [kx, ky, kz] = sampleVec3(k.spec.position, tNext, 0, 0.5, 0);
        k.body.setNextKinematicTranslation({ x: kx, y: ky, z: kz });
        k.body.setNextKinematicRotation(yawQuat(sampleAnimatable(k.spec.rotationY, tNext, 0)));
      }
      // startAt: the body holds its pose kinematically, then goes live with
      // its initial velocities — timed beats ("the wall collapses at 3s").
      for (const d of dynamics) {
        // Strictly after: the sample AT startAt still shows the held pose
        // (release applies to the step that ends past it).
        if (d.released || tNext <= (d.phys.startAt ?? 0)) continue;
        d.body.setBodyType(R.RigidBodyType.Dynamic, true);
        if (d.phys.velocity) d.body.setLinvel({ x: d.phys.velocity[0], y: d.phys.velocity[1], z: d.phys.velocity[2] }, true);
        if (d.phys.angularVelocity) {
          const D = Math.PI / 180;
          d.body.setAngvel(
            { x: d.phys.angularVelocity[0] * D, y: d.phys.angularVelocity[1] * D, z: d.phys.angularVelocity[2] * D },
            true,
          );
        }
        d.released = true;
      }
      world.step();
      record(i);
      recorded = i + 1;
      // Early out once the world is at rest and nothing can wake it (no
      // kinematic movers, no pending startAt) — sampling clamps to the last
      // recorded sample, so a 60s scene with 2s of tumbling bakes 2s.
      if (!kinematics.length && dynamics.every((d) => d.released && d.body.isSleeping())) break;
    }
    for (const d of dynamics) d.track!.count = recorded;

    return bodies.map((b) => (b ? b.track : null));
  } finally {
    world.free();
  }
}

/** Interpolate a bake track at time t onto an object's transform. Pure —
 *  this is all poseAt does for a simulated prop. */
export function samplePhysicsTrack(
  track: BakeTrack,
  t: number,
  out: { position: { set(x: number, y: number, z: number): unknown }; quaternion: { set(x: number, y: number, z: number, w: number): unknown } },
): void {
  const f = Math.max(0, Math.min(t * PHYSICS_HZ, track.count - 1));
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, track.count - 1);
  const a = f - i0;
  const s = track.samples;
  const o0 = i0 * 7;
  const o1 = i1 * 7;
  const L = (k: number): number => s[o0 + k] + (s[o1 + k] - s[o0 + k]) * a;
  out.position.set(L(0), L(1), L(2));
  // Adjacent samples are 1/60s apart → tiny rotations, so a sign-corrected
  // nlerp is indistinguishable from slerp (and dependency-free).
  const dot = s[o0 + 3] * s[o1 + 3] + s[o0 + 4] * s[o1 + 4] + s[o0 + 5] * s[o1 + 5] + s[o0 + 6] * s[o1 + 6];
  const sgn = dot < 0 ? -1 : 1;
  let qx = s[o0 + 3] + (sgn * s[o1 + 3] - s[o0 + 3]) * a;
  let qy = s[o0 + 4] + (sgn * s[o1 + 4] - s[o0 + 4]) * a;
  let qz = s[o0 + 5] + (sgn * s[o1 + 5] - s[o0 + 5]) * a;
  let qw = s[o0 + 6] + (sgn * s[o1 + 6] - s[o0 + 6]) * a;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  qx /= n;
  qy /= n;
  qz /= n;
  qw /= n;
  out.quaternion.set(qx, qy, qz, qw);
}
