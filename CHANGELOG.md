# Changelog

All notable changes to Velocut are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once packages
are published.

## [Unreleased]

### Added
- **Scene Director**: agent-driven 3D character & scene animation
  (`@velocut/scene-sdk`). Declarative SceneSpec v1 (characters with preset
  action sequences + cross-fades, keyframed positions/camera, environments,
  lighting, props) rendered deterministically through the existing
  compositor/export pipeline; CC0 starter assets (three.js RobotExpressive)
  with a license-vetted manifest; a structured scene inspector (form +
  raw-JSON escape hatch); a Director panel (orbit stage view, spec-camera
  frustum, drag-to-block writing back to the spec, camera-key list, scrub);
  and agent surfaces `velocut.sceneClip` / `velocut.sceneAssets` in the
  script sandbox, verified with a real LLM turn.
- Text selection quality: selection/edit boxes hug the font line box (not
  the padded raster frame), and in-place editing gains double-click word
  selection (`Intl.Segmenter`, CJK-aware) and triple-click select-all.

### Changed
- **Procedural specs live in the document** (`Asset.spec`, new
  `setAssetSpec` command; PROTOCOL_VERSION 2, document formatVersion 2 with
  automatic migration of stored motion specs). Spec edits — agent or UI —
  are now single attributed history nodes: undo/redo, branch checkout and
  multi-tab sync all carry them, and editing a spec recompiles the preview
  through one observer path.

### Fixed
- Re-attaching a procedural (motion/scene) source no longer leaks the old
  resident preview VideoFrame.

## [0.1.0] — 2026-07-08

First public release.

### Added
- The editor itself: an AI-native, local-first, browser video editor — a
  canonical Rust engine (→ WASM) mirrored by a TypeScript reference engine,
  kept in lock-step by shared golden vectors; WebGPU compositing + WebCodecs
  decode/export; an LLM agent editing through the same JSON command protocol
  as the UI; branching edit history; local-first persistence (OPFS +
  IndexedDB) with multi-tab CRDT sync.
- **Multi-project management**: a toolbar project switcher; every persistence
  surface (document, history, media, caches, motion specs) is isolated per
  project, and pre-existing data is adopted as the default project with zero
  data moves.
- **LLM provider settings**: any Anthropic-protocol-compatible relay/gateway
  via a configurable base URL, `x-api-key` or `Authorization: Bearer` auth,
  custom model ids, and a one-round-trip connection test.
- **Volume keyframes**: fade-in/out and ducking, authorable from the inspector
  and pinned by a golden vector.
- Persisted-document **format versioning**: a `formatVersion` anchor +
  migration chain stamped into the collab and history stores. Old data
  migrates up; data from a *newer* build is refused rather than silently
  corrupted.
- Declarative `motionClip`: motion graphics as a serializable JSON spec
  rendered by a fixed interpreter — persisted across reload, and safe to
  author from the sandboxed script tool.
- **Protocol hardening**: boundary-rejection golden vectors, cross-kind
  `moveClip` rejection (previously unenforced in both engines), a unified
  `hasAudio` default on the document-load path, integer-microsecond
  validation at the dispatch boundary, and `PROTOCOL_VERSION`.
- **Test suite**: unit tests for the agent tool-use loop (injected transport)
  and the effect/motion-spec registries; a Playwright E2E smoke suite; CI
  gates every PR on four jobs (Rust fmt+clippy+vectors, TS vectors+unit+tsc,
  WASM compile, E2E).
- Governance & docs: English-only source and docs (README keeps a `简体中文`
  variant), editor/agent screenshots, per-package usage examples,
  CODE_OF_CONDUCT, dependabot, issue/PR templates, a `justfile`, and this
  changelog.

### Changed
- `velocut_script` runs in a null-origin sandboxed iframe with a
  `connect-src 'none'` CSP and network-global hardening — the agent's scripts
  cannot read the API key or reach the network (see SECURITY.md).
- Package dependencies are declared honestly: each package lists its own
  runtime deps and the editor declares all internal packages.

### Fixed
- Switching projects could lose the last edits of the outgoing project: saves
  are debounced, and the navigation raced the write. App-controlled reloads
  now await a deterministic persistence flush (found by the E2E suite).
- `exactFrame` returned a resident VideoFrame that export/observe would close,
  freezing the preview permanently; it now returns a clone.
