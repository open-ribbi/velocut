# Media runtime hardening

This work preserves the existing browser engine and adds host-level ownership
and admission boundaries. Desktop hosts can later replace media implementations
without changing document semantics.

## 1. Media scheduling

`MediaTaskScheduler` is shared by media libraries within one JavaScript realm.
It admits two codec operations and one heavyweight job by default, bounds the
waiting queue to 128, and orders queued work as preview, observation, export,
then proxy. Active playback defers proxies. Foreground work aborts a running
proxy attempt, waits for its cleanup, and restarts it when the foreground is
idle. Exports and other non-replayable operations are never automatically
restarted. Separate tabs/processes do not share this scheduler.

Each media worker owns an LRU budget of four video decoders. Exact requests and
streaming transcodes pin their decoders; idle preview/export decoders can be
closed and reopened at a keyframe. Same-source exact requests are serialized.
Audio requests use the host codec lane. These bounds are application policies,
not a claim about a machine's hardware-session limit.

The library bounds preview caches on arrival, including paused/inactive assets.
The default budget is 128 MiB estimated as width × height × 4 per frame; one
oversized frame may remain so an 8K source is not made permanently black.
The shared preview budget trims look-ahead before removing the last frame of an
active source. Requests for already delivered but evicted timestamps explicitly
restart decoding; backward seeks also restart from a preceding keyframe instead
of mistaking an advanced decode cursor for available cached frames.
Worker exact-frame rings use a 32 MiB estimate per source with the same one-frame
minimum. These estimates exclude decoder-internal surfaces, renderer clones,
textures and GPU-driver allocations; they are not measurements of total VRAM.

Pending requests have a 30-second deadline. A timeout or worker failure rejects
pending work and terminates that library's worker. Disposal cancels queued jobs,
releases playback ownership, closes cached frames and rejects unresolved calls.
Late transferred frames are closed even after their caller has gone away.

Proxy attempts always close encoders/streams and abort incomplete writable files.
Only complete files receive the completion marker. Proxy timestamps retain source
time, including input below the requested proxy frame rate. Automatic proxy
creation remains opt-in; resource policies are configurable and should be tuned
using the performance suite before changing that default.

Validation: full TypeScript/production build; 227 Node tests including queue
priority, cleanup-before-restart, cancellation, decoder LRU pinning, frame cache
bounds and worker deadlines; browser tests cover real proxy preemption/source
time, MP4 varispeed/audio automation, captions and preview/MCP controls.

## 2. Export isolation

Studio's `startFilmExport` captures a document/revision and immutable source
identities synchronously at submission. Queued jobs never reread the live store.
The evaluator, audio automation and scene/motion specs all come from that same
snapshot. Each admitted job opens a private MediaLibrary/worker; procedural
sources are compiled independently, and released with the private session.
Imported video File identities and cloned images survive disposal of the live
library. PCM cache Files are captured before queueing. External procedural URLs
and fonts are resolved during preparation; this is not an archival bundle of
external services or fonts.

Jobs expose queued/preparing/rendering/completed/cancelled/failed states, an ID,
source revision, a result Promise and cancellation. The browser host exposes
`velocut.exportFilm(options)` for integrations in the same page. Job objects and
Blob results are local objects, not JSON MCP response payloads. Closing/reloading
the browser still ends its jobs; durable background export requires a desktop or
server host. Retrying starts a new explicit job/snapshot, not an automatic replay.

Every export attempt uses a UUID-named OPFS file. Failed/cancelled attempts abort
and remove their own files; successful outputs stay owned by their consumer.
Call `job.releaseOutput()` or `releaseExportOutput(blob)` after consuming them.
Studio provides a clear-temporary-exports action after downloads finish because
ordinary browser downloads offer no reliable completion callback. It never
removes another export's output or the previous output when a new job starts.
Do not delete a successful output while a download is still reading it. Completed
files are not automatically swept across reloads in this phase.

Validation: production build and 229 Node tests; real browser exports exercise
queued revisions with different colors, edits during 3D export, queued/running
cancellation, injected failure cleanup, independent output deletion and a later
successful job. Existing audio/caption and proxy scheduling regressions remain
part of the validation set.
