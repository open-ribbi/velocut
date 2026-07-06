# @velocut/render-sdk

The browser rendering & media runtime — everything downstream of a `FrameGraph`.

- **Contents**: `Renderer` (WebGPU compositing), `MediaLibrary` + `media.worker` (mp4box demux, WebCodecs decode with lazy byte-range reads), `Exporter` (WebCodecs encode + mp4 mux, streaming), `AudioEngine`, `Playback`, `Observer` (frame grabs, shot boundaries, loudness), the effect/transition registry, TTS/transcribe, and the declarative `motionspec` interpreter.
- **Role**: knows nothing about timeline semantics, documents, or commands — it only consumes protocol `FrameGraph`s and media. This is the reusable rendering layer.
- **Depends on**: `@velocut/protocol`, `@huggingface/transformers`, `mp4-muxer`, `mp4box`.

See [ARCHITECTURE.md](../../../ARCHITECTURE.md).
