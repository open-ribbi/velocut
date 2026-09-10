# SDK and plugin distribution

Status: implemented and locally verified (2026-09-11). Public registry publishing is a separate
release action; this change prepares independently installable artifacts.

Accepted direction: one monorepo, versioned npm SDKs, a browser project runtime,
a generic MCP server, a prebuilt Studio launcher, and a thin Codex plugin built
from the same MCP source. Rendering stays in the browser; npm does not imply a
Node GPU or headless rendering implementation.

Completion gates:
- [x] Protocol, TS core, scene and render packages ship JS/types and explicit exports.
- [x] Workers and scene assets work from installed tarballs outside this checkout.
- [x] Project authoring runtime has no imports from the editor application.
- [x] Editor and MCP host use the shared runtime, retaining history and conflicts.
- [x] Generic MCP npm command and bundled Codex plugin share one implementation.
- [x] CLI serves the prebuilt editor with isolation headers and connection guidance.
- [x] Compatibility is negotiated independently of document revisions.
- [x] Versioned plugin marketplace/release artifacts and npm packaging CI exist.
- [x] Clean-install, rendering, MCP, CLI, and existing editor regression tests pass.
- [x] English/Chinese quick starts and package integration examples match artifacts.

References:
- https://github.com/excalidraw/excalidraw
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation
- https://github.com/microsoft/playwright-mcp
- https://github.com/ahujasid/blender-mcp#components


Verification evidence
---------------------
- `npm ci --ignore-scripts` followed by `npm run build:release` succeeds from
  the lockfile. SDK declarations and the production app compile.
- `npm test`: 76 engine/SDK tests and 8 MCP tests pass, including explicit
  version negotiation, legacy compatibility and rejected protocol sets.
- `npm -w @velocut/cli test`: 2 server/CLI journeys pass (headers, ranges, host
  validation, paths, busy ports, invalid options, and bundle availability).
- `npm run e2e`: all 28 existing browser journeys pass after runtime extraction.
- `npm run test:distribution`: seven tarballs installed outside the checkout,
  strict type consumption, Vite production AND development, Worker messages,
  WebGPU pixels, custom scene asset hosting, project cache isolation, shared
  runtime subpaths, CLI/MCP scene vision, portable launcher and relocated plugin.
- `npm run publish:release`: all seven verified artifacts pass npm publish dry-run.
  Nothing has been uploaded to the public registry.
- Plugin Creator and Skill Creator validators pass for source and built plugins.
- `artifacts/manifest.json` contains artifact hashes; the distribution verification
  record is bound to those hashes, and publishing refuses changed bytes.
- Local verification platform: macOS / Node 22.22.0. Windows/Linux jobs are
  configured in the distribution CI matrix; they were not executed in this
  local session. The workflow creates a draft release on matching version tags.

A production asset allowlist prevents the developer's gitignored test media
from entering the CLI/portable bundle. The default release uses the TS document
engine; explicitly opt into freshly built WASM using VELOCUT_INCLUDE_WASM=1.
Optional inference dependencies remain separate from the core rendering install.
