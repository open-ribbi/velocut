# Independent SDKs, Studio and MCP

The monorepo produces seven public-package candidates at version 0.1.0. No
registry publication is performed by build/test commands. Replace the example
version only with a release that actually exists in your registry.

| Package | Environment | Public responsibility |
| --- | --- | --- |
| `@velocut/protocol` | Node/browser | Document and command contract, validation, bridge compatibility |
| `@velocut/core-ts` | Node/browser | Pure timeline engine and evaluation; no GPU required |
| `@velocut/render-sdk` | Browser | WebGPU, WebCodecs, workers, audio, export, observation |
| `@velocut/scene-sdk` | Pure edits: Node/browser; rendering: browser | SceneSpec, geometry, GLB, physics, cameras, bundled assets |
| `@velocut/runtime` | Project rendering/host: browser | Shared authoring, history, storage injection and MCP host dispatch |
| `@velocut/mcp` | Node 22.6+ | Client-independent MCP stdio process and loopback pairing |
| `@velocut/cli` | Node 22.6+ plus browser | Prebuilt local editor server and environment check |

All SDKs ship ESM JS and declarations tested with TypeScript 5.9.3. They do not
require a TypeScript loader. CommonJS SDK entry points and a Node/headless GPU
renderer are not provided. MCP uses a bundled CJS executable for portability.
The root workspace, UI, collaboration glue and built-in provider agent remain
private packages. Public packages declare their dependencies explicitly; the
runtime does not import application files or require React.

## Build and use without a registry

From `web/`:

```sh
npm ci
npm run build:release
npm run pack:release
```

The generated `artifacts/` directory (repository root) contains:

- Seven `.tgz` npm packages and `manifest.json` with versions and SHA-256 hashes.
- `velocut-0.1.0/`: a relocatable standalone distribution. Run
  `node start-studio.mjs` there. Its `studio/` includes the prebuilt UI, scene
  assets and bundled browser dependencies; npm install is unnecessary.
- The same standalone directory is a Codex marketplace with
  `.agents/plugins/marketplace.json` and `plugins/velocut/`. Add this directory
  as a marketplace source, then install the plugin and start a new task.

For a separate npm consumer, create a new directory and install the relevant
`.tgz` files. Before initial registry publication, install **all dependent
Velocut tarballs in the same npm command**, so npm can resolve their exact
versions locally. `npm run test:distribution` demonstrates this outside the
checkout and rejects workspace symlinks.

For users who only need the product, the CLI tarball has no npm runtime
dependencies. The MCP package bundles its executable dependencies; it still
requires a running editor and a browser pairing. Neither includes Node itself.

## Integrate the SDKs

- [TS core](../../web/packages/core-ts/README.md): direct engine command/evaluation example.
- [Renderer](../../web/packages/render-sdk/README.md): FrameGraph → GPU canvas, workers and cleanup.
- [Scene SDK](../../web/packages/scene-sdk/README.md): compile a scene and serve packaged assets.
- [Runtime](../../web/packages/runtime/README.md): create/edit/history flow and project storage injection.

`render-sdk` constructs workers using relative emitted `.js` URLs. Vite production
consumers are tested without source aliases. In Vite development, add the
`velocutVite()` plugin exported from `@velocut/render-sdk/vite`; it preserves
Worker URLs and shared runtime modules across dependency optimization. Other bundlers must preserve or
rewrite those worker URLs, and a custom static deployment must copy the emitted
worker assets. The public worker subpaths also support explicit asset imports.

Copy `scene-sdk/assets` to a served directory and configure `assetBase` if it is
not `/scene-assets`. The package owns these assets and their attribution files;
the application build merely copies them. Rust/WASM document-engine artifacts
are optional and separate from Three.js/physics. Configure `wasmBase` on the
runtime engine factory for alternate hosting.

Browser rendering requires a secure context, WebGPU/WebCodecs and the appropriate
codecs. The CLI supplies MIME types, range support and COOP/COEP headers. Local
speech inference is optional: install `@huggingface/transformers` for Whisper or
VITS. Installing core rendering alone does not install that inference stack.
Optional Vite cloud relays are not part of the static CLI server.

## Versions and release verification

The public packages and bundled plugin currently use one coordinated version.
Internal `@velocut/*` dependencies of published packages are exact, so publishing
cannot silently mix incompatible early versions. Change versions through:

```sh
npm run version:release -- 0.2.0
```

Rebuild afterwards. The bridge negotiates protocol versions separately from
npm versions, persisted document format and optimistic document revisions.
Protocol 2 negotiates explicitly and accepts wire-compatible protocol 1 peers;
unknown protocol sets fail before registering a page.

```sh
npm run build:release
npm -w @velocut/cli test
npm run pack:release
npm run test:distribution
npm test
npm run e2e
```

Do not rebuild packages concurrently with live dev-server browser tests: changing
compiled modules triggers HMR/reloads and invalidates the in-flight page session.
The distribution test exercises installed packages in a temporary directory:
Node imports, strict declaration consumption, production Vite bundling, actual
Worker messages/WebGPU pixels, project isolation, prebuilt CLI HTTP, and MCP
scene creation/vision. It writes a hash-bound verification record to artifacts.

`.github/workflows/distribution.yml` runs the distribution checks on macOS,
Windows and Linux. A matching version tag creates a **draft** GitHub release
only after the matrix passes. The tag must equal the package version. Public
npm publishing remains explicit:

```sh
npm run publish:release             # npm dry-run; no registry writes
npm run publish:release -- --execute
```

Publishing requires ownership of the `@velocut` namespace and npm authentication
(or a configured trusted CI publisher). Neither is assumed or stored in this
repository. The script refuses to publish bytes that differ from the verified
artifacts and publishes in dependency order. On GitHub Actions it requests
provenance, which requires the corresponding OIDC permissions. Registry writes
are not transactional: if a later package fails, inspect the published versions
before retrying. Never overwrite/reuse a published version for different bytes.
