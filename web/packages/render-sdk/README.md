# @velocut/render-sdk

The browser rendering & media runtime — everything downstream of a `FrameGraph`.

- **Contents**: `Renderer` (WebGPU compositing), `MediaLibrary` + `media.worker` (mp4box demux, WebCodecs decode with lazy byte-range reads), `Exporter` (WebCodecs encode + mp4 mux, streaming), `AudioEngine`, `Playback`, `Observer` (frame grabs, shot boundaries, loudness), the effect/transition registry, TTS/transcribe, and the declarative `motionspec` interpreter.
- **Role**: knows nothing about timeline semantics, documents, or commands — it only consumes protocol `FrameGraph`s and media. This is the reusable rendering layer.
- **Depends on**: `@velocut/protocol`, `@huggingface/transformers`, `mp4-muxer`, `mp4box`.

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
