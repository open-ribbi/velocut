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
agent's `velocut_script` sandbox. The MCP adapter delegates to the same services.

| Method | Behavior |
|---|---|
| `sceneClip({spec,…})` | Create and compile a scene, normalize anonymous prop IDs |
| `sceneInspect({assetId,timeS?})` | Return normalized spec, document revision, world transforms and evaluated bounds |
| `sceneEdit({assetId,expectedRevision?,edits,dryRun?})` | Compile then commit once; `dryRun:true` returns a validated candidate without committing |
| `sceneImportModel({assetId,file?/base64?,kind?,…})` | Import an embedded GLB into versioned project storage and create a static/animated object |
| `sceneArrange({assetId,ids,mode,…})` | Ground, place on another object, align an edge, or distribute using world bounds; accepts `dryRun` |
| `previewSession({rate?,playing?,timeUs?})` | Read/control editor preview speed, play/pause and seek; no document/history/export changes |
| `directorSession(opts?)` | Read/control open scene, selection, focus, view, gizmo mode, time and playback |
| `observe({mode:'scene',source:{assetId},view,…})` | Render a construction/shot view and return image plus revision and geometry evidence |

The discrete `velocut_observe` tool carries images to the model. The existing
script observation contract returns numeric/structured data only, so scripts
should not be used to request visual reasoning from image bytes.

### Preview speed (unreleased)

The editor toolbar and Director transport each provide a **Preview** selector:
0.25×, 0.5×, 1×, 1.5×, 2×, 4×. It is available without selecting a clip. The
existing **Clip speed** selector still retimes a selected clip and changes its
exported duration; preview speed changes neither the document nor export.

```js
// Editor timeline: project-local microseconds; omitted options read state.
await velocut.previewSession({ rate: 2, playing: true, timeUs: 0 });
// Director: independent speed and scene-local seconds.
await velocut.directorSession({ assetId, rate: 0.5, playing: true, timeS: 0 });
```

The MCP equivalents are `velocut_preview({sessionId,rate?,playing?,timeUs?})` and
`velocut_director({sessionId,options:{assetId,rate,...}})`. The built-in agent and
MCP scripts share `previewSession`. Custom SDK hosts pass their `Playback`
instance as the sixth argument to `createProjectHost`; without it the host
returns an explicit unsupported result. `Playback.session()` also supports this
API directly. Rates are session-only: a new project/page starts at 1×; opening a
fresh Director session starts at 1×. Switching to the Director pauses the editor.

Editor preview audio uses the same rate for its clock and PCM scheduling, so it
stays synchronized; pitch changes with speed (no pitch preservation). Clips with
an authored clip speed other than 1 retain the existing muted-preview/export
limitation. The Director's scene transport does not play timeline audio.

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

### Batch copying and precise placement (unreleased)

These operations work in `sceneEdit.edits`, from the standalone SDK's
`applySceneEdits`, the built-in agent, and the Codex MCP script tool.

- `duplicateMany`: `{type:'duplicateMany',ids,copies:[{prefix,transform?,relative?}],timeS?}`.
  Select independent roots; descendants are included automatically. Every copy
  uses `${prefix}/${oldId}` for all objects, remapping parent, attachment and
  internal gaze references across the entire selection. External references stay
  external. Each optional transform applies to each copied root in its own local
  frame; use `relative:true` for offsets that preserve separation. Originals are
  unchanged. Result `copies` contains `{prefix,rootIds,idMap}` for each copy;
  `createdIds` lists new objects remaining in the candidate, `changedIds` includes
  updated/removed objects. Prefix collisions fail the entire batch.
- `transform`: `{type:'transform',ids,transform:{position?,rotation?,scale?},relative?,timeS?}`.
  Position and rotation use `{x?,y?,z?}`. Scale is a positive number or per-axis
  object. Default mode sets supplied components to the requested values at
  `timeS` (default 0); `relative:true` adds position/Euler components and multiplies
  scales. Omitted axes remain unchanged. Keyframes shift uniformly, retaining
  timing and easing. Coordinates are parent-local, rotations are XYZ Euler
  degrees about each object's own origin. This is not rotation/scaling of a
  selection around a shared pivot. Physics props require `timeS:0`.
