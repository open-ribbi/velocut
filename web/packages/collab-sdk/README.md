# @velocut/collab-sdk

Local-first persistence + multi-tab CRDT sync.

- **Contents**: `CollabSession` (a Yjs entity-level CRDT mirror of the document, synced across tabs via `BroadcastChannel`), and the persistence primitives — IndexedDB (`kv`) for documents/history and OPFS for media bytes.
- **Role**: keeps a session's document, history, and media on-device so a reload restores the last state; provides the seam for real multi-user sync later (swap the provider for `y-websocket`).
- **Depends on**: `@velocut/protocol`, `yjs`.

See [ARCHITECTURE.md](../../../ARCHITECTURE.md) and [SECURITY.md](../../../SECURITY.md).
