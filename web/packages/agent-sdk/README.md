# @velocut/agent-sdk

The LLM editing agent — an Anthropic-protocol tool-use loop.

- **Role**: drives the model that edits Velocut. Its tools (`velocut_apply`, `velocut_get_document`, `velocut_observe`, `velocut_tts`, `velocut_transcribe`, `velocut_script`, `velocut_search`) all reach the host via an `AgentHost` interface and ultimately flow through the same `dispatch(Command)` pipeline as the UI. The system prompt's command catalog is generated from `@velocut/protocol`.
- **Transport is injectable** (`createMessage` / `createStream`), so the loop is testable without network access and can move to a backend without touching the tool logic.
- **Depends on**: `@velocut/protocol`, `@anthropic-ai/sdk`.

Trust model & the `velocut_script` sandbox: [SECURITY.md](../../../SECURITY.md).
