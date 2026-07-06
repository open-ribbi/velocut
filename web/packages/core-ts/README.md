# @velocut/core-ts

The TypeScript **reference engine** — a faithful mirror of the canonical Rust engine (`crates/velocut-core`).

- **Role**: applies `@velocut/protocol` commands to the document model and evaluates a time into a `FrameGraph`. It is the frontend's fallback when the WASM bundle is absent, and is directly runnable on Node.
- **Contract**: its behavior is pinned to the Rust engine by the shared golden vectors in `protocol/vectors/*.json` — `test/vectors.test.ts` runs them here, `crates/velocut-core/tests/vectors.rs` runs the same set there. A behavioral change must land as a new vector that both sides pass.
- **Depends on**: `@velocut/protocol`.

See [ARCHITECTURE.md](../../../ARCHITECTURE.md) → "协议先行,引擎双实现".
