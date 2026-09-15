# Atomic API foundation (unreleased)

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

Kinds: `document`, `snapshot`, `assets`, `tracks`, `clips`, `sceneObjects`, `sceneGeometries`, `sceneMaterials`, `sceneBudget`,
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
commit. All new APIs use the `{ok,data,...}` envelope.

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
- This is unreleased work. Published 0.0.1 packages and release tags are unchanged.

## Resource import, probing and complete clip duplication (unreleased)

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
- This is an unreleased source change; it does not replace published 0.0.1
  packages or provide persistent job recovery.

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

- Instances require opaque materials. Physics and bone attachment require
  conversion with `makeUnique`; these cases fail explicitly instead of falling
  back silently to expensive meshes or incorrectly sorted transparency.
- Position/rotation animation and animated parents work with the existing
  grammar. Scale remains constant; visibility/opacity animation is future work.
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
builds and plugin validation pass. This remains an unreleased source increment.

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
when their immutable files initially deduplicate. Reusable animation definitions,
visibility/scale animation and further resource scaling remain separate work.

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
