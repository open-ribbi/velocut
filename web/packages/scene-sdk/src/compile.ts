// compile.ts — SceneSpec → CompiledScene (the export/preview interpreter).
//
// A thin shell over the shared stage (stage.ts): buildStage owns the world
// and per-t posing; this file adds the SPEC camera and the VideoFrame
// surface. The contract that matters: render(index) is a PURE function of
// the spec and the frame index — poseAt fully re-derives state from t — so
// preview, scrubbing and frame-exact export agree.
//
// three.js loads dynamically inside load(): the editor bundle pays for 3D
// only once a scene clip actually exists.

import { sampleAnimatable } from '@velocut/render-sdk/motionspec';
import type * as THREE from 'three';
import { buildStage, sampleVec3, DEFAULT_ASSET_BASE, type Stage } from './stage.ts';
import { expandShots } from './shots.ts';
import type { SceneSpec, Vec3A } from './types.ts';

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

/** Deterministic handheld wobble: a fixed multi-sine of t (distinct phases
 *  per channel index) — reproducible on every render, no randomness. */
function wobble(t: number, hz: number, channel: number): number {
  const w = 2 * Math.PI * hz;
  const p = channel * 1.7;
  return Math.sin(w * t + 0.7 + p) * 0.62 + Math.sin(w * 2.17 * t + 3.1 + p) * 0.27 + Math.sin(w * 4.9 * t + 5.3 + p) * 0.11;
}

/** The shot camera's sampled position at t (also fed to gaze:'camera'). */
export function specCameraPosition(spec: SceneSpec, t: number): [number, number, number] {
  return sampleVec3(spec.camera?.position, t, 5, 2.4, 7);
}

/** Aim the camera per the spec at time t — shared with the Director panel's
 *  spec-camera preview so staging and rendering agree. Expects a spec whose
 *  shots are already expanded (see expandShots). */
export function applySpecCamera(camera: THREE.PerspectiveCamera, spec: SceneSpec, stage: Stage, t: number): void {
  const cam = spec.camera;
  camera.fov = sampleAnimatable(cam?.fov, t, 40);
  const [px, py, pz] = specCameraPosition(spec, t);
  const shake = cam?.shake;
  const amp = shake?.amplitude ?? (shake ? 0.03 : 0);
  const hz = shake?.frequency ?? 1.1;
  camera.position.set(
    px + amp * wobble(t, hz, 0),
    py + amp * 0.6 * wobble(t, hz, 1),
    pz + amp * wobble(t, hz, 2),
  );
  const look = cam?.lookAt;
  if (look && 'character' in look && typeof look.character === 'string') {
    const pos = stage.characterPosition(look.character, t);
    if (pos) {
      const h = stage.characters.find((c) => c.spec.id === look.character)?.heightM ?? 1.7;
      camera.lookAt(pos[0], pos[1] + h * 0.72, pos[2]);
    } else {
      camera.lookAt(0, 1, 0);
    }
  } else {
    camera.lookAt(...sampleVec3(look as Vec3A | undefined, t, 0, 1, 0));
  }
  // After lookAt the local axes are the view axes: Z-roll = dutch angle,
  // small X/Y rotations = handheld aim wobble.
  const rollRad = (sampleAnimatable(cam?.roll, t, 0) * Math.PI) / 180;
  if (rollRad) camera.rotateZ(rollRad);
  const rotAmp = ((shake?.rotAmplitude ?? (shake ? 0.5 : 0)) * Math.PI) / 180;
  if (rotAmp) {
    camera.rotateX(rotAmp * wobble(t, hz, 3));
    camera.rotateY(rotAmp * wobble(t, hz, 4));
  }
  camera.updateProjectionMatrix();
}

export function compileSceneSpec(
  rawSpec: SceneSpec,
  defaults: { width: number; height: number; fps: number; assetBase?: string },
): CompiledScene {
  const spec = expandShots(rawSpec);
  const width = Math.round(spec.width ?? defaults.width);
  const height = Math.round(spec.height ?? defaults.height);
  // Inherit the document's frame rate (24fps projects must not get a 30fps
  // grid — timeline sampling would judder), clamped defensively.
  const fps = Math.min(120, Math.max(1, spec.fps ?? defaults.fps ?? 30));
  const frameDurUs = Math.round(1e6 / fps);
  const frameCount = Math.max(1, Math.ceil(spec.durationUs / frameDurUs));
  const assetBase = defaults.assetBase ?? DEFAULT_ASSET_BASE;

  let stage: Stage | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let canvas: OffscreenCanvas | null = null;

  async function load(): Promise<void> {
    stage = await buildStage(spec, assetBase);
    canvas = new OffscreenCanvas(width, height);
    renderer = new stage.three.WebGLRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      antialias: true,
      preserveDrawingBuffer: false,
    });
    renderer.setSize(width, height, false); // updateStyle=false: OffscreenCanvas has no .style
    renderer.shadowMap.enabled = true;
    camera = new stage.three.PerspectiveCamera(40, width / height, 0.1, 500);
  }

  function render(index: number): VideoFrame {
    if (!renderer || !stage || !camera || !canvas) throw new Error('CompiledScene.render() before load()');
    const clamped = Math.max(0, Math.min(frameCount - 1, index));
    const t = (clamped * frameDurUs) / 1e6;
    stage.poseAt(t, { cameraPos: specCameraPosition(spec, t) });
    applySpecCamera(camera, spec, stage, t);
    renderer.render(stage.scene, camera);
    return new VideoFrame(canvas, { timestamp: clamped * frameDurUs, duration: frameDurUs });
  }

  function dispose(): void {
    // forceContextLoss frees the GL context NOW (browsers cap live contexts
    // at ~8-16; waiting for GC turns spec-edit iteration into "oldest context
    // will be lost" black frames). GPU copies die with the context; shared
    // CPU-side assets (cached GLTF geometry/materials) stay untouched for
    // other live stages.
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer = null;
    stage = null;
    camera = null;
    canvas = null;
  }

  return { width, height, frameDurUs, frameCount, load, render, dispose };
}
