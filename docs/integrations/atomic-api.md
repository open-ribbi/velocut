# Atomic API foundation (unreleased)

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

Kinds: `document`, `snapshot`, `assets`, `tracks`, `clips`, `sceneObjects`,
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

Limits: 200 operations/request; 256 KiB JSON request and response; 8 MiB source
document; 8 snapshots (oldest evicted, no silent fallback); 128 retained request
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
