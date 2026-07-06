# Releasing

Velocut is a single-maintainer project; releases are manual and lightweight.
Packages are not yet published to npm/crates.io (they're `private`), so a
"release" today means tagging a coherent state of the repo.

## Before a release

1. **Engine consistency** — if anything touched engine behavior, confirm a
   golden vector covers it and both sides pass:
   ```bash
   cargo test
   cd web && npm test
   ```
2. **Type + build** — `cd web/apps/editor && npx tsc -b`, then `just build`
   (rebuilds the WASM engine and the app).
3. **WASM freshness** — if `crates/velocut-core` changed, rebuild the bundle
   (`just build-wasm`) so the canonical engine, not the TS fallback, is what
   ships.
4. **Hygiene** — no secrets, keys, `/Users/...` paths, or copyrighted media in
   the diff or working tree (`git status` should be clean of stray notes).

## Cutting the release

1. Update [CHANGELOG.md](CHANGELOG.md): move `[Unreleased]` items under a new
   version heading with the date.
2. Bump versions if publishing (all packages currently share `0.1.0`).
3. Tag: `git tag v0.1.0 && git push --tags`.

## When packages go public (future)

When there's a real downstream consumer, the plan is: give each package a
`build` producing `dist/*.js` + `dist/*.d.ts`, drop `private: true`, and adopt
[changesets](https://github.com/changesets/changesets) for multi-package
versioning. Rust crates publish independently via `cargo publish`; their
versions are **not** tied to the npm packages (mirroring biome/wasmtime).
Until then, the manual flow above is sufficient.
