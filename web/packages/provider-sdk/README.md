# @velocut/provider-sdk

Host-neutral contracts for independently packaged audio/video/image model
providers. No runtime dependencies, React, renderer, filesystem or model SDK.
Uses standard JavaScript, fetch, AbortSignal and Uint8Array in Node or browsers.

```ts
import {ProviderRegistry} from '@velocut/provider-sdk';
import {taskApiProvider} from '@velocut/provider-task-api';

const registry = new ProviderRegistry().register(taskApiProvider);
const channel = registry.create({
  id: 'my-video', provider: 'task-api',
  config: {baseUrl: 'https://your-service.example', models: ['your-model']},
  credentials: {apiKey: {store: 'host', key: 'video-key'}},
}, {
  resolveCredential: async ref => myCredentialStore.get(ref.store, ref.key),
});
const request = {capability:'video.generate', model:'your-model', input:{prompt:'A lake'}};
channel.describe(); // no keys, URLs from config, network or credential resolution
channel.supports(request); // pure model/service validation
const receipt = await channel.submit(request, {requestId:'shot-001'});
// Persist the complete receipt privately, with the original channel configuration.
const status = await channel.poll(receipt);
if (status.state === 'ready') {
  const result = await channel.collect(status.receipt ?? receipt);
  // The host chooses how to save, probe, register or place result.outputs.
}
```

This example assumes an application-owned `myCredentialStore`; no storage or
network action is installed by importing this package. Request IDs are forwarded
in call context; each adapter must use only the idempotency mechanism actually
supported by its service. They do not provide cross-call deduplication alone.

`ProviderDefinition` supplies metadata/config schema, declared credential slots
and a factory. `ModelDefinition` supplies input schema plus a pure validator;
`supports` adds service-specific restrictions. Schemas are discovery metadata,
not a hidden generic schema interpreter: providers implement config validation in
`create`, model checks in `validate` and service restrictions in `supports`.

`execute` handles immediate results. `submit/poll/collect` handle asynchronous
jobs. Optional `cancel` returns accepted/confirmed/unsupported/too-late; only
confirmed establishes remote cancellation. Optional `readPricing` returns source
and provider-owned data, without inventing prices or authorizing a purchase.
No operation automatically retries or switches models/accounts. Hosts own durable
jobs, scheduling, concurrency, polling intervals and paid-retry decisions.

Inputs and private receipt state are finite JSON. Receipts are tagged with their
provider/channel and cannot accidentally be passed to a different configured
channel. They must contain no keys or media bytes; they may contain private
service state or signed result URLs, so do not expose them to agents or document
history. Only explicitly configured, declared credential slots resolve. Provider
code is trusted host code, not an execution sandbox; installing it is a host
integration decision. The registry never loads arbitrary code from model input.

Outputs are typed media URLs, encoded bytes or host resource references, with
optional metadata and usage. Structured results such as transcripts can use
`data` with an empty media output set. Audio decoding, persistent files and timeline
editing belong to the host. Multiple outputs are supported by the base contract.
The `/video` subpath contains legacy video types and `asVideoGenerator` for the
current single-URL video timeline; it deliberately rejects unsupported output
shapes rather than dropping extra candidates.

See the [integration guide](../../../docs/integrations/providers.md) and the
[independent package example](../../../examples/provider-example). These new
packages are in source/local builds and have not yet been published to npm.


The `/catalog` subpath exports editable model presets, parameter controls/defaults
and validation helpers. These are model/service metadata, not credentials or a
universal wire protocol. Studio uses the same metadata for configuration forms,
per-generation controls and host-side preflight. Built-in protocols remain
explicitly selected; a new model ID on a compatible protocol requires only
configuration, while a different protocol still requires an adapter.
