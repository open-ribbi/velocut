# Scene Director — agent-driven 3D character & scene animation

| | |
|---|---|
| Status | Draft for review |
| Date | 2026-07-08 |
| Scope decision | MVP = scene + camera moves + preset character actions; assets = built-in CC0 starter library |

## Motivation

Velocut's agent can already cut, grade, caption and author 2D motion graphics.
The next expressive tier is *staged* content: put characters in a 3D set, give
them actions, direct the camera, and get an animated shot on the timeline —
what director-console products expose as a stage view with blocking, shots and
camera moves. In Velocut the **agent is the director**: "a character walks
into the living room, sits down, the camera pushes in from the doorway" should
compile to a deterministic, editable clip. A stage-manipulation UI comes
later; the spec is the product, the UI is a viewer/refiner over it.

## Non-goals (MVP)

- No lip-sync, no TTS-driven dialogue animation (phase 3 candidate).
- No physics, cloth, hair springs — nothing frame-order-dependent.
- No external generation services (text-to-3D, motion synthesis). The asset
  registry is designed so these can slot in later, but local-first ships first.
- No character import (VRM/GLB) in the MVP; registry-listed built-ins only.
- No stage-editing UI beyond selecting/trimming the clip; the agent (and
  `window.velocut.sceneClip` for humans) is the only author at first.

## Prior art in this repo: the motionClip seam

motionClip established the exact shape this feature needs, end to end:

| Seam | motionClip today | Scene Director |
|---|---|---|
| Declarative spec | `MotionSpec` (motionspec.ts) | `SceneSpec` |
| Validation | `validateMotionSpec()` | `validateSceneSpec()` |
| Persistence | IndexedDB `motion:<project>:<assetId>` | `scene:<project>:<assetId>` |
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
motionClip: validate → persist spec → compile → attach → place clip on a
"Scenes" track → return `{ok, assetId, clipId, trackId, durationUs}`.
The `velocut_script` docstring gains the SceneSpec schema, the vocabulary doc,
and one worked example (character walks to a chair and sits; camera pushes in;
one cut to a close-up). Editing an existing scene = `sceneClip` with the
`assetId` to replace — same replace-don't-mutate convention as motion.

### UI (phased)

- **MVP**: none beyond the timeline clip itself (select, move, trim — all free
  from the existing clip machinery). Inspector shows "Edit via agent" and the
  raw spec (read-only JSON view).
- **Phase 2 — Director panel**: stage view (orbit camera over the compiled
  scene), drag characters/props (writes position keyframes back to the spec),
  shot list, scrub-linked preview. Human refinement of agent output through
  the same spec — the UI/agent symmetry Velocut already has for commands.

## Implementation plan

| Phase | Deliverable | Size |
|---|---|---|
| P0 | Pipeline spike: `scene-sdk` with hard-coded cube + camera keyframes rendering through `attachProceduralSource` to timeline + export | S |
| P1 | SceneSpec v1: schema, validator, compiler (characters + actions + camera), asset manifest + CC0 pack vendoring, `sceneClip` host API + restore path | L |
| P2 | Agent enablement: sandbox RPC, `scenePromptDoc`, docstring + example, real-LLM verification via the claude-plus proxy flow | M |
| P3 | Director panel (stage view, drag-to-blocking, shot list) | L |
| P4+ | Dialogue/TTS + lip-sync, GLB/VRM import, root motion, external generation sources | — |

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

## Open questions

1. Default scene clip fps: 30 (motion default) or follow doc fps? Proposal: 30.
2. Should the "Scenes" track reuse the Graphics track motion uses, or get its
   own? Proposal: own track, name `Scenes`.
3. Environment scale conventions (meters) need one worked reference scene to
   calibrate agent spatial reasoning; pick the living-room env as canonical.
