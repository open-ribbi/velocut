// compile.ts — SceneSpec → CompiledScene (three.js WebGL2 interpreter).
//
// The contract that matters: render(index) is a PURE function of the spec and
// the frame index. Every frame fully re-derives scene state from t — object
// transforms from sampled keyframes, character poses from resolveActions()
// weights applied through AnimationMixer.update(0) — so preview, scrubbing
// and frame-exact export agree, and the same index always yields the same
// pixels. Nothing here may read the clock or accumulate across frames.
//
// three.js loads dynamically inside load(): the editor bundle pays for 3D
// only once a scene clip actually exists.

import { sampleAnimatable } from '@velocut/render-sdk';
import type * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveActions, type ClipMeta } from './actions.ts';
import type { SceneAssetManifest, SceneSpec, Vec3A } from './types.ts';

export interface CompiledScene {
  width: number;
  height: number;
  frameDurUs: number;
  frameCount: number;
  /** Load three.js + models. Call once before render(). */
  load(): Promise<void>;
  /** Render frame `index` → a fresh VideoFrame (caller owns/closes it). */
  render(index: number): VideoFrame;
  /** Release the GL context and scene resources. */
  dispose(): void;
}

/** Where scene assets (manifest + GLBs) are served from. */
export const DEFAULT_ASSET_BASE = '/scene-assets';

// Module-level caches: the manifest and parsed GLBs are immutable per URL —
// characters across scenes (and recompiles of the same scene) share them.
let manifestCache = new Map<string, Promise<SceneAssetManifest>>();
const gltfCache = new Map<string, Promise<GLTF>>();

