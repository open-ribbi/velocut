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

`Playback` follows the audio sample clock while it advances. If audio is
suspended or its clock stops for 250 ms, preview time continues from the last
audio progress using the wall clock and the selected preview rate. Recovery
rejoins at the current preview position and discards queued or in-flight PCM
from before the interruption. Direct `AudioEngine` integrations should treat
`clockUs() === null` as an unavailable audio clock, including when the underlying
`AudioContext` still reports `running`.

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

## Provider compatibility

Video and cloud-speech calls use the shared declarative executor and preset
definitions in `@velocut/provider-sdk`. Existing render-sdk exports remain as thin
compatibility wrappers; they no longer own HTTP request/response implementations.
Browser waveform decoding remains in `MiniMaxTextToSpeech`. New model integrations
can use YAML/JSON definitions; SDK hosts can also implement Provider contracts.
See the [Provider guide](../../../docs/integrations/providers.md).

## Video provider lifecycle

`createVideoGen(kind, config)` retains `generate(request)` for legacy consumers.
Resumable hosts use optional `submit(request) -> {taskId}` followed by
`poll(taskId, signal) -> VideoGenPoll`. The built-in task-api provider implements
both. `VideoGenTransportError` distinguishes known rejected submissions from
uncertain acceptance, and retryable polling failures from blocked ones. Store
receipts before polling; never implement recovery by blindly repeating submit.
`VideoModelCapabilities` describes optional durations/ratios/resolutions/image
and audio constraints. Channel configuration supplies these metadata; they are
not inferred from model names. Provider credentials belong to the host.
