<!-- Thanks for contributing to Velocut! Keep the description short; the checklist is what matters. -->

## What & why

<!-- One or two sentences. Link any related issue. -->

## Checklist

- [ ] **If this changes engine behavior** (command semantics, eval, the document model): a new/updated golden vector is included in `protocol/vectors/`, and **both** `cargo test` and `cd web && npm test` pass.
- [ ] `npx tsc -b` in `web/apps/editor` is clean.
- [ ] If the Rust engine changed, I rebuilt the WASM bundle (`just build-wasm`) and it still works, **or** the change is TS-only.
- [ ] No secrets, keys, or `/Users/...` absolute paths are committed.
- [ ] AI assistance in this change is disclosed (if any).

<!--
The core rule: engine behavior is a contract pinned by golden vectors shared by
the Rust and TS engines. A behavior change that isn't accompanied by a vector
that both sides pass is not a complete change. See CONTRIBUTING.md.
-->
