// scene.ts — the SceneSpec compiler: declarative 3D scene → per-frame VideoFrames.
//
// Same contract as render-sdk's CompiledMotion: `render(index)` is a PURE
// function of the spec and the frame index (scene state is fully re-derived
// from t every frame — AnimationMixer-style setTime, no accumulation), which
// is what makes preview, scrubbing and frame-exact export agree. Three.js is
// loaded dynamically inside load() so the editor bundle doesn't pay for it
// until the first scene clip exists.
//
// P0 scope: a built-in stage (ground + lights + a hero cube) with a keyframed
// camera — this proves the WebGL2 OffscreenCanvas → VideoFrame → WebGPU
// compositor + export pipeline. Characters/props/environments arrive in P1;
// the spec shape and the purity contract don't change.

import { sampleAnimatable, type Animatable } from '@velocut/render-sdk';
import type * as THREE from 'three';

/** Per-axis animatable 3D value (world units = meters). */
export interface Vec3A {
  x?: Animatable;
  y?: Animatable;
  z?: Animatable;
}

export interface SceneCamera {
  /** Vertical field of view, degrees. */
  fov?: Animatable;
  position?: Vec3A;
  lookAt?: Vec3A;
}

export interface SceneSpec {
  version: 1;
  durationUs: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Stage preset id. P0 ships only 'spike' (ground + lights + hero cube). */
  environment?: string;
  camera?: SceneCamera;
}

export interface CompiledScene {
  width: number;
  height: number;
  frameDurUs: number;
  frameCount: number;
  /** Load three.js + scene assets. Call once before render(). */
  load(): Promise<void>;
  /** Render frame `index` → a fresh VideoFrame (caller owns/closes it). */
  render(index: number): VideoFrame;
  /** Release the GL context and scene resources. */
  dispose(): void;
}

/** Structural validation (schema-level). Returns an error message or null. */
export function validateSceneSpec(spec: unknown): string | null {
  const s = spec as SceneSpec | null;
  if (!s || typeof s !== 'object') return 'spec must be an object';
  if (s.version !== 1) return 'spec.version must be 1';
  if (!(typeof s.durationUs === 'number' && s.durationUs > 0)) return 'spec.durationUs must be > 0';
  if (s.camera != null && typeof s.camera !== 'object') return 'spec.camera must be an object';
  return null;
}

const sampleVec3 = (
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

export function compileSceneSpec(
  spec: SceneSpec,
  defaults: { width: number; height: number; fps: number },
): CompiledScene {
  const width = Math.round(spec.width ?? defaults.width);
  const height = Math.round(spec.height ?? defaults.height);
  const fps = spec.fps ?? 30;
  const frameDurUs = Math.round(1e6 / fps);
  const frameCount = Math.max(1, Math.ceil(spec.durationUs / frameDurUs));

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let hero: THREE.Object3D | null = null;
  let canvas: OffscreenCanvas | null = null;

  async function load(): Promise<void> {
    const three = await import('three');
    canvas = new OffscreenCanvas(width, height);
    renderer = new three.WebGLRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      antialias: true,
      // The frame is read synchronously right after render(); nothing needs
      // the buffer preserved across tasks.
      preserveDrawingBuffer: false,
    });
    // updateStyle=false: an OffscreenCanvas has no .style.
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true;

    scene = new three.Scene();
    scene.background = new three.Color(0x10141c);

    // --- built-in spike stage: ground + lights + a hero cube -------------
    const ground = new three.Mesh(
      new three.PlaneGeometry(40, 40),
      new three.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const key = new three.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 3);
    key.castShadow = true;
    scene.add(key);
    scene.add(new three.AmbientLight(0x8899bb, 0.6));

    const cube = new three.Mesh(
      new three.BoxGeometry(1, 1, 1),
      new three.MeshStandardMaterial({ color: 0xe05545, roughness: 0.4 }),
    );
    cube.position.y = 0.5;
    cube.castShadow = true;
    scene.add(cube);
    hero = cube;

    camera = new three.PerspectiveCamera(40, width / height, 0.1, 200);
  }

  function render(index: number): VideoFrame {
    if (!renderer || !scene || !camera || !canvas) {
      throw new Error('CompiledScene.render() before load()');
    }
    const clamped = Math.max(0, Math.min(frameCount - 1, index));
    const t = (clamped * frameDurUs) / 1e6;

    // Scene state is a pure function of t — re-derived every frame.
    if (hero) {
      hero.rotation.y = t * 1.2;
      hero.position.y = 0.5 + 0.25 * Math.abs(Math.sin(t * 2));
    }
    const cam = spec.camera;
    camera.fov = sampleAnimatable(cam?.fov, t, 40);
    camera.position.set(...sampleVec3(cam?.position, t, 4, 2.2, 6));
    camera.lookAt(...sampleVec3(cam?.lookAt, t, 0, 0.5, 0));
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    return new VideoFrame(canvas, { timestamp: clamped * frameDurUs, duration: frameDurUs });
  }

  function dispose(): void {
    renderer?.dispose();
    renderer = null;
    scene = null;
    camera = null;
    hero = null;
    canvas = null;
  }

  return { width, height, frameDurUs, frameCount, load, render, dispose };
}
