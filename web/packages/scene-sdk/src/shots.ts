// shots.ts — expand a shot cut-list into plain step-eased camera keyframes.
//
// `shots[]` is authoring sugar: the runtime camera model stays "one camera,
// keyframed values" (what the interpreter, Director frustum and inspector all
// understand). Expansion is a pure spec→spec transform: each shot contributes
// its values as keyframes at its own start with a `steps(1)` arrival ease —
// i.e. the previous shot's value HOLDS until the boundary, then hard-cuts.
// Keyframes authored inside a shot are relative to the shot start and get
// shifted to scene time.

import type { Animatable } from '@velocut/render-sdk';
import type { SceneCamera, SceneShot, SceneSpec, Vec3A } from './types.ts';

const CUT: string = 'steps(1)';

interface Key {
  t: number;
  v: number;
  ease?: string;
}

/** Append one shot's contribution for a single scalar field. */
function appendField(out: Key[], a: Animatable | undefined, fallback: number, shotStart: number, isFirst: boolean): void {
  if (a == null) a = fallback;
  if (typeof a === 'number') {
    // Constant for this shot: one key at the boundary (hard cut unless first).
    out.push({ t: shotStart, v: a, ease: isFirst ? undefined : CUT });
  } else {
    // Keyframed within the shot: shift to scene time; the FIRST key arrives as
    // a cut, the rest keep their authored eases.
    a.forEach((k, i) => {
      out.push({
        t: shotStart + k.t,
        v: k.v,
        ease: i === 0 ? (isFirst ? k.ease : CUT) : k.ease,
      });
    });
  }
}

function expandVec3(shots: SceneShot[], pick: (c: SceneCamera) => Vec3A | undefined, dx: number, dy: number, dz: number): Vec3A {
  const xs: Key[] = [];
  const ys: Key[] = [];
  const zs: Key[] = [];
  shots.forEach((s, i) => {
    const v = pick(s.camera);
    appendField(xs, v?.x, dx, s.start, i === 0);
    appendField(ys, v?.y, dy, s.start, i === 0);
    appendField(zs, v?.z, dz, s.start, i === 0);
  });
  return { x: xs, y: ys, z: zs };
}

/**
 * If the spec has `shots`, return a copy whose `camera` is the expanded cut
 * sequence (and `shots` removed); otherwise return the spec unchanged. Call
 * before compiling/staging — validateSceneSpec has already enforced shot
 * ordering and a single lookAt mode.
 */
export function expandShots(spec: SceneSpec): SceneSpec {
  const shots = spec.shots;
  if (!shots || shots.length === 0) return spec;

  const fov: Key[] = [];
  const roll: Key[] = [];
  shots.forEach((s, i) => {
    appendField(fov, s.camera.fov, 40, s.start, i === 0);
    appendField(roll, s.camera.roll, 0, s.start, i === 0);
  });

  const charTarget = shots
    .map((s) => s.camera.lookAt)
    .find((l) => l != null && 'character' in (l as object)) as { character: string } | undefined;

  const camera: SceneCamera = {
    fov,
    roll,
    position: expandVec3(shots, (c) => c.position, 5, 2.4, 7),
    lookAt: charTarget ?? expandVec3(shots, (c) => c.lookAt as Vec3A | undefined, 0, 1, 0),
    // One shake profile for the whole sequence (the first shot that sets one).
    shake: shots.map((s) => s.camera.shake).find((sh) => sh != null),
  };
  const { shots: _drop, ...rest } = spec;
  return { ...rest, camera };
}

// Referenced by tests to assert cut semantics without duplicating the string.
export const CUT_EASE = CUT;
