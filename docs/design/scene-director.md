# Scene Director — agent-driven 3D character & scene animation

| | |
|---|---|
| Status | Implemented through P3 (M0 cbfb11b · P0 25e73b4 · P1 13b9aeb · P2 a2a5722 · P3 84c9e8d); hybrid rendering (below) is the committed next direction |
| Date | 2026-07-08 |
| Scope decision | MVP = scene + camera moves + preset character actions; assets = built-in CC0 starter library |

## Motivation

Velocut's agent can already cut, grade, caption and author 2D motion graphics.
The next expressive tier is *staged* content: put characters in a 3D set, give
them actions, direct the camera, and get an animated shot on the timeline —
what director-console products expose as a stage view with blocking, shots and
camera moves. In Velocut the **agent is the director**: "a character walks
into the living room, sits down, the camera pushes in from the doorway" should
compile to a deterministic, editable clip.

The end-game is **hybrid rendering**: diffusion-video platforms (LibTV,
TapNow — model aggregation over an infinite canvas) direct the *generator*
through prompts and get cinematic pixels with probabilistic control; Velocut
directs the *stage* and gets deterministic, editable control with modest
pixels. The Scene Director's deterministic per-frame output is, by
construction, ideal conditioning input for those generators — so the plan is
to use staged clips as the controllable skeleton and generation as the
optional skin (see "Hybrid rendering" below), rather than compete on raw
image quality.

**Agent-first, human-adjustable** is a core requirement, not a later phase:
everything the agent authors must be manually editable in the UI, and both
paths edit the *same spec through the same host API* — the SceneSpec analog of
the existing rule that the agent and the UI speak one command protocol. The
MVP ships with a structured spec editor (inspector forms); the 3D stage view
is a richer editing surface layered on the same seam later.

## Non-goals (MVP)

- No lip-sync, no TTS-driven dialogue animation (phase 3 candidate).
- No physics, cloth, hair springs — nothing frame-order-dependent.
- No external generation services (text-to-3D, motion synthesis). The asset
  registry is designed so these can slot in later, but local-first ships first.
- No character import (VRM/GLB) in the MVP; registry-listed built-ins only.
- No 3D stage view (orbit camera, drag gizmos) in the MVP — but manual
  editing itself is IN scope from day one, via the structured inspector
  (see UI section). Only the *viewport manipulation* surface is deferred.

## Prior art in this repo: the motionClip seam

motionClip established the exact shape this feature needs, end to end:

| Seam | motionClip today | Scene Director |
|---|---|---|
| Declarative spec | `MotionSpec` (motionspec.ts) | `SceneSpec` |
| Validation | `validateMotionSpec()` | `validateSceneSpec()` |
| Persistence | IndexedDB `motion:<project>:<assetId>` — **replaced by in-document specs, see "Spec history"; motion is retrofitted first** | document state (`Asset.spec`) |
| Asset URL | `src: 'motion://…'` | `src: 'scene://…'` |
| Compiled form | `CompiledMotion { load(), render(index): VideoFrame }` | `CompiledScene`, same interface |
| Frame delivery | `MediaLibrary` procedural source map; 1 resident preview frame; fresh frames for export | identical |
| Entry point | `createMotionClip()` (services/motion.ts), exposed as `window.velocut.motionClip` | `createSceneClip()` / `window.velocut.sceneClip` |
| Agent surface | `velocut.motionClip()` RPC inside the `velocut_script` sandbox | `velocut.sceneClip()` RPC, same sandbox |
| Reload path | `restoreMotionClip()` re-attaches from the persisted spec | `restoreSceneClip()` |

Two properties of that seam are load-bearing and must be preserved:

1. **Pure data, no code.** The spec is JSON interpreted by a fixed renderer.
   The agent sandbox threat model (null-origin iframe, `connect-src 'none'`)
   stays intact because a SceneSpec can express nothing but scene state.
2. **Pure function of time.** `render(index)` must depend only on the spec and
   the frame index — that is what makes preview, scrubbing and frame-exact
   export agree, and it is why physics is out of scope.

## Architecture

### New package: `@velocut/scene-sdk`

Owns Three.js (WebGL2 on an `OffscreenCanvas`), GLTF loading, the SceneSpec
schema/validator/compiler, and the built-in asset registry. `render-sdk`
stays three-free: `MediaLibrary` already consumes procedural sources through
the narrow `{ width, height, frameDurUs, frameCount, load(), render(index) }`
shape, so the only render-sdk change is generalizing the motion-source map to
accept any such source (`attachProceduralSource(assetId, source)`), which
motionClip then also uses.

