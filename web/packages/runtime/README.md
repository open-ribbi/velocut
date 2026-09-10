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
