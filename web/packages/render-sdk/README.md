# @velocut/render-sdk

The browser rendering & media runtime — everything downstream of a `FrameGraph`.

- **Contents**: `Renderer` (WebGPU compositing), `MediaLibrary` + `media.worker` (mp4box demux, WebCodecs decode with lazy byte-range reads), `Exporter` (WebCodecs encode + mp4 mux, streaming), `AudioEngine`, `Playback`, `Observer` (frame grabs, shot boundaries, loudness), the effect/transition registry, TTS/transcribe, and the declarative `motionspec` interpreter.
- **Role**: knows nothing about timeline semantics, documents, or commands — it only consumes protocol `FrameGraph`s and media. This is the reusable rendering layer.
- **Core dependencies**: `@velocut/protocol`, `gsap`, `mp4-muxer`, `mp4box`, and lightweight upload signing. `@huggingface/transformers` is an optional peer: install it only for browser-local Whisper/VITS. Core rendering does not load it.

## Usage

Browser only — requires WebGPU and WebCodecs.

```ts
import { Renderer, MediaLibrary } from '@velocut/render-sdk';

const renderer = new Renderer();
await renderer.init(canvas); // HTMLCanvasElement or OffscreenCanvas

const media = new MediaLibrary();            // worker-backed demux/decode
const source = await media.probeVideo(file); // File → RemoteVideoSource
media.attachVideo('asset-1', source, file);

// fg is a protocol FrameGraph — e.g. from @velocut/core-ts's evaluate()
renderer.render(fg, media);
```

See the [root README](../../../README.md) and [ARCHITECTURE.md](../../../ARCHITECTURE.md).

## Package integration

Published artifacts contain ESM JavaScript, TypeScript 5.9+ declarations and
self-contained `media.worker.js` / `render.worker.js` files. Vite recognizes
the relative `new Worker(new URL(..., import.meta.url))` pattern and emits the
workers into your build. No source aliases or TypeScript worker loader is needed.

For Vite **development** use the included helper. Dependency prebundling moves
modules and would otherwise break relative worker URLs:

```js
// vite.config.mjs
import { velocutVite } from '@velocut/render-sdk/vite';
export default { plugins: [velocutVite()], build: { target: 'esnext' } };
```

The helper excludes the SDKs from dependency optimization and supplies isolation
headers for development/preview. Set the same headers on your production host.
Both Vite development and production consumer builds are verified.
The public worker exports are `@velocut/render-sdk/workers/media` and
`@velocut/render-sdk/workers/render`. For a custom asset pipeline copy these
worker files unchanged and pass their served URLs through
`new RendererClient({ workerUrl })` and `new MediaLibrary(projectId, { workerUrl })`.
These options avoid depending on bundler-specific worker discovery.

Serve through HTTPS or loopback HTTP with COOP `same-origin` and COEP
`require-corp`. Media must satisfy the browser's codec and origin requirements.
`RendererClient` transfers a DOM canvas to a render worker; keep that canvas
mounted while it is in use, and call `dispose()` when done. `Renderer` renders
on the calling thread and also accepts OffscreenCanvas. Close caller-owned
VideoFrames; `MediaLibrary.dispose()` releases its workers and cached frames.

Optional modules also have explicit subpath exports: `/transcribe`, `/tts`,
`/upload`, `/videogen`, `/effects` and `/motionspec`. Missing optional model
libraries affect only the corresponding inference feature. No provider key or
model download is needed to composite and export existing media.
