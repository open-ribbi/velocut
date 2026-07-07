# @velocut/protocol

The command protocol shared by both engines — the single source of truth for what a valid edit *is*.

- **Contents**: TypeScript types (`src/types.ts`) and the zod command schema + summaries (`src/schema.ts`). The zod shapes correspond 1:1 to the Rust `serde` model in `crates/velocut-core`.
- **Role**: every edit — from the UI, the agent, `window.velocut`, or a script — is one of these `Command`s. `@velocut/core-ts` and `crates/velocut-core` both implement exactly this protocol; `protocol/vectors/*.json` are the golden vectors that keep the two in lock-step.
- **Depends on**: `zod`.

## Usage

```ts
import { validateCommand, PROTOCOL_VERSION, type Command } from '@velocut/protocol';

const cmd: Command = { type: 'addTrack', kind: 'video', name: 'Main' };
console.log(PROTOCOL_VERSION);      // 1
console.log(validateCommand(cmd));  // { ok: true }

console.log(validateCommand({ type: 'addClip', trackId: 't1' }));
// { ok: false, code: 'invalidArg', message: 'assetId: Required' }
```

See the [root README](../../../README.md) and [PROTOCOL.md](../../../PROTOCOL.md) for the authoritative command reference.
