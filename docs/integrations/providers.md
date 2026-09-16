# Velocut Provider packages (unreleased)

Velocut owns this provider architecture. It borrows Hypit's separation of model
semantics, service adapters and configured endpoints; it does not integrate or
require HypiHub, and it does not import Hypit's code or runtime.

| Package | Responsibility |
| --- | --- |
| `@velocut/provider-sdk` | Model schema/validation, capability requests, channel configuration, scoped credential references, provider registry, lifecycle/result/error contracts |
| `@velocut/provider-task-api` | Existing video task API mapping and HTTP transport |
| `@velocut/provider-minimax` | Existing MiniMax speech mapping and encoded audio transport |
| `@velocut/runtime` | Durable project jobs, receipts, reference snapshots, retries of tracking, adoption and history |
| `@velocut/render-sdk` | Rendering, decoding and compatibility wrappers for previous provider exports |

Providers execute one primitive request. They receive no Store, timeline, DOM or
editing API. A provider may generate video, synthesize audio or implement another
capability, while the agent/host composes generation, storage, registration and
placement separately. Capability names are extensible; declaring image/transcribe
capabilities in a custom provider does not add a built-in implementation or a new
Studio panel automatically.

## Author a package

Use the [independent example](../../examples/provider-example). Its only Velocut
peer dependency is `@velocut/provider-sdk`; compile normal ESM JavaScript and type
declarations, export a `ProviderDefinition`, and distribute it in an npm package.
A host explicitly imports and registers it. Registration alone never requests
credentials or calls a service. The SDK does not download/evaluate packages from
a project document, URL, prompt or agent tool argument.

Define model schemas and validators independently from wire mapping. A model's
semantic constraints belong in its `validate`; narrower service limits belong in
`supports`. Channel addresses, protocol options and credential references are
host configuration. The SDK exposes schemas as metadata but does not implement a
general JSON Schema evaluator. Each provider validates its config in its factory.

For immediate operations implement `execute`. For remote jobs implement
`submit/poll` and, when needed, `collect`. Persist the complete returned receipt
before doing subsequent work. Poll can return a new receipt with changed private
state. A `ready` result separates remote completion from collection. The SDK does
not save the receipt or retry any action; the host owns these policies. Returned
media is a set of URL/bytes/resource references, not a clip.

Credential resolvers belong to the host and can be backed by its existing browser
settings, environment, keychain or another trusted store. This increment adds
references and a resolver contract, not a new keychain integration. Only declared
and configured slots are available to the provider. Model descriptions never
include channel config/credentials. Known resolved secrets are redacted from
thrown action errors; provider authors must still avoid including secrets or
signed URLs in public results, diagnostics and messages.

## Connect an external video provider to the current editor

The existing registry remains a compatibility boundary:

```ts
import {ProviderRegistry} from '@velocut/provider-sdk';
import {asVideoGenerator} from '@velocut/provider-sdk/video';
import {registerVideoGenProvider} from '@velocut/render-sdk/videogen';
import {exampleProvider} from '@example/velocut-video-provider';

const registry = new ProviderRegistry().register(exampleProvider);
registerVideoGenProvider({
  id: exampleProvider.id, label: exampleProvider.label,
  create: config => asVideoGenerator(registry.create({
    id: 'example-channel', provider: exampleProvider.id,
    config: {endpoint: config.baseUrl},
    credentials: {apiKey: {store:'host',key:'selected-channel'}},
  }, {resolveCredential: async () => config.apiKey})),
});
```

Run registration from trusted application startup before opening provider
settings. Studio's protocol selector then lists that kind. Custom hosts can use
the base registry directly and supply richer credentials/configuration. The stock
Studio build includes task-api video and MiniMax speech; installing an npm package
alone does not dynamically inject it into an already built Studio.

`asVideoGenerator` translates existing video inputs into reference IDs supplied by
its host resolver. It carries opaque receipt state through submit/poll, and invokes
collection after readiness. The current timeline accepts one video URL; binary or
multi-output results need a host consumer for the base result contract. Existing
public `TaskApiVideoGen`, `createVideoGen`, `registerVideoGenProvider` and
`MiniMaxTextToSpeech` remain available. AudioContext stays in render-sdk's decoding
wrapper. Direct Provider consumers can run speech transport in Node.

## Runtime recovery and boundaries

The generation journal upgrades from version 1 to 2 without re-submitting jobs.
Version 2 prevents older runtimes from interpreting the new private state as public metadata.
Generation jobs retain `providerHandle` privately in the project ledger and pass
it back to the original adapter after reload. Agent get/list responses and edit
history exclude that opaque state. Existing endpoint/key binding checks, request
ID deduplication, local cancellation and explicit result adoption stay in the
runtime. A provider's `cancel:accepted` is not confirmation; the Studio Stop
tracking control continues to mean only local cancellation.

The task-api adapter deliberately does not assume every relay supports remote
cancellation, a pricing endpoint or an idempotency header. Other providers can
implement those documented service features via the public contracts. Pricing
responses preserve their source and data; the SDK invents no estimate.

All provider verification uses injected mock transports. The source builds ten
public package tarballs, including these three new packages. The published 0.0.1
release still contains the earlier seven packages until an explicit new release.
