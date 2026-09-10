// types.ts — SceneSpec v1: the declarative 3D scene document.
//
// Pure JSON, interpreted by a fixed compiler (compile.ts) — the agent sandbox
// threat model stays intact because a spec can express nothing but scene
// state. Keyframes reuse the MotionSpec grammar ({t, v, ease} with GSAP ease
// names) so agents learn ONE animation vocabulary.

import { validateAssembly, type AssemblyRecipe } from './assemblies.ts';
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

/** Local transform relative to parentId (a group); root coordinates are meters.
 * Euler rotations use XYZ order and degrees. Every rotation axis is animatable. */
export interface SceneTransform {
  name?: string;
  parentId?: string;
  position?: Vec3A;
  rotationX?: Animatable;
  rotationY?: Animatable;
  rotationZ?: Animatable;
  scale?: Scale3;
}

export interface SceneGroup extends SceneTransform {
  id: string;
  assembly?: AssemblyRecipe;
}

export interface SceneLight extends SceneTransform {
  id: string;
  type: 'point' | 'spot' | 'directional' | 'ambient';
  color?: string;
  intensity?: Animatable;
  distance?: number;
  decay?: number;
  /** Spot half-angle, degrees. Directional/spot lights point down local -Z. */
  angle?: number;
  penumbra?: number;
  shadow?: boolean;
}

export interface SceneMaterial {
  roughness?: number;
  metalness?: number;
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  side?: 'front' | 'double';
}

