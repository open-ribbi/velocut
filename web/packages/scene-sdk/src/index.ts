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
  type SceneModel,
  type SceneLight,
  type SceneGroup,
  type SceneTransform,
  type SceneMaterial,
  type SceneCamera,
  type SceneCharacter,
  type SceneProp,
  type SceneAction,
  type SceneShot,
  type PropPhysics,
  type Scale3,
  type Vec3A,
  type SceneAssetManifest,
  type ManifestClip,
} from './types.ts';
export { resolveActions, type ActivePose, type ClipMeta } from './actions.ts';
export { POSE_PRESETS, MANNEQUIN_JOINTS, MANNEQUIN_DEFAULT_COLOR, type MannequinJoint } from './mannequin.ts';
export { expandShots, CUT_EASE } from './shots.ts';
export { scenePromptDoc } from './prompt.ts';
export { bakePhysics, samplePhysicsTrack, propPhysics, PHYSICS_HZ, PHYSICS_MAX_S, type BakeTrack } from './physics.ts';
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

export { applySceneEdits, normalizeSceneSpec, nextSceneId, sceneObjects, type SceneEdit, type SceneObjectKind, type SceneObject } from './authoring.ts';

export { validateViewCamera, type SceneViewCamera, constructionCamera, inspectStage, SCENE_VIEWS, type SceneView } from './inspection.ts';

export { ASSEMBLY_DEFAULTS, assemblyParts, type AssemblyRecipe, type AssemblyTemplate } from './assemblies.ts';

export { withImportedModels, validateGlb, parseSceneModel, loadImportedModel, MAX_MODEL_BYTES, type SceneResources } from './models.ts';

export { exportSceneGlb, type SceneGlbOptions, type SceneGlbResult } from './export.ts';