Three.js is imported dynamically on first `sceneClip` call so the editor's
initial bundle does not pay for it (~170 KB gz + assets).

The compositor is WebGPU; the scene renderer is a separate WebGL2 context.
They exchange `VideoFrame`s exactly like decoded video does today, so there is
no context interop — only the usual GPU time budget to watch (see Risks).

### SceneSpec (v1 outline)

Reuses the `Animatable = number | MotionKeyframe[]` pattern (seconds, value,
GSAP ease names) from MotionSpec verbatim — one keyframe grammar for agents to
learn. `Vec3A = { x?: Animatable; y?: Animatable; z?: Animatable }`.

```ts
interface SceneSpec {
  version: 1;
  durationUs: number;
  width?: number; height?: number; fps?: number;   // default: doc size, 30
  environment: string;              // registry id, e.g. 'env/living-room'
  lighting?: 'day' | 'night' | 'indoor';           // preset rigs
  characters?: Array<{
    id: string;                     // spec-local name, referenced by camera
    model: string;                  // registry id, e.g. 'char/adventurer'
    position?: Vec3A;               // world units (meters); root motion comes
    rotationY?: Animatable;         //   from keyframing these, not from clips
    scale?: number;
    actions?: Array<{               // preset animation clips, sequenced
      clip: string;                 // registry clip id: 'walk', 'sit', 'wave'…
      start: number;                // seconds
      end?: number;                 // default: next action or spec end
      loop?: boolean;               // default true for locomotion clips
      fade?: number;                // cross-fade seconds into this action
    }>;
  }>;
  props?: Array<{ id: string; model: string; position?: Vec3A;
                  rotationY?: Animatable; scale?: number }>;
  camera: {
    fov?: Animatable;               // default 40
    position: Vec3A;
    lookAt: Vec3A | { character: string };   // track a character by id
  };
}
```

Shots/cuts are expressed with step-eased camera keyframes (`ease: 'steps(1)'`
already exists in the GSAP vocabulary); if that proves awkward for agents in
practice, an explicit `shots[]` sugar can compile down to the same keyframes
in v2 without touching the renderer.

Walking is `clip: 'walk'` (in place) plus keyframed `position` — the agent
matches move speed to the clip's natural gait (the registry doc states each
locomotion clip's m/s so the agent can compute keyframe spacing). This is the
standard MVP trade; root-motion extraction can replace it later without a
schema change.

### Determinism

- Animation sampling uses `AnimationMixer.setTime(t)` per rendered frame —
  stateless with respect to previous frames.
- Cross-fades are computed from declared `fade` windows, not from wall-clock
  transitions.
- No physics, no `Math.random`, no time-of-day defaults.
- `load()` resolves all GLTFs/textures before the first `render()`, mirroring
  the motion compiler's font/image preload, so export never awaits mid-stream.

### Built-in asset registry

A manifest (`scene-assets/manifest.json` under `public/`, shipped with the
app) lists every asset with id, display name, license, file, and for
characters the available animation clips with their gait speeds:

```ts
interface SceneAssetManifest {
  characters: Record<string, { file: string; license: string;
    clips: Record<string, { durS: number; loop: boolean; speedMps?: number }> }>;
  environments: Record<string, { file: string; license: string; ground: number }>;
  props: Record<string, { file: string; license: string }>;
}
```

Starter pack (all CC0, vetted before vendoring — license files ship alongside):

- **Characters**: Quaternius *Universal Animated* pack (rigged, comes with
  idle/walk/run/sit/wave/interact clips baked into the GLB — no retargeting
  needed, which is the single biggest scope cut in this design).
- **Environments**: a small set of Kenney / Quaternius low-poly interiors and
  exteriors (living room, office, street, forest).
- **Props**: a curated few dozen Kenney objects.

The registry is the extension point for everything deferred: user-imported
GLB/VRM later becomes a dynamic registry source backed by OPFS; an external
generation service becomes a registry source that resolves ids to fetched
assets. Neither changes SceneSpec.

`scenePromptDoc()` (analogous to `effectPromptDoc`) renders the manifest into
the agent-facing vocabulary: asset ids, clip names, gait speeds, environment
bounds. This is what makes the agent's output *grounded* — it can only name
things that exist.

### Agent surface

`velocut.sceneClip(opts)` joins the `velocut_script` sandbox RPC list
(`RPC_METHODS` in services/script.ts), with the same host-side flow as
motionClip: validate → dispatch the creation batch (spec travels inside the
document, see "Spec history") → compile → attach → return
`{ok, assetId, clipId, trackId, durationUs}`.
The `velocut_script` docstring gains the SceneSpec schema, the vocabulary doc,
and one worked example (character walks to a chair and sits; camera pushes in;
one cut to a close-up). Editing an existing scene = `sceneClip` with the
`assetId` to replace — same replace-don't-mutate convention as motion.

