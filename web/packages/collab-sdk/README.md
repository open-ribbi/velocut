# @velocut/collab-sdk

Local-first persistence + multi-tab CRDT sync.

- **Contents**: `CollabSession` (a Yjs entity-level CRDT mirror of the document, synced across tabs via `BroadcastChannel`), and the persistence primitives — IndexedDB (`kv`) for documents/history and OPFS for media bytes.
- **Role**: keeps a session's document, history, and media on-device so a reload restores the last state; provides the seam for real multi-user sync later (swap the provider for `y-websocket`).
- **Depends on**: `@velocut/protocol`, `yjs`.

## Usage

```ts
import { CollabSession, type CollabHost } from '@velocut/collab-sdk';

const host: CollabHost = {
  getState: () => ({ doc: engine.document(), revision: engine.revision() }),
  subscribe: (fn) => store.subscribe(fn),   // call fn after every local edit
  loadDocument: (doc) => { engine.load(doc); }, // persisted/remote state → engine
};

const session = new CollabSession(host, 'my-room');
await session.start(); // restore from IndexedDB, then sync across tabs
session.onPeersChange = (n) => console.log(`${n} tab(s) connected`);
```

See the [root README](../../../README.md), [ARCHITECTURE.md](../../../ARCHITECTURE.md) and [SECURITY.md](../../../SECURITY.md).
