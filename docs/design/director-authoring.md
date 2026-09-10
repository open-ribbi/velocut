# Director authoring expansion

Status: native authoring implementation complete; validation audit below. Scope: expand Velocut's editable 3D authoring capabilities;
The [Codex plugin](../integrations/codex-plugin.md) now provides an MCP adapter over these same host services.

## Requirements

- Objects have stable identifiers. Object edits, duplication, removal and batches
  use a shared data API and produce one history entry per transaction.
- Extend authoring with full XYZ rotation, per-axis scale, nested groups,
  editable materials and reusable parametric geometry. Preserve legacy scenes.
- Queries expose evaluated world transforms and bounds at a specified time.
  Observation supports construction views and shot views without changing the
  authored camera, and identifies the observed document version.
- The host validates and compiles before publishing an edit, reports failures,
  and rejects stale writes instead of overwriting a human's intervening change.
- Human controls and agent scripts reach the same authoring services. Keep the
  document declarative, replayable and undoable; scripts do not mutate Three.js.
- Provide parametric assemblies, alignment/array operations, model import
  and Director session controls. Advanced sculpting/retopology remains a potential
  Blender asset-production integration, not a requirement to rebuild Blender.

## Verification

Exercise legacy scenes, hierarchy/cycle validation, rotation and physics parity,
reference integrity on duplicate/delete, transaction atomicity, concurrent edits,
render readiness, undo/redo/reload, and browser rendering. Verify human edits to
AI-authored objects and subsequent agent edits to those same objects. Track
unfinished requirements explicitly; passing schema tests alone is not completion.

## Implemented authoring surface

All methods below are available in the editor's `window.velocut` and in the
agent's `velocut_script` sandbox. A future MCP adapter can delegate to them.

| Method | Behavior |
|---|---|
| `sceneClip({spec,…})` | Create and compile a scene, normalize anonymous prop IDs |
| `sceneInspect({assetId,timeS?})` | Return normalized spec, document revision, world transforms and evaluated bounds |
| `sceneEdit({assetId,expectedRevision?,edits})` | Apply an object/scene transaction; compile before committing; return `ready:true` |
| `sceneImportModel({assetId,file?/base64?,kind?,…})` | Import an embedded GLB into versioned project storage and create a static/animated object |
| `sceneArrange({assetId,ids,mode,…})` | Ground, place on another object, or align an edge using world bounds |
| `directorSession(opts?)` | Read/control open scene, selection, focus, view, gizmo mode, time and playback |
| `observe({mode:'scene',source:{assetId},view,…})` | Render a construction/shot view and return image plus revision and geometry evidence |

The discrete `velocut_observe` tool carries images to the model. The existing
script observation contract returns numeric/structured data only, so scripts
should not be used to request visual reasoning from image bytes.

### Transaction grammar

- `add`: `{type:'add',kind:'prop'|'character'|'group'|'light',object:{id,…}}`
- `update`: `{type:'update',id,patch:{…},clear?:[fieldNames]}`. Supplied fields
  replace their previous values; nested objects are not implicitly deep-merged.
- `remove`: `{type:'remove',id,cascade?:true}`. Without cascade, reject children
  and references; with cascade, remove descendants and clear camera/gaze links.
- `duplicate`: `{type:'duplicate',id,newId,offset?:{x,y,z}}`. Clone descendants
  and remap internal references. Offset is parent-local, and shifts keyframe paths.
- `array`: `{type:'array',id,prefix,copies,offset:{x,y,z}}`. Make `copies` new
  subtrees, named `prefix_1` onward, at cumulative offsets. One undo entry.
- `assembly`: `{type:'assembly',id,recipe:{template,parameters}}`. Templates:
  table, chair, stairs. Width/depth/height in meters; thickness for furniture;
  steps for stairs. Generated parts are ordinary editable props with stable IDs.
  Regeneration replaces generated geometry, preserves custom children and part
  color/material choices, and keeps the assembly group's transform.
- `scene`: `{type:'scene',patch:{camera?,shots?,environment?,lighting?,physics?},clear?}`.

Geometry: existing primitives, lathe and extrusion, plus `prop/tube` with a
3D `path`, `radius` and `closed`; extrusion now accepts `holes` and `bevel`.
Groups nest via `parentId`. All objects support animatable `rotationX/Y/Z`
(degrees, XYZ Euler order) and positive per-axis scale. Props expose PBR
roughness, metalness, opacity, emissive color/intensity and face sidedness.

### Example: assemble and place a vase

```js
const created = await velocut.sceneClip({
  name: 'Workshop',
  spec: { version: 1, durationUs: 4_000_000, environment: 'env/stage' }
});
if (!created.ok) throw new Error(created.message);
const assetId = created.assetId;
const edited = await velocut.sceneEdit({ assetId, edits: [
  { type: 'assembly', id: 'table', recipe: {
    template: 'table', parameters: { width: 2, height: 0.9 }
  } },
  { type: 'add', kind: 'prop', object: {
    id: 'vase', model: 'prop/lathe',
    points: [[0.1,0],[0.25,0.15],[0.12,0.5],[0.16,0.6]],
    color: '#4488aa', material: { roughness: 0.2, metalness: 0.3 }
  } }
] });
if (!edited.ok) throw new Error(edited.message);
const placed = await velocut.sceneArrange({
  assetId, ids: ['vase'], mode: 'on', referenceId: 'table/top', gap: 0.005,
  expectedRevision: edited.revision
});
if (!placed.ok) throw new Error(placed.message);
await velocut.directorSession({ assetId, objectId: 'vase', focusId: 'table' });
```