- `layout`: `{type:'layout',ids,layout,timeS?}`. Place origins in caller ID order.
  All roots must share a parent frame (or the same attachment bone). Layouts:
  - `{mode:'line',origin:{x?,y?,z?},step:{x?,y?,z?}}`.
  - `{mode:'grid',origin:{x?,y?,z?},columns,spacing:{x,z}}`: row-major X/Z grid,
    positive spacing and 1..200 columns.
  - `{mode:'radial',center:{x?,y?,z?},radius,startAngle?,sweepAngle?,facing?,rotationOffset?}`:
    X/Z ring or arc, positive radius, default start 0 and sweep 360 degrees.
    Angle 0 is +Z; positive angles turn toward +X. A full ±360 ring omits the
    duplicate endpoint; shorter arcs include both endpoints. Facing defaults to
    `keep`, or use `inward`, `outward`, `tangent` to orient local +Z; `rotationOffset`
    adds a yaw correction to these orientations. Only yaw changes. Omitted
    origin/center axes are 0. Existing animation paths are shifted at `timeS`.
- `sceneArrange({assetId,ids,mode:'distribute',axis?,gap?,start?,timeS?,expectedRevision?,dryRun?})`:
  pack evaluated world bounds in ID order, along positive axis (default X), with
  `gap` meters between edges (default 0; negative values intentionally overlap).
  `start` sets the first lower edge, defaulting to that object's current lower
  edge. Other world coordinates are retained. Supports different, rotated/scaled
  parents and shifts local animation paths. It does not use `referenceId`.

Selections reject duplicate IDs and parent/descendant overlap. Limits remain
200 props, 100 groups, 8 characters, 16 lights, and 256 KiB per scene; assembly
parts count as props. `duplicateMany` accepts 1..100 copy requests and at most
500 generated objects, subject to these tighter scene limits. Layouts address
origins, not geometry clearance; use world-bound arrangement for measured gaps.

`dryRun:true` performs the same validation and compilation as a commit, disposes
its temporary renderer, and returns `{ok:true,preview:true,ready:false,revision,
spec,changedIds,createdIds,copies}`. It changes neither document nor history and
returns no image. Commit the same edits with the returned revision; a concurrent
edit causes a conflict. Preview is optional, not an approval requirement.

Combine copying, layout and detailed transforms in **one** `sceneEdit` call to
get one undo step and no partial state if validation/compilation fails. Several
separate calls in a script are still separate transactions.

```js
// assetId is the scene selected from document/inspection, not an object ID.
const current = await velocut.sceneInspect({ assetId });
if (!current.ok) throw new Error(current.message);
const copies = Array.from({ length: 11 }, (_, i) => ({ prefix: `seat${i + 1}` }));
const ids = ['chair', ...copies.map(c => `${c.prefix}/chair`)];
const edits = [
  { type: 'assembly', id: 'chair', recipe: { template: 'chair' } },
  { type: 'duplicateMany', ids: ['chair'], copies },
  { type: 'layout', ids, layout: {
    mode: 'radial', center: { y: 0 }, radius: 4,
    startAngle: -90, sweepAngle: 180, facing: 'inward'
  } },
  { type: 'transform', ids: ['seat1/chair'], relative: true,
    transform: { position: { y: 0.1 }, rotation: { y: 5 } } }
];
const result = await velocut.sceneEdit({
  assetId, expectedRevision: current.revision, edits
});
if (!result.ok) throw new Error(result.message);
return { revision: result.revision, createdIds: result.createdIds, copies: result.copies };
// Follow with the separate velocut_observe tool for actual images.
```

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

## Batch placement validation (2026-09-11)

- Production SDK declarations and editor build passed; no new dependencies.
- 84 unit tests and 8 MCP tests passed. New placement cases cover absolute and
  relative animated transforms, multi-root reference/attachment remapping,
  assembly regeneration after copying, line/grid/radial layouts, facing, copy
  limits, malformed inputs, overlapping selections and transactional failures.
- 15 relevant browser tests passed across `director-authoring.spec.ts`,
  `codex-plugin.spec.ts` and `placement.spec.ts`. The packaged MCP executes a
  real sandbox script that previews and commits copies + layout + adjustments,
  returns rendered image content and undoes the whole batch in one step.
  Distribution measures exact gaps under rotated/nonuniformly scaled parents,
  preserves animation and rejects stale revisions. Dry-run compile failures
  leave document and history unchanged. The final focused MCP check also covers
  the direct distribute tool's dryRun/start schema.

## Preview speed validation (2026-09-11)

- 88 unit tests and 8 MCP tests passed. Preview tests exercise wall/audio clock
  rate changes, continuous switching, seeking, pause/end/replay, invalid request
  atomicity, delayed AudioContext activation and stale PCM cancellation.
- All 37 browser tests passed. After the final workspace-pause and compact-control
  changes, the 17 affected Director/preview/layout tests passed again. Real MCP
  and sandbox calls control both preview transports, no history/document changes
  occur, fresh projects reset to 1×, and small-window selectors remain usable.
- Production SDK/type declarations and editor build passed. No new dependencies,
  registry publication or GitHub release changes were made for this feature.
