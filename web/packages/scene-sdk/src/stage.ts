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

import { sampleAnimatable } from '@velocut/render-sdk/motionspec';
import type * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveActions, type ClipMeta } from './actions.ts';
import { buildMannequin, MANNEQUIN_JOINTS, POSE_PRESETS, type MannequinJoint } from './mannequin.ts';
import { bakePhysics, samplePhysicsTrack, type BakeTrack } from './physics.ts';
import { loadImportedModel, type SceneResources } from './models.ts';
import { normalizeSceneSpec } from './authoring.ts';
import { validateSceneSpec } from './types.ts';
import type { SceneAssetManifest, SceneSpec, Scale3, Vec3A, SceneTransform, SceneGroup, SceneLight } from './types.ts';

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
  /** Head bind-pose rotation: restored every frame before the mixer runs, so
   *  gaze's premultiplied yaw never accumulates when no clip drives the head
   *  (poseAt must stay a pure function of t). */
  headRest: THREE.Quaternion | null;
  /** Rest-facing offset baked on the inner node (manifest yawDeg), radians —
   *  gaze clamps relative to the ACTUAL facing, spec rotationY + this. */
  yawRad: number;
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
  /** Baked simulation track for physics:'dynamic' props — poseAt samples it
   *  instead of the spec transform (fixed/kinematic stay spec-driven). */
  bake?: BakeTrack;
}

/** Full local Euler rotation, shared with physics sampling. */
export function applyRotation(root: THREE.Object3D, spec: SceneTransform, t: number): void {
  const D = Math.PI / 180;
  root.rotation.set(sampleAnimatable(spec.rotationX, t, 0) * D,
    sampleAnimatable(spec.rotationY, t, 0) * D, sampleAnimatable(spec.rotationZ, t, 0) * D, 'XYZ');
}

export interface Stage {
  three: typeof THREE;
  scene: THREE.Scene;
  characters: StageCharacter[];
  props: StageProp[];
  groups: Array<{ root: THREE.Group; spec: SceneGroup }>;
  lights: Array<{ root: THREE.Group; spec: SceneLight; light: THREE.Light }>;
  /** Pose every character/prop for time t (seconds) — pure w.r.t. prior calls.
   *  Pass the shot camera's position so `gaze: 'camera'` heads can aim at it. */
  poseAt(t: number, opts?: { cameraPos?: [number, number, number] }): void;
  /** A character's sampled world position at t (camera tracking, dragging). */
  characterPosition(id: string, t: number): [number, number, number] | null;
}