### UI (phased) — manual adjustment is MVP scope

Both surfaces below are *editors over the spec*: every change revalidates,
persists, recompiles and refreshes the preview through the exact host path the
agent uses (`sceneClip` with the existing `assetId`). There is no UI-only
state; anything a human adjusts, the agent sees on its next turn, and vice
versa.

- **MVP — Scene inspector (structured editor)**: selecting a scene clip opens
  a form view of the spec in the existing inspector:
  - per-character: model picker (registry), position/rotationY keyframe rows,
    action list (clip picker + start/end/loop/fade fields);
  - camera: fov/position/lookAt keyframe rows, "track character" toggle;
  - environment & lighting pickers;
  - a raw-JSON tab (edit + validate) as the escape hatch for anything the
    forms don't surface yet.
  Cheap to build (forms, no 3D viewport), and it guarantees the
  human-adjustable requirement from the first release.
- **Phase 3 — Director panel (stage view)**: orbit camera over the compiled
  scene, drag characters/props with gizmos (writes position keyframes back to
  the spec), camera handles, shot list, scrub-linked preview. A richer input
  device for the same fields the inspector edits.

**Undo/redo**: full history support for spec content edits is a hard
requirement and gets its own section below — specs move *into* the document
model, so every adjustment (agent or human) is a history node like any other
command.

## Spec history — specs are document state

### Requirement

Every spec content edit — an agent turn rewriting a scene, a human nudging a
camera keyframe in the inspector — must participate in the full history
model: undo/redo, the branching history board (jump to any node, branch from
it), actor attribution, and multi-tab sync. Not best-effort; by construction.

### Why the current storage cannot satisfy it

Velocut has **three history layers, and all three are whole-document
snapshots**:

1. Engine undo (`engine.rs`): `undo: Vec<Document>` — every apply pushes a
   full snapshot.
2. Editor branching history (`state/history.ts`): a git-style `HistoryTree`
   where **every node carries a complete `VDocument` snapshot** plus actor
   attribution; undo/redo/`jumpTo(id)` load a node's snapshot wholesale.
3. Collab (Yjs CRDT): the document is the synced unit; persistence and
   multi-tab merge operate on it.

Specs today live in an IndexedDB kv store (`motion:<project>:<assetId>`)
that is *invisible to all three layers*. No parallel mechanism can patch
this: `jumpTo` an arbitrary branch node must atomically restore the spec
state at that node, which is exactly "snapshot the spec with the document" —
anything else (a shadow journal keyed to history node ids, versioned kv)
re-implements snapshots poorly and desynchronizes on prune/branch/multi-tab.

### Options considered

| | Mechanism | Verdict |
|---|---|---|
| **A. Specs in the document** | `Asset.spec` opaque JSON string; a `setAssetSpec` protocol command | **Chosen.** All three history layers, CRDT sync, branch jump, attribution and persistence work with zero new machinery — snapshots simply carry the spec. |
| B. Immutable specs + asset swap | Every edit mints a new assetId; a command swaps the clip's asset | GC of orphaned specs must trace reachability across *all* history branches incl. pruned ones — effectively unsolvable without walking every snapshot; asset identity churn breaks references (camera `lookAt.character`, inspector selection); kv write vs doc update ordering races multi-tab. |
| C. Parallel spec journal | Keep kv, add an undo journal coordinated with the store | Two sources of truth; `jumpTo`/prune/branch-switch cannot be made atomic across them; reinvents layer 2 badly. |

### Design (A)

**Model.** `Asset` gains `spec?: string` (JSON-serialized, absent for media
assets). It is an **opaque string to the engines**: Rust stores
`Option<String>`, TS mirrors it, neither interprets the contents. The
`src` scheme (`motion://` / `scene://`) remains the router that tells the
render layer which interpreter owns the spec. Spec *content* validation
(SceneSpec/MotionSpec schemas) happens at the host API layer before
dispatch, where the interpreters live — the timeline engines must not grow
a rendering vocabulary, and golden vectors pin storage semantics only.

**Protocol.**
- `setAssetSpec { assetId, spec: string | null }` — replace (or clear) an
  asset's spec. Errors: `notFound` (no such asset), `invalidArg` (spec is
  not parseable JSON, or exceeds the size cap — proposal 256 KB).
