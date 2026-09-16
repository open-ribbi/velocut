# @velocut/provider-minimax

MiniMax is a model vendor, not a speech-only protocol. This package exports three
native API adapters using the common Provider contracts:

| Export / provider ID | Capability | Routes |
| --- | --- | --- |
| `minimaxProvider` / `minimax` | Speech synthesis | `/v1/t2a_v2` |
| `minimaxVideoProvider` / `minimax-video` | Hailuo video generation | `/v1/video_generation`, `/v1/query/video_generation`, `/v1/files/retrieve` |
| `minimaxMusicProvider` / `minimax-music` | Song generation | `/v1/music_generation` |

All accept user-owned credentials and configured API addresses. New channels use
`baseUrl`; speech keeps the previous `endpoint` option for compatibility. Root
URLs and a trailing `/v1` are accepted. The speech compatibility wrapper keeps its
old development-proxy default when neither is supplied. Nothing installs a proxy
or reads a global account for you.

Speech returns encoded audio with voice, speed, volume, pitch, emotion and language
controls. Music accepts prompt, lyrics, sample rate, bitrate and watermark. Video
returns an asynchronous receipt, polls its status and resolves the existing file's
download URL. Audio decoding and file persistence stay in the host.

MiniMax-H3 in the referenced evo-backend implementation uses a separate task-gateway
protocol. Configure the **MiniMax H3 · Task API** preset for that route; it is
implemented by provider-task-api and is distinct from the native Hailuo endpoint.
A model name alone does not determine a service's request protocol.

Reference: [MiniMax HTTP speech](https://platform.minimax.io/docs/api-reference/speech-t2a-http),
[official video guide](https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/references/minimax-video-guide.md),
[MiniMax music](https://platform.minimax.io/docs/api-reference/music-generation).
No live provider account has been exercised by automated tests. This package is
in source/local builds and has not yet been published to npm.
