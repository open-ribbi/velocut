# Velocut Architecture

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ App Shell  (TS + React, DI container)                     │
│   Canvas self-drawn timeline / Inspector / AgentConsole   │
│   Does only two things: send Command JSON, receive        │
│   document snapshots to render the UI                     │
├──────────────────────────────────────────────────────────┤
│ Editing Core  (Rust → WASM; TS reference implementation   │
│   of the same protocol)                                   │
│   Document model · command validation/execution ·         │
│   snapshot-based undo/redo (200 steps)                    │
│   Keyframe evaluation (linear/hold/bezier) → FrameGraph   │
├────────────────────────┬─────────────────────────────────┤
│ Media pipeline         │ Render engine                    │
│ mp4box demux           │ WebGPU (wgpu semantics, WGSL)    │
│ WebCodecs HW decode    │ external texture consumes        │
│ Frame LRU + keyframe   │ VideoFrame directly, single-     │
│ addressing             │ pipeline compositing             │
│                        │ Effects = registry (schema-      │
│                        │ driven UI)                       │
├────────────────────────┴─────────────────────────────────┤
│ Audio engine: AudioBufferSource-scheduled mixing; during  │
│   playback audio is the master clock                      │
├──────────────────────────────────────────────────────────┤
│ Agent (@velocut/agent-sdk): Claude tool-use loop, tools = │
│   velocut_apply/get_document/evaluate → same dispatch     │
│   chain                                                   │
├──────────────────────────────────────────────────────────┤
│ Collaboration & persistence (@velocut/collab-sdk): Yjs    │
│   entity-level CRDT mirror, BroadcastChannel for real-    │
│   time multi-tab; IndexedDB documents + OPFS media        │
└──────────────────────────────────────────────────────────┘
```

## SDK-ization (packages/)

- `@velocut/protocol` — types and command protocol (the dual-engine contract)
- `@velocut/core-ts` — TS reference engine (pinned down by golden vectors)
- `@velocut/render-sdk` — Renderer (WebGPU) + MediaLibrary (+decode worker,
  lazy byte-range reads) + AudioEngine + Playback; no timeline semantics, only
  consumes FrameGraph
- `@velocut/agent-sdk` — LLM editing agent (browser connects directly to the
  Anthropic API; transport injectable for testing)
- `@velocut/collab-sdk` — CollabSession (Yjs/BC/IndexedDB) + OPFS media library

## Core Decisions and Rationale

**1. Protocol first, dual engine implementations.**
The Rust core is the canonical implementation (compiled to WASM for the browser; the same crate runs directly on the server). The TS reference engine implements the same protocol, serving lightweight Node Agent / server-side use, and is also the frontend fallback when the WASM package is missing. The two are pinned to identical behavior by the golden vectors in `protocol/vectors` — changing engine semantics requires changing the vectors first, and both sides must pass simultaneously before the change counts as done. This makes "frontend/backend universal, directly operable by AI" not a slogan but a contract protected by tests.

**2. AI-native = a single command chain.**
UI gestures, the in-app Agent console, `window.velocut`, and server-side tasks all converge into the same `engine.apply(json)`: the same validation, the same undo history, the same revision stream. During UI dragging only a local ghost is drawn; a single command is committed only on `pointerup` — command granularity = gesture granularity = undo granularity, which is also exactly the LLM's tool-call granularity.

**3. Engine as a pure function: `evaluate(doc, t) → FrameGraph`.**
Timeline semantics (track layering order, speed-change mapping, keyframe interpolation) are all fully settled inside the core; the renderer receives a flat list of "what to draw for this frame". Preview and future offline export consume the same FrameGraph, guaranteeing WYSIWYG; the mixer likewise consumes `audio: AudioSlice[]`.

**4. Time in integer microseconds.**
Floating-point seconds accumulate error across trim/split/speed-change chains and break dual-engine consistency; integer µs stays within the f64/JSON safe range (±106 days), and all command boundaries are rounded to integers.

**5. WebGPU + WebCodecs, Chrome/Edge only.**
`importExternalTexture(VideoFrame)` lets decoded frames enter the shader with zero copies; text/images are rasterized into VideoFrames and reuse the same pipeline. Decoding follows the standard preview strategy: feed frames forward during sequential playback; on seek, flush and restart from the nearest preceding keyframe; an LRU holds a small number of decoded frames (VideoFrame must be explicitly closed — VRAM-sensitive).

**6. Effects are data, not code branches.**
The document stores only `{effect, params}`; the frontend registry provides the schema (Inspector auto-generates controls) and uniform packing. Adding an effect = one registry entry + shader math; the protocol and core stay untouched.

**7. Procedural assets: the spec lives in the document, opaque to the engines.**
Motion-graphics clips (and 3D scenes) are declarative JSON specs rendered by a fixed interpreter. The spec is stored on the asset itself (`Asset.spec`, edited via `setAssetSpec`) rather than in a side store, because every history layer in Velocut — engine undo, the branching history board, Yjs sync — snapshots whole documents: in-document specs get undo/redo, branch checkout, attribution and multi-tab sync with zero extra machinery. The engines treat the spec as an opaque string and enforce only storage invariants (valid JSON, 256 KB cap — vector 10); its MEANING belongs to the render layer, routed by the asset's `src` scheme (`motion://`, `scene://`). One observer re-compiles the interpreter whenever an asset's spec differs from what is attached — so an edit, an undo, a history jump and a remote peer's change are all the same code path.

**7. DI container assembles services.**
Engine (wasm/ts runtime detection), MediaLibrary, Renderer, Playback, and Store are all registered/resolved through the container; testing and replacement (e.g. swapping in a WebGL2 renderer) touch only the assembly point.

## Reserved Extension Seams

- **CRDT collaboration (v1 landed)**: the Y.Doc mirrors the document at entity granularity (one entry per track/asset); concurrent edits to different entities merge automatically, same-entity edits use LWW; nextId merges via max() to prevent id collisions. Future evolution: op-based undo, y-websocket server provider, clip-level granularity.
- **Worker-ization**: only `FrameGraph` JSON and VideoFrame (Transferable) pass between decode/render and the main thread, so moving into a Worker changes no interfaces; the vite dev server is already configured with COOP/COEP, and SharedArrayBuffer is available.
- **Export**: offline loop `evaluate(n/fps)` → exact frame grab (await, not best-effort) → same Renderer rendering offscreen → VideoEncoder → mp4 mux (add a muxer crate on the Rust side).
- **Transitions**: the FrameGraph is already a layered list; a transition = a special layer relationship of two adjacent layers + a blend shader; just add a `transition` field to the protocol.

## Known Trade-offs (v0.1)

- Undo is a full snapshot (simple to implement, absolutely correct); switch to structural sharing or an op log when documents get huge.
- Preview frame grabbing is best-effort (nearest available frame), preserving smoothness rather than frame-exact accuracy — only the export path requires exactness.
- Text rendering goes through Canvas2D rasterization, with no glyph caching and no stroke/shadow.
- Audio mixing v1: slices with speed≠1 are muted (speed change with pitch preservation is an export-path feature); preview mixing is AudioBufferSource scheduling, and during playback the AudioContext is the master clock.
