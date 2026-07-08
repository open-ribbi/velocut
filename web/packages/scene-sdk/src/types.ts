// types.ts — SceneSpec v1: the declarative 3D scene document.
//
// Pure JSON, interpreted by a fixed compiler (compile.ts) — the agent sandbox
// threat model stays intact because a spec can express nothing but scene
// state. Keyframes reuse the MotionSpec grammar ({t, v, ease} with GSAP ease
// names) so agents learn ONE animation vocabulary.

import type { Animatable } from '@velocut/render-sdk';
import { MANNEQUIN_JOINTS, POSE_PRESETS, type MannequinJoint } from './mannequin.ts';

/** Per-axis animatable 3D value (world units = meters, Y up). */
export interface Vec3A {
  x?: Animatable;
  y?: Animatable;
  z?: Animatable;
}

/** One preset-animation segment in a character's action sequence. Actions are
 *  sorted by start; each is active from its start until the next action's
 *  start (the last one runs to the end of the scene). `fade` cross-fades from
 *  the previous action over that many seconds. */
export interface SceneAction {
  /** Registry clip id for the character's model (e.g. 'Walking', 'Wave'). */
  clip: string;
  /** Seconds from scene start. */
  start: number;
  /** Loop the clip (default: the manifest's per-clip loop flag). */
  loop?: boolean;
  /** Cross-fade seconds from the previous action (default 0.3). */
  fade?: number;
}

/** Uniform (number) or per-axis scale — a pillar stretched into a lamp post
 *  is `{x:0.2, y:3, z:0.2}`. */
export type Scale3 = number | { x?: number; y?: number; z?: number };

export interface SceneCharacter {
  /** Spec-local id, referenced by camera lookAt. */
  id: string;
  /** Registry model id (e.g. 'char/robot'). */
  model: string;
  position?: Vec3A;
  /** Yaw, degrees (0 = facing +Z, toward the default camera). */
  rotationY?: Animatable;
  scale?: Scale3;
  actions?: SceneAction[];
  /** Head aim: look at the shot camera or another character (yaw-clamped so
   *  the head never spins). Great for dialogue staging and to-camera beats. */
  gaze?: 'camera' | { character: string };
  /** Facial expression / blend-shape weights: morph target name (see the
   *  manifest's per-model `morphs`) → weight 0..1, constant or keyframed.
   *  A model with mouth morphs gets talking the same way. */
  morphs?: Record<string, Animatable>;
  /** Poseable figures (char/mannequin): a preset name, or a preset plus
   *  per-joint Euler overrides in degrees [pitch, yaw, roll] — each axis
   *  constant or keyframed, so a pose can move. */
  pose?: string | CharacterPose;
  /** Body color for built-in figures (CSS hex). */
  color?: string;
}

export interface CharacterPose {
  preset?: string;
  joints?: Record<string, [Animatable, Animatable, Animatable]>;
}

export interface SceneProp {
  id?: string;
  /** Registry prop id (e.g. 'prop/cube') — built-in geometry in v1. */
  model: string;
  position?: Vec3A;
  rotationY?: Animatable;
  scale?: Scale3;
  /** CSS hex color for built-in props. */
  color?: string;
  /** Parent this prop to a character's bone slot (see the manifest's per-model
   *  `bones`, e.g. handR/handL/head). While attached, position/rotationY/scale
   *  are LOCAL to the bone (meters) — a hand-held item rides the animation. */
  attachTo?: { character: string; bone?: string };
  /** Parametric geometry input, meters. For 'prop/lathe': a [radius, y]
   *  profile from bottom to top, revolved around the Y axis (vases, cups,
   *  bottles, lampshades). For 'prop/extrude': a closed [x, y] polygon
   *  outline extruded along Z by `depth` (arrows, stars, signs). */
  points?: [number, number][];
  /** Extrusion thickness for 'prop/extrude', meters (default 0.1). */
  depth?: number;
}

export interface SceneCamera {
  /** Vertical field of view, degrees (default 40). */
  fov?: Animatable;
  position?: Vec3A;
  /** A point, or a character to track (its chest height, follows movement). */
  lookAt?: Vec3A | { character: string };
  /** Dutch angle, degrees (rotation around the view axis). */
  roll?: Animatable;
  /** Deterministic handheld wobble (a fixed multi-sine of t — reproducible on
   *  every render). amplitude in meters, rotAmplitude in degrees, frequency Hz. */
  shake?: { amplitude?: number; rotAmplitude?: number; frequency?: number };
}