### Implemented extensions and boundaries

- `on` centers X/Z and places the lower bound on the reference's upper Y bound.
  This is bounding-box placement, not surface contact detection. `align` uses
  `axis` and `edge` (`min`, `max`, `center`). Parent transforms and bone-local
  units are accounted for; animated positions retain their keyframes.
- Physics props currently require world-root placement. Concave primitive
  colliders continue to use convex hulls. Grouped physics needs its own design.
- Queries are snapshots; a revision identifies the observed document. Pass it
  back on writes. Conflicting edits return a conflict rather than auto-merging.
- Scene metadata (duration/resolution/fps) is not resized by object transactions.
  Resizing requires coordinating asset and timeline metadata; create a new clip
  in the current API.
- Self-contained GLB 2 imports persist by SHA-256 under the owning project's
  OPFS directory. The SceneSpec keeps the model registry, label, animation names,
  morph names and optional bone slots; undo/history references immutable bytes.
  The import supports static props and animated models. Embedded bitmap textures
  and source materials are retained; prop overrides clone materials per instance.
  External dependencies and invalid models fail without changing the document.
- `prop/mesh` adds explicit vertices, triangular faces and optional per-vertex UVs.
  These are editable in scripts and the Director. Limits: 4096 vertices, 8192
  triangles, within the existing 256 KiB SceneSpec cap. This is indexed-mesh
  authoring, not Blender sculpting, retopology, modifier stacks or shader nodes.
- Independent point, spot, directional and ambient lights are first-class objects
  (IDs, hierarchy, transforms, duplicate/delete, intensity keys, color, shadow,
  range/decay and spot cone controls). `lighting:'none'` disables the preset rig.
  Directional and spot lights point down their local -Z axis.
- `directorSession({camera:{position,target,up?,projection?,fov?,height?}})`
  controls a free perspective or orthographic inspection camera. Manual orbit/pan
  is reflected back into session state. The same camera can be passed to scene
  observation; it does not modify the authored shot.
- Legacy `apply` scene writes, including mixed command batches, now dry-run on
  the reference engine and compile changed scenes before a single real dispatch.
  Callers should await these writes. Render errors and conflicts are returned.
- The Codex plugin implements an MCP adapter over the public host methods. No host
  JavaScript or live Three.js graph is exposed to the script sandbox. Importing
  GLB does not import a Blender file's editing history; complex DCC workflows can
  produce assets for this runtime without being reimplemented here.

## Validation record (2026-09-10)

- Production build (`npm run build`): passed. Existing large-bundle warnings
  remain; no additional runtime dependencies were introduced.
- Unit suite (`npm test`): 76 passed, including legacy scene validation/physics
  and new transactional authoring, IDs, references, recipes and arrays.
- Browser suite (`npx playwright test --workers=1`): 19 passed. Scenarios: transaction compile failure leaves the document unchanged;
  undo/redo/reload; actual construction-view pixels; XYZ rotation/physics parity;
  deterministic hierarchy sampling; human→script editing; concurrent-write
  rejection; extrusion holes and sweeps; Director navigation/playback; nested
  coordinate-space placement; real mouse gizmo drag; existing import/project
  smoke coverage, GLB geometry/textures/animations and storage isolation, custom
  view cameras, independent lights/mesh editing and the built-in agent loop. See
  `web/e2e/director-authoring.spec.ts` and `web/e2e/director-models.spec.ts`.
- Export-frame/shot-observation pixel agreement is checked through the same
  `CompiledScene.render()` VideoFrame contract consumed by timeline export,
  including out-of-order seeks. This is not a new end-to-end codec benchmark.

### Completion audit

| Requirement | Current evidence |
|---|---|
| Stable IDs, object and batch authoring, history | `authoring.test.ts`; authoring E2E transaction, undo/redo/reload and real gizmo drag |
| XYZ transforms, hierarchy, materials, parametric and mesh authoring | Geometry/physics parity; assembly/array tests; mesh topology and rendered-light tests |
| Structured spatial queries and visual feedback | World bounds under transformed parents; construction/custom cameras; actual image pixels and frame agreement |
| Validate/compile before commit; reject conflicts | Failed scene edits and mixed legacy batches leave the document unchanged; concurrent-edit test |
| Shared human/AI services | Human GLB/field edits followed by scripts; built-in agent-loop test receives an image and records AI attribution |
| Model import and persistence | Embedded GLB geometry/texture/animation tests; reload/history; project-isolation and collider tests |
| Director workspace control | Session open/selection/focus/scrub/playback/custom-camera tests; navigation leaves authored data unchanged |
| Codex MCP adapter | Packaged local server, paired browser bridge, real MCP-to-browser editing/vision tests; see the integration guide |

The automated agent-loop test uses deterministic model responses to verify the
real host/tool/vision/history wiring. It does not assert that a real model will
produce professional geometry for every natural-language request. Known runtime
boundaries above remain explicit; implementing Blender's full DCC feature set is
outside the requested native Director capability expansion.
