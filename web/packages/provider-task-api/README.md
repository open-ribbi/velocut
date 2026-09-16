# @velocut/provider-task-api

Velocut's existing async task API protocol, packaged independently. Depends only
on `@velocut/provider-sdk`. It contains no UI, rendering, storage or vendor model
catalogue. Import `taskApiProvider` and register it with `ProviderRegistry`.

Configure `{baseUrl, models?}` and an `apiKey` credential reference. Model input
uses `prompt`, optional `durationS`, `ratio`, `resolution`, `generateAudio`,
`firstFrameReferenceId`, `lastFrameReferenceId`, `referenceImageIds` and
`referenceVideoIds`. Reference IDs resolve through the host's `resources.urlFor`;
arbitrary reference URL fields are rejected. The host chooses the applicable
upload transport and lifetime. An omitted model list means a dynamic channel,
not verified support for every possible model.

Submission maps to `POST /api/v1/tasks {model,params}` with Bearer authentication;
polling uses `GET /api/v1/tasks/{id}`. Completed results retain the URL, duration,
resolution, ratio and reported cost. Collection resolves that existing output;
the host downloads and stores bytes. Known HTTP rejection and unknown submission
outcomes are distinct. No paid submission is retried automatically. This protocol
has no assumed remote cancel, pricing or idempotency header support.

`TaskApiVideoGen` preserves the old render-sdk API through the same implementation.
The render-sdk root and `/videogen` subpath re-export it for existing consumers.
This source/local package is not yet published to npm.


## Model configuration and Ark

`modelSettings` selects a preset and optional additional scalar parameter fields.
The task API adapter forwards validated `parameters` into `params`, resolves
first/last frames and image/video/audio references, and accepts documented wrapped
responses (`data.task_id`/`data.id`, `data.result.url`). A Base URL ending in
`/api/v1` is normalized without duplicating the route. Presets use the actual
service model IDs from the referenced evo-backend mapping; users can edit those
IDs for aliases on compatible gateways.

`arkVideoProvider` is a separate registered protocol (`ark-video`) for
`/contents/generations/tasks` under the supplied Ark API base, usually ending in
`/api/v3`. It maps references into typed content with explicit media roles and
returns the completed content's video URL. It does not assume the task-gateway
request/response shape. The protocol selector in Studio includes both adapters.
