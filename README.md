<!-- markdownlint-disable MD041 -->
**English** | [简体中文](README.zh-CN.md)

# Velocut

[![CI](https://github.com/willbean/velocut/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen)

An **AI-native, local-first video editor that runs entirely in the browser**. A canonical Rust engine (compiled to WASM) is mirrored by a TypeScript reference engine and kept in lock-step by shared golden-vector tests; WebGPU handles compositing and WebCodecs handles decode/export; and an LLM agent edits through the *exact same* JSON command protocol a human drives from the UI.

> **Protocol-first, AI-native.** Humans edit via the UI, the LLM issues JSON commands directly — both flow through one command pipeline into one document model. The AI agent is treated as the system's first-class *user*; the human UI's job is to make the agent's perception and actions visible and correctable.

![Velocut editor — multi-track timeline with waveforms, keyframes, transitions, speed ramps, and a WebGPU-composited preview](docs/media/editor.png)

> Some deeper docs are still Chinese-first. [PROTOCOL.md](PROTOCOL.md) and `web/packages/protocol/src/schema.ts` are the most complete English entry points to the command model.

## Requirements

- **Node ≥ 22.6** (`npm test` uses `--experimental-strip-types`; a `.nvmrc` is at the repo root)
- **Browser: Chrome / Edge 113+** (WebGPU + WebCodecs; Safari/Firefox not yet supported)
- Optional: Rust stable + `wasm-pack` (only to build the canonical WASM engine)

## Quick start (zero-dependency, TS engine)

```bash
cd web
npm install
npm run dev
```

Works out of the box: when the DI container detects the WASM bundle is absent, it falls back to the TypeScript reference engine (a badge in the top-right shows the active engine).

## Enable the Rust/WASM engine (canonical implementation)

```bash
# one-time setup
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# build and drop into the app's public dir (or: just build-wasm)
wasm-pack build crates/velocut-wasm --target web --release \
  --out-dir web/apps/editor/public/wasm

cd web && npm run dev   # badge switches to "engine: Rust/WASM"
```

## Agent quick start

Velocut's first "user" is the AI agent. Click the **⌘ Agent** bubble (bottom-right), paste your own Anthropic API key (`sk-ant-...`), and edit in natural language — *"cut out the silent parts", "add a title at the start"*.

![The agent reads the project and lands a styled closing title card in one atomic batch — through the exact same command protocol the UI uses](docs/media/agent.png)

- **The key lives only in your browser's localStorage; requests go straight to Anthropic with no intermediary server** (trust model: [SECURITY.md](SECURITY.md)).
- The agent can *see* (frame grabs / contact sheets), *hear* (loudness & silence analysis), and *cut* (shot-boundary detection). Every edit uses the same command protocol as the UI, so each step is visible in a chat card and the branching history tree — click to jump, undo to roll back.
- To route to a different model via a local proxy: in dev mode set `localStorage.setItem('velocut.devProxy','1')`; any Anthropic-protocol-compatible proxy on `127.0.0.1:3141` works (optional, not required).

### Optional capabilities & key convention (dev server only)

Web search (Gemini grounding) and MiniMax cloud TTS are proxied by the Vite dev server, which injects the secrets server-side so the browser never holds them:

```bash
# both optional; the files are gitignored, placed under web/apps/editor/
echo "<your Google API key>"  > web/apps/editor/.google-key    # velocut_search
echo "<your MiniMax key>"     > web/apps/editor/.minimax-key   # cloud TTS (local TTS needs no key)
```

Note: these proxies exist only under `npm run dev`; after a static `vite build`, search and cloud TTS are unavailable.

## Testing (both engines share golden vectors)

```bash
cargo test                # the Rust engine runs protocol/vectors/*.json
cd web && npm test        # the TS engine runs the same vectors
```

Any change to engine behavior must land as a new vector, and both sides must pass to count as consistent — CI (`.github/workflows/ci.yml`) enforces this pair of tests + `tsc` + a WASM compile smoke test on every PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for the flow.

## Repository layout

```
crates/
  velocut-core/        # canonical engine: model / commands / eval / history (pure Rust, no wasm deps)
  velocut-wasm/        # wasm-bindgen bindings (string-JSON ABI)
protocol/
  vectors/             # golden test vectors — the behavioral contract for both engines
web/
  packages/protocol/   # TS protocol types + zod validation (1:1 shape with the Rust serde model)
  packages/core-ts/    # TS reference engine (frontend fallback; runnable on Node)
  packages/render-sdk/ # WebGPU compositing / WebCodecs decode+export / workers / perception (grabs, shots, loudness)
  packages/agent-sdk/  # Anthropic-protocol tool-use loop (injectable transport)
  packages/collab-sdk/ # local-first persistence + multi-tab CRDT sync (Yjs)
  apps/editor/         # Vite + React editor (canvas timeline / branching history / agent console)
```

## Current capabilities

1. ✅ Multi-track editing: split / drag / snap / speed / trim / track reorder, with a **branching** edit history (go back and edit to fork a new branch; human vs. AI actions are color-attributed).
2. ✅ Keyframe animation (linear / hold / bezier) + an effect registry (color grade, etc.) + transitions.
3. ✅ Text layers & caption styling (rasterized → composited through the same WebGPU pipeline as video).
4. ✅ Audio: mixed playback, TTS narration (local / MiniMax), Whisper auto-captions.
5. ✅ Agent perception: frame-grab observation / shot-boundary detection / loudness & silence analysis, surfaced as images and sparklines in chat.
6. ✅ Declarative motion graphics (`motionClip`): keyframed layers described by a JSON spec — persisted, and safe to author from the sandboxed script tool.
7. ✅ Export: WebCodecs encode + mp4 mux (streaming, no whole-clip memory bloat); background low-res proxy transcode for smooth preview.
8. ✅ Local-first: media in OPFS, document + history in IndexedDB, real-time multi-tab sync.

Keys: Space = play / S = split / Delete = delete / Cmd+Z = undo / Ctrl+wheel = zoom timeline / drag a clip edge to trim / right-click a track head or clip for a menu.

## Programmatic entry points

- DevTools / external scripts: `window.velocut.apply({type:'splitClip', clipId:'clip_2', atUs:1500000})`
- Node-side engine: `@velocut/core-ts` (consumed inside the workspace; standalone npm publish is on the roadmap).

Command protocol → [PROTOCOL.md](PROTOCOL.md). Architecture decisions → [ARCHITECTURE.md](ARCHITECTURE.md). Security & trust model → [SECURITY.md](SECURITY.md).

## License

MIT © 2026 willbean
