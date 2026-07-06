# Changelog

All notable changes to Velocut are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once packages
are published.

## [Unreleased]

Work toward the first public release. See [README](README.md) for current
capabilities. Highlights since the initial import:

### Added
- Declarative `motionClip`: motion graphics are now a serializable JSON spec
  (keyframed layers) rendered by a fixed interpreter — persisted across reload,
  and safe to author from the sandboxed script tool.
- GitHub Actions CI: Rust + TS golden-vector tests, `tsc`, and a WASM compile
  smoke test on every PR.
- English README (with a `简体中文` version), per-package READMEs, a `justfile`
  task runner, issue/PR templates, and this changelog.

### Changed
- `velocut_script` now runs in a null-origin sandboxed iframe with a
  `connect-src 'none'` CSP and network-global hardening — the agent's scripts
  can no longer read the API key or reach the network (see SECURITY.md).
- Package dependencies are now declared honestly: each package lists its own
  runtime deps and the editor declares all internal packages.

### Fixed
- `exactFrame` returned a resident VideoFrame that export/observe would close,
  freezing the preview permanently; it now returns a clone.
- Moved an internal red-team note out of the repo and hardened `.gitignore`;
  fixed a broken code fence in ARCHITECTURE.md.

## [0.1.0] — initial import

- AI-native, local-first, browser video editor: canonical Rust engine (→ WASM)
  mirrored by a TypeScript reference engine, kept in lock-step by shared golden
  vectors; WebGPU compositing + WebCodecs decode/export; an LLM agent editing
  through the same JSON command protocol as the UI; branching edit history;
  local-first persistence (OPFS + IndexedDB) with multi-tab CRDT sync.
