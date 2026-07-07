# Contributing to Velocut

(English PRs and issues are welcome — the rules below are short, and the one
that matters is **№1: engine behavior changes ship with a golden vector**.)

## Environment

- Node ≥ 22.6 (`.nvmrc` at the repo root), Rust stable; browser Chrome/Edge 113+
- `cd web && npm install && npm run dev` is all you need to get it running (no wasm toolchain required — it automatically falls back to the TS engine)

## Rule №1: engine behavior change = new golden vector

Velocut has two engine implementations (canonical Rust + reference TS). Behavioral
consistency is pinned down by `protocol/vectors/*.json`, enforced on both sides by CI.
**Any PR that changes command semantics must come with a vector** — otherwise you have
effectively changed only one side, and nobody knows the other side is broken.

A vector looks like this (`protocol/vectors/03_trim_undo_redo.json`):

```jsonc
{
  "name": "One sentence stating the behavior this vector pins down",
  "steps": [
    { "apply": { "type": "addAsset", "id": "a1", "kind": "video", "src": "mem://a1", "name": "A", "durationUs": 10000000 } },
    { "apply": { "type": "addTrack", "kind": "video" } },
    { "apply": { "type": "addClip", "trackId": "track_1", "assetId": "a1", "startUs": 1000000, "durationUs": 4000000, "sourceInUs": 500000 } },
    { "undo": true },
    { "redo": true }
  ],
  "expect": {
    "clips": [ { "id": "clip_2", "trackId": "track_1", "startUs": 1000000, "durationUs": 4000000, "sourceInUs": 500000 } ]
  }
}
```

Key points:

- ids are minted deterministically by the engine (`<kind>_<nextId>`, monotonically increasing) — count ids by following the existing vectors
- Error paths use `applyErr` (asserting the error code); evaluation assertions use `eval` (layers and/or `audio` gain); document-load behavior uses a `load` step — the existing vectors have examples of every form
- Put new files in `protocol/vectors/`; tests on both sides discover them automatically (by directory traversal), no registration needed

How to run:

```bash
cargo test                # Rust side
cd web && npm test        # TS side (same JSON suite)
cd web && npx tsc -b apps/editor   # type check
```

## Where to make changes — quick reference

| What you want to change | Where to touch |
| --- | --- |
| New command / change command semantics | `web/packages/protocol/src/schema.ts` (zod + SUMMARIES) → `crates/velocut-core/src/command.rs` → `web/packages/core-ts/src/engine.ts` → new vector |
| Rendering / export / decoding | `web/packages/render-sdk/src/` (for the worker protocol, see the header comment in `media.worker.ts`) |
| Agent tools & prompts | `web/packages/agent-sdk/src/index.ts` + `protocol-prompt.ts` |
| Effects / transitions | `web/packages/render-sdk/src/effects.ts` (a registry — no need to touch agent-sdk) |
| Editor UI | `web/apps/editor/src/ui/` |

If you changed the Rust engine, remember to rebuild wasm (see README for the command) —
otherwise you are still running the old engine or the TS engine locally. The badge in the
top-right corner will tell you the truth.

## Common pitfalls

- **"Do I need Rust installed?"** No — without the wasm bundle the app falls
  back to the TS reference engine automatically. You only need Rust to work on
  the canonical engine itself.
- **"I changed the engine but nothing happened."** If the top-right badge says
  `engine: Rust/WASM`, the browser is running the *prebuilt* wasm from
  `web/apps/editor/public/wasm` — rebuild it (`just build-wasm`) or your change
  only exists in native `cargo test`.
- **"`npm install` / `npm test` fails."** Check `node --version` — the test
  runner relies on `--experimental-strip-types`, which needs Node ≥ 22.6
  (`nvm use` picks up the repo's `.nvmrc`).
- **"My command is rejected with `invalidArg: Expected integer`."** All times
  are integer microseconds; round before dispatching. The boundary rejects
  fractions on purpose — the two engines would round them differently.
- **First contribution idea:** copy an existing vector, change one step, make
  a prediction about `expect`, and run both suites. If your prediction is
  wrong, you just learned real engine semantics — cheaper than reading code.

## Style

- Match the comment density and naming of the surrounding code; comments should only state constraints the code itself cannot express
- Commit messages should explain the "why", not restate the diff
