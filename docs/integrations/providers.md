# Velocut Provider packages (unreleased)

For no-code model integration, use [declarative YAML/JSON models](declarative-models.md).
Studio and Codex share a local configuration host; installing a model npm package
is not required. The APIs below remain available to custom SDK hosts and existing channels.


Velocut owns this provider architecture. It borrows Hypit's separation of model
semantics, service adapters and configured endpoints; it does not integrate or
require HypiHub, and it does not import Hypit's code or runtime.

| Package | Responsibility |
| --- | --- |
| `@velocut/provider-sdk` | Model schema/validation, capability requests, channel configuration, scoped credential references, provider registry, lifecycle/result/error contracts |
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
host configuration. Low-level custom providers implement their own validators.
The declarative interpreter executes JSON Schema validation and the configured
request/response mappings; built-in recipes use exactly the same interpreter.

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
Studio build includes Task API, Ark and MiniMax video, speech and music; installing an npm package
alone does not dynamically inject it into an already built Studio.

`asVideoGenerator` translates existing video inputs into reference IDs supplied by
its host resolver. It carries opaque receipt state through submit/poll, and invokes
collection after readiness. The current timeline accepts one video URL; binary or
multi-output results need a host consumer for the base result contract. Existing
public `TaskApiVideoGen`, `createVideoGen`, `registerVideoGenProvider` and
`MiniMaxTextToSpeech` remain available. AudioContext stays in render-sdk's decoding
wrapper. Direct Provider consumers can run speech transport in Node.

## Runtime recovery and boundaries

The generation journal upgrades from versions 1/2/3 to 4 without re-submitting jobs.
Version 2 protected private provider handles; version 3 keeps older executors from
claiming new jobs whose model parameters and reference roles they cannot preserve.
Version 4 adds complete declarative inputs and pinned model definition revisions.
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

All provider verification uses injected mock transports. The source builds eight
public package tarballs, including the shared Provider SDK. The published 0.0.1
release still contains the earlier seven packages until an explicit new release.

## Configure models in Studio

Open the toolbar's **Model settings** button. Select a model preset, enter your
own **Base URL**, **API Token** and actual model/deployment ID, adjust defaults,
and save the channel. No SDK code or package registration is needed for the
built-in protocols. Video channels also appear in the generation-range panel;
speech/music channels appear in the audio preview area. The same configuration
can be reached from Assistant settings.

A model brand is separate from its HTTP protocol. The shipped choices are:

| Protocol | Model presets / request shape |
| --- | --- |
| Task API | Custom models, MiniMax H3, Seedance 2.0 / Mini / 2.5; `/api/v1/tasks` with `{model,params}` |
| Ark content tasks | Custom Seedance deployment/model IDs; typed text/image/video/audio content under `/contents/generations/tasks` |
| MiniMax Video API | Native Hailuo 2.3; submit, query, then retrieve the generated file |
| MiniMax Speech API | Speech 2.8 HD/Turbo, editable model ID, voice/speed/volume/pitch/emotion/language |
| MiniMax Music API | Music 2.5, prompt/lyrics and audio output parameters |

The Task API Seedance presets default to `seedance-2.0`, `seedance-2.0-mini` and
`seedance-2.5`; these are the gateway model IDs referenced in evo-backend. A
compatible service may use aliases, so the ID stays editable. MiniMax H3 through
that task gateway uses `2K`/`768P` and 4–15 seconds; Hailuo's native route uses its
own duration/resolution rules. Those are distinct presets and adapters.

The parameter inventory was checked against evo-backend commit `58be2808`, in
its video tools, `common/seedance2hm`, `common/seedance`, and MiniMax audio tools.
Only public model/request definitions informed the implementation. Velocut has
no dependency on that backend, its deployment, accounts, billing or secrets.
This is not a claim that every evo-backend tool/protocol is implemented.

Known presets expose parameter controls and supported video lengths/resolutions.
Advanced settings let users add validated scalar controls (text, number, boolean
or enum), limits and defaults for a custom model on the selected compatible
protocol. These fields are applied to the actual request, not merely displayed.
Default values can be overridden per generation. Routing, credentials, URLs and
media references cannot be added as arbitrary scalar parameters. A different wire
protocol still needs an adapter; changing a Base URL does not translate an API.

**Check configuration** validates locally and sends no paid or authentication
request. Browser requests still require service CORS support or a compatible
proxy. Development builds offer a relay button which preserves the API base path;
the portable static server does not turn into an unrestricted proxy. Reference
media storage can be configured in the same dialog for protocols that require
public reference URLs.

Video reference snapshots can now contain imported images, video or audio, or a
captured timeline frame. Requests specify first/last-frame IDs or ordered reference
ID arrays. Model rules reject incompatible roles, unsupported frames and invalid
combinations before uploading or submitting. Seedance 2.5 uses multimodal references
rather than dedicated first/last-frame fields in this preset. The fixed timeline
range continues to choose a supported positive source duration; smart duration,
video extension/editing modes and every provider-specific feature are not inferred.

Generated audio is saved in the original project's OPFS with a separate execution
record. Users can preview saved candidates after reload and explicitly keep one
in assets. Speech can also be selected as the built-in narration channel. Immediate
audio requests interrupted without a completed response are not automatically
retried; their outcome remains visible. Audio generation does not insert a clip.
Video model configuration drives the existing SDK/MCP/CodeAct generation actions;
this increment does not add a generic paid audio execution tool to the MCP host.

Document format 5 preserves full model inputs, configuration revisions, parameters
and reference roles; formats 1–4 migrate forward. The engine feature probe prevents an old WASM binary from silently
dropping these fields. Legacy channel settings remain browser-local. Declarative definitions and tokens
use the local Studio model host; neither stores credentials in the document or
returned Agent channel metadata. Private job
receipts continue to be excluded from public job get/list results.
