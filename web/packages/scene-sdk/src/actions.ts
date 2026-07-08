// actions.ts — pure math for character action sequences.
//
// Given a character's action list and a time t, resolve which preset clips
// play, at what local clip time, with what cross-fade weights. A pure
// function of (actions, t, clip metadata) — no mixer state survives between
// frames, which is what keeps scene rendering deterministic for export.

import type { SceneAction } from './types.ts';

export interface ClipMeta {
  /** Natural duration of the animation clip, seconds. */
  duration: number;
  /** Default loop behaviour when the action doesn't say. */
  loop: boolean;
}

export interface ActivePose {
  clip: string;
  /** Local time within the clip, seconds. */
  time: number;
  /** Blend weight 0..1 (weights of all active poses sum to 1). */
  weight: number;
}

const DEFAULT_FADE = 0.3;
/** Non-looping clips freeze a hair before the end so the pose holds. */
const HOLD_EPS = 1e-4;

/** Local clip time for an action that started at `start`, evaluated at `t`. */
function localTime(t: number, start: number, meta: ClipMeta, loop: boolean | undefined): number {
  const el = Math.max(0, t - start);
  const dur = Math.max(meta.duration, HOLD_EPS);
  return (loop ?? meta.loop) ? el % dur : Math.min(el, dur - HOLD_EPS);
}

/**
 * Resolve the active pose blend at time `t`.
 *
 * Actions are sorted by start; action i is active on [start_i, start_{i+1})
 * and the last runs to the end of the scene. Inside an action's first `fade`
 * seconds the PREVIOUS action keeps playing and the two cross-fade linearly.
 * Unknown clips (not in `clips`) are skipped — the character holds whatever
 * else is active (or bind pose).
 */
export function resolveActions(
  actions: SceneAction[] | undefined,
  t: number,
  clips: Record<string, ClipMeta>,
): ActivePose[] {
  const seq = (actions ?? []).filter((a) => clips[a.clip]).sort((a, b) => a.start - b.start);
  if (seq.length === 0) return [];

  // Which action owns t (the last with start <= t; before the first → the first).
  let i = 0;
  while (i + 1 < seq.length && seq[i + 1].start <= t) i++;
  const cur = seq[i];
  const meta = clips[cur.clip];
  const curPose: ActivePose = { clip: cur.clip, time: localTime(t, cur.start, meta, cur.loop), weight: 1 };

  // Cross-fade window from the previous action.
  const fade = Math.max(0, cur.fade ?? DEFAULT_FADE);
  const into = t - cur.start;
  if (i > 0 && fade > 0 && into >= 0 && into < fade) {
    const prev = seq[i - 1];
    // Same clip on both sides of the fade (Walk → Wave → Walk): one
    // AnimationAction can't hold two times, and a self-fade is a no-op
    // visually — just play the current action at full weight.
    if (prev.clip !== cur.clip) {
      const p = into / fade;
      curPose.weight = p;
      const prevMeta = clips[prev.clip];
      return [
        { clip: prev.clip, time: localTime(t, prev.start, prevMeta, prev.loop), weight: 1 - p },
        curPose,
      ];
    }
  }
  return [curPose];
}
