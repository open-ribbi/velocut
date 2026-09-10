# @velocut/scene-sdk

Declarative editable 3D scenes: SceneSpec validation, pure scene edits,
parametric assemblies, Three.js staging, GLB import, camera sampling,
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
