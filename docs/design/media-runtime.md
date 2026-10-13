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
