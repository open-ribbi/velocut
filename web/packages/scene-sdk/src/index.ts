// @velocut/scene-sdk — declarative 3D scenes for Velocut (the Scene Director).
//
// A SceneSpec is pure JSON interpreted by a fixed three.js compiler into the
// same per-frame VideoFrame contract motion graphics use, so scenes ride the
// existing compositor, timeline and export machinery. The spec itself lives in
// the document (Asset.spec — undo/history/sync included); see
// docs/design/scene-director.md.

export {
  validateSceneSpec,
  type SceneSpec,
  type SceneCamera,
  type SceneCharacter,
  type SceneProp,
  type SceneAction,
  type SceneShot,
  type Scale3,
  type Vec3A,
  type SceneAssetManifest,
  type ManifestClip,
} from './types.ts';
export { resolveActions, type ActivePose, type ClipMeta } from './actions.ts';
export { expandShots, CUT_EASE } from './shots.ts';
export { scenePromptDoc } from './prompt.ts';
export { compileSceneSpec, applySpecCamera, specCameraPosition, type CompiledScene } from './compile.ts';
export {
  buildStage,
  loadSceneManifest,
  resetSceneManifestCache,
  sampleVec3,
  DEFAULT_ASSET_BASE,
  type Stage,
  type StageCharacter,
  type StageProp,
} from './stage.ts';