/** Build the world (environment, lights, characters, props) for a spec. */
export async function buildStage(spec: SceneSpec, assetBase: string = DEFAULT_ASSET_BASE, resources?: SceneResources): Promise<Stage> {
  const error = validateSceneSpec(spec);
  if (error) throw new Error(error);
  spec = normalizeSceneSpec(spec);
  const three = await import('three');
  const [{ GLTFLoader }, SkeletonUtils] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/utils/SkeletonUtils.js'),
  ]);

  const scene = new three.Scene();
  const groups = (spec.groups ?? []).map((g) => ({ spec: g, root: new three.Group() }));
  const parents = new Map(groups.map((g) => [g.spec.id, g.root]));
  for (const g of groups) {
    g.root.name = g.spec.id;
    (g.spec.parentId ? parents.get(g.spec.parentId)! : scene).add(g.root);
  }

  // ------------------------------------------------- environment presets
  // Unknown names fail the build (not a silent default): the same typo-must-
  // be-loud rule as clips and models — the agent can only fix what it sees.
  const env = spec.environment ?? 'env/stage';
  if (!['env/stage', 'env/grid', 'env/void'].includes(env)) {
    throw new Error(`unknown environment '${env}' (available: env/stage, env/grid, env/void)`);
  }
  const lighting = spec.lighting ?? 'day';
  const palettes: Record<string, { bg: number; ground: number; ambient: number; ambientI: number; key: number; keyI: number }> = {
    none: { bg: 0x101318, ground: 0x666666, ambient: 0xffffff, ambientI: 0, key: 0xffffff, keyI: 0 },
    day: { bg: 0xbfd4e6, ground: 0x9aa48f, ambient: 0xffffff, ambientI: 0.7, key: 0xfff2d9, keyI: 2.4 },
    night: { bg: 0x0b1020, ground: 0x1d2433, ambient: 0x334466, ambientI: 0.5, key: 0x9db8ff, keyI: 1.4 },
    indoor: { bg: 0x2b2723, ground: 0x54483c, ambient: 0xfff1e0, ambientI: 0.9, key: 0xffe8c4, keyI: 1.6 },
  };
  const pal = palettes[lighting];
  if (!pal) throw new Error(`unknown lighting '${lighting}' (available: ${Object.keys(palettes).join(', ')})`);
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
  key.castShadow = pal.keyI > 0;
  key.visible = pal.keyI > 0;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  scene.add(key);
  scene.add(new three.AmbientLight(pal.ambient, pal.ambientI));

  const lights = (spec.lights ?? []).map((s) => {
    const light = s.type === 'point' ? new three.PointLight() : s.type === 'spot' ? new three.SpotLight() :
      s.type === 'directional' ? new three.DirectionalLight() : new three.AmbientLight();
    light.color.set(s.color ?? '#ffffff');
    const root = new three.Group(); root.name = s.id; root.add(light);
    if (light instanceof three.SpotLight || light instanceof three.DirectionalLight) {
      light.target.position.set(0, 0, -1); root.add(light.target);
    }
    if (light instanceof three.PointLight || light instanceof three.SpotLight) {
      light.distance = s.distance ?? 0; light.decay = s.decay ?? 2;
    }
    if (light instanceof three.SpotLight) {
      light.angle = (s.angle ?? 45) * Math.PI / 180; light.penumbra = s.penumbra ?? 0.2;
    }
    if ('shadow' in light) {
      light.castShadow = s.shadow ?? false;
      (light as THREE.PointLight).shadow.mapSize.set(512, 512);
    }
    (s.parentId ? parents.get(s.parentId)! : scene).add(root);
    return { root, spec: s, light };
  });

  // ------------------------------------------------------------ characters
  const builtinManifest = await loadSceneManifest(assetBase);
  const manifest: SceneAssetManifest = { ...builtinManifest, characters: { ...builtinManifest.characters } };
  for (const [id, model] of Object.entries(spec.models ?? {})) {
    manifest.characters[id] = { ...model, file: model.src, license: 'user imported' };
  }
  const characters: StageCharacter[] = [];
  for (const c of spec.characters ?? []) {
    const entry = manifest.characters[c.model];
    if (!entry) throw new Error(`unknown character model '${c.model}'`);

    // Built-in poseable figure: generated geometry, no GLTF, joints as groups.
    if (entry.file.startsWith('builtin:')) {
      if (c.actions?.length) {
        throw new Error(`character '${c.id}': '${c.model}' has no animation clips — use the pose field (keyframable) instead of actions`);
      }
      const m = buildMannequin(three, c.color);
      scene.add(m.root);
      characters.push({
        root: m.root,
        mixer: new three.AnimationMixer(m.root), // inert (no clips)
        actions: new Map(),
        clips: {},
        heightM: entry.heightM ?? m.heightM,
        head: m.joints.get('head') ?? null,
        headRest: null, // pose fully re-sets every joint each frame
        yawRad: 0,
        morphMeshes: [],
        mannequinJoints: m.joints,
        spec: c,
      });
      continue;
    }
    let gltf: GLTF;
    if (spec.models?.[c.model]) gltf = await loadImportedModel(spec.models[c.model].src, resources);
    else {
      const url = `${assetBase}/${entry.file}`;
      let g = gltfCache.get(url);
      if (!g) {
        g = new GLTFLoader().loadAsync(url);
        g.catch(() => gltfCache.delete(url));
        gltfCache.set(url, g);
      }
      gltf = await g;
    }
    const inner = SkeletonUtils.clone(gltf.scene);
    inner.traverse((o) => {
      o.castShadow = true;
    });
    // Body tint (multi-figure scenes need tell-apart colors, same as the
    // builtin mannequin). Clones share materials with the GLTF cache, so
    // recoloring means cloning the material per character — only untextured
    // ones (tinting a texture reads as broken). Each material's lightness
    // ratio is preserved, so two-tone figures keep their joint contrast.
    if (c.color) {
      const tint = new three.Color(c.color);
      const hsl = { h: 0, s: 0, l: 0 };
      let maxL = 0;
      inner.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
          if (!mat.map && mat.color) maxL = Math.max(maxL, mat.color.getHSL(hsl).l);
        }
      });
      const recolored = new Map<THREE.Material, THREE.Material>();
      inner.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const remap = (mat: THREE.Material): THREE.Material => {
          const std = mat as THREE.MeshStandardMaterial;
          if (std.map || !std.color) return mat;
          let out = recolored.get(mat);
          if (!out) {
            out = mat.clone();
            const ratio = maxL > 0 ? std.color.getHSL(hsl).l / maxL : 1;
            (out as THREE.MeshStandardMaterial).color.copy(tint).multiplyScalar(ratio);
            recolored.set(mat, out);
          }
          return out;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(remap) : remap(mesh.material);
      });
    }
    // Wrap in a group: baseScale/yawDeg normalize the model's native units
    // and rest facing on the INNER node, so the user-facing transform on the
    // outer root keeps the spec conventions (meters; rotationY 0 faces +Z).
    if (entry.baseScale != null) inner.scale.setScalar(entry.baseScale);
    const yawRad = ((entry.yawDeg ?? 0) * Math.PI) / 180;
    if (yawRad) inner.rotation.y = yawRad;
    const root = new three.Group();
    root.add(inner);
    scene.add(root);
    // Gaze target: the manifest's declared head bone wins — a /head/i traverse
    // can hit a skinned head MESH first (rotating it does nothing), and rigs
    // name things unpredictably. The regex stays as the fallback.
    let head: THREE.Object3D | null = (entry.bones?.head && inner.getObjectByName(entry.bones.head)) || null;
    const morphMeshes: THREE.Mesh[] = [];
    inner.traverse((o) => {
      if (!head && /head/i.test(o.name)) head = o;
      if ((o as THREE.Mesh).morphTargetDictionary) morphMeshes.push(o as THREE.Mesh);
    });
    const mixer = new three.AnimationMixer(inner);
    const actions = new Map<string, THREE.AnimationAction>();
    const clips: Record<string, ClipMeta> = {};
    for (const clip of gltf.animations) {
      // Blender exports prefix clips with the armature ("CharacterArmature|
      // Walk") — register under the bare name so the agent vocabulary stays
      // clean and portable across rigs.
      const name = spec.models?.[c.model] ? clip.name : clip.name.split('|').pop()!;
      if (!entry.clips[name]) continue; // only registry-listed clips
      actions.set(name, mixer.clipAction(clip));
      clips[name] = { duration: clip.duration, loop: entry.clips[name].loop ?? true };
    }
    if (c.pose != null) {
      throw new Error(`character '${c.id}': '${c.model}' is not poseable — pose only works on builtin figures (char/mannequin); use actions`);
    }
    // A typo'd clip name must fail the build, not freeze in bind pose: the
    // agent's most likely mistake, and the manifest knows the whole answer.
    for (const a of c.actions ?? []) {
      if (!clips[a.clip]) {
        throw new Error(`character '${c.id}': unknown clip '${a.clip}' (available: ${Object.keys(clips).join(', ') || 'none'})`);
      }
    }
    characters.push({
      root,
      mixer,
      actions,
      clips,
      heightM: entry.heightM ?? 1.7,
      head,
      headRest: head ? (head as THREE.Object3D).quaternion.clone() : null,
      yawRad,
      morphMeshes,
      spec: c,
    });
  }

  // ----------------------------------------------------------------- props
  const props: StageProp[] = [];
  for (const p of spec.props ?? []) {
    let mesh: THREE.Object3D;
    const imported = spec.models?.[p.model];
    if (imported) {
      const gltf = await loadImportedModel(imported.src, resources);
      mesh = new three.Group();
      const inner = SkeletonUtils.clone(gltf.scene);
      mesh.add(inner);
      inner.traverse((o) => {
        const part = o as THREE.Mesh;
        if (!part.isMesh) return;
        part.castShadow = true; part.receiveShadow = true;
        const remap = (original: THREE.Material) => {
          if (!p.color && !p.material) return original;
          const material = original.clone() as THREE.MeshStandardMaterial;
          if (p.color && material.color) material.color.set(p.color);
          const m = p.material;
          if (m?.roughness != null) material.roughness = m.roughness;
          if (m?.metalness != null) material.metalness = m.metalness;
          if (m?.opacity != null) { material.opacity = m.opacity; material.transparent = m.opacity < 1; }
          if (m?.emissive != null && material.emissive) material.emissive.set(m.emissive);
          if (m?.emissiveIntensity != null) material.emissiveIntensity = m.emissiveIntensity;
          if (m?.side != null) material.side = m.side === 'double' ? three.DoubleSide : three.FrontSide;
          return material;
        };
        part.material = Array.isArray(part.material) ? part.material.map(remap) : remap(part.material);
      });
    } else {
    const color = new three.Color(p.color ?? '#8fa3bf');
    const m = p.material;
    const mat = new three.MeshStandardMaterial({ color, roughness: m?.roughness ?? 0.6,
      metalness: m?.metalness ?? 0, opacity: m?.opacity ?? 1, transparent: (m?.opacity ?? 1) < 1,
      emissive: m?.emissive ?? '#000000', emissiveIntensity: m?.emissiveIntensity ?? 1,
      side: m?.side === 'double' ? three.DoubleSide : three.FrontSide });
    let geo: THREE.BufferGeometry;
    if (p.model === 'prop/mesh' && p.vertices && p.faces) {
      geo = new three.BufferGeometry();
      geo.setAttribute('position', new three.Float32BufferAttribute(p.vertices.flat(), 3));
      geo.setIndex(p.faces.flat());
      if (p.uvs) geo.setAttribute('uv', new three.Float32BufferAttribute(p.uvs.flat(), 2));
      geo.computeVertexNormals();
    } else if (p.model === 'prop/tube' && p.path) {
      const curve = new three.CatmullRomCurve3(p.path.map((pt) => new three.Vector3(...pt)), p.closed ?? false, 'centripetal');
      geo = new three.TubeGeometry(curve, Math.min(256, Math.max(16, p.path.length * 8)), p.radius ?? 0.05, 12, p.closed ?? false);
    } else if (p.model === 'prop/sphere') geo = new three.SphereGeometry(0.5, 32, 16);
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
      if (!m?.side) mat.side = three.DoubleSide; // open profiles expose the inside wall
    } else if (p.model === 'prop/extrude' && p.points) {
      // Extrude a closed [x, y] outline along Z — arrows, stars, signs.
      const shape = new three.Shape();
      shape.moveTo(p.points[0][0], p.points[0][1]);
      for (let i = 1; i < p.points.length; i++) shape.lineTo(p.points[i][0], p.points[i][1]);
      shape.closePath();
      for (const outline of p.holes ?? []) {
        const hole = new three.Path();
        hole.moveTo(...outline[0]);
        for (const pt of outline.slice(1)) hole.lineTo(...pt);
        hole.closePath(); shape.holes.push(hole);
      }
      const bevel = p.bevel ?? 0;
      geo = new three.ExtrudeGeometry(shape, { depth: p.depth ?? 0.1, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3 });
      // Center the extrusion on its local origin so rotationY spins in place.
      geo.translate(0, 0, -(p.depth ?? 0.1) / 2);
    } else if (p.model === 'prop/cube') geo = new three.BoxGeometry(1, 1, 1);
    else {
      throw new Error(
        `unknown prop model '${p.model}' (available: prop/cube, prop/sphere, prop/pillar, prop/cone, prop/torus, prop/hemisphere, prop/lathe, prop/extrude, prop/tube, prop/mesh)`,
      );
    }
    mesh = new three.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    }

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

  // ---------------------------------------------------------------- physics
  // Props that opted in get simulated ONCE here (deterministic bake); poseAt
  // stays a pure sampler of t, so scrub/preview/export agree. Rapier (WASM)
  // loads only when a spec actually uses physics.
  if ((spec.props ?? []).some((p) => p.physics != null)) {
    const tracks = await bakePhysics(
      spec,
      props.map((p) => ({ spec: p.spec, mesh: p.root })),
    );
    props.forEach((p, i) => {
      const track = tracks[i];
      if (track) p.bake = track;
    });
  }

  for (const e of [...characters, ...props]) {
    e.root.name = e.spec.id!;
    if (e.spec.parentId) parents.get(e.spec.parentId)!.add(e.root);
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
  function aimHead(c: StageCharacter, target: THREE.Vector3): void {
    if (!c.head) return;
    c.root.updateWorldMatrix(true, true);
    const headPos = c.head.getWorldPosition(tmpV.clone());
    const dx = target.x - headPos.x;
    const dz = target.z - headPos.z;
    if (dx * dx + dz * dz < 1e-6) return;
    const desiredYaw = Math.atan2(dx, dz);
    const forward = new three.Vector3(0, 0, 1).applyQuaternion(c.root.getWorldQuaternion(new three.Quaternion()));
    const bodyYaw = Math.atan2(forward.x, forward.z) + c.yawRad;
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
    for (const g of groups) {
      g.root.position.set(...sampleVec3(g.spec.position, t, 0, 0, 0));
      applyRotation(g.root, g.spec, t);
      applyScale(g.root, g.spec.scale ?? 1);
    }
    for (const l of lights) {
      l.root.position.set(...sampleVec3(l.spec.position, t, 0, 0, 0));
      applyRotation(l.root, l.spec, t); applyScale(l.root, l.spec.scale ?? 1);
      l.light.intensity = sampleAnimatable(l.spec.intensity, t, l.spec.type === 'ambient' ? 0.5 : l.spec.type === 'directional' ? 3 : 100);
    }
    for (const c of characters) {
      const [x, y, z] = sampleVec3(c.spec.position, t, 0, 0, 0);
      c.root.position.set(x, y, z);
      applyRotation(c.root, c.spec, t);
      if (c.spec.scale != null) applyScale(c.root, c.spec.scale);

      // Poseable figure: every joint fully re-set from preset + overrides —
      // unset override axes fall back to the preset (sampleAnimatable's
      // fallback), so partial overrides compose naturally.
      if (c.mannequinJoints) {
        const poseSpec = c.spec.pose;
        const presetName = typeof poseSpec === 'string' ? poseSpec : poseSpec?.preset;
        const base = (presetName ? POSE_PRESETS[presetName] : undefined) ?? POSE_PRESETS.standing;
        const overrides = typeof poseSpec === 'object' ? poseSpec.joints : undefined;
        // Grounding offset baked into the preset (sitting drops to seat
        // height) — spec position.y stays a clean user-intent offset.
        c.root.position.y = y + (base.rootY ?? 0);
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

      // Reset the head to its bind pose BEFORE the mixer: if no clip drives
      // the head bone this frame, last frame's gaze rotation must not persist
      // (it would accumulate — a spinning head, and scrub-order-dependent
      // output). The mixer simply overwrites this when a clip does drive it.
      if (c.head && c.headRest) c.head.quaternion.copy(c.headRest);

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
        if (opts?.cameraPos) aimHead(c, tmpV.set(...opts.cameraPos));
      } else {
        const other = characters.find((o) => o.spec.id === gaze.character);
        if (other && other !== c) {
          other.root.updateWorldMatrix(true, false);
          aimHead(c, other.root.localToWorld(new three.Vector3(0, other.heightM * 0.9, 0)));
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
        applyRotation(p.root, p.spec, t);
        applyScale(p.root, p.spec.scale ?? 1);
        p.root.scale.multiplyScalar(k);
        continue;
      }
      if (p.bake) {
        // Simulated prop: transform comes from the baked track (full 3D
        // rotation — tumbling bodies aren't yaw-only).
        samplePhysicsTrack(p.bake, t, p.root);
        if (p.spec.scale != null) applyScale(p.root, p.spec.scale);
        continue;
      }
      const [x, y, z] = sampleVec3(p.spec.position, t, 0, 0.5, 0);
      p.root.position.set(x, y, z);
      applyRotation(p.root, p.spec, t);
      if (p.spec.scale != null) applyScale(p.root, p.spec.scale);
    }
  }

  function characterPosition(id: string, t: number): [number, number, number] | null {
    const c = characters.find((x) => x.spec.id === id);
    if (!c) return null;
    const point = new three.Vector3(...sampleVec3(c.spec.position, t, 0, 0, 0));
    if (c.mannequinJoints) {
      const pose = c.spec.pose;
      const preset = typeof pose === 'string' ? pose : pose?.preset;
      point.y += (preset ? POSE_PRESETS[preset] : undefined)?.rootY ?? 0;
    }
    let parentId = c.spec.parentId;
    while (parentId) {
      const group = groups.find((g) => g.spec.id === parentId)!.spec;
      const dummy = new three.Object3D();
      dummy.position.set(...sampleVec3(group.position, t, 0, 0, 0));
      applyRotation(dummy, group, t); applyScale(dummy, group.scale ?? 1); dummy.updateMatrix();
      point.applyMatrix4(dummy.matrix);
      parentId = group.parentId;
    }
    return point.toArray() as [number, number, number];
  }

  return { three, scene, characters, props, groups, lights, poseAt, characterPosition };
}
