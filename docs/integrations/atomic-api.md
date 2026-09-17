# Atomic API foundation (0.0.2)

Shared geometry and instancing are described in [the instance section](#shared-native-geometry-and-instances).

The runtime adds three transport-neutral methods: `capabilities`, `query` and
`transaction`. CodeAct also gets pure `ops` and `ref` helpers. Existing methods
and MCP tools remain supported. This is the foundation for agent composition,
not a prebuilt talking-head/advertising workflow.

## Discover before composing

```js
const info = await velocut.capabilities({ namespace: 'commands' });
const split = await velocut.capabilities({ name: 'splitClip' });
```

Named command definitions generate JSON Schema from the actual protocol Zod
schemas, including required fields and operation-result references on ID fields.
`resultSchema` identifies the returned IDs. Runtime validation additionally checks
schema refinements, locked tracks, overlap and document constraints. Top-level
unknown command fields are rejected; nested values keep protocol parsing rules.

`namespace:'effects'` reads the shared effect registry. `name:'query'` provides
its schema and allowed/default fields per entity. `name:'transaction'` provides
its request schema. Unsupported atomic services are reported as unavailable;
that does not remove separate existing app integrations. Legacy methods are
separate calls, not commands that can be nested in the new transaction.

## Query snapshots and entities

```js
const snap = await velocut.query({ kind: 'snapshot' });
if (!snap.ok) throw new Error(snap.error.message);
const page = await velocut.query({
  kind: 'clips', snapshotId: snap.data.snapshotId,
  fields: ['id', 'trackId', 'startUs', 'durationUs', 'sourceInUs', 'speed'],
  offset: 0, limit: 50
});
```

Kinds: `document`, `snapshot`, `assets`, `tracks`, `clips`, `generationSlots`, `sceneObjects`, `sceneGeometries`, `sceneMaterials`, `sceneCurves`, `sceneBindings`, `sceneBudget`,
`selection`. Entity results have `data:{items,total,nextOffset}`; continue until
nextOffset is null. Use the same snapshotId for every page. Live pages without a
snapshot can change between calls. Expired IDs fail instead of reading live data.
`ids` is a filter (missing IDs produce no matching items, not an exception).

Clip filters: trackId, assetId, fromUs/toUs. Time filters select clips intersecting
the half-open timeline interval; they do not mean "clip starts after". Results
sort by startUs, trackId and id. Scene object queries require assetId and return
authored local properties; select `fields:['id','object']` for full authored data.
Use sceneInspect for evaluated bounds/world transforms. Asset defaults omit src
and spec; request them explicitly. Projection accepts top-level field names only.
Selection is live UI state and rejects snapshotId.

## Compose, validate and commit

This example creates a text track, then inserts a title by referencing the actual
track ID returned by the previous operation. It does not edit the document until
commit. The query/transaction APIs use the `{ok,data,...}` envelope.

```js
const snap = await velocut.query({kind:'snapshot'});
if (!snap.ok) throw new Error(snap.error.message);
const operations = [
  { id:'track', command:velocut.ops.addTrack({kind:'text',name:'Titles'}) },
  { id:'title', command:velocut.ops.addTextClip({
    trackId:velocut.ref('track','trackId'),
    startUs:0, durationUs:2000000,
    text:{content:'Hello',fontSize:48,color:'#ffffff'}
  }) }
];
const plan = {runtimeId:snap.runtimeId, expectedRevision:snap.revision, operations};
const checked = await velocut.transaction({action:'validate',...plan});
if (!checked.ok) throw new Error(checked.error.message);
const result = await velocut.transaction({action:'commit',requestId:'title-001',...plan});
if (!result.ok) throw new Error(result.error.message);
return {revision:result.revision,clipId:result.data.results.title.clipId};
```

`ops.<commandType>(args)` and `ref(operationId,field)` are synchronous data builders,
not RPCs. JavaScript/TypeScript consumers import them from `@velocut/protocol` and
obtain the runtime with `atomicRuntime(store)` from `@velocut/runtime`. Both the
built-in agent and external MCP host call this same runtime; actor attribution
remains attached to the committed batch.

References are only accepted on assetId/trackId/clipId/effectId fields, and only
to earlier outputs. Available outputs are assetId, trackId, clipId, leftClipId,
rightClipId, effectId, depending on the command. No expressions or arbitrary
property paths are evaluated. Nested protocol batches are not operations here.
All arguments apply to the evolving candidate document, not automatically to the
original snapshot. For multiple cuts, the agent plans source/time mappings.

Validation simulates the commands and compiles modified scene assets without
changing the document, revision or history. Commit checks the revision again,
publishes one protocol batch, and returns `results` keyed by operation ID plus
`changes.assets/tracks/clips` with created/updated/removed IDs. IDs returned by a
validation are only valid for that same unchanged base revision.

Asset registration accepts project opfs:// resources or scene:// specifications.
It registers metadata: it does not import files or prove every media resource is
available. Scene compilation requires the scene authoring/media binding. Within
this API, setAssetSpec is restricted to scene assets. Existing motion APIs, file
I/O, generation, subtitles and async job orchestration have not been silently
converted into transactional commands.

## Retry and lifetime

```js
const status = await velocut.transaction({
  action:'status', runtimeId:snap.runtimeId, requestId:'title-001'
});
```

Commit requires a caller-supplied requestId. Concurrent/repeated identical
requests share their result; changing the payload under the same ID is rejected.
Retrying a committed request after undo does not redo it. Status is pending,
completed (with the saved result) or unknown. An unknown outcome must be
reconciled by inspection; it is not proof that nothing happened.

The journal is **in memory for the Store lifetime**, shared across adapters for
that Store. It is not durable across reload/restart. A new runtime has a new
runtimeId; old requests are rejected with staleRuntime/unknown outcome rather
than blindly replayed. Failed attempts are also retained. Use a new request ID
for a corrected/new plan. No cross-project transaction or durable exactly-once
claim is made.

Limits: 200 operations/request; no fixed runtime JSON request, response or source-
document byte ceilings; 8 snapshots (oldest evicted, no silent fallback); 128 retained request
records per runtime (not silently evicted). Names/IDs: operation and request IDs
use 1..128 ASCII letters/digits/`_.:-`, starting with a letter or digit. Entity
pages max 100. Deeply nested or non-JSON requests are rejected. Preview and commit
never reserve global IDs in advance.

Errors carry code, message, optional operationId/operationIndex/field, retryable
and outcome. Outcome is not_committed or unknown for failures. A commit may have
succeeded even if delivery failed: reconnect and query status in the same
runtime, or inspect the document if its runtime changed. Cancellation before
commit leaves the document unchanged; it cannot undo a committed transaction.

## MCP

- `velocut_capabilities`: discovery and named schemas.
- `velocut_query`: snapshot/entity queries.
- `velocut_transaction`: validate, commit, status with the same request grammar.
- `velocut_script`: exposes the new methods plus pure ops/ref builders.
- `velocut_observe`: now declares audio and shots modes already handled by the
  runtime, in addition to its previous modes. Script observation still returns
  data only; use the direct tool for images.

Scope of this implementation: schema discovery, bounded snapshot/entity reads,
and reliable in-runtime composition of existing timeline protocol commands.
Complete clip duplication and resource/probe jobs are added below. Transcript
models, durable jobs and cross-call scene/timeline transactions remain follow-up work.

## Validation record (2026-09-15)

- 98 unit tests pass, including generated schemas, pure typed builders, snapshot
  isolation/projection/pagination, result references, rollback, competing writes,
  request replay after undo, stale runtime rejection and unknown post-commit results.
- 8 MCP tests pass. The full 41-test browser suite passed; the three atomic API
  browser tests then passed after adding a compiling-transaction disconnect case
  (42 distinct browser cases verified across those runs).
- Production build and independent tarball installation pass, including strict
  SDK type consumption, schema discovery and a dependent atomic transaction in
  the installed SDK, plus existing browser rendering, worker and MCP checks.
- These capabilities are included in 0.0.2.

## Resource import, probing and complete clip duplication (0.0.2)

These primitives are now available independently:

| Primitive | Invocation | Output / side effect |
|---|---|---|
| resource.import | `resources({action:'import',runtimeId,requestId,file})` in the browser SDK; `velocut_import_media` with an absolute path in MCP | A job. Stores uniquely named immutable project bytes; no asset/track/clip creation |
| resource.get/list | `resources({action:'get',runtimeId,resourceId})` or action:list with offset/limit | Runtime resource descriptors (ID, name, MIME hint, byte count, SHA-256, OPFS locator) |
| media.probe | `jobs({action:'submit',runtimeId,requestId,task:'media.probe',resourceId})` | A job whose result contains probeId, resourceId, hash and metadata; no document edit |
| asset.register | `ops.registerAsset({resourceId,probeId,name?})` within a transaction | Rechecks bytes and successful probe, expands to addAsset; returns assetId, no insertion |
| clip.duplicate | `ops.duplicateClip({clipId,trackId?,startUs?})` within a transaction; also the protocol duplicateClip command | Deep-copy a clip and return clipId; source media asset is shared, clip/effect IDs are fresh |
| jobs.get/list/cancel | `jobs({action,...})` or `velocut_jobs` | Query/stop work without inserting or registering anything |

`capabilities` now reports `resources`, `jobs`, `resource.import`, `media.probe`
and `registerAsset`, with availability determined by the project's adapter.
MCP adds only two transport tools: `velocut_import_media` for privileged local
file input, and `velocut_jobs` for probe submission and task management. The
existing `velocut_script` exposes resources/jobs; no separate workflow tool is
required for assembling a video.

A typical sequence is:

1. Read runtimeId from query or capabilities.
2. Call `velocut_import_media({sessionId,runtimeId,requestId,path})`.
3. Poll `velocut_jobs({sessionId,runtimeId,action:'get',jobId})`. On succeeded,
   read `data.result.resource.id`. A top-level ok only means the request was
   handled; always inspect the job state.
4. Submit `media.probe` using a different requestId; poll for succeeded, then
   read `data.result.probeId` and metadata.
5. Build a document transaction with registration, insertion and duplication.

```js
// resourceId and probeId come from completed jobs in this same runtime.
const snap = await velocut.query({kind:'snapshot'});
if (!snap.ok) throw new Error(snap.error.message);
const operations = [
  {id:'asset',command:velocut.ops.registerAsset({resourceId,probeId})},
  {id:'track',command:velocut.ops.addTrack({kind:'video'})},
  {id:'clip',command:velocut.ops.addClip({
    assetId:velocut.ref('asset','assetId'), trackId:velocut.ref('track','trackId'),
    startUs:0, durationUs:1000000
  })},
  {id:'copy',command:velocut.ops.duplicateClip({
    clipId:velocut.ref('clip','clipId'), startUs:2000000
  })},
  {id:'trim',command:velocut.ops.trimClip({
    clipId:velocut.ref('copy','clipId'), edge:'out', toUs:2750000
  })}
];
return await velocut.transaction({
  action:'commit',runtimeId:snap.runtimeId,expectedRevision:snap.revision,
  requestId:'register-insert-copy-001',operations
});
```

This transaction creates one undo entry. Import/probe jobs do not enter document
history. Registration is metadata/document work: the editor's existing media
restore service attaches registered OPFS assets asynchronously. Custom SDK hosts
still own their media attachment/restore loop. The old UI convenience importer
remains compatible; this new resource directory only contains atomic imports.

Duplicate preserves assetId, sourceInUs, speed/duration, transform, volume,
text/style, keyframes, effects/parameters/enabled states and transition data.
The default destination is the source end on its existing track; an occupied
range is rejected rather than moving other clips. Destination track kinds must
match and the destination must be unlocked. Reading a locked source into an
unlocked destination is allowed. Clip and effect IDs are reminted, so later edits
to copied effects cannot accidentally target source effects. Query the copied
clip's effects to obtain their new IDs when needed. This command is implemented
in both Rust and TypeScript and covered by shared golden vectors.
The timeline context menu also exposes **Duplicate at track end**, which passes
the track's current end explicitly and selects the new clip after success.

### Job and storage contract

- States: queued, running, cancel_requested, succeeded, failed, cancelled.
  Cancellation is cooperative. A video/image probe can remain cancel_requested
  until its decoder returns; no success result is published afterward. Completed
  jobs are not undone or deleted by cancel.
- Import/probe request IDs share a runtime-scoped namespace. Identical retries
  return the original job; different content/parameters under one ID are rejected.
  Use jobs.list to recover an accepted job if its initial reply was lost.
- Accepted jobs continue independently of a transient MCP disconnect while the
  page remains alive. Reload/project switch invalidates job and resource handles.
  Registered OPFS assets survive reload; undo does not remove their source bytes.
- Successful unregistered imports retain their files in project storage. The
  runtime-only resource catalogue is not restored after reload; reimport if the
  handles were lost. A persistent catalogue/garbage collector is future work.
- Partial writes from failed/cancelled imports are removed. If storage cleanup
  fails, the terminal job exposes cleanupWarning; it does not claim disk cleanup
  succeeded. Unique internal filenames prevent same-name imports overwriting
  previous media. No RAM-only fallback is used for this atomic import path.
- Limits for this initial path: 1 byte..64 MiB/file, 256 MiB imported/pending bytes
  per runtime, 128 retained jobs, 2 executing and 16 queued. Standalone audio is
  limited to 5 minutes and 16 MiB because the editor still attaches whole PCM.
  Existing legacy UI imports keep their own behavior.
- Probe formats: PNG/JPEG/WebP/GIF (image/first-frame behavior), MP4/MOV supported
  by the existing decoder, and browser-supported audio. Audio metadata probing
  does not decode whole PCM. Unknown standalone-audio codec/sample-rate/channel
  values are null. Video metadata lists the selected video/audio playback tracks,
  not a promise that every track or codec in the container is supported.
- SDK setup: call `configureMediaResources(store,{storage,probe})` once per Store.
  Storage implements project-scoped write(name,Blob), read(name), remove(name).
  The browser can use `probeMediaFile(media,file,signal)` from render-sdk. Do not
  reuse a Store/storage binding for a different project. No new runtime packages
  are required for this extension.

### Verification of this increment

- 104 TypeScript/Node tests and 8 MCP tests pass.
- The complete 44-test browser suite passes. After adding the timeline menu
  entry, all 10 resource, multi-selection/reference and compact-layout tests
  pass again, including a real MP4 import/probe/register/copy/trim workflow.
- Rust tests, shared clip-duplication golden vectors and strict Clippy pass;
  the Rust WASM bundle builds successfully. Rebuild local WASM artifacts when
  updating an existing checkout so its command set includes `duplicateClip`.
- Production editor/SDK/CLI/plugin builds and plugin manifest validation pass.
  Independently installed npm tarballs pass distribution checks, including
  resource import/probe/registration/duplication through the installed SDK.
- These resource primitives are included in 0.0.2; resource import/probe jobs
  do not provide persistent job recovery.

## Shared native geometry and instances

A scene can store one editable mesh under `spec.geometries[geometryId]` and
reference it from many props with `model:'prop/instance'` and `geometryId`.
Geometry IDs are scene-local registry keys, not imported-media job handles.
Runtime scene creation/edits externalize vertices into immutable project files,
recording references in `spec.geometryResources`. One BufferGeometry is built per
geometry per stage. Legacy inline geometry remains readable. Compatible opaque instances share an InstancedMesh draw
batch; each still has its own stable object ID, parent, transform and color.

Existing `sceneEdit` exposes the new atomic operations:

| Edit | Effect |
| --- | --- |
| `geometry.create {id,geometry}` | Create a definition; duplicate registry IDs fail |
| `geometry.clone {id,newId}` | Clone a definition; immutable file bytes remain shared until changed |
| `geometry.update {id,geometry}` | Replace its full definition; all referring instances update |
| `geometry.patch {id,attribute,updates}` | Replace selected vertex/face/UV indices; preserve all other data |
| `geometry.remove {id}` | Remove an unreferenced definition; live references reject deletion |
| `add {kind:'prop',object:{id,model:'prop/instance',geometryId,...}}` | Create one independently editable instance |
| `update/transform/layout/duplicate/duplicateMany/remove` | Existing object edits work on instances; duplication preserves the shared reference |
| `makeUnique {id,geometryId?}` | Clone the definition and bind a resource-backed `prop/mesh`; preserve object ID, parent, transform and appearance |

Every geometry definition accepts `name?`, `vertices`, `faces`, and `uvs?` with
the existing explicit-mesh topology rules. Deleting an instance does not delete
its geometry. `makeUnique` creates a separate geometry ID (explicit `geometryId` or generated
`unique_N`), initially sharing immutable file bytes. It leaves other instances
linked and does not garbage collect the old geometry; call `geometry.remove` explicitly when no users remain.

```js
// assetId is an existing scene asset. All sandbox RPC calls need await.
const snap = await velocut.query({kind:'snapshot'});
if (!snap.ok) throw new Error(snap.error.message);
const edits = [
  {type:'geometry.create', id:'panel', geometry:{
    vertices:[[-0.5,0,0],[0.5,0,0],[0.5,1,0],[-0.5,1,0]],
    faces:[[0,1,2],[0,2,3]]
  }},
  ...Array.from({length:100}, (_,i) => ({
    type:'add', kind:'prop', object:{
      id:`panel_${i}`, model:'prop/instance', geometryId:'panel',
      position:{x:(i%10)*1.1,y:0,z:Math.floor(i/10)*1.1},
      color:'#c98236', material:{side:'double'}
    }
  }))
];
const check = await velocut.sceneEdit({
  assetId, expectedRevision:snap.revision, edits, preflight:true
});
if (!check.ok) return check;
return await velocut.sceneEdit({
  assetId, expectedRevision:check.revision, edits, includeSpec:false
});
```

`preflight:true` performs structural validation and budget checks, returns
`ready:false, compiled:false`, and never writes files, creates a renderer or changes
history. Patching or making a resource-backed geometry unique reads its source file.
It is not proof that models load or that the result looks correct. `dryRun:true`
also compiles the candidate. Commit without either flag, then observe actual
frames. Successful preflights/edits return `budget`; failed candidate validation
also returns it when the candidate structure permits reliable counting.
`includeSpec:false` suppresses the full spec in edit replies. Each committed
batch is one undo step; a script containing several batches is not one transaction.

Read compact data through the existing query API (MCP: `velocut_query`):

- `kind:'sceneGeometries',assetId`: paginated `id/name/vertexCount/triangleCount/instanceCount`.
  Includes `storage:'inline'|'resource'`. Opt into `fields:['id','geometry']` for
  legacy inline data or `fields:['id','resource']` for immutable file metadata.
  Use `sceneGeometry` below to read arrays regardless of storage type.
- `kind:'sceneObjects',assetId`: includes `model`, `geometryId` and `materialId` by default. It returns
  authored objects without repeating their referenced geometry.
- `kind:'sceneBudget',assetId`: counts, limits and violations, without GPU work.
  Supports `snapshotId`, but not pagination or field projection.
- `capabilities` includes `sceneLimits`. `sceneAssets` explains the complete edit
  grammar. No new large workflow tool or third-party dependency is needed.

There is no fixed instance-count limit (`limits.instances:null`). Other limits:
200 ordinary props; 64 shared geometries;
100 groups; 128 instance draw batches; 2 million instanced triangles; a separate 16 MiB logical referenced-geometry budget. There is no fixed scene
manifest byte limit (`limits.specBytes:null`). `used.specBytes` estimates the compact manifest;
`documentBytes` reports current JSON bytes, which can be larger for inline input. Each shared geometry has at most 4096
vertices and 8192 triangles. Per-instance colors do not split batches; geometry
or material differences can. Triangle/batch counters describe native instances,
not the full GPU cost of imported GLBs, shadows or procedural primitives.

Current boundaries:

- Physics and bone attachment require conversion with `makeUnique`.
- Instances support visibility, per-axis scale and opacity animation, shared
  curves and individual delays (see Animation channels below). Fully opaque
  instances batch; partially transparent instances use individual draws while
  retaining shared geometry. Transparency uses ordinary object sorting.
- The Director uses logical meshes for precise selection, bounds and gizmos.
  Shared geometry fields state how many instances will change. **Make geometry
  unique** allows independent editing from the same properties panel.
- Static GLB export emits individually named nodes with shared geometry and
  per-instance appearance. It preserves selection and evaluated parent/world
  transforms, but does not export Velocut editing recipes or animation tracks.
- The runtime now externalizes native shared geometry and updates instance/group
  transforms without rebuilding renderers. Other scene edits still compile a
  fresh candidate. This does not yet claim a 10000-instance workload or incremental
  topology/material/physics recompilation.

### Instance increment verification

109 Node/TypeScript tests, 8 MCP tests and all 46 browser tests pass. Independent
tarball installation verifies the public geometry/budget/query/preflight APIs,
alongside the existing production/development SDK render checks. Editor, SDK,
CLI and plugin builds and plugin validation pass.

The browser acceptance fixture builds an original 36-vertex, 68-triangle barrel
tile and places 1000 linked copies. An isolated 640×360 render with shadows off
uses one shared geometry, one draw call and 68000 triangles. This is a rendering
batch check, not a promise about interactive frame rate. The test also verifies
per-object colors, render equivalence with independent meshes, animated objects
under transformed parents, selected GLB export, shared edits, conversion to an independent
mesh, undo/redo, persistence and the compact properties control. This earlier increment rejected the 1001st instance; that count limit has since
been removed. The current test preflights and commits the 1001st instance, then
undoes it successfully.

## Geometry resources and incremental transforms

Shared geometry is now stored as an immutable `.vmesh` file in project storage.
`sceneClip`, `sceneEdit` and `replaceSceneSpec` convert inline `geometries` to
`geometryResources` before committing. Hashes identify exact binary versions;
geometry names stay in the manifest. Identical content reuses a file. Format v1
stores Float64 positions/UVs and Uint32 triangle indices with a validated header,
so source numbers survive exact save/load round trips. Float32 conversion remains
an operation of the renderer, not a destructive source conversion.

The compact manifest has no fixed byte ceiling. Shared geometry has a separate
16 MiB budget per scene; each geometry retains the 4096-vertex/8192-triangle limit.
`sceneBudget` continues reporting manifest and geometry sizes. Large inline JSON
can be used in direct commands and atomic transactions; raw `setAssetSpec` does not
automatically externalize it. Use scene editing APIs when resource-backed geometry
is desired, and use projection/pagination to keep replies convenient to inspect.

Read and edit a small range through SDK/CodeAct or the equivalent MCP tool
`velocut_scene_geometry`:

```js
const page = await velocut.sceneGeometry({
  assetId, geometryId:'tile', attribute:'vertices', offset:4, limit:1
});
if (!page.ok) throw new Error(page.message);
const [x,y,z] = page.items[0];
return await velocut.sceneEdit({
  assetId, expectedRevision:page.revision, includeSpec:false,
  edits:[{type:'geometry.patch', id:'tile', attribute:'vertices',
    updates:[{index:4, value:[x,y+0.01,z]}]}]
});
```

Reads support vertices/faces/uvs, default offset 0 and limit 256, maximum 1024.
They return captured revision, source metadata, items, total and nextOffset.
Patches replace 1..1024 unique existing indices; invalid topology fails atomically.
Inserting/removing vertices or faces still uses `geometry.update` with a complete
replacement definition. A patch creates a new immutable file version; it does not
modify old files or yet patch GPU topology in place.

Instance/group transform-only edits reuse the existing stage, shared GPU geometry,
batches and renderer, while invalidating cached preview frames. Director gizmos
and playback use the updated transforms. Scene edit replies identify the chosen
path as `updateMode:'transforms'|'rebuild'`. Undo/redo and document synchronization
also attempt the transform update path. Changes to hierarchy, geometry, materials,
physics or other scene structure fall back to full compilation before commit.
Raw scene command batches currently retain their full-compile preflight path.

SDK hosts configure project storage with `configureSceneStorage` once per Store.
The adapter must preserve the hash-based filename and source bytes. Direct
scene-sdk consumers supply `SceneResources.geometryBytes(src)`; the SDK verifies
hash, binary structure and manifest counts. `resolveSceneGeometry(spec,id,resources)`
reads either inline or resource-backed geometry. Old inline scenes continue to
load and are externalized on their next runtime scene edit.

Storage/history boundaries:

- History records compact references. Undo restores an earlier reference, and
  reload resolves that exact version from the same project's storage.
- `preflight` writes nothing. `dryRun` compiles using temporary in-memory geometry
  resources and writes nothing; commit the original edit list, not its temporary
  returned manifest.
- Missing, truncated, corrupted or cross-project resources fail explicitly.
  Geometry editing must not fall back to an empty or different mesh.
- Files from old versions, and files prepared for edits that later fail, are
  retained. Garbage collection across history/branches is not implemented; the
  per-scene budget is not a disk-retention quota.
- Project backups/transfer must include the referenced `.vmesh` files. Document
  synchronization alone does not transfer these binary assets to another peer.
- Both `prop/instance` and `prop/mesh` can reference a geometry ID. `makeUnique`
  keeps geometry out of the manifest; old inline meshes remain supported. Geometry
  topology edits still rebuild the stage; only compatible instance/group transforms
  take the incremental path.

### Resource increment verification

115 Node/TypeScript tests, 8 MCP tests and all 48 browser tests pass. New coverage
checks exact binary round trips, hash/header/count validation, project isolation,
source-range reads, atomic index patches and storage failure. A large inline
fixture exceeds 256 KiB and persists as a compact manifest under 1 KiB; identical
definitions reuse one file.

Browser tests also instrument WebGL context requests: eight consecutive instance
moves plus undo/redo create no new preview or Director renderer, while actual
rendered pixel positions change correctly. GPU geometry/batch identities and
source-read counts stay stable under compatible transforms. Geometry edits create
new file versions; undo and reload restore the correct vertices. Independently
installed CLI/MCP/SDK packages pass geometry reads and incremental-transform
checks, alongside the existing development/production render probes. Production
builds and plugin validation pass. These changes are included in 0.0.2.

## Shared materials and independent geometry resources

Props can bind `materialId` to `spec.materials[id]`, whose fields are `name?`,
`color?`, `roughness?`, `metalness?`, `opacity?`, `emissive?`,
`emissiveIntensity?`, and `side?`. Registry colors use #RRGGBB. Local `prop.color`
and defined `prop.material` fields override the shared values; omitted/null fields
inherit. The Director shows resolved numeric/color values, offers **Share this
material**, and distinguishes shared edits from local overrides.

```js
const snap = await velocut.query({kind:'snapshot'});
if (!snap.ok) throw new Error(snap.error.message);
return await velocut.sceneEdit({
  assetId, expectedRevision:snap.revision, includeSpec:false,
  edits:[
    {type:'material.create',id:'glazed',material:{
      color:'#c08b39',roughness:0.38,metalness:0.12,side:'double'
    }},
    {type:'update',id:'tile_0',patch:{materialId:'glazed'},clear:['material','color']},
    {type:'geometry.clone',id:'tile',newId:'special'},
    {type:'update',id:'tile_0',patch:{geometryId:'special'}},
    {type:'geometry.patch',id:'special',attribute:'vertices',
      updates:[{index:0,value:[0,0.02,0]}]}
  ]
});
```

`material.update` replaces a definition; object overrides remain. `material.remove`
rejects a definition still referenced by any prop. `query({kind:'sceneMaterials',
assetId})` returns id/name/objectCount; request `fields:['id','material']` for the
full definition. Scene edit results include `materialIds` and `geometryIds`.
Instance batches are derived from resolved parameters rather than material IDs,
so equivalent definitions can still batch together; per-instance colors stay in
instance attributes. Resolved transparency remains unsupported on instances.

`makeUnique({id,geometryId?})` is the convenience edit for converting an instance
to an ordinary mesh with its own geometry definition. It retains transform,
color, material binding, parent and object ID. It does not detach a shared material.
Unlike the earlier implementation, it no longer copies vertices into the prop.
A geometry clone initially references the same immutable `.vmesh`; a subsequent
patch writes a new version for that definition only. Other definitions and undo
history retain their original references. `sceneGeometries` distinguishes
`instanceCount` from `objectCount`, because ordinary meshes can now reference it.

There is no fixed instance-count limit. Existing limits remain 200 ordinary props,
64 geometry definitions, 128
shared material definitions and 128 instance draw batches. The scene manifest has
no fixed byte ceiling.
Cloned definitions count toward the logical geometry count/byte budgets even
when their immutable files initially deduplicate. Animation curves are shared
scene definitions too; see Animation channels below.

## Animation channels

Animation uses independently editable numeric channels and reusable curves. No
new top-level MCP workflow is required: use `sceneEdit`, `query`, `sceneInspect`
and `observe`, or compose them in CodeAct.

Every group, prop, instance and character supports:

- `visible`: a boolean or `[{t,v:boolean}]` step keys.
- `opacity`: a number or `[{t,v,ease?}]`, constrained to 0..1. This multiplies
  material opacity and ancestor opacity; it does not overwrite a shared material.
- `animation: {timeOffset?, channels?}`. `timeOffset` delays the object's local
  transform/visibility/opacity clock in seconds (negative offsets start early).
- Channel names: `position.x/y/z`, `rotationX/Y/Z`, `scale.x/y/z`, `visible`,
  `opacity`. A channel overrides the matching base field. Values are a number,
  `[{t,v,ease?}]`, or a shared-curve binding. Base `scale` remains a positive
  constant number or `{x?,y?,z?}`; animate scale through `animation.channels`.

`spec.curves` holds `{id: {name?, mode?:'continuous'|'step', keys:[{t,v,ease?}]}}`.
Continuous curves reuse MotionSpec easing: the arriving key's `ease` controls
the segment; omitted easing is linear. Keys hold before the first and after
the last key. Times must be finite, nonnegative and strictly increasing. There
is no configured curve/key count or scene-manifest byte ceiling.

A binding is `{curveId,timeOffset?,timeScale?,valueScale?,valueOffset?}`:

```text
curveTime = (sceneTime - object.animation.timeOffset - binding.timeOffset)
            * binding.timeScale
value = sample(curve, curveTime) * binding.valueScale + binding.valueOffset
```

Offsets default to 0; scales default to 1; `timeScale` must be positive. Channel
bindings override base values, so use `valueOffset` to add a placement baseline.
Visibility channels use numeric 0/1 step values without easing. Shared visibility
bindings require a step curve and cannot use value transforms. Scale channels
allow zero; opacity channels allow 0..1. Invalid key endpoints are rejected;
easing overshoot is clamped to these ranges at sampling time.

Existing atomic edits:

```js
{type:'curve.create', id:'grow', curve:{keys:[{t:0,v:0},{t:0.6,v:1,ease:'power2.out'}]}}
{type:'curve.update', id:'grow', curve:{keys:[{t:0,v:0},{t:1,v:1,ease:'none'}]}}
{type:'curve.remove', id:'grow'}
```

Update replaces the whole definition and validates every referencing object;
remove rejects live references. `curveIds` lists changed definitions, and
`changedIds` lists affected objects. Updates and reference changes can be
combined in one undoable `sceneEdit`. `query({kind:'sceneCurves',assetId})`
returns paginated `id/name/mode/keyCount/objectCount`; add `fields:['id','curve']`
to read keys. A curve referenced by several channels on one object counts once.

For example, given an existing geometry `tile` and material `gold`, an Agent
can combine reveal, growth, drop and fade with its own placement loop:

```js
const snapshot = await velocut.query({kind:'snapshot'});
if (!snapshot.ok) throw Error(JSON.stringify(snapshot));
const edits = [
  {type:'curve.create', id:'grow', curve:{keys:[{t:0,v:0},{t:.6,v:1,ease:'power2.out'}]}},
  {type:'curve.create', id:'drop', curve:{keys:[{t:0,v:3},{t:.6,v:0,ease:'power2.out'}]}},
  {type:'curve.create', id:'show', curve:{mode:'step',keys:[{t:0,v:0},{t:.01,v:1}]}},
  ...Array.from({length:100}, (_,i) => ({
    type:'add', kind:'prop', object:{
      id:`tile_${i}`, model:'prop/instance', geometryId:'tile', materialId:'gold',
      position:{x:(i%10)*.35,z:Math.floor(i/10)*.35},
      animation:{timeOffset:i*.03,channels:{
        'position.y':{curveId:'drop',valueOffset:2},
        'scale.y':{curveId:'grow'},
        opacity:{curveId:'grow',timeScale:2},
        visible:{curveId:'show'},
      }},
    },
  })),
];
const result = await velocut.sceneEdit({assetId,expectedRevision:snapshot.revision,edits,includeSpec:false});
if (!result.ok) throw Error(JSON.stringify(result));
return result;
```

Use a scene duration long enough to include the final delay plus curve duration.
For more than 500 edits, split calls; each call is its own transaction.
`duplicate`, `duplicateMany`, `transform`, `layout` and `sceneArrange` retain
curve references. Position/rotation placement adjusts each binding's value
offset. Scaling multiplies its values. Absolute scaling at a sampled zero must
be done by editing the keys/binding directly, since no scale ratio exists there.

The Director's **Animation** panel edits channels, bindings, shared keys and
object delay in the compact properties view. Bound transform fields display
the curve ID; editing a shared curve updates all its users.

Evaluation and rendering details:

- Parent transforms, visibility and opacity affect descendants, but each
  object samples its own clock; parent delays are not accumulated into children.
- Zero scale, hidden objects and zero opacity stop drawing and picking. They
  are excluded from automatic framing. Explicit focus by ID can still frame
  hidden geometry for editing. `sceneInspect` retains geometric bounds and
  adds `visible` and `opacity` (the inherited object multiplier, excluding base
  material opacity); `quaternion` is null when the world matrix is singular.
- Partially transparent instances retain shared geometry but use separate
  draw calls and per-object materials. They return to opaque batches at alpha 1.
  Fades do not cast opaque shadows; transparency uses Three.js object sorting,
  so intersecting transparent surfaces are not order-independent transparency.
- Group opacity also multiplies descendant light intensity. Lights use their
  existing `intensity` keys instead of a direct opacity channel.
- Object delays do not retime skeletal clips, mannequin pose, morph, camera,
  light-intensity or physics tracks. Physics bodies remain active when hidden.
  Physics props reject transform-channel animation and delayed legacy transform
  keys; existing physics and kinematic grammar remains supported.
- Instance/group visual or channel edits reuse renderers. Registry/geometry/
  material changes still build a fresh candidate. Static GLB exports the sampled
  visible geometry, scale and material alpha; it does not export animation
  tracks. An entirely hidden selection produces an explicit empty-export error.

## Anchors and spatial queries

These are small data operations that an Agent can compose with existing
`transform`, `layout`, geometry and animation edits. They do not create a
building or solve contact. Persistent surface attachments and one-way bindings
are authored separately as described below.

Every object/group may define local anchors:

```js
{type:'anchor.set', id:'column', anchorId:'top',
 anchor:{position:[0,.5,0],normal:[0,1,0],tangent:[1,0,0]}}
{type:'anchor.remove', id:'column', anchorId:'top'}
```

`anchor.set` upserts one entry in `object.anchors`; `anchor.remove` rejects a
missing entry. Anchors also support an optional `name`. Coordinates are before
the object's scale, rotation and translation: on a centered unit cube scaled
to a 3 m column, local `[0,.5,0]` follows the column top. Normal defaults to +Y;
tangent defaults to +X, or +Z when the normal is parallel to +X. Explicit
directions must be nonzero and independent. Anchors copy with their objects
and persist through history. The compact Director **Anchors** panel edits the
same data. Anchor-only edits reuse the existing stage/renderers.

`sceneSpatial({assetId,timeS?,expectedRevision?,queries:[...]})` evaluates a
batch of independent numerical queries against one captured scene and time.
It returns `{ok,assetId,revision,timeS,results}` without a full spec or document
changes. The runtime builds a CPU stage, with no additional WebGL renderer or
retained query-stage cache. Pure SDK consumers can call
`queryStageSpatial(stage, queries)` after `stage.poseAt(timeS)`.

The MCP tool is `velocut_scene_spatial`; CodeAct uses `velocut.sceneSpatial`.
`capabilities({name:'sceneSpatial'})` exposes the full input schema.

| Query | Required fields | Optional fields / result |
|---|---|---|
| `anchors` | `objectId` | `anchorIds`, `status:valid|invalid`; returns evaluated anchor `items` |
| `anchorRepair` | `objectId`, `anchorId`, `method:face|raycast` | Explicit `ray` for raycast; read-only candidate and proposed edit |
| `raycast` | `origin`, `direction` | `objectIds`, `maxDistance`, `includeHidden`; nearest `hit` or null |
| `surface` | `objectId`, `triangleIndex`, `barycentric` | `meshPath` defaults to `[]`; returns `surface` |
| `distance` | `from`, `to` | World points, delta and distance in meters |
| `angle` | `a`, `vertex`, `b` | Angle at vertex, 0..180 degrees; zero-length arms fail |

Vectors are `[x,y,z]`. Measurement points are `{position:[x,y,z]}` in world
space, `{objectId,position:[x,y,z]}` in object-local space, or
`{objectId,anchorId}`. Normal and tangent are returned normalized and
orthogonal; the supplied tangent is projected into the local anchor plane
before transformation. `bitangent = normal × tangent`. Normal transformation uses the
inverse transpose, including nonuniform parent scales.

Ray scopes include descendants of the selected object/group IDs. Internal
instance batches are excluded; hits identify editable logical objects.
Geometry is tested from both sides, independently of material culling or
texture alpha. Hidden objects are skipped unless `includeHidden:true`.
Queries sample current triangle vertices, including skin and morph deformation.
The surface normal follows the world triangle's winding, rather than its
interpolated shading normal. This is geometric measurement, not pixel picking.

Hit/surface data includes `objectId`, `meshPath` (child indices from that object
root), `triangleIndex`, `vertexIndices`, `barycentric`, world position/frame,
interpolated UV coordinates and `local`, a reusable object-local anchor
definition. Barycentric weights must be 0..1 and sum to 1. A collapsed frame
has `frameValid:false` and null directions. `local:null` means the object's
world matrix cannot be inverted; do not guess an anchor from that result.

For example, attach an editable anchor to a sampled roof point:

```js
const result = await velocut.sceneSpatial({assetId,timeS:2,queries:[
  {type:'raycast',origin:[0,20,0],direction:[0,-1,0],objectIds:['roof']},
]});
if (!result.ok) throw Error(result.message);
const hit = result.results[0].hit;
if (!hit?.local || !hit.frameValid) throw Error('No usable roof surface');
const edited = await velocut.sceneEdit({assetId,expectedRevision:result.revision,
  includeSpec:false,edits:[
    {type:'anchor.set',id:hit.objectId,anchorId:'seat',anchor:hit.local},
  ]});
if (!edited.ok) throw Error(edited.message);
return await velocut.sceneSpatial({assetId,timeS:2,expectedRevision:edited.revision,
  queries:[{type:'distance',from:{objectId:hit.objectId,anchorId:'seat'},
    to:{objectId:'tile',anchorId:'bottom'}}]});
```

Agents can calculate an offset from the returned world normal and submit an
ordinary transform edit. Object-local anchors follow object transforms and
animation; they do not follow subsequent vertex edits or bone deformation
inside the object. Resample and update the anchor when the geometry changes.
`meshPath` and triangle indices are revision-scoped handles: pass the returned
`revision` as `expectedRevision` when reusing them, and resample after topology
changes. The result's revision identifies the captured document even if a
concurrent edit happens while geometry is loading.

### Live surface anchors and persistent bindings

For a fixed local point, store `hit.local` as before. To follow a mesh, store
`hit.surfaceAnchor` instead:

```js
const sampled = await velocut.sceneSpatial({assetId,timeS:3,queries:[
  {type:'raycast',origin:[0,10,0],direction:[0,-1,0],objectIds:['roof']},
]});
if (!sampled.ok) throw Error(sampled.message);
const hit = sampled.results[0].hit;
if (!hit?.surfaceAnchor) throw Error('No attachable surface');
const result = await velocut.sceneEdit({assetId,expectedRevision:sampled.revision,
  includeSpec:false,edits:[
    {type:'anchor.set',id:'roof',anchorId:'seat',
     anchor:{...hit.surfaceAnchor,tangent:[0,0,1]}},
    {type:'anchor.set',id:'tile',anchorId:'bottom',
     anchor:{position:[0,0,0],normal:[0,1,0],tangent:[0,0,1]}},
    {type:'binding.create',id:'tile_position',binding:{
      type:'position',source:{objectId:'roof',anchorId:'seat'},
      target:{objectId:'tile',anchorId:'bottom'},
      offset:[0,0,.002],offsetSpace:'source',motion:{referenceTimeS:3},
    }},
    {type:'binding.create',id:'tile_orientation',binding:{
      type:'orientation',source:{objectId:'roof',anchorId:'seat'},
      target:{objectId:'tile',anchorId:'bottom'},twist:0,
    }},
  ]});
if (!result.ok) throw Error(result.message);
return result;
```

The example assumes `roof` and `tile` already exist. Use the sampled
`hit.objectId` when the mesh owner differs from the requested group. Source-space
offset axes are **tangent, bitangent, normal**, measured in meters; `.002` on Z
places the target anchor 2 mm along the surface normal. Optional surface-anchor
`tangent` is a heading in the owner's local coordinates, projected onto the
current surface. It keeps rows consistently oriented instead of following
different triangle edges. If omitted, the triangle's edge supplies the tangent.

A live anchor has this shape:

```ts
{kind:'surface', name?, tangent?, surface:{
  sourceKey, topologyKey, meshPath, triangleIndex, barycentric,
  geometryKey?, vertexIndices?
}}
```

Use keys returned by the query. Source identity and whole-topology checks remain
in place. New native references also carry the immutable geometry content hash
(`geometryKey`) and an ordered three-vertex witness (`vertexIndices`). Verified
`geometry.patch` operations advance the whole-mesh proofs while retaining that
witness. Vertex deformation keeps attachments live; changing a referenced face's
ordered indices invalidates that face's anchors. Unrelated face patches leave
other attachments valid. Digests are prepared outside the animation loop.

Native `geometry.update`, raw geometry replacement and vertex reindexing do not
advance these proofs. Changed native geometry bytes invalidate their references,
even if index numbers were reused. Byte-identical replacements and `makeUnique`
can retain attachments. Imported GLB source changes remain strict; skin/morph and
node animation continue to be sampled. This is not semantic part matching.
Surface references cannot cross another authored object's root: attach to the
logical mesh owner returned by raycast.

`sceneSpatial` anchor results identify `kind` and `status`. An invalid surface
or failed binding dependency returns `status:'invalid'`, `position:null` and a
message. Distance/angle queries reject invalid anchor inputs, so two obsolete
anchors cannot silently report a successful zero gap. A collapsed but
topologically valid surface can still supply a point with `frameValid:false`;
its orientation is unavailable. Repair an attachment with a fresh
`hit.surfaceAnchor` and `anchor.set`; dependents recover on the next evaluation.
Local anchors retain their original fixed-point semantics.

Bindings live in `spec.bindings` and use the existing atomic edit API:

```js
{type:'binding.create',id,binding}  // must not already exist
{type:'binding.update',id,binding} // replace the whole definition
{type:'binding.remove',id}
```

Every definition has `type`, `source:{objectId,anchorId}`,
`target:{objectId,anchorId}`, optional `name`, `enabled` and
`motion:{referenceTimeS}`. Position bindings optionally add `offset:[x,y,z]`
and `offsetSpace:'world'|'source'` (default world). Orientation bindings align
the anchor frames and optionally add `twist` degrees around the source normal.
Targets use local anchors on non-physics props, lights or groups without
characters. Character surfaces may be sources. Character targets and groups
containing characters are excluded from this rigid pass, which runs after
skeletal animation and gaze. No binding-count ceiling is configured.

There is one active writer per position/orientation channel per target. Cycles,
including cycles through parenting, and missing references are rejected before
commit. Orientation solves before position, making the target anchor the pivot.
Nonuniform parent transforms and target scales are accounted for. Every pose
starts from authored data and evaluates the dependency graph once; seeking
backward does not accumulate previous results or rewrite document transforms.

Authored animation on a controlled channel requires explicit
`motion.referenceTimeS`, within the scene duration:

- Position adds `authoredPosition(t) - authoredPosition(referenceTimeS)` in the
  target parent's coordinates to the solved position.
- Orientation postmultiplies the solved rotation by
  `inverse(authoredRotation(referenceTimeS)) * authoredRotation(t)`.
- Scale, visibility and opacity keep their existing authored behavior.

Thus a falling-tile curve remains a reusable displacement from its new seat.
Source changes do not overwrite the curve or its delay. `sceneEdit` direct
position/rotation updates, transforms and layouts reject writes to active
controlled fields. Use binding offset/twist, edit motion channels/curves, or
disable/remove the binding first. Disabling restores the current authored pose;
it does not bake the last derived pose into the document. The Director displays
controlled fields as bindings and provides an editable **Bindings** panel.

Query `sceneBindings` for paginated definitions (default
`id/name/type/source/target/enabled`; opt into `binding` for all fields).
`sceneSpatial` query `{type:'bindings',ids?}` returns evaluated
`valid/disabled/invalid/suspended` states at `timeS`. `sceneInspect` includes
target binding states and `bindingValid`. Edit receipts include `bindingIds`
and affected driven objects in `changedIds`.

Failures restore that object's deterministic authored pose in the Director,
invalidate downstream dependencies and show diagnostics. Zero-scale orientation
frames suspend the binding until the frame is usable again. Shot rendering,
capture and GLB export reject visible failed bindings in their export scope;
hidden collapsed objects can be omitted. The Director remains available for
repair and highlights invalid dependencies. No last-good matrix is reused.

Copies clone bindings targeting the copied subtree and remap internal sources;
external sources remain explicit links. `copies.bindingIdMap` gives the new
binding IDs. Copying a controlled root with a position/rotation transform is
rejected; copy first, then edit or detach its cloned binding. Cascading object
removal clears bindings referencing removed objects. Removing a referenced
anchor requires removing its bindings too.

These relationships maintain points and frames. They do not certify solid
contact, penetration depth, tenon fit, wall thickness or tile overlap, and they
do not implement a general nonlinear constraint solver or arbitrary parameter
expression graph.

### Local invalidation and repair workflow

Known patches keep vertex and face **slots** stable. They may update coordinates,
UVs or existing face entries, but cannot insert/remove/reindex slots. The SDK
verifies each affected geometry's exact pre-patch content and topology before
advancing any reference. The stored ordered face witness is never silently
changed. A previously failed face remains failed through unrelated patches;
restoring its original ordered indices can restore it. Use full replacement for
renumbering, rather than disguising a remap as coordinate patches.

Legacy references without content keys/witnesses retain whole-topology checks.
A known patch upgrades a legacy reference only after an exact topology match;
it does not blindly repair already-mismatched references. An explicit face
preview can upgrade a currently valid legacy reference. Raw full-spec geometry
replacement with unchanged unversioned legacy references is rejected until they
are upgraded. The `geometry.update` edit pins legacy references to the old native
geometry version, allowing the replacement to commit with explicit invalid
attachments rather than falsely accepting reused indices.

The workflow has separate read and write primitives:

```js
const state = await velocut.sceneSpatial({assetId,timeS:20,queries:[
  {type:'anchors',objectId:'roof',status:'invalid'},
]});
if (!state.ok) throw Error(state.message);
const ids = state.results[0].items.filter(a=>a.kind==='surface').map(a=>a.anchorId);
if (!ids.length) return {repaired:0};
const preview = await velocut.sceneSpatial({assetId,timeS:20,
  expectedRevision:state.revision,
  queries:ids.map(anchorId=>({type:'anchorRepair',objectId:'roof',anchorId,method:'face'})),
});
if (!preview.ok) throw Error(preview.message);
return preview; // Inspect candidates before choosing edits to commit.
```

`method:'face'` checks source, full geometry version and whole topology, then
requires the current face to contain the same three original vertex IDs. It
reorders barycentric weights by vertex identity, preserving the reference point
when winding/order changes. It does not infer a new face after reindexing or
connectivity replacement. `method:'raycast'` instead requires an explicit
`ray:{origin,direction,maxDistance?,includeHidden?}`. Its hit must belong to the
same object; it never moves an anchor or binding onto an arbitrary neighbor.
Upstream invalid bindings must be repaired before sampling a dependent object.

A result has `status:'candidate'` and `candidate`, or `status:'unavailable'` with
an explanation. The candidate includes its proposed anchor, world point/frame,
`windingReversed`, `orientationChanged`, and an `edit`. A cyclic face permutation
can preserve the normal but change the default edge tangent, so it still needs
orientation review. With an explicit stable tangent, an unchanged frame need
not be flagged. For ray repairs the old frame comparison can be unknown (null).
These diagnostics describe the proposed frame, not solid contact or fit.

After choosing candidates:

```js
const edits = selectedCandidates.map(c=>c.edit);
const check = await velocut.sceneEdit({assetId,expectedRevision:preview.revision,
  edits,preflight:true,includeSpec:false});
if (!check.ok) throw Error(check.message);
return await velocut.sceneEdit({assetId,expectedRevision:preview.revision,
  edits,includeSpec:false});
```

The edit is `{type:'anchor.rebind',id,anchorId,expected,surface}`. It compares the
old `SurfaceReference` and replaces only `anchor.surface`. Current names and
tangent overrides, binding IDs/offsets, materials and animations remain intact.
Runtime commits require the preview's `expectedRevision` and validate candidate
references against the **final batch geometry**, including during preflight.
Any stale or invalid candidate rejects the whole batch. Pure SDK callers can
supply verified resource geometry via the existing `GeometryDataRequired` replay
mechanism. Imports/procedural meshes additionally need runtime stage validation.

The compact Anchors panel offers invalid/all-surface scope, paginated previews,
frame values and selection before commit. Orientation-changing candidates are
not preselected. The all-surface scope can explicitly upgrade valid old
references. The existing 500-edit transaction limit applies; pagination limits
only the displayed rows, not scene capacity. Unavailable repairs require an
explicit resample. Undo/redo and reload preserve both the repair and its proofs.

No new scene, anchor or instance count/byte cap is introduced. Native geometry
files keep the existing format. Pure synchronous edit hashing uses the MIT
[@noble/hashes SHA-256 implementation](https://github.com/paulmillr/noble-hashes);
resource and renderer checks remain compatible with WebCrypto SHA-256.

### Collision shapes and compound bodies

`physics.colliders` is a registry on each physics prop. Every entry belongs to
the **same rigid body**, so a compound shape moves as one object. Omitting the
registry supplies `default:{shape:'auto'}`; an explicit empty registry disables
collision. Body mass is distributed among its colliders by volume; a dynamic
body without colliders defaults to 1 kg unless `physics.mass` is specified.

Automatic cubes, uniform spheres, circular pillars and cones keep analytic
shapes. Other **fixed/kinematic** props now use triangle meshes, preserving
holes and recesses. Other dynamic props retain convex hulls and return a warning
that cavities may be filled. To retain an older static hull approximation,
select `convexHull` explicitly. Dynamic triangle meshes are rejected: use convex
parts attached to one body. These choices follow [Rapier's collider guidance](https://rapier.rs/docs/user_guides/javascript/colliders/).

Supported definitions:

```ts
{shape:'auto', name?}
{shape:'box', halfExtents:[x,y,z], position?, rotation?, name?}
{shape:'sphere', radius, position?, rotation?, name?}
{shape:'mesh'|'convexHull', geometryId?, position?, rotation?, name?}
```

Positions and sizes use object-local meters before object scale; rotation is XYZ
Euler degrees. An explicit sphere requires uniform object scale. Rotated boxes
under nonuniform scale use an exact convex hull to retain the resulting shear.
For mesh/hull shapes, omit `geometryId` to use the visual mesh or supply a native
geometry registry ID. Collision-only geometry references are counted, protected
from deletion and follow native geometry edits, including immutable resources.
Auto shapes take no custom pose; choose an explicit shape to supply one.

```js
// Replace the implicit collider with independent parts on one body.
const result = await velocut.sceneEdit({assetId,expectedRevision,edits:[
  {type:'collider.remove',id:'beam',colliderId:'default'},
  {type:'collider.create',id:'beam',colliderId:'left',collider:{
    shape:'box',halfExtents:[.25,.1,1],position:[-.75,0,0],
  }},
  {type:'collider.create',id:'beam',colliderId:'right',collider:{
    shape:'box',halfExtents:[.25,.1,1],position:[.75,0,0],
  }},
],includeSpec:false});
if (!result.ok) throw Error(result.message);
```

`collider.create/update` require `{id,colliderId,collider}`; `update` replaces one
definition. `collider.remove` requires `{id,colliderId}`. `collider.reset` requires
`{id}` and restores the implicit automatic shape. Physics must first be enabled
with the ordinary object update primitive. First edits materialize the implicit
`default`, so adding a part does not silently remove an existing collider.
All operations support ordinary atomic commit, revision checks, undo and redo.

Read-only queries share the scene's captured revision and sampled time:

```js
await velocut.sceneSpatial({assetId,timeS:2,queries:[
  {type:'colliders',objectIds:['beam'],offset:0,limit:50},
  {type:'colliderGeometry',objectId:'beam',colliderId:'left',space:'world',offset:0,limit:256},
]});
await velocut.directorSession({assetId,objectId:'beam',colliderView:'selected'});
```

`colliders` returns actual effective shape, vertex/triangle counts (zero for
analytic primitives), collider mass and warnings, with body mass/count summaries.
`colliderGeometry` returns Rapier debug line segments `[ax,ay,az,bx,by,bz]`,
`total`, and `nextOffset`; it does not return visual mesh triangles. `space`
defaults to world; local segments already include object scale. Both queries
page at 256 by default, with at most 1024 items per response and no new scene
capacity limit. Unknown object/collider IDs fail explicitly.

Director `colliderView:'off'|'selected'|'all'` controls inspection wireframes
without document edits. They follow sampled body poses, are hidden in shot view,
and are disposed on disable/rebuild. Inspection geometry is generated on demand;
no physics world or per-frame collision-mesh history is retained. The compact
Physics & colliders panel edits body settings, individual shapes and transforms,
and reads effective collision descriptions.

Visual raycasts still inspect rendered geometry. A triangle mesh describes a
boundary and has no solid interior. Collision queries do not provide contact
forces, automatic convex decomposition, or structural strength verification.
Physical connections use the separate joint primitives below. The deterministic
physics bake and its existing duration behavior remain in effect.

### Physical joints

`SceneSpec.joints` is a registry of connections between **two independent physics
props**. `joint.create` and `joint.update` take `{id,joint}`; update replaces one
definition. `joint.remove` takes `{id}`. Edits validate and commit atomically,
support preflight, revision checks, undo/redo and save/reload, and return `jointIds`.
They create Rapier impulse joints during the physics bake, not animation bindings.

Every definition has `{type,a,b,name?,enabled?,contactsEnabled?}`. Each endpoint
is `{objectId,position:[x,y,z]}` or `{objectId,anchorId}`. Points use object-local
meters **before object scale**. Named anchors must be local anchors; only their
position is used, not their normal/tangent. Both bodies must have physics enabled
and have different IDs. An enabled joint needs at least one dynamic body; fixed
and kinematic bodies can connect to dynamic bodies. `enabled` defaults true.
`contactsEnabled` defaults false between the two connected bodies; set it true
when their colliders should also interact.

| Type | Additional fields | Meaning |
| --- | --- | --- |
| `fixed` | `rotationA?`, `rotationB?` | Local XYZ reference rotations in degrees; default identity. Locks all relative motion. |
| `spherical` | None | Connects the two points, permits relative rotation. |
| `revolute` | `axis`, `limits?`, `motor?` | One free angular coordinate, in degrees. |
| `prismatic` | `axis`, `limits?`, `motor?` | One free translational coordinate, in meters. |
| `rope` | `length` | Maximum anchor distance in meters; allows slack. |
| `spring` | `length`, `stiffness`, `damping` | Rest length in meters, positive stiffness and nonnegative damping; stretches under load. |
| `generic` | `axis`, `lockedAxes` | Lock any subset of `x,y,z,rotationX,rotationY,rotationZ`; an empty array leaves all free. |

`axis` is a finite, nonzero direction normalized by the SDK. The public Rapier
JavaScript constructor applies this **same local direction to both bodies**;
independent hinge/slider axes are not exposed here. Axes/reference rotations do
not inherit object scale. Generic axis names refer to the joint's frame, whose
X direction follows `axis`. Queries return the actual solver reference frames.
Fixed joints support independent `rotationA`/`rotationB` frames. Initial point or
frame mismatches may move bodies when the solver starts: creation does not infer
an offset, snap geometry, or preserve an arbitrary initial relative pose.

Hinge/slider `limits:[min,max]` must be finite and ordered. Hinge limits and
position targets use the signed `-180..180` degree coordinate; sliders use meters.
Motors accept one of:

```ts
{mode:'position',targetPosition,stiffness,damping,model?:'force'|'acceleration'}
{mode:'velocity',targetVelocity,damping,model?:'force'|'acceleration'}
```

Position targets must fall inside configured limits. Velocity uses degrees/s for
hinges and m/s for sliders; use it for continuous turns. Stiffness/damping are the
native Rapier coefficients, with angular controllers operating internally in
radians. The default model is force-based. Settings are constant within a scene;
this version does not add time-keyed motors, force thresholds or break events.

```js
// Both bodies and their local "hinge" anchors already exist.
const state = await velocut.query({kind:'sceneJoints',assetId});
if (!state.ok) throw Error(state.error.message);
const edit = {type:'joint.create',id:'beam_hinge',joint:{
  type:'revolute',
  a:{objectId:'column',anchorId:'hinge'},
  b:{objectId:'beam',anchorId:'hinge'},
  axis:[0,0,1],limits:[-60,60],
  motor:{mode:'position',targetPosition:45,stiffness:100,damping:20},
}};
const result = await velocut.sceneEdit({assetId,expectedRevision:state.revision,
  edits:[edit],includeSpec:false});
if (!result.ok) throw Error(result.message);
return await velocut.sceneSpatial({assetId,timeS:2,expectedRevision:result.revision,
  queries:[{type:'joints',ids:['beam_hinge']}]});
```

`query({kind:'sceneJoints',assetId,fields:['id','joint']})` returns paginated
definitions without running physics. `sceneSpatial` query
`{type:'joints',ids?,objectIds?,offset?,limit?}` reads sampled results, including:

- `engine`: actual Rapier version and impulse-solver identity (null without physics).
- Configured `enabled`/`disabled` status, endpoint identities and world positions.
- World `frameA/frameB` quaternions `[x,y,z,w]` and applicable joint `axisA/axisB`.
- `anchorDistanceM` and translation expressed in frame A.
- `coordinate/unit`: signed hinge angle, slider translation, or spring/rope distance.
- `linearErrorM`, `angularErrorDeg`, `limitError`, and spring `extensionM` where applicable; otherwise null.

The point distance is **not an error for every joint**: a slider may separate
along its free axis, a rope may be slack, and a spring may extend. Generic angular
residuals are not reported as a scalar; inspect the returned frames. These values
describe the sampled pose, not contact forces, bearing capacity, or structural
safety. Unknown joint/body filters fail explicitly. Spatial pages default to 256
and allow 1..1024 items per response; there is no new joint-count cap.

Joint graphs may contain loops. Redundant/conflicting constraints can leave
residual errors; configured `enabled` does not claim that every constraint has
converged. Non-finite simulation poses reject compilation. The existing 60 Hz
physics bake and 120-second bake ceiling still apply. Active motors prevent the
resting-world early exit. No solver world or per-joint frame history is retained;
queries derive measurements from sampled body transforms and compact setup data.
Development prebundling resolves Rapier through the Scene SDK to avoid selecting
a different transitive version; browser tests verify the actual solver version.

Integrity and composition rules:

- Removing a connected object requires `cascade:true` or removing its joints in
  the same edit batch. Cascade removes the connected joints.
- Referenced local anchors and body physics cannot be removed while their joint
  remains, including disabled joints. Editing a referenced anchor position rebakes physics.
- Copying both endpoints clones internal joints and returns `copies[].jointIdMap`.
  Copying only one endpoint omits the external connection and reports
  `copies[].omittedJointIds`; it does not attach the copy back to the original body.
- `changedIds` includes connected bodies through the enabled joint graph.

The compact Director has a structured joint draft/editor, endpoint/axis controls,
limits, motor settings, enable/remove actions and an explicit inspection button.
`directorSession({jointView:'off'|'selected'|'all'})` toggles guides without document
changes. Guides follow the sampled bodies, are hidden in shot view and disposed
when disabled or rebuilt. Static GLB export continues to bake the sampled pose;
it does not export an executable physics joint graph.

### Assembly regeneration and development consistency

Updating an `assembly` now merges the old recipe, current edited parts and new
recipe. Values still equal to old generated defaults follow new parameters;
differing values survive. Transform object fields merge per axis; arrays of
keyframes remain whole. Names, shared material bindings, visibility, opacity,
animation, anchors and custom geometry fields are preserved when customized.
Custom children remain, and manually deleted generated parts stay deleted while
they occur in the old recipe. Parts removed by a new recipe are removed.

This is a value-based merge, not persistent override provenance: if an edited
value equals the old generated default, it follows the recipe again. General parameter expressions and explicit override provenance remain separate
work. Active pose bindings keep their controlled base fields unchanged during
recipe regeneration; scale and other unbound recipe fields still update.

The repository editor now resolves the scene SDK package root directly to its
source entry, alongside the other live workspace SDKs. Its UI and runtime no
longer mix current TypeScript exports with a stale scene SDK `dist`. Package
asset subpaths retain their ordinary export resolution. Release packages still
ship built JavaScript and types; independent tarball installation tests that
path separately.

## Compact history storage

History snapshots remain full ordinary documents in the runtime. The tree interns
identical immutable asset/command spec strings, and releases unused pool entries
when nodes are pruned or rebased. Commands are copied before retention so caller
mutation cannot rewrite history.

`HistoryTree.serializeCompact()` stores each distinct spec once in a table and
references it from snapshot assets and asset/spec commands. Its independent
`historyEncoding:'spec-table-v1'` marker does not change document format versions.
The decoder accepts legacy history, validates table references and rejects unknown
encodings. The public `serialize()` method remains compatible with full-document
consumers. All branches, IDs, commands and snapshot values survive round trips.

Studio reads the compact IndexedDB key first and writes new history there. An
existing legacy key is kept as a recovery/downgrade copy and is not updated with
new edits. Thus the new active payload shrinks, while old disk bytes may remain
until explicitly cleaned up or the project is deleted. This is not yet general
checkpoint/delta history or resource garbage collection.

### Sharing increment verification

122 Node/TypeScript tests and 8 MCP tests pass. The 50-test browser suite passes;
after adding the compact material-panel test and stale-edit protection, all 18
related browser tests pass again (51 distinct browser cases total). The checks
include reference cloning, clone/makeUnique followed by index patches in one
transaction, shared material overrides, exact rendered appearance and GLB material
parity, persistence, compact-history restoration and branch-preserving codec
round trips. Installed npm packages pass shared-material and compact-history
checks in addition to existing standalone SDK/CLI/plugin validation.

The detailed tile fixture uses the real evaluation's 594-vertex/1184-triangle
shell and 1000 independently timed placements. The projected manifest falls from
272,708 to 211,799 bytes without changing the material parameters. Making one
geometry independent brings it to 212,018 bytes: an increase of 219 bytes instead
of putting the 28 KiB mesh back inline.

The original Yellow Crane project's 119-node history round-trips unchanged:
34,996,027 legacy bytes become 3,418,973 compact bytes with 7 unique specs. In the
same isolated-browser memory protocol, loaded/after-reload JS heap is about
14.5 MiB versus the earlier 72.3 MiB. This reduction is in the page's JS heap,
not an equivalent percentage reduction of GPU or total browser memory. Existing
legacy disk data remains a recovery copy. No package has been published by this
increment.

### Instance-count policy

The fixed 1000-instance ceiling has been removed from validation and budget
preflight. `limits.instances:null` means no configured count ceiling;
`used.instances` still reports the actual count. The former combined props-array
length check has also been removed so it cannot reintroduce the same ceiling.
Per-call edit/copy sizes, geometry validity and separate geometry/render-budget
checks remain. The scene manifest byte ceiling has also been removed. More than 1000 instances can be authored across ordinary
batches; this is not a claim that every scene size fits all remaining budgets.

### Scene-text byte policy

The former 256 KiB procedural-spec/scene-manifest ceiling is removed from the
protocol schema, Rust and TypeScript engines, scene preflight and scene editing.
The runtime also removes its JSON request/response byte gates and source-document
byte gate, so another runtime byte ceiling cannot block a large spec during
query, snapshot or transaction. Discovery returns null for these unset limits.
Byte counters remain available; JSON syntax, schemas, references and geometry
validity are still checked. Transport implementations and file/resource APIs
retain their independent behavior and limits.

The shared golden vector generates large Unicode and ASCII JSON in both engines
and checks create, replace, undo/redo, reload and invalid-JSON rejection. Runtime
tests exercise a 9 MiB spec through transaction and snapshot/query. Browser
coverage creates the previously oversized inline-material tile scene through
MCP, reads its full spec, edits it through an atomic transaction, and verifies
persistence after reload. Shared materials remain an optimization, not a
requirement for this formerly oversized case. Rebuild the local WASM artifacts
when updating an existing source checkout.

Verification: 124 Node/TypeScript tests, 8 MCP tests, Rust golden vectors and
strict Clippy pass. Eight relevant browser tests pass, including the oversized
scene round trip. WASM and production packages rebuild successfully; separately
installed npm packages accept and return a 400,000-character spec. Plugin
validation also passes. This source change has not been published to npm.

## Timeline video generation

Generation is split between undoable document commands and persistent external
jobs. These additions are in source and local builds, not the published 0.0.1.
The document format is now **4**; versions 1/2/3 migrate forward. Older writers
must reject format 4 rather than silently discard generation slots.

| Operation | Responsibility |
| --- | --- |
| `addGenerationSlot`, `updateGenerationSlot`, `removeGenerationSlot` | Edit target track/range, prompt and input parameters; no network |
| `query({kind:'generationSlots'})` | Snapshot-aware IDs, placement, intent version and adopted clip/candidate |
| `generation({action:'capabilities'})` | Configured channel/model metadata and optional supported durations, ratios, resolutions, image/audio inputs; no keys/URLs |
| `generation({action:'plan',slotId})` | Validate inputs; report timeline duration, required source duration (including clip speed), chosen provider duration |
| `captureReference` / `references` | Save/list immutable project-bound first-frame snapshots |
| `submit` / `get` / `list` / `cancel` / `resume` | Manage persistent provider jobs independently of edits |
| `registerResult` | Register an already downloaded candidate as a video asset |
| `adopt` | Register and resolve/replace the slot in one undoable batch |
| `resolveGenerationSlot` / `replaceClipSource` | Pure core commands for placement or stable-identity source replacement |

`generation()` returns `{ok:true,...actionResult}` or `{ok:false,message}`;
`plan` adds `request,targetDurationUs,requiredSourceDurationS,providerDurationS`,
`submit/get/cancel/resume` return `job`, and `list/references` return
`items,total,nextOffset` (offset/limit pagination). An empty channel/model/prompt
is legal in a draft slot, but cannot be submitted. `capabilitiesKnown` means a
model has configured capability metadata; absent duration constraints cannot
prove that a provider accepts arbitrary lengths. Providers remain authoritative.

```js
// Choose a channel/model from generation({action:'capabilities'}).
const snap = await velocut.query({kind:'snapshot'});
if (!snap.ok) throw Error(snap.error.message);
const created = await velocut.transaction({
  action:'commit', runtimeId:snap.runtimeId, expectedRevision:snap.revision,
  requestId:'create-shot-001', operations:[
    {id:'track',command:velocut.ops.addTrack({kind:'video',name:'Generated'})},
    {id:'slot',command:velocut.ops.addGenerationSlot({
      trackId:velocut.ref('track','trackId'), startUs:2000000, durationUs:6000000,
      request:{channel:'my-channel',model:'my-model',prompt:'A slow push over a lake',ratio:'16:9'}
    })}
  ]
});
if (!created.ok) throw Error(created.error.message);
const slotId = created.data.results.slot.slotId;
const plan = await velocut.generation({action:'plan',slotId});
if (!plan.ok) throw Error(plan.message);
// This separate operation uses provider credits; reuse this requestId on retry.
return await velocut.generation({action:'submit',slotId,
  intentVersion:plan.intentVersion,requestId:'generate-shot-001-take-1'});
```

`captureReference` requires `expectedRevision` and `source:{kind:'timeline',timeUs,
clipId?}` or `source:{kind:'asset',assetId}`. Timeline capture is composite by
default; clipId isolates that visible clip. Imported image assets must be in
project storage. Capture saves a PNG and provenance locally and returns
`reference`; put its ID in `request.firstFrameReferenceId`. Only submission
uploads it through configured storage. No remote reference URL is accepted.

`submit` returns immediately with a durable, immutable request and job ID. The
requestId is project-scoped and persistent; repeating it returns the same job,
including after undo/reload. Changed slot/version with that ID conflicts. New
candidates require a new requestId. A receipt is saved as soon as submission
returns. Reload resumes polling/downloading, never a POST without certainty.
`submission_unknown` means the previous POST may have succeeded without a saved
receipt; it cannot be resumed as a new submission. Investigate the provider
before deliberately creating a new paid request. A failed download or interrupted
poll can resume using the existing receipt. `cancel` stops local tracking only.
A queued job cancelled before submission can be resumed into the queue.

The job service uses a project runner (two concurrent jobs by default) and a
durable journal, outside document/history. Closing Studio pauses processing;
reopening that project resumes work. Moving/deleting a slot, undoing an edit or
switching projects never redirects a result into another project. The service
supports same-origin, same-browser tab coordination; it is not a remote worker
or cross-device queue. Changing a job's channel endpoint/key blocks tracking
until the original configuration is restored. Reference/result files and the
journal stay local to the browser; document JSON alone is not a portable backup
of their bytes or execution records.

After `get` reports a downloaded result, `registerResult` takes
`{jobId,expectedRevision}`. `adopt` additionally takes `{slotId,intentVersion}`.
Adoption checks the **current** slot position and revision; it does not reuse the
position captured at submission. A later prompt/input/duration edit changes the
intent version and rejects old candidates unless `acceptEarlierIntent:true` is
explicit. Pure moves do not change it. Overlap/locked-track/deleted-slot failures
leave both document and history unchanged. Candidates remain accessible in jobs.

Default adoption trims a long result to the target, preserving the full original
asset. A short result fails; `fit:'sourceDuration'` explicitly changes the timeline
length to its available duration at the clip's current speed. There is no silent
slowdown or loop. Subsequent candidates replace the **same clip ID** while keeping
transforms, effects, keyframes, volume and speed. `replaceClipSource` has the same
preservation rule; its default sourceInUs is zero. Removing a generation intent
keeps any adopted clip. Removing its clip removes that attached intent.

Unresolved active slots appear as `FrameGraph.pendingGenerationIds`; export of
such frames fails with a clear message. Adopt a result, remove the intent, or
mute its track before exporting that range. Muted/out-of-range slots do not
block export. Preview shows an unresolved-generation badge.

`@velocut/runtime` exposes `configureGeneration(store, adapter)` and
`generation(store, input)`. Hosts provide durable journal/file storage, channel
binding, provider submit/poll, capture/probe and cross-runtime locking through
`GenerationAdapter`. The browser implementation uses IndexedDB, OPFS and Web
Locks. There are no React dependencies in the job manager. `@velocut/render-sdk`
provides `VideoGenerator.submit/poll`, `VideoGenPoll` and optional
`VideoModelCapabilities`; a legacy generate-only provider must add lifecycle
methods before it can back resumable jobs. MCP exposes `velocut_generation` with
the same actions and CodeAct exposes `velocut.generation()`.


### Configured model parameters and reference roles

Generation requests additionally accept scalar `parameters`, `lastFrameReferenceId`,
`referenceImageIds`, `referenceVideoIds` and `referenceAudioIds`. Values must match
configured model fields; endpoint/token/raw-reference-URL controls are excluded.
The host applies model defaults, validates parameter types, durations and supported
reference combinations before queuing paid work. Changed parameters or ordered
references change intentVersion. These values survive Rust/TS editing, undo and
reload in document format 4.

`captureReference({source:{kind:'asset',assetId},expectedRevision})` can snapshot
imported image, audio or video files; references expose their media kind. Frame
capture remains PNG. All referenced IDs must belong to the project and match
individual input roles, including when an ID appears in several roles. Upload
uses the captured media type and only occurs when generation is submitted.
`generation({action:'capabilities'})` now includes non-secret model settings so
Agents can discover parameter defaults and field definitions. Human configuration
is available through the toolbar's Model settings dialog.