- `addAsset` gains optional `spec`, so procedural asset creation is atomic.
- Dispatch-boundary validation checks JSON-parseability + cap only.
- New golden vector `10_asset_specs.json`: set / replace / clear / load with
  spec present / `notFound` / oversized+unparseable rejections / undo / redo.
- `PROTOCOL_VERSION` → 2, persisted-document `formatVersion` bump with a
  migration that folds each `motion:<project>:<assetId>` kv entry into its
  asset's `spec` and deletes the kv key. Older builds refuse newer docs —
  already the designed formatVersion behavior.

**Creation flow.** `createMotionClip`/`createSceneClip` dispatch one
`batch` — `[addAsset(with spec), addTrack?, addClip]` (asset ids are
deterministic mints, so the host computes the id the same way the engine
will) — which records as **one history node**: undoing an agent-created
scene removes it atomically, and the node carries `actor: ai` + the prompt,
so the history board attributes it.

**Edit flow.** Inspector field commit / agent revision = one `setAssetSpec`
dispatch = one attributed history node (`describeCommand` gains a label,
e.g. "Edit scene"). During a live drag the inspector uses a transient
compiled-scene override and dispatches once on gesture end — the same
ghost-then-commit pattern the transform gizmos use today.

**Render side.** The store already re-renders on document revision; a
procedural-source observer diffs `asset.spec` on revision bump and
re-attaches the compiled source. Undo, redo, branch jump and *remote* edits
(other tab, other peer) all arrive as document changes, so recompile-on-spec-
change is one code path with no special cases. This also fixes a latent
motionClip gap: today another tab never sees a spec change until reload.

**CRDT semantics.** The spec syncs as one atomic string value —
last-writer-wins per edit, no intra-spec merging. That is the desired
granularity: a half-merged scene is worse than a lost race, and the history
board holds every version anyway.

### Cost accounting

- **Engines**: one model field + one command + vectors, both engines.
  Mechanical; the Rust side is `Option<String>` + a match arm.
- **History size**: `HistoryTree` keeps ≤ 400 nodes, each a full document
  snapshot — specs multiply into that. Bounded by the 256 KB cap and, in
  practice, KB-scale specs; same-realm `structuredClone` shares immutable
  string storage so the memory cost is far below the naive 400×. The
  *serialized* history store does duplicate the string per node; if that
  ever bites, dedup-by-content-hash in `serialize()` is a contained
  optimization. Not needed up front.
- **Yjs update log**: whole-string replace per edit accumulates; the
  existing persistence compaction owns this (same class as any chatty
  command stream).
- **Migration risk**: kv → document fold is per-project and idempotent
  (missing kv entry → spec stays absent, renderer shows the existing
  missing-spec error card). History stores migrate through the established
  `formatVersion` chain in `HistoryTree.deserialize`.
- **Docs**: PROTOCOL.md (+command, +field), ARCHITECTURE.md (procedural
  assets section), agent prompt docs.

### Sequencing

This lands as **M0, before any 3D work**, by retrofitting motionClip: same
seam, existing feature, existing tests prove it (unit + vectors + E2E), and
the scene work then builds on a paved road instead of migrating twice.

## Implementation plan

| Phase | Deliverable | Size |
|---|---|---|
| M0 | **Specs become document state** (see "Spec history"): `Asset.spec` + `setAssetSpec` in both engines, golden vector, formatVersion migration folding motion kv specs into the document, motionClip retrofit (creation batch, observer-driven recompile), PROTOCOL/ARCHITECTURE docs | M–L |
| P0 | Pipeline spike: `scene-sdk` with hard-coded cube + camera keyframes rendering through `attachProceduralSource` to timeline + export | S |
| P1 | SceneSpec v1: schema, validator, compiler (characters + actions + camera), asset manifest + CC0 pack vendoring, `sceneClip` host API + restore path, **scene inspector (structured manual editing)** | L |
| P2 | Agent enablement: sandbox RPC, `scenePromptDoc`, docstring + example, real-LLM verification via the claude-plus proxy flow | M |
| P3 | Director panel (stage view, drag-to-blocking, shot list) | L |
| P4 | **Hybrid rendering** (previz → video generation), see the dedicated section | L |
| P5+ | Dialogue/TTS + lip-sync, GLB/VRM import, root motion, text-to-3D asset sources | — |

## Hybrid rendering — previz → video generation

The committed follow-up direction: a staged scene clip becomes the
*conditioning skeleton* for a diffusion video generator, marrying our
deterministic control with generative image quality.

