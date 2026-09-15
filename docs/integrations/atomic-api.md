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
New editing semantics such as full clip duplication, transcript models,
durable jobs and cross-call scene/timeline transactions remain follow-up work.

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
