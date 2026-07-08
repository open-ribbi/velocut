// stage.ts — the shared 3D stage: build a SceneSpec's world and pose it at t.
//
// Two consumers, one scene graph:
//   • compile.ts (the export/preview interpreter) adds the spec camera and a
//     VideoFrame surface;
//   • the editor's Director panel adds an orbit camera, hit-testing and drag
//     handles for manual blocking.
// Both call poseAt(t), which fully re-derives object transforms and character
// poses from the spec at time t (pure with respect to previous frames), so
// what the director stages IS what the interpreter renders.

import { sampleAnimatable } from '@velocut/render-sdk';
import type * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveActions, type ClipMeta } from './actions.ts';
import { buildMannequin, MANNEQUIN_JOINTS, POSE_PRESETS, type MannequinJoint } from './mannequin.ts';
import type { SceneAssetManifest, SceneSpec, Scale3, Vec3A } from './types.ts';

/** Apply a uniform or per-axis scale (missing axes stay 1). */
function applyScale(root: THREE.Object3D, scale: Scale3): void {
  if (typeof scale === 'number') root.scale.setScalar(scale);
  else root.scale.set(scale.x ?? 1, scale.y ?? 1, scale.z ?? 1);
}

export const DEFAULT_ASSET_BASE = '/scene-assets';

// Module-level caches: manifest + parsed GLBs are immutable per URL.
let manifestCache = new Map<string, Promise<SceneAssetManifest>>();
const gltfCache = new Map<string, Promise<GLTF>>();

