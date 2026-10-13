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
closed and reopened at a keyframe. Flushes retain their lease until the codec
closes, and stream errors reject consumers rather than masquerading as EOF.
Same-source exact requests are serialized.
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

Storage quota/write errors fail visibly and clean up the attempted file; they do
not fall back to an unbounded in-memory mux. The compatibility memory path is
used only when streaming file APIs are absent.

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

## 3. Reproducible performance baselines

From `web/`, build once and keep that build unchanged during measurement:

```sh
npm run build
npm run test:benchmark-media
npm run benchmark:media -- --profile quick --samples 5 --out ../artifacts/media-benchmark/baseline.json
npm run benchmark:media -- --profile quick --samples 5 --baseline ../artifacts/media-benchmark/baseline.json --out ../artifacts/media-benchmark/current.json
npm run benchmark:media -- --profile standard --samples 5 --out ../artifacts/media-benchmark/standard.json
```

The default uses the full Chromium new-headless channel and requests native GPU
execution. If it receives SwiftShader/software rendering it fails explicitly.
`--browser chrome` selects installed Chrome; `--gpu software` explicitly selects
the software configuration for CI. Native and software runs cannot be compared.
All runs use fresh browser contexts and loopback-only static serving; they do not
load personal browser profiles, model credentials, projects or external services.
Generated input bytes are cached under `artifacts/media-benchmark/fixtures-v1/`
and hashed so reruns use identical compressed video and PCM files.

| Workload | Quick | Standard | Measurements |
| --- | --- | --- | --- |
| AVC video | 4K, 2 s, 12 fps | Same input | Frame-exact random seek, fresh proxy generation |
| Timeline | 4 tracks × 25 clips, 4 source videos | 8 tracks × 200 clips, 4 source videos | Source-ready seek acknowledgement, 100 evaluations, 2-second export, preview queue telemetry |
| Audio | 60-second mono WAV | 600-second mono WAV | Full import/PCM cache creation, random 1-second PCM reads |
| 3D | 256 instances, 8 animated groups | 4,096 instances, 8 animated groups | Scene creation, pose/render submission, 2-second export |

Repeated timings exclude an explicit warmup and include raw samples plus
nearest-rank p50/p95. Import/scene-creation values have one sample and are diagnostic
only. Small-sample p95 is not a stable production latency promise. The comparison
checks matching OS/CPU/GPU/browser, profile, sample count, recipe and fixture
hashes before applying its default 30% and 5 ms regression thresholds; both must
be exceeded. Missing metrics, invalid samples and partial runs fail closed.
Exit codes: 0 complete/no regression, 1 detected regression, 2 failed/incompatible
run. A build/recipe change during a run invalidates that run.

`velocut.diagnostics()` exposes bounded preview and media telemetry. The preview
queue is capped at two in-flight messages; an admission drop invalidates a paused
view when a slot frees, so the latest seek is eventually rendered. Acknowledgement
latency measures worker consumption/render submission, not OS presentation or
GPU completion. Source readiness additionally checks missing media and source
frame timestamps. Counts of admission drops are not display-frame drop counts.
Telemetry retains at most 512 acknowledgement timings.

Reports include event-loop timer gaps/long tasks, main-isolate heap readings after
forced GC, media cache estimates, pending requests and the actual WebGPU adapter.
They do not measure total browser/worker/native memory or total VRAM. Synthetic
short video stresses resolution and concurrent decoding, not multi-hour GOP
indexes or tens-of-gigabytes disk I/O. HDR, VFR, HEVC long-GOP and real large-file
fixtures remain additional profiles to add; do not extrapolate capacity limits
from this initial suite.