export function loadSceneManifest(base: string = DEFAULT_ASSET_BASE): Promise<SceneAssetManifest> {
  let p = manifestCache.get(base);
  if (!p) {
    p = fetch(`${base}/manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`scene manifest: HTTP ${r.status}`);
      return r.json() as Promise<SceneAssetManifest>;
    });
    // A failed fetch must not poison the cache permanently.
    p.catch(() => manifestCache.delete(base));
    manifestCache.set(base, p);
  }
  return p;
}

/** Test hook: drop cached manifests (e.g. after changing asset base). */
export function resetSceneManifestCache(): void {
  manifestCache = new Map();
}

const sampleVec3 = (v: Vec3A | undefined, t: number, dx: number, dy: number, dz: number): [number, number, number] => [
  sampleAnimatable(v?.x, t, dx),
  sampleAnimatable(v?.y, t, dy),
  sampleAnimatable(v?.z, t, dz),
];

interface CharRuntime {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  clips: Record<string, ClipMeta>;
  heightM: number;
  spec: NonNullable<SceneSpec['characters']>[number];
}

interface PropRuntime {
  root: THREE.Object3D;
  spec: NonNullable<SceneSpec['props']>[number];
}

export function compileSceneSpec(
  spec: SceneSpec,
  defaults: { width: number; height: number; fps: number; assetBase?: string },
): CompiledScene {
  const width = Math.round(spec.width ?? defaults.width);
  const height = Math.round(spec.height ?? defaults.height);
  const fps = spec.fps ?? 30;
  const frameDurUs = Math.round(1e6 / fps);
  const frameCount = Math.max(1, Math.ceil(spec.durationUs / frameDurUs));
  const assetBase = defaults.assetBase ?? DEFAULT_ASSET_BASE;

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let canvas: OffscreenCanvas | null = null;
  let chars: CharRuntime[] = [];
  let props: PropRuntime[] = [];

  async function load(): Promise<void> {
    const three = await import('three');
    const [{ GLTFLoader }, SkeletonUtils] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/utils/SkeletonUtils.js'),
    ]);

    canvas = new OffscreenCanvas(width, height);
    renderer = new three.WebGLRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      antialias: true,
      preserveDrawingBuffer: false,
    });
    renderer.setSize(width, height, false); // updateStyle=false: OffscreenCanvas has no .style
    renderer.shadowMap.enabled = true;

    scene = new three.Scene();

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
    chars = [];
    for (const c of spec.characters ?? []) {
      const entry = manifest.characters[c.model];
      if (!entry) throw new Error(`unknown character model '${c.model}'`);
      const url = `${assetBase}/${entry.file}`;
      let g = gltfCache.get(url);
      if (!g) {
        g = new GLTFLoader().loadAsync(url);
        g.catch(() => gltfCache.delete(url));
        gltfCache.set(url, g);
      }
      const gltf = await g;
      const root = SkeletonUtils.clone(gltf.scene);
      root.traverse((o) => {
        o.castShadow = true;
      });
      scene.add(root);
      const mixer = new three.AnimationMixer(root);
      const actions = new Map<string, THREE.AnimationAction>();
      const clips: Record<string, ClipMeta> = {};
      for (const clip of gltf.animations) {
        if (!entry.clips[clip.name]) continue; // only registry-listed clips
        actions.set(clip.name, mixer.clipAction(clip));
        clips[clip.name] = { duration: clip.duration, loop: entry.clips[clip.name].loop ?? true };
      }
      chars.push({ root, mixer, actions, clips, heightM: entry.heightM ?? 1.7, spec: c });
    }

    // ----------------------------------------------------------------- props
    props = [];
    for (const p of spec.props ?? []) {
      const color = new three.Color(p.color ?? '#8fa3bf');
      const mat = new three.MeshStandardMaterial({ color, roughness: 0.6 });
      let mesh: THREE.Mesh;
      if (p.model === 'prop/sphere') mesh = new three.Mesh(new three.SphereGeometry(0.5, 32, 16), mat);
      else if (p.model === 'prop/pillar') mesh = new three.Mesh(new three.CylinderGeometry(0.3, 0.3, 2, 24), mat);
      else mesh = new three.Mesh(new three.BoxGeometry(1, 1, 1), mat); // prop/cube + fallback
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      props.push({ root: mesh, spec: p });
    }

    camera = new three.PerspectiveCamera(40, width / height, 0.1, 500);
  }

  /** A character's sampled world position at time t (shared by its own
   *  transform and by camera lookAt tracking). */
  function charPosition(c: CharRuntime, t: number): [number, number, number] {
    return sampleVec3(c.spec.position, t, 0, 0, 0);
  }

  function render(index: number): VideoFrame {
    if (!renderer || !scene || !camera || !canvas) throw new Error('CompiledScene.render() before load()');
    const clamped = Math.max(0, Math.min(frameCount - 1, index));
    const t = (clamped * frameDurUs) / 1e6;

    for (const c of chars) {
      const [x, y, z] = charPosition(c, t);
      c.root.position.set(x, y, z);
      c.root.rotation.y = (sampleAnimatable(c.spec.rotationY, t, 0) * Math.PI) / 180;
      if (c.spec.scale != null) c.root.scale.setScalar(c.spec.scale);

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
    }

    for (const p of props) {
      const [x, y, z] = sampleVec3(p.spec.position, t, 0, 0.5, 0);
      p.root.position.set(x, y, z);
      p.root.rotation.y = (sampleAnimatable(p.spec.rotationY, t, 0) * Math.PI) / 180;
      if (p.spec.scale != null) p.root.scale.setScalar(p.spec.scale);
    }

    const cam = spec.camera;
    camera.fov = sampleAnimatable(cam?.fov, t, 40);
    camera.position.set(...sampleVec3(cam?.position, t, 5, 2.4, 7));
    const look = cam?.lookAt;
    if (look && 'character' in look && typeof look.character === 'string') {
      const target = chars.find((c) => c.spec.id === look.character);
      if (target) {
        const [x, y, z] = charPosition(target, t);
        camera.lookAt(x, y + target.heightM * 0.72, z);
      } else {
        camera.lookAt(0, 1, 0);
      }
    } else {
      camera.lookAt(...sampleVec3(look as Vec3A | undefined, t, 0, 1, 0));
    }
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    return new VideoFrame(canvas, { timestamp: clamped * frameDurUs, duration: frameDurUs });
  }

  function dispose(): void {
    renderer?.dispose();
    renderer = null;
    scene = null;
    camera = null;
    canvas = null;
    chars = [];
    props = [];
  }

  return { width, height, frameDurUs, frameCount, load, render, dispose };
}