export interface SceneCharacter extends SceneTransform {
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

/** Rigid-body physics for a prop (Rapier, baked deterministically at build).
 *  dynamic = simulated (position/rotationY give the CONSTANT initial
 *  transform; motion comes from the sim). fixed = immovable collider (ramps,
 *  walls). kinematic = keyframe-driven collider that pushes dynamics (moving
 *  platforms, sweeping arms). */
export interface PropPhysics {
  type: 'dynamic' | 'fixed' | 'kinematic';
  /** Kilograms (dynamic; default derived from the collider volume). */
  mass?: number;
  /** Bounciness 0..1 (default 0.3). */
  restitution?: number;
  /** Surface friction >= 0 (default 0.6). */
  friction?: number;
  /** Initial linear velocity, m/s (dynamic only). */
  velocity?: [number, number, number];
  /** Initial angular velocity, degrees/s (dynamic only). */
  angularVelocity?: [number, number, number];
  /** Seconds — the body holds its initial pose until then (timed collapses). */
  startAt?: number;
}

export interface SceneProp extends SceneTransform {
  material?: SceneMaterial;
  /** Explicit editable triangle mesh (local meters, counter-clockwise faces). */
  vertices?: [number, number, number][];
  faces?: [number, number, number][];
  uvs?: [number, number][];
  /** Circular sweep along a 3D Catmull-Rom path, meters (prop/tube). */
  path?: [number, number, number][];
  radius?: number;
  closed?: boolean;
  /** Interior cutouts in an extruded outline; each loop is in local XY. */
  holes?: [number, number][][];
  /** Rounded extrusion edges, meters (0 disables bevel). */
  bevel?: number;
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
  /** Opt into the rigid-body simulation: a type shorthand or full options.
   *  Mutually exclusive with attachTo; dynamic/fixed require a constant
   *  initial transform (keyframes belong to kinematic colliders). */
  physics?: PropPhysics['type'] | PropPhysics;
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

export interface SceneModel {
  /** Immutable GLB bytes in the owning project's storage. */
  src: string;
  label: string;
  heightM: number;
  clips: Record<string, ManifestClip>;
  bones?: Record<string, string>;
  morphs?: string[];
}

export interface SceneSpec {
  version: 1;
  durationUs: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Registry environment id (default 'env/stage'). */
  environment?: string;
  lighting?: 'day' | 'night' | 'indoor' | 'none';
  lights?: SceneLight[];
  models?: Record<string, SceneModel>;
  groups?: SceneGroup[];
  characters?: SceneCharacter[];
  props?: SceneProp[];
  camera?: SceneCamera;
  /** Multi-shot cut list — overrides `camera` when present (see SceneShot). */
  shots?: SceneShot[];
  /** World physics settings (only matter for props with a `physics` field). */
  physics?: {
    /** Downward gravity, m/s² (default 9.81). */
    gravity?: number;
  };
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
      /** Normalizes the model's rest facing to the spec convention
       *  (rotationY 0 faces +Z): degrees baked under the user-facing
       *  transform (180 for a model authored facing -Z). Without it, body
       *  direction and gaze/lookAt semantics disagree and no spec value can
       *  fix both. */
      yawDeg?: number;
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

const PHYSICS_TYPES = ['dynamic', 'fixed', 'kinematic'] as const;
const PHYSICS_KEYS = ['type', 'mass', 'restitution', 'friction', 'velocity', 'angularVelocity', 'startAt'];
const isVel3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(fin);

function checkPropPhysics(p: SceneProp): string | null {
  const raw = p.physics!;
  const ph = typeof raw === 'string' ? { type: raw } : raw;
  if (typeof ph !== 'object' || ph == null || !PHYSICS_TYPES.includes(ph.type)) {
    return `prop physics must be 'dynamic' | 'fixed' | 'kinematic' or { type, … }`;
  }
  if (typeof raw === 'object' && !Object.keys(raw).every((k) => PHYSICS_KEYS.includes(k))) {
    return `prop physics takes only { ${PHYSICS_KEYS.join(', ')} }`;
  }
  if (p.parentId) return 'prop: physics requires a world-root object (group transforms are not baked)';
  if (p.attachTo) return 'prop: physics and attachTo cannot combine (bone-parented props are not simulated)';
  if (ph.mass != null && !(fin(ph.mass) && ph.mass > 0)) return 'prop physics.mass must be > 0 (kg)';
  if (ph.restitution != null && !(fin(ph.restitution) && ph.restitution >= 0 && ph.restitution <= 1)) {
    return 'prop physics.restitution must be 0..1';
  }
  if (ph.friction != null && !(fin(ph.friction) && ph.friction >= 0)) return 'prop physics.friction must be >= 0';
  if (ph.startAt != null && !(fin(ph.startAt) && ph.startAt >= 0)) return 'prop physics.startAt must be seconds >= 0';
  for (const k of ['velocity', 'angularVelocity'] as const) {
    if (ph[k] != null && !isVel3(ph[k])) return `prop physics.${k} must be [x, y, z] numbers`;
  }
  if (ph.type !== 'dynamic' && (ph.velocity || ph.angularVelocity || ph.startAt != null)) {
    return `prop physics: velocity/angularVelocity/startAt only apply to type 'dynamic'`;
  }
  if (ph.type !== 'kinematic') {
    // The simulation owns a dynamic body's motion (and a fixed body doesn't
    // move at all) — keyframed transforms would silently disagree with the
    // bake. Loud rule: constants only; keyframes belong to kinematic.
    const keyed = [p.rotationX, p.rotationY, p.rotationZ].some(Array.isArray) || (p.position != null && [p.position.x, p.position.y, p.position.z].some(Array.isArray));
    if (keyed) {
      return `prop physics '${ph.type}': position/rotationY must be constants (the simulation drives motion — use physics.velocity/startAt, or type 'kinematic' for a keyframe-driven collider)`;
    }
  }
  return null;
}

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
  if (s.models != null) {
    if (typeof s.models !== 'object' || Array.isArray(s.models) || Object.keys(s.models).length > 64) return 'models must be a registry with at most 64 entries';
    for (const [id, m] of Object.entries(s.models)) {
      if (!/^model\/[a-zA-Z0-9_-]+$/.test(id)) return 'imported model ids must start with model/';
      if (!m || typeof m !== 'object' || !/^opfs:\/\/scene-model-[a-f0-9]{64}\.glb$/.test(m.src)) return 'model src must be a content-addressed project GLB';
      if (typeof m.label !== 'string' || m.label.length > 256 || !fin(m.heightM) || m.heightM < 0 || m.heightM > 1e6) return 'invalid model label or height';
      if (!m.clips || typeof m.clips !== 'object' || Array.isArray(m.clips) || Object.keys(m.clips).length > 200) return 'invalid model animation registry';
      for (const [name, clip] of Object.entries(m.clips)) {
        if (!name || !clip || typeof clip !== 'object' || (clip.loop != null && typeof clip.loop !== 'boolean')) return 'invalid model animation clip';
      }
      if (m.bones != null && (typeof m.bones !== 'object' || Array.isArray(m.bones) || Object.values(m.bones).some((name) => typeof name !== 'string'))) return 'invalid model bone slots';
      if (m.morphs != null && (!Array.isArray(m.morphs) || !m.morphs.every((name) => typeof name === 'string'))) return 'invalid model morph names';
    }
  }
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
    // Generous cap: blockout sets (a greybox city block is easily 100 cubes)
    // are a first-class workflow; the cap only bounds compile cost.
    if (!Array.isArray(s.props) || s.props.length > 200) return 'spec.props must be an array of at most 200';
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
      if (p.model === 'prop/mesh') {
        if (!Array.isArray(p.vertices) || p.vertices.length < 3 || p.vertices.length > 4096 || !p.vertices.every(isVel3)) return 'mesh vertices must contain 3..4096 finite triples';
        if (!Array.isArray(p.faces) || !p.faces.length || p.faces.length > 8192) return 'mesh faces must contain 1..8192 index triples';
        for (const f of p.faces) {
          if (!Array.isArray(f) || f.length !== 3 || !f.every((i) => Number.isInteger(i) && i >= 0 && i < p.vertices!.length) || new Set(f).size !== 3) return 'mesh faces need three distinct valid vertex indices';
          const [a,b,c] = f.map((i) => p.vertices![i]);
          const u = b.map((v,i) => v-a[i]), v = c.map((n,i) => n-a[i]);
          const area = Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]);
          if (!Number.isFinite(area) || area < 1e-12) return 'mesh contains a degenerate triangle';
        }
        if (p.uvs != null && (!Array.isArray(p.uvs) || p.uvs.length !== p.vertices.length || !p.uvs.every((uv) => Array.isArray(uv) && uv.length === 2 && uv.every(fin)))) return 'mesh uvs must provide a finite pair per vertex';
      } else if (p.vertices != null || p.faces != null || p.uvs != null) return 'vertices/faces/uvs only apply to prop/mesh';
      if (p.model === 'prop/tube') {
        if (!Array.isArray(p.path) || p.path.length < 2 || p.path.length > 64 || !p.path.every(isVel3)) return 'prop/tube needs path: [[x,y,z],…] (2..64 points)';
        if (p.path.some((pt, i) => i > 0 && pt.every((v, a) => v === p.path![i - 1][a]))) return 'tube path cannot have consecutive identical points';
        if (p.radius != null && !(fin(p.radius) && p.radius > 0 && p.radius <= 100)) return 'tube radius must be >0 and <=100';
        if (p.closed != null && typeof p.closed !== 'boolean') return 'tube closed must be boolean';
        if (p.closed && p.path.length < 3) return 'closed tube needs at least 3 points';
      } else if (p.path != null || p.radius != null || p.closed != null) return 'path/radius/closed only apply to prop/tube';
      if (p.holes != null || p.bevel != null) {
        if (p.model !== 'prop/extrude') return 'holes/bevel only apply to prop/extrude';
        if (p.holes != null && (!Array.isArray(p.holes) || p.holes.length > 16 || !p.holes.every((h) => isPointList(h) && h.length >= 3))) return 'extrude holes must contain up to 16 polygons (3..64 points each)';
        if (p.bevel != null && !(fin(p.bevel) && p.bevel >= 0 && p.bevel <= 1)) return 'extrude bevel must be 0..1 meters';
      }
      if (p.points != null && p.model !== 'prop/lathe' && p.model !== 'prop/extrude') {
        return `prop '${p.model}' does not take points (only prop/lathe and prop/extrude do)`;
      }
      if (p.physics != null) {
        const err = checkPropPhysics(p);
        if (err) return err;
      }
    }
  }
  if (s.physics != null) {
    if (typeof s.physics !== 'object' || Array.isArray(s.physics)) return 'spec.physics must be an object';
    if (!Object.keys(s.physics).every((k) => k === 'gravity')) return 'spec.physics takes only { gravity? }';
    const g = s.physics.gravity;
    if (g != null && !(fin(g) && g >= 0 && g <= 100)) return 'spec.physics.gravity must be 0..100 (m/s², downward)';
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
  // Validate the shared authoring vocabulary after the legacy shape checks.
  if (s.groups != null && (!Array.isArray(s.groups) || s.groups.length > 100)) return 'groups must be an array of at most 100';
  if (s.lights != null && (!Array.isArray(s.lights) || s.lights.length > 16)) return 'lights must be an array of at most 16';
  for (const light of s.lights ?? []) {
    if (!light || !light.id || !['point', 'spot', 'directional', 'ambient'].includes(light.type)) return 'light requires an id and a valid type';
    if (light.color != null && !/^#[a-f0-9]{6}$/i.test(light.color)) return 'light color must be #RRGGBB';
    if (light.intensity != null && (!isAnimatable(light.intensity) || (Array.isArray(light.intensity) ? light.intensity.map((k) => k.v) : [light.intensity]).some((v) => v < 0 || v > 100000))) return 'light intensity must be 0..100000 (constant or keyframed)';
    for (const [key, max] of [['distance', 10000], ['decay', 5], ['penumbra', 1]] as const) {
      const v = light[key]; if (v != null && !(fin(v) && v >= 0 && v <= max)) return `invalid light ${key}`;
    }
    if (light.angle != null && !(fin(light.angle) && light.angle > 0 && light.angle < 90)) return 'spot angle must be >0 and <90 degrees';
    if (light.type !== 'spot' && (light.angle != null || light.penumbra != null)) return 'angle/penumbra only apply to spot lights';
    if (light.type !== 'spot' && light.type !== 'point' && (light.distance != null || light.decay != null)) return 'distance/decay only apply to point/spot lights';
    if (light.shadow != null && typeof light.shadow !== 'boolean') return 'light shadow must be boolean';
  }
  const all = [...(s.characters ?? []), ...(s.props ?? []), ...(s.groups ?? []), ...(s.lights ?? [])];
  const ids = new Set<string>();
  for (const o of all) {
    if (!o || typeof o !== 'object') return 'scene objects must be objects';
    if (o.id != null) {
      if (typeof o.id !== 'string' || !o.id.trim()) return 'object id must be a non-empty string';
      if (ids.has(o.id)) return `duplicate object id '${o.id}'`;
      ids.add(o.id);
    }
    if (o.name != null && typeof o.name !== 'string') return 'object name must be a string';
    if (o.parentId != null && (typeof o.parentId !== 'string' || !o.parentId)) return 'parentId must be a group id';
    if (o.position != null && !isVec3A(o.position)) return 'object: invalid position';
    if (o.scale != null && !isScale3(o.scale)) return 'object: invalid scale';
    const scales = typeof o.scale === 'number' ? [o.scale] : Object.values(o.scale ?? {});
    if (scales.some((n) => n <= 0)) return 'object scale must be positive';
    for (const axis of ['rotationX', 'rotationY', 'rotationZ'] as const) {
      if (o[axis] != null && !isAnimatable(o[axis])) return `object: invalid ${axis}`;
    }
  }
  const groups = new Map((s.groups ?? []).map((g) => [g.id, g]));
  for (const g of s.groups ?? []) {
    if (!g.id) return 'every group needs a string id';
    if (g.assembly) { const err = validateAssembly(g.assembly); if (err) return err; }
  }
  for (const o of all) {
    const ancestors = new Set<string>(o.id ? [o.id] : []);
    let parent = o.parentId;
    while (parent) {
      if (ancestors.has(parent)) return `group cycle at '${parent}'`;
      ancestors.add(parent);
      const g = groups.get(parent);
      if (!g) return `unknown parent group '${parent}'`;
      parent = g.parentId;
    }
  }
  for (const p of s.props ?? []) {
    if (p.parentId && p.attachTo) return 'prop: parentId and attachTo cannot combine';
    const m = p.material;
    if (m != null) {
      if (typeof m !== 'object' || Array.isArray(m)) return 'material must be an object';
      if (!Object.keys(m).every((k) => ['roughness', 'metalness', 'opacity', 'emissive', 'emissiveIntensity', 'side'].includes(k))) return 'unknown material field';
      for (const k of ['roughness', 'metalness', 'opacity'] as const) {
        if (m[k] != null && !(fin(m[k]) && m[k] >= 0 && m[k] <= 1)) return `material.${k} must be 0..1`;
      }
      if (m.emissive != null && (typeof m.emissive !== 'string' || !/^#[0-9a-f]{6}$/i.test(m.emissive))) return 'material.emissive must be #RRGGBB';
      if (m.emissiveIntensity != null && !(fin(m.emissiveIntensity) && m.emissiveIntensity >= 0 && m.emissiveIntensity <= 100)) return 'material.emissiveIntensity must be 0..100';
      if (m.side != null && !['front', 'double'].includes(m.side)) return 'material.side must be front or double';
    }
  }
  const characterIds = new Set((s.characters ?? []).map((c) => c.id));
  for (const c of s.characters ?? []) {
    if (typeof c.gaze === 'object' && !characterIds.has(c.gaze.character)) return `unknown gaze character '${c.gaze.character}'`;
  }
  for (const cam of [s.camera, ...(s.shots ?? []).map((shot) => shot.camera)]) {
    if (cam?.lookAt && 'character' in cam.lookAt && !characterIds.has(cam.lookAt.character)) return `unknown camera character '${cam.lookAt.character}'`;
  }
  return null;
}
