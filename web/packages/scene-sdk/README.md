# @velocut/scene-sdk

Declarative editable 3D scenes: SceneSpec validation, pure scene edits,
parametric assemblies, shared native geometry and instances, object-local anchors,
CPU spatial queries, Three.js staging, GLB import, camera sampling,
deterministic physics and frame rendering. ESM JS and TypeScript 5.9+ types are
published; no Velocut checkout or Vite source aliases are required.

Pure validation/edit functions can run in Node. Compiling/rendering a scene
requires a browser with WebGL2, OffscreenCanvas and VideoFrame. Use
`@velocut/runtime` to put scene edits into a project with history and media.

```ts
import { compileSceneSpec } from '@velocut/scene-sdk';
const scene = compileSceneSpec({ version: 1, durationUs: 1_000_000,
  props: [{ id: 'cube', model: 'prop/cube', color: '#e6b774' }] },
  { width: 640, height: 360, fps: 30, assetBase: '/scene-assets' });
await scene.load();
const frame = scene.render(0); // VideoFrame; consumer owns this frame
// Draw/export frame, then close it and release the scene.
frame.close();
scene.dispose();
```

## Assets

Copy this package's `assets/` directory to your public `scene-assets/` directory.
For a Node build script, resolve the manifest with
`import.meta.resolve('@velocut/scene-sdk/assets/manifest.json')` and copy its
containing directory. Pass a different `assetBase` for a subpath deployment.
Models in the manifest resolve relative to this base; retain their LICENSES.md.
Velocut's CLI includes the assets already. Imported GLBs use the explicit
`SceneResources.modelBytes` resolver supplied by the host.

## Static model export (0.0.1)

`exportSceneGlb(spec, { timeS, objectIds?, assetBase?, resources? })` returns a
GLB Blob and format-limit warnings. Omit objectIds for the whole scene. It
preserves hierarchy/world placement, materials, textures and the sampled
skin/morph pose, without animation tracks or procedural editing recipes.
See the [model export guide](../../../docs/integrations/model-export.md).

## Shared geometry (unreleased)

`SceneSpec.geometries` stores editable vertices/faces/UVs once. Props with
`model:'prop/instance', geometryId` share that definition while keeping their
own ID, transform, parent, color and material. Compatible opaque instances
render in one batch. `applySceneEdits` supports `geometry.create`,
`geometry.clone`, `geometry.update`, `geometry.patch`, `geometry.remove` and
resource-backed `makeUnique`; ordinary object edits
also work on instances. `sceneBudget(spec)` exposes counts and limits.

There is no fixed instance-count limit (`SCENE_LIMITS.instances === null`).
The manifest has no fixed byte ceiling (`SCENE_LIMITS.specBytes === null`).
The separate geometry and rendering budgets remain. Runtime scene edits move geometry to immutable `.vmesh` files and store
references in `geometryResources`. Supply `SceneResources.geometryBytes` when
compiling these specs directly; `resolveSceneGeometry` verifies bytes and metadata.
`Stage.updateTransforms` and `CompiledScene.updateTransforms` retain renderers
for compatible instance/group transform changes; other edits rebuild the stage. See the [atomic API guide](../../../docs/integrations/atomic-api.md#shared-native-geometry-and-instances)
for preflight, query, persistence and material/physics restrictions.

## Shared materials

`SceneSpec.materials` defines reusable material parameters and color; props bind
`materialId`. Per-object `color` and `material` fields override shared defaults.
Use `material.create`, `material.update` and `material.remove` through scene edits;
removal rejects live references. Material IDs and geometry IDs have separate
registries. The runtime query kind `sceneMaterials` returns compact summaries.

`geometry.clone` creates an independently editable definition without duplicating
immutable bytes. `makeUnique` binds such a clone to a regular `prop/mesh`, retaining
resource storage and allowing ordinary-mesh transparency/physics. Clone and patch
can compose in one runtime scene edit. The pure `applySceneEdits` function accepts
an optional verified geometry-data map for resource-backed index patches; runtime
hosts resolve only the files required by the edit plan automatically.
