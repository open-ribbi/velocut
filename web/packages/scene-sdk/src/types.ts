// types.ts — SceneSpec v1: the declarative 3D scene document.
//
// Pure JSON, interpreted by a fixed compiler (compile.ts) — the agent sandbox
// threat model stays intact because a spec can express nothing but scene
// state. Keyframes reuse the MotionSpec grammar ({t, v, ease} with GSAP ease
// names) so agents learn ONE animation vocabulary.

import type { Animatable } from '@velocut/render-sdk';

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
}

export interface SceneCamera {
  /** Vertical field of view, degrees (default 40). */
  fov?: Animatable;
  position?: Vec3A;
  /** A point, or a character to track (its chest height, follows movement). */
  lookAt?: Vec3A | { character: string };
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
  characters: Record<string, { file: string; label?: string; license: string; heightM?: number; clips: Record<string, ManifestClip> }>;
  environments: Record<string, { label?: string; builtin?: boolean; license: string }>;
  lighting: Record<string, { label?: string }>;
  props: Record<string, { label?: string; builtin?: boolean; license: string }>;
}

// ---------------------------------------------------------------- validation

const isAnimatable = (v: unknown): boolean =>
  typeof v === 'number' ||
  (Array.isArray(v) && v.every((k) => k && typeof k.t === 'number' && typeof k.v === 'number'));

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
  if (!(typeof s.durationUs === 'number' && s.durationUs > 0)) return 'spec.durationUs must be > 0';
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
      if (c.actions != null) {
        if (!Array.isArray(c.actions) || c.actions.length > 50) return `character '${c.id}': actions must be an array of at most 50`;
        for (const a of c.actions) {
          if (!a || typeof a.clip !== 'string') return `character '${c.id}': every action needs a clip name`;
          if (typeof a.start !== 'number' || a.start < 0) return `character '${c.id}': action.start must be a number >= 0`;
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
    }
  }
  if (s.camera != null) {
    const cam = s.camera;
    if (typeof cam !== 'object') return 'spec.camera must be an object';
    if (cam.fov != null && !isAnimatable(cam.fov)) return 'camera.fov must be animatable';
    if (cam.position != null && !isVec3A(cam.position)) return 'camera.position must be a Vec3A';
    if (cam.lookAt != null && !isVec3A(cam.lookAt) && typeof (cam.lookAt as { character?: unknown }).character !== 'string') {
      return 'camera.lookAt must be a Vec3A or { character: id }';
    }
  }
  return null;
}