/** One shot in a cut sequence — sugar that compiles to step-eased camera
 *  keyframes (a hard cut at each shot's start). Keyframed values inside a
 *  shot's camera are RELATIVE to the shot start (seconds). */
export interface SceneShot {
  /** Seconds from scene start; shots must be sorted and start at 0. */
  start: number;
  camera: SceneCamera;
}

export interface SceneSpec {
  version: 1;
  durationUs: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Registry environment id (default 'env/stage'). */
  environment?: string;
  lighting?: 'day' | 'night' | 'indoor';
  characters?: SceneCharacter[];
  props?: SceneProp[];
  camera?: SceneCamera;
  /** Multi-shot cut list — overrides `camera` when present (see SceneShot). */
  shots?: SceneShot[];
}

// ------------------------------------------------------------ asset manifest

export interface ManifestClip {
  loop?: boolean;
  /** Natural gait speed for locomotion clips — lets an author match position
   *  keyframes to the animation so walking doesn't skate. */
  speedMps?: number;
}

export interface SceneAssetManifest {
  version: 1;
  characters: Record<
    string,
    {
      file: string;
      label?: string;
      license: string;
      heightM?: number;
      /** Normalizes the model's native units to meters (e.g. 0.01 for a
       *  centimeter-authored GLB) — applied under the user-facing transform. */
      baseScale?: number;
      /** Semantic bone slots (handR/handL/head/…) → actual rig bone names,
       *  the vocabulary prop attachTo speaks. */
      bones?: Record<string, string>;
      /** Morph-target (blend shape) names exposed for character.morphs. */
      morphs?: string[];
      clips: Record<string, ManifestClip>;
    }
  >;
  environments: Record<string, { label?: string; builtin?: boolean; license: string }>;
  lighting: Record<string, { label?: string }>;
  props: Record<string, { label?: string; builtin?: boolean; license: string }>;
}

// ---------------------------------------------------------------- validation

// Finite-only: NaN/Infinity survive the sandbox's structured clone but turn
// into `null` under JSON.stringify — the document would store a spec that can
// never validate again (renders now, black after reload). Reject at the door.
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const isAnimatable = (v: unknown): boolean =>
  fin(v) || (Array.isArray(v) && v.length > 0 && v.every((k) => k && fin(k.t) && fin(k.v)));

const isScale3 = (v: unknown): boolean => {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v == null || typeof v !== 'object') return false;
  // Same no-unknown-keys rule as Vec3A: a malformed scale must fail loudly,
  // not render as a NaN matrix (invisible object) — found by a real agent
  // authoring {x,y,z} scales.
  if (!Object.keys(v).every((k) => k === 'x' || k === 'y' || k === 'z')) return false;
  const o = v as { x?: unknown; y?: unknown; z?: unknown };
  return [o.x, o.y, o.z].every((a) => a === undefined || (typeof a === 'number' && Number.isFinite(a)));
};

const isVec3A = (v: unknown): boolean => {
  if (v == null || typeof v !== 'object') return false;
  // No unknown keys: a typo like {charcter: …} must not pass as an
  // all-defaults Vec3A — silent acceptance hides authoring mistakes.
  if (!Object.keys(v).every((k) => k === 'x' || k === 'y' || k === 'z')) return false;
  const o = v as Vec3A;
  return [o.x, o.y, o.z].every((a) => a === undefined || isAnimatable(a));
};

/** Structural validation. Returns an error message or null. Registry checks
 *  (does the model/clip exist?) happen at compile/host time against the
 *  manifest — this stays pure and dependency-free. */