export function loadSceneManifest(base: string = DEFAULT_ASSET_BASE): Promise<SceneAssetManifest> {
  let p = manifestCache.get(base);
  if (!p) {
    p = fetch(`${base}/manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`scene manifest: HTTP ${r.status}`);
      return r.json() as Promise<SceneAssetManifest>;
    });
    p.catch(() => manifestCache.delete(base)); // don't poison the cache
    manifestCache.set(base, p);
  }
  return p;
}

/** Test hook: drop cached manifests. */
export function resetSceneManifestCache(): void {
  manifestCache = new Map();
}

export const sampleVec3 = (
  v: Vec3A | undefined,
  t: number,
  dx: number,
  dy: number,
  dz: number,
): [number, number, number] => [
  sampleAnimatable(v?.x, t, dx),
  sampleAnimatable(v?.y, t, dy),
  sampleAnimatable(v?.z, t, dz),
];

export interface StageCharacter {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  clips: Record<string, ClipMeta>;
  heightM: number;
  /** Head bone (name matches /head/i), if the rig has one — gaze target. */
  head: THREE.Object3D | null;
  /** Meshes with morph targets — driven by character.morphs. */
  morphMeshes: THREE.Mesh[];
  /** Set for the built-in poseable figure: joint name → its rotation group. */
  mannequinJoints?: Map<MannequinJoint, THREE.Group>;
  spec: NonNullable<SceneSpec['characters']>[number];
}

export interface StageProp {
  root: THREE.Object3D;
  spec: NonNullable<SceneSpec['props']>[number];
  /** Set when parented to a character bone: meters→bone-local unit factor
   *  (compensates baseScale and any rig-inherited scale). */
  attachComp?: number;
}

export interface Stage {
  three: typeof THREE;
  scene: THREE.Scene;
  characters: StageCharacter[];
  props: StageProp[];
  /** Pose every character/prop for time t (seconds) — pure w.r.t. prior calls.
   *  Pass the shot camera's position so `gaze: 'camera'` heads can aim at it. */
  poseAt(t: number, opts?: { cameraPos?: [number, number, number] }): void;
  /** A character's sampled world position at t (camera tracking, dragging). */
  characterPosition(id: string, t: number): [number, number, number] | null;
}

/** Build the world (environment, lights, characters, props) for a spec. */
export async function buildStage(spec: SceneSpec, assetBase: string = DEFAULT_ASSET_BASE): Promise<Stage> {
  const three = await import('three');
  const [{ GLTFLoader }, SkeletonUtils] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/utils/SkeletonUtils.js'),
  ]);

  const scene = new three.Scene();

  // ------------------------------------------------- environment presets
  const env = spec.environment ?? 'env/stage';
  const lighting = spec.lighting ?? 'day';
  const palettes: Record<string, { bg: number; ground: number; ambient: number; ambientI: number; key: number; keyI: number }> = {
    day: { bg: 0xbfd4e6, ground: 0x9aa48f, ambient: 0xffffff, ambientI: 0.7, key: 0xfff2d9, keyI: 2.4 },
    night: { bg: 0x0b1020, ground: 0x1d2433, ambient: 0x334466, ambientI: 0.5, key: 0x9db8ff, keyI: 1.4 },
    indoor: { bg: 0x2b2723, ground: 0x54483c, ambient: 0xfff1e0, ambientI: 0.9, key: 0xffe8c4, keyI: 1.6 },
  };
  const pal = palettes[lighting] ?? palettes.day;
  scene.background = new three.Color(pal.bg);

  if (env !== 'env/void') {
    const ground = new three.Mesh(
      new three.PlaneGeometry(80, 80),
      new three.MeshStandardMaterial({ color: pal.ground, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'stage-ground';
    scene.add(ground);
    if (env === 'env/grid') {
      const grid = new three.GridHelper(80, 80, 0xffffff, 0x888888);
      (grid.material as THREE.Material).opacity = 0.25;
      (grid.material as THREE.Material).transparent = true;
      grid.position.y = 0.01;
      scene.add(grid);
    }
  }

  const key = new three.DirectionalLight(pal.key, pal.keyI);
  key.position.set(5, 8, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  scene.add(key);
  scene.add(new three.AmbientLight(pal.ambient, pal.ambientI));

  // ------------------------------------------------------------ characters
  const manifest = await loadSceneManifest(assetBase);
  const characters: StageCharacter[] = [];
  for (const c of spec.characters ?? []) {
    const entry = manifest.characters[c.model];
    if (!entry) throw new Error(`unknown character model '${c.model}'`);

    // Built-in poseable figure: generated geometry, no GLTF, joints as groups.
    if (entry.file.startsWith('builtin:')) {
      const m = buildMannequin(three, c.color);
      scene.add(m.root);
      characters.push({
        root: m.root,
        mixer: new three.AnimationMixer(m.root), // inert (no clips)
        actions: new Map(),
        clips: {},
        heightM: entry.heightM ?? m.heightM,
        head: m.joints.get('head') ?? null,
        morphMeshes: [],
        mannequinJoints: m.joints,
        spec: c,
      });
      continue;
    }
    const url = `${assetBase}/${entry.file}`;
    let g = gltfCache.get(url);
    if (!g) {
      g = new GLTFLoader().loadAsync(url);
      g.catch(() => gltfCache.delete(url));
      gltfCache.set(url, g);
    }
    const gltf = await g;
    const inner = SkeletonUtils.clone(gltf.scene);
    inner.traverse((o) => {
      o.castShadow = true;
    });
    // Wrap in a group: baseScale normalizes the model's native units (e.g. the
    // Fox is authored in centimeters) on the INNER node, so the user-facing
    // scale/position on the outer root stays in meters.
    if (entry.baseScale != null) inner.scale.setScalar(entry.baseScale);
    const root = new three.Group();
    root.add(inner);
    scene.add(root);
    let head: THREE.Object3D | null = null;
    const morphMeshes: THREE.Mesh[] = [];
    inner.traverse((o) => {
      if (!head && /head/i.test(o.name)) head = o;
      if ((o as THREE.Mesh).morphTargetDictionary) morphMeshes.push(o as THREE.Mesh);
    });
    const mixer = new three.AnimationMixer(inner);
    const actions = new Map<string, THREE.AnimationAction>();
    const clips: Record<string, ClipMeta> = {};
    for (const clip of gltf.animations) {
      if (!entry.clips[clip.name]) continue; // only registry-listed clips
      actions.set(clip.name, mixer.clipAction(clip));
      clips[clip.name] = { duration: clip.duration, loop: entry.clips[clip.name].loop ?? true };
    }
    characters.push({ root, mixer, actions, clips, heightM: entry.heightM ?? 1.7, head, morphMeshes, spec: c });
  }

  // ----------------------------------------------------------------- props
  const props: StageProp[] = [];
  for (const p of spec.props ?? []) {
    const color = new three.Color(p.color ?? '#8fa3bf');
    const mat = new three.MeshStandardMaterial({ color, roughness: 0.6 });
    let geo: THREE.BufferGeometry;
    if (p.model === 'prop/sphere') geo = new three.SphereGeometry(0.5, 32, 16);
    else if (p.model === 'prop/pillar') geo = new three.CylinderGeometry(0.3, 0.3, 2, 24);
    else if (p.model === 'prop/cone') geo = new three.ConeGeometry(0.5, 1, 24);
    else if (p.model === 'prop/torus') {
      geo = new three.TorusGeometry(0.4, 0.12, 12, 32);
      geo.rotateX(-Math.PI / 2); // lie flat (a ring on the ground), like the other primitives
    } else if (p.model === 'prop/hemisphere') {
      geo = new three.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    } else if (p.model === 'prop/lathe' && p.points) {
      // Revolve a [radius, y] profile around Y — vases, cups, lampshades.
      geo = new three.LatheGeometry(p.points.map(([r, y]) => new three.Vector2(Math.max(0, r), y)), 32);
      mat.side = three.DoubleSide; // open profiles expose the inside wall
    } else if (p.model === 'prop/extrude' && p.points) {
      // Extrude a closed [x, y] outline along Z — arrows, stars, signs.
      const shape = new three.Shape();
      shape.moveTo(p.points[0][0], p.points[0][1]);
      for (let i = 1; i < p.points.length; i++) shape.lineTo(p.points[i][0], p.points[i][1]);
      shape.closePath();
      geo = new three.ExtrudeGeometry(shape, { depth: p.depth ?? 0.1, bevelEnabled: false });
      // Center the extrusion on its local origin so rotationY spins in place.
      geo.translate(0, 0, -(p.depth ?? 0.1) / 2);
    } else geo = new three.BoxGeometry(1, 1, 1); // prop/cube + fallback
    const mesh: THREE.Mesh = new three.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (p.attachTo) {
      // Parent to a character's bone (semantic slot → rig bone name from the
      // manifest). The bone subtree inherits baseScale, so spec-side meters
      // are converted with a compensation factor measured off the bind pose.
      const target = characters.find((c) => c.spec.id === p.attachTo!.character);
      if (!target) throw new Error(`prop attachTo: unknown character '${p.attachTo.character}'`);
      const model = (spec.characters ?? []).find((c) => c.id === p.attachTo!.character)!.model;
      const slots = manifest.characters[model]?.bones ?? {};
      const slot = p.attachTo.bone ?? 'handR';
      const boneName = slots[slot];
      if (!boneName) {
        throw new Error(`prop attachTo: '${model}' has no bone slot '${slot}' (available: ${Object.keys(slots).join(', ') || 'none'})`);
      }
      const bone = target.root.getObjectByName(boneName);
      if (!bone) throw new Error(`prop attachTo: bone '${boneName}' not found in '${model}'`);
      target.root.updateWorldMatrix(true, true);
      const ws = bone.getWorldScale(new three.Vector3());
      const comp = 1 / (ws.x || 1);
      bone.add(mesh);
      props.push({ root: mesh, spec: p, attachComp: comp });
      continue;
    }
    scene.add(mesh);
    props.push({ root: mesh, spec: p });
  }

  /** Max head turn away from the body's facing (radians ≈ ±70°). */
  const GAZE_CLAMP = (70 * Math.PI) / 180;
  const UP = new three.Vector3(0, 1, 0);
  const tmpV = new three.Vector3();
  const tmpQ = new three.Quaternion();
  const tmpQ2 = new three.Quaternion();

  /** Turn the head bone toward a world point: yaw-only (rotation around the
   *  world Y axis, which is safe for ANY rig's bone axes — no head tilt), and
   *  clamped relative to the body so the head never spins. Applied AFTER the
   *  animation pose, still a pure function of (t, target). */
  function aimHead(c: StageCharacter, t: number, target: THREE.Vector3): void {
    if (!c.head) return;
    c.root.updateWorldMatrix(true, true);
    const headPos = c.head.getWorldPosition(tmpV.clone());
    const dx = target.x - headPos.x;
    const dz = target.z - headPos.z;
    if (dx * dx + dz * dz < 1e-6) return;
    const desiredYaw = Math.atan2(dx, dz);
    const bodyYaw = (sampleAnimatable(c.spec.rotationY, t, 0) * Math.PI) / 180;
    // Shortest signed difference, clamped to the neck's range.
    let extra = desiredYaw - bodyYaw;
    extra = Math.atan2(Math.sin(extra), Math.cos(extra));
    extra = Math.max(-GAZE_CLAMP, Math.min(GAZE_CLAMP, extra));
    // World-axis rotation applied to a bone: localQ' = pq⁻¹ · ΔQ · pq · localQ.
    const pq = c.head.parent!.getWorldQuaternion(tmpQ);
    const dq = tmpQ2.setFromAxisAngle(UP, extra);
    c.head.quaternion.premultiply(pq.clone().invert().multiply(dq).multiply(pq));
  }

  function poseAt(t: number, opts?: { cameraPos?: [number, number, number] }): void {
    for (const c of characters) {
      const [x, y, z] = sampleVec3(c.spec.position, t, 0, 0, 0);
      c.root.position.set(x, y, z);
      c.root.rotation.y = (sampleAnimatable(c.spec.rotationY, t, 0) * Math.PI) / 180;
      if (c.spec.scale != null) applyScale(c.root, c.spec.scale);

      // Poseable figure: every joint fully re-set from preset + overrides —
      // unset override axes fall back to the preset (sampleAnimatable's
      // fallback), so partial overrides compose naturally.
      if (c.mannequinJoints) {
        const poseSpec = c.spec.pose;
        const presetName = typeof poseSpec === 'string' ? poseSpec : poseSpec?.preset;
        const base = (presetName ? POSE_PRESETS[presetName] : undefined) ?? POSE_PRESETS.standing;
        const overrides = typeof poseSpec === 'object' ? poseSpec.joints : undefined;
        const D = Math.PI / 180;
        for (const j of MANNEQUIN_JOINTS) {
          const grp = c.mannequinJoints.get(j)!;
          const b = base[j] ?? [0, 0, 0];
          const o = overrides?.[j];
          grp.rotation.set(
            sampleAnimatable(o?.[0], t, b[0]) * D,
            sampleAnimatable(o?.[1], t, b[1]) * D,
            sampleAnimatable(o?.[2], t, b[2]) * D,
          );
        }
        continue;
      }

      // Deterministic pose: explicitly set every action's enabled/weight/time
      // for THIS t, then update(0) to write the blended pose to the bones.
      const poses = resolveActions(c.spec.actions, t, c.clips);
      for (const [name, action] of c.actions) {
        const hit = poses.find((p) => p.clip === name);
        if (!hit) {
          action.stop();
          continue;
        }
        action.play();
        action.paused = true;
        action.weight = hit.weight;
        action.time = hit.time;
      }
      c.mixer.update(0);

      // Expression morphs, sampled after the mixer (the animations here don't
      // drive morphs, so nothing fights) — still a pure function of t.
      if (c.spec.morphs) {
        for (const mesh of c.morphMeshes) {
          for (const [name, w] of Object.entries(c.spec.morphs)) {
            const idx = mesh.morphTargetDictionary?.[name];
            if (idx != null && mesh.morphTargetInfluences) {
              mesh.morphTargetInfluences[idx] = Math.max(0, Math.min(1, sampleAnimatable(w, t, 0)));
            }
          }
        }
      }
    }
    // Gaze runs after every mixer wrote its pose, so a character can aim at
    // another character's CURRENT-frame position.
    for (const c of characters) {
      const gaze = c.spec.gaze;
      if (!gaze) continue;
      if (gaze === 'camera') {
        if (opts?.cameraPos) aimHead(c, t, tmpV.set(...opts.cameraPos));
      } else {
        const other = characters.find((o) => o.spec.id === gaze.character);
        if (other && other !== c) {
          const [ox, oy, oz] = sampleVec3(other.spec.position, t, 0, 0, 0);
          aimHead(c, t, tmpV.set(ox, oy + other.heightM * 0.9, oz));
        }
      }
    }
    for (const p of props) {
      if (p.attachComp != null) {
        // Bone-local: spec meters → bone units via the compensation factor;
        // default offset 0 (the bone origin), default scale 1 m compensated.
        const k = p.attachComp;
        const [x, y, z] = sampleVec3(p.spec.position, t, 0, 0, 0);
        p.root.position.set(x * k, y * k, z * k);
        p.root.rotation.y = (sampleAnimatable(p.spec.rotationY, t, 0) * Math.PI) / 180;
        applyScale(p.root, p.spec.scale ?? 1);
        p.root.scale.multiplyScalar(k);
        continue;
      }
      const [x, y, z] = sampleVec3(p.spec.position, t, 0, 0.5, 0);
      p.root.position.set(x, y, z);
      p.root.rotation.y = (sampleAnimatable(p.spec.rotationY, t, 0) * Math.PI) / 180;
      if (p.spec.scale != null) applyScale(p.root, p.spec.scale);
    }
  }

  function characterPosition(id: string, t: number): [number, number, number] | null {
    const c = characters.find((x) => x.spec.id === id);
    return c ? sampleVec3(c.spec.position, t, 0, 0, 0) : null;
  }

  return { three, scene, characters, props, poseAt, characterPosition };
}
