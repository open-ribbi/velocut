# @velocut/core-ts

The TypeScript **reference engine** — a faithful mirror of the canonical Rust engine (`crates/velocut-core`).

- **Role**: applies `@velocut/protocol` commands to the document model and evaluates a time into a `FrameGraph`. It is the frontend's fallback when the WASM bundle is absent, and is directly runnable on Node.
- **Contract**: its behavior is pinned to the Rust engine by the shared golden vectors in `protocol/vectors/*.json` — `test/vectors.test.ts` runs them here, `crates/velocut-core/tests/vectors.rs` runs the same set there. A behavioral change must land as a new vector that both sides pass.
- **Depends on**: `@velocut/protocol`.

## Usage

Runs directly on Node (>= 22.6): `node --experimental-strip-types demo.ts`

```ts
import { TsEngine } from '@velocut/core-ts';

const engine = new TsEngine('demo', 1920, 1080, 30, 1);

engine.apply({ type: 'addAsset', kind: 'video', src: 'clip.mp4', name: 'Clip', durationUs: 5_000_000, id: 'asset-1' });
engine.apply({ type: 'addTrack', kind: 'video' });
const trackId = engine.document().tracks[0].id;
engine.apply({ type: 'addClip', trackId, assetId: 'asset-1', startUs: 0, durationUs: 2_000_000 });

const fg = engine.evaluate(1_000_000); // FrameGraph at t = 1s
console.log(fg.layers.length, fg.layers[0].sourceTimeUs); // 1 1000000
```

See the [root README](../../../README.md) and [PROTOCOL.md](../../../PROTOCOL.md) for the full command set.