export function validateSceneSpec(spec: unknown): string | null {
  const s = spec as SceneSpec | null;
  if (!s || typeof s !== 'object') return 'spec must be an object';
  if (s.version !== 1) return 'spec.version must be 1';
  if (!(fin(s.durationUs) && s.durationUs > 0)) return 'spec.durationUs must be > 0';
  if (s.fps != null && !(fin(s.fps) && s.fps >= 1 && s.fps <= 120)) return 'spec.fps must be 1..120';
  if (s.width != null && !(fin(s.width) && s.width >= 16 && s.width <= 8192)) return 'spec.width must be 16..8192';
  if (s.height != null && !(fin(s.height) && s.height >= 16 && s.height <= 8192)) return 'spec.height must be 16..8192';
  if (s.characters != null) {
    if (!Array.isArray(s.characters) || s.characters.length > 8) return 'spec.characters must be an array of at most 8';
    const seen = new Set<string>();
    for (const c of s.characters) {
      if (!c || typeof c.id !== 'string' || !c.id) return 'every character needs a string id';
      if (seen.has(c.id)) return `duplicate character id '${c.id}'`;
      seen.add(c.id);
      if (typeof c.model !== 'string') return `character '${c.id}': model must be a registry id string`;
      if (c.position != null && !isVec3A(c.position)) return `character '${c.id}': invalid position`;
      if (c.rotationY != null && !isAnimatable(c.rotationY)) return `character '${c.id}': invalid rotationY`;
      if (c.scale != null && !isScale3(c.scale)) return `character '${c.id}': scale must be a number or {x?,y?,z?}`;
      if (c.gaze != null && c.gaze !== 'camera' && typeof (c.gaze as { character?: unknown }).character !== 'string') {
        return `character '${c.id}': gaze must be 'camera' or { character: id }`;
      }
      if (c.morphs != null) {
        if (typeof c.morphs !== 'object' || Array.isArray(c.morphs)) {
          return `character '${c.id}': morphs must be { name: weight } with animatable weights`;
        }
        for (const [name, w] of Object.entries(c.morphs)) {
          if (!isAnimatable(w)) return `character '${c.id}': morph '${name}' weight must be animatable`;
        }
      }
      if (c.pose != null) {
        // Typo'd preset/joint names must fail here, not silently fall back —
        // an agent's misspelled pose would otherwise validate and do nothing.
        const badPreset = (name: string): string | null =>
          POSE_PRESETS[name] ? null : `character '${c.id}': unknown pose preset '${name}' (presets: ${Object.keys(POSE_PRESETS).join(', ')})`;
        if (typeof c.pose === 'string') {
          const e = badPreset(c.pose);
          if (e) return e;
        } else {
          const p = c.pose;
          if (typeof p !== 'object') return `character '${c.id}': pose must be a preset name or { preset?, joints? }`;
          if (p.preset != null) {
            if (typeof p.preset !== 'string') return `character '${c.id}': pose.preset must be a string`;
            const e = badPreset(p.preset);
            if (e) return e;
          }
          if (p.joints != null) {
            if (typeof p.joints !== 'object' || Array.isArray(p.joints)) return `character '${c.id}': pose.joints must be { joint: [x,y,z] }`;
            for (const [joint, v] of Object.entries(p.joints)) {
              if (!MANNEQUIN_JOINTS.includes(joint as MannequinJoint)) {
                return `character '${c.id}': unknown joint '${joint}' (joints: ${MANNEQUIN_JOINTS.join(', ')})`;
              }
              if (!Array.isArray(v) || v.length !== 3 || !v.every(isAnimatable)) {
                return `character '${c.id}': pose.joints.${joint} must be [pitch, yaw, roll] (degrees, animatable)`;
              }
            }
          }
        }
      }
      if (c.color != null && typeof c.color !== 'string') return `character '${c.id}': color must be a CSS color string`;
      if (c.actions != null) {
        if (!Array.isArray(c.actions) || c.actions.length > 50) return `character '${c.id}': actions must be an array of at most 50`;
        for (const a of c.actions) {
          if (!a || typeof a.clip !== 'string') return `character '${c.id}': every action needs a clip name`;
          if (!fin(a.start) || a.start < 0) return `character '${c.id}': action.start must be a number >= 0`;
          if (a.fade != null && (!fin(a.fade) || a.fade < 0)) return `character '${c.id}': action.fade must be a number >= 0`;
        }
      }
    }
  }
  if (s.props != null) {
    if (!Array.isArray(s.props) || s.props.length > 50) return 'spec.props must be an array of at most 50';
    for (const p of s.props) {
      if (!p || typeof p.model !== 'string') return 'every prop needs a model id';
      if (p.position != null && !isVec3A(p.position)) return 'prop: invalid position';
      if (p.scale != null && !isScale3(p.scale)) return 'prop: scale must be a number or {x?,y?,z?}';
      if (p.attachTo != null) {
        const a = p.attachTo;
        if (typeof a !== 'object' || typeof a.character !== 'string' || !a.character) {
          return 'prop.attachTo must be { character: id, bone? }';
        }
        if (a.bone != null && typeof a.bone !== 'string') return 'prop.attachTo.bone must be a slot name string';
        if (!(s.characters ?? []).some((c) => c.id === a.character)) {
          return `prop.attachTo: no character with id '${a.character}'`;
        }
      }
      const isPointList = (v: unknown): v is [number, number][] =>
        Array.isArray(v) &&
        v.length <= 64 &&
        v.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((n) => typeof n === 'number' && Number.isFinite(n)));
      if (p.model === 'prop/lathe') {
        if (!isPointList(p.points) || p.points.length < 2) return 'prop/lathe needs points: [[radius, y], …] (2..64, meters)';
        if (p.points.some(([r]) => r < 0)) return 'prop/lathe: radii must be >= 0';
      }
      if (p.model === 'prop/extrude') {
        if (!isPointList(p.points) || p.points.length < 3) return 'prop/extrude needs points: [[x, y], …] (3..64, a closed outline)';
        if (p.depth != null && !(typeof p.depth === 'number' && Number.isFinite(p.depth) && p.depth > 0)) {
          return 'prop/extrude: depth must be a positive number (meters)';
        }
      }
      if (p.points != null && p.model !== 'prop/lathe' && p.model !== 'prop/extrude') {
        return `prop '${p.model}' does not take points (only prop/lathe and prop/extrude do)`;
      }
    }
  }
  const checkCamera = (cam: SceneCamera, where: string): string | null => {
    if (typeof cam !== 'object' || cam == null) return `${where} must be an object`;
    if (cam.fov != null && !isAnimatable(cam.fov)) return `${where}.fov must be animatable`;
    if (cam.position != null && !isVec3A(cam.position)) return `${where}.position must be a Vec3A`;
    if (cam.roll != null && !isAnimatable(cam.roll)) return `${where}.roll must be animatable`;
    if (cam.shake != null) {
      const sh = cam.shake;
      if (typeof sh !== 'object') return `${where}.shake must be an object`;
      for (const k of ['amplitude', 'rotAmplitude', 'frequency'] as const) {
        if (sh[k] != null && !(typeof sh[k] === 'number' && Number.isFinite(sh[k]))) return `${where}.shake.${k} must be a number`;
      }
    }
    if (cam.lookAt != null && !isVec3A(cam.lookAt) && typeof (cam.lookAt as { character?: unknown }).character !== 'string') {
      return `${where}.lookAt must be a Vec3A or { character: id }`;
    }
    return null;
  };
  if (s.camera != null) {
    const err = checkCamera(s.camera, 'camera');
    if (err) return err;
  }
  if (s.shots != null) {
    if (!Array.isArray(s.shots) || s.shots.length === 0 || s.shots.length > 32) {
      return 'spec.shots must be a non-empty array of at most 32';
    }
    let prev = -1;
    let sawPoint = false;
    let charTarget: string | null = null;
    for (let i = 0; i < s.shots.length; i++) {
      const shot = s.shots[i];
      if (!shot || !fin(shot.start) || shot.start < 0) return `shots[${i}].start must be a number >= 0`;
      if (i === 0 && shot.start !== 0) return 'shots[0].start must be 0';
      if (shot.start <= prev && i > 0) return 'shots must be sorted by ascending start';
      prev = shot.start;
      const err = checkCamera(shot.camera, `shots[${i}].camera`);
      if (err) return err;
      const look = shot.camera?.lookAt;
      if (look != null) {
        if ('character' in (look as object)) {
          const id = (look as { character: string }).character;
          if (charTarget != null && charTarget !== id) return 'shots cannot track different characters (one target per cut list)';
          charTarget = id;
        } else {
          sawPoint = true;
        }
      }
    }
    if (sawPoint && charTarget != null) {
      return 'shots cannot mix point lookAt and character tracking (expansion needs one mode)';
    }
  }
  return null;
}
