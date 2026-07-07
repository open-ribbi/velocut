# @velocut/agent-sdk

The LLM editing agent — an Anthropic-protocol tool-use loop.

- **Role**: drives the model that edits Velocut. Its tools (`velocut_apply`, `velocut_get_document`, `velocut_observe`, `velocut_tts`, `velocut_transcribe`, `velocut_script`, `velocut_search`) all reach the host via an `AgentHost` interface and ultimately flow through the same `dispatch(Command)` pipeline as the UI. The system prompt's command catalog is generated from `@velocut/protocol`.
- **Transport is injectable** (`createMessage` / `createStream`), so the loop is testable without network access and can move to a backend without touching the tool logic.
- **Depends on**: `@velocut/protocol`, `@anthropic-ai/sdk`.

## Usage

```ts
import { runAgentTurn, type AgentHost } from '@velocut/agent-sdk';

// Anything that speaks the protocol can host the agent — e.g. TsEngine from @velocut/core-ts.
const host: AgentHost = {
  dispatch: (cmd) => engine.apply(cmd),
  document: () => engine.document(),
  evaluate: (timeUs) => engine.evaluate(timeUs),
};

const history = await runAgentTurn({
  apiKey: 'sk-ant-…',
  history: [],
  userText: 'Trim the first clip to 2 seconds and add a title',
  host,
  onEvent: (e) => { if (e.kind === 'textDelta') process.stdout.write(e.delta); },
  // Transport is injectable: pass createMessage / createStream to route
  // through your own backend or a network-free test stub.
});
```

See the [root README](../../../README.md); trust model & the `velocut_script` sandbox: [SECURITY.md](../../../SECURITY.md).
