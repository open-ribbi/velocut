// @velocut/scene-sdk — declarative 3D scenes for Velocut (the Scene Director).
//
// A SceneSpec is pure JSON interpreted by a fixed three.js compiler into the
// same per-frame VideoFrame contract motion graphics use, so scenes ride the
// existing compositor, timeline and export machinery. The spec itself lives in
// the document (Asset.spec — undo/history/sync included); see
// docs/design/scene-director.md.

export {
  compileSceneSpec,
  validateSceneSpec,
  type SceneSpec,
  type SceneCamera,
  type Vec3A,
  type CompiledScene,
} from './scene.ts';
