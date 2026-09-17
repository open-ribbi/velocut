# Declarative media models

Run the current prebuilt `velocut studio`, open **Model settings → Model definitions**,
and import YAML/JSON or start from a template. Save the definition, click **Connect**,
enter the service Base URL, its remote model/deployment ID when required, and its token.
No source checkout, npm model package, or application startup registration is needed.
Codex can create the same definition using `velocut_models` from API documentation.

Definitions are data: the executor never branches on a vendor/model name. Each definition
owns its input schema, constraints, request mapping and output mapping. UI controls and
agent discovery use that schema. Existing browser-configured channels remain supported.

## Configuration example

This is an illustrative service, not a claim that every `/tasks` API has this shape:

```yaml
version: 1
id: my-video
label: My video service
capability: video.generate
timeline:
  prompt: description
  duration: seconds
inputSchema:
  type: object
  required: [description, seconds]
  additionalProperties: false
  properties:
    description: {type: string, minLength: 1}
    seconds: {type: integer, enum: [5, 10]}
    camera:
      type: object
      properties:
        movement: {type: string}
        strength: {type: number, minimum: 0, maximum: 1, default: 0.5}
execution:
  type: async-http
  auth: {type: bearer}
  submit:
    method: POST
    path: /tasks
    body:
      model: {$connection: remoteModel}
      parameters: {$input: ''}
  receipt: {id: '$.data.task_id'}
  poll:
    method: GET
    path: /tasks/{receipt.id}
    status: $.data.status
    states:
      running: [queued, processing]
      succeeded: [completed]
      failed: [failed, cancelled]
  outputs:
    - kind: video
      url: $.data.video_url
```

`timeline` is optional semantic metadata, not a mandatory input shape. Its duration
binding supplies the requested source duration if the input omitted it. Explicit
model inputs keep their values. The editor's target range is separate from model input.
Async video models returning one video URL can use persistent timeline jobs and adoption.

## Schema and expressions

Input schemas use Ajv's JSON Schema draft-07 implementation in strict mode. Unsupported
keywords and unresolved references fail validation. Input values are cloned before
defaults are applied. Types are not coerced and unknown fields are never silently removed.
Use `additionalProperties: false` to reject extra fields, or explicitly allow them for
an extensible pass-through schema. Nested objects, arrays, enum, oneOf/anyOf, if/then/else,
dependencies and ordinary draft-07 constraints are supported. Defaults inside ambiguous
conditional branches are rejected by strict schema compilation. YAML aliases, executable
tags and duplicate keys are rejected. There is no JavaScript expression evaluation.

Body and query mappings are JSON-shaped templates:

| Expression | Meaning |
| --- | --- |
| `{$input: ''}` | Whole normalized input object, retaining JSON types |
| `{$input: camera.speed}` | Input field; add `optional: true` to omit an absent value |
| `{$connection: remoteModel}` | Connection's remote model ID (credentials are unavailable here) |
| `{$receipt: fileId}` | A persisted, explicitly mapped receipt field |
| `{$requestId: true}` | Host's request ID; only send if the service documents idempotency |
| `{$map: {items: ..., value: ...}}` | Map an array; `$item` reads each element |
| `{$if: {value: ..., equals: ..., then: ..., else: ...}}` | Conditional value/omission; without equals, tests presence excluding null/false |
| `{$media: {id: ..., kind: image}}` | Resolve a project reference through configured media transport |

Response paths support `$`, dotted properties and numeric array indices, not arbitrary
JSONPath scripts, filters or recursive queries. Relative request paths stay on the configured
Base URL. `{receipt.id}` path components are URL-encoded. Query maps handle query encoding.
Constant request headers are limited to Accept/Content-Type. Authentication is `bearer`
(default), `header` with a name and optional prefix, or `none`.

For project media, declare an object input with `x-media-kind: image|video|audio`, and
properties `$mediaRef: {type: string}` and `kind: {const: image}` (adapt the kind).
The editor renders a saved-reference selector. Map its `$mediaRef` through `$media`;
the job validates ownership and kind before uploading. Capture references through the
existing generation API. Uploaded references currently use configured reference storage;
provider-specific multipart/file-ID upload handshakes are not implemented by this interpreter.

## Lifecycle and outputs

- `sync-http`: submit returns the result directly.
- `async-http`: submit extracts a receipt ID; poll maps exact running/success/failure states.
  Unknown states stop tracking with an error. An uncertain submission never auto-retries.
- Optional `collect`: a successful poll can map extra receipt fields (such as `fileId`),
  followed by a separate result request. Only mapped fields are persisted, not full responses.
- A request can declare `error: {path, success, message?}` for a service error inside HTTP 200.
- Outputs support `url`, `hex`, `base64`, or `bytes: true` with request `response: bytes`.
  `each` maps an output array; optional `data` returns structured data. Output media kinds are
  video, audio and image. The provider SDK exposes the complete result; the timeline consumer
  currently accepts exactly one video URL and rejects incompatible results explicitly.
  Synchronous audio definitions can be previewed and kept in project assets through
  Model settings, using the same schema-driven input form.

The interpreter uses HTTP JSON or binary responses. Streaming, WebSockets, webhook-only
completion, custom request signing, and multipart uploads require additional transport primitives.
It does not infer these protocols from a model name or Base URL.

## Codex configuration surface

`velocut_models` is a dedicated configuration tool, not part of the CodeAct sandbox:

- `list`, `get`: definitions, schema, current revision, YAML and connection metadata.
- `validate`: validate a YAML string or JSON definition without sending a provider request.
- `upsert`, `remove`: persist changes; updates require the revision returned by get/list.
- `connections`: list, upsert `connection: {id, modelId, baseUrl, remoteModel?, label?}`, or
  remove `id`. Updating a connection requires its returned `expectedRevision`.
- `preview`: `connectionId`, optional model `revision`, `input`, optional `requestId`.
  Returns normalized input and the compiled request with a credential placeholder; no HTTP
  call, credential read or reference upload takes place.

Tokens are entered in Studio and never returned through discovery/export/preview. A change
to a connection's Base URL clears its saved token. Model configuration does not submit a job.
Use `velocut_generation` for paid timeline generation, as a separate authorized action.
New slot requests carry `{channel, model, prompt: '', input: {...}}`. Full nested inputs and
the pinned model revision survive project reload, history and the TS/Rust engines.

## Storage and deployment

The local Studio host executes configured adapters so upstream APIs do not need browser CORS
for submission/poll/collection. Vite uses the same host during development. Static-only web
hosting does not expose this service; the UI explains that a current local Studio is needed.

Definitions, immutable definition revisions and connection settings are stored in
`~/.velocut/models/config.json` (override with `VELOCUT_MODEL_HOME`). YAML is the import/export
format; the local database keeps revision history so pending tasks retain their original
mapping after a definition edit. Token storage is a local plaintext file created with mode
0600 on POSIX, not an OS keychain. Configurations are separate from Codex's plugin cache.
HTTP administration accepts same-origin JSON POSTs; provider redirects are not followed with
credentials. Existing project jobs remain in the project's browser ledger. Changing connection
credentials/endpoints blocks those jobs until restored; changing a definition preserves its
previous revision for existing jobs. Recorded URL results stream through the local host without sending model credentials
to the result CDN. Caller-provided download URLs are not accepted. Reference uploads
still use the existing configured media storage transport.