**Why our side needs zero pipeline changes.** A scene clip already produces
exactly what conditioning needs: frame-exact renders (`CompiledScene.render`),
a camera trajectory, character poses over time, and a bounded duration — and
the existing exporter can emit any scene segment as a clean mp4/frames today.
The generated result comes back as an ordinary imported asset. Everything new
lives beside the pipeline, not inside it.

**What actually gets built:**

1. **Generation-provider registry** — the `TtsProvider` registry
   (render-sdk/tts.ts) is the exact precedent: `VideoGenProvider { id, label,
   modes: ['i2v','v2v','keyframes'], generate(inputs, opts) → asset bytes }`,
   configured like the LLM relay settings (base URL + key in localStorage,
   BYOK, connection test). Kling/Wan/Seedance-class APIs slot in as entries;
   local ComfyUI too.
2. **Conditioning export** — per provider mode: first/last frame stills
   (i2v), the full previz segment (v2v / video-conditioning), or, for
   control-net-style APIs, auxiliary passes (depth, lineart) — three.js can
   render a depth pass from the same stage in a few lines when a provider
   wants it.
3. **Stylize surface** — inspector/Director gain "Generate styled render":
   pick provider + style prompt → async job → result lands as a NEW asset
   placed beside (or replacing) the scene clip, with the scene clip kept as
   the editable source of truth. Regenerating = re-run from the same skeleton.
   The agent gets the same verb (`velocut.stylizeScene({clipId, provider,
   prompt})`) in the script sandbox.
4. **Consistency dividend** — the pitch that makes this more than a feature:
   multi-shot character/scene consistency is diffusion platforms' structural
   weakness, and conditioning every shot on the SAME 3D stage anchors
   identity, layout and camera geometry across shots for free.

**Trust boundary note:** provider calls are host-side network egress with the
user's key — they belong with the other host tools (tts/search), NEVER
callable with attacker-controlled URLs from the script sandbox; the provider
list is user-configured, the sandbox only names a registered provider id.

Each phase lands green (unit + E2E) before the next starts. P0 proves the two
risky integrations (WebGL2 `OffscreenCanvas` → `VideoFrame` → WebGPU
compositor; export determinism) before any schema work.

## Testing

- **Unit (node)**: `validateSceneSpec` acceptance/rejection table; action
  sequencing math (start/end/fade resolution); camera keyframe sampling
  (pure functions, no GL needed).
- **Scene-graph goldens**: for a golden spec, snapshot the *evaluated scene
  state* (object transforms, active clip + local time, camera pose) at fixed
  times — pins determinism without pixel-comparing GL output across GPUs.
- **E2E smoke**: create a minimal scene clip via `window.velocut.sceneClip`,
  assert the clip exists, a preview frame arrives, and it survives reload
  (spec restore path). Skips pixel assertions, same GPU-less-CI stance as the
  existing suite.

## Risks

| Risk | Mitigation |
|---|---|
| GPU contention: scene GL render + WebGPU compositing per frame | Scene renders only when its clip is under the playhead; 1 resident preview frame (motion parity); export is pull-based so it just slows, not breaks |
| Bundle size (three.js + loaders) | Dynamic import on first use; assets fetched on demand from `public/scene-assets/` |
| CC0 pack provenance | Vendor with per-asset license files; verify at vendoring time; no Mixamo (redistribution not permitted) |
| Agent authors invalid/ungrounded specs | Registry-driven vocabulary in the prompt; validator errors are returned verbatim as tool results so the agent self-corrects (motion parity) |
| Walk speed vs position keyframes mismatch looks skatey | Gait speeds in the manifest + prompt guidance; acceptable MVP artifact, root motion later |
| three.js WebGPU renderer temptation | Stay on WebGL2 until three's WebGPU path is stable; the seam (VideoFrame out) hides the choice |
| History bloat from spec snapshots | 256 KB spec cap; `structuredClone` shares immutable strings in memory; dedup-by-hash in history serialization as a contained fallback |
| formatVersion migration (kv → document) | Idempotent per-project fold; missing kv entry degrades to the existing missing-spec error card; downgrade protection already designed (newer-format refusal) |

## Open questions

1. Default scene clip fps: 30 (motion default) or follow doc fps? Proposal: 30.
2. Should the "Scenes" track reuse the Graphics track motion uses, or get its
   own? Proposal: own track, name `Scenes`.
3. Environment scale conventions (meters) need one worked reference scene to
   calibrate agent spatial reasoning; pick the living-room env as canonical.
4. Spec size cap: 256 KB proposed — generous for scenes (KB-scale), small
   enough to bound history snapshots. Confirm against the largest realistic
   agent-authored scene before freezing the vector.
