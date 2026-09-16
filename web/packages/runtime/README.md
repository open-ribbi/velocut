# @velocut/runtime

Project editing services shared by Velocut Studio and external hosts. This
package has no React dependency or imports from the editor application. It
combines the pure engine, scene SDK and browser renderer; it does not make GPU
rendering available in Node. ESM JavaScript and TypeScript 5.9+ declarations ship
in `dist`. Import `@velocut/runtime/store` or `/engine` for non-rendering use.

```ts
import { Store, TsEngineAdapter, bindSceneAuthoring, configureSceneStorage,
  createSceneClip, editScene, syncSceneAsset, pruneSceneRenderers,
  disposeSceneAuthoring } from '@velocut/runtime';
import { MediaLibrary } from '@velocut/render-sdk';

const store = new Store(new TsEngineAdapter('My project', 1280, 720, 30, 1));
const media = new MediaLibrary('my-project');
bindSceneAuthoring(store, media, { assetBase: '/scene-assets' });
const made = await createSceneClip(store, media, {
  spec: { version: 1, durationUs: 2_000_000,
    props: [{ id: 'cube', model: 'prop/cube', color: '#e6b774' }] },
});
if (!made.ok || !made.assetId) throw new Error(made.message);
const result = await editScene(store, {
  assetId: made.assetId,
  expectedRevision: store.getState().revision,
  edits: [{ type: 'update', id: 'cube', patch: { position: { x: 2 } } }],
});
if (!result.ok) throw new Error(result.message);
store.undo();
// After history restores or externally loaded documents, synchronize derived
// renderers. Studio already does this in its restore observer.
for (const asset of store.getState().doc.assets) {
  if (asset.src.startsWith('scene://')) await syncSceneAsset(store, media, asset);
}
pruneSceneRenderers(store);
// When destroying the host:
disposeSceneAuthoring(store);
media.dispose();
```

Serve `@velocut/scene-sdk/assets` at the configured asset base. GLB import also
requires `configureSceneStorage(store, { load, save })`. `save(File)` persists the
file and returns `opfs://<file.name>`; `load(src)` resolves that logical reference
inside this project and returns its Blob or null. Your implementation may use
OPFS, a project database, or another host-owned store. References contain a
content hash that the runtime verifies; never resolve them in another project.

`createProjectHost(store, media, observer, project, actor?)` exposes the allowlisted
project command dispatcher used by the MCP adapter. It receives an AbortSignal,
attributes edits, rejects stale revisions and runs programs in an isolated
browser iframe. Passing actor `{ name: 'Codex', peerPrefix: 'codex' }` affects
history labels, not model execution. There is no nested LLM call.

Use `createEngine({ ..., wasmBase: '/wasm' })` to try the separately built Rust
engine, with TS fallback. The scene's Three.js/physics runtime and document
engine WASM are independent. Persistence, account/provider settings, UI and
browser lifecycle belong to the host. Call disposal methods when it closes.

## Compact history

`HistoryTree` shares immutable spec strings in memory. `serialize()` still returns
ordinary documents for existing consumers; `serializeCompact()` emits the
`spec-table-v1` storage encoding. `HistoryTree.deserialize()` reads both formats.
The compact encoding preserves node IDs, branches, commands and snapshots.

Studio stores compact history under `<history key>:compact-v1`, keeping an existing
legacy history value as a downgrade/recovery copy. New writes do not update that
legacy copy; older Studio versions see the last legacy state. Deleting a project
removes both keys. This reduces the active save payload, not necessarily total
disk use immediately. No history nodes are dropped by deduplication; the existing
400-node retention policy is unchanged.

## Timeline generation

`configureGeneration(store, adapter)` installs a durable project job manager;
`generation(store, input)` exposes capabilities, planning, reference capture,
submit/get/list/cancel/resume, result registration and adoption. Provide a
`GenerationAdapter` for journal/files, immutable reference capture, submit/poll,
media probing and locks. No paid work starts when adding a document slot.
Submission requires a stable requestId and intentVersion; adoption additionally
checks the current document revision. The manager never automatically re-posts
an uncertain request. Dispose the manager with the host.

Studio implements this adapter with project-scoped IndexedDB/OPFS and Web Locks.
Custom hosts must supply equivalent durability and single-runner coordination;
an in-memory adapter does not provide reload safety. Refer to the
[atomic API contract](../../../docs/integrations/atomic-api.md#timeline-video-generation)
for commands, action parameters and recovery behavior.

The generation journal also retains an optional provider-owned JSON handle,
privately beside the task ID. Submit receipts and poll updates persist it; reload
passes it to the same adapter. Public job get/list metadata omits it. Provider
contracts come from `@velocut/provider-sdk`; see the [Provider guide](../../../docs/integrations/providers.md).
