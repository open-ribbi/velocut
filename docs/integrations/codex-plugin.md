# Velocut in Codex

The plugin lets the model in a Codex conversation use the live Velocut editor.
There is no nested LLM call or additional OpenAI API credential. The editor owns
rendering, document state, undo/history and imported model bytes. Scene data and
observations are returned to the Codex conversation for reasoning and vision.

## Components

- `web/packages/codex-bridge`: official MCP SDK v2 server, ephemeral loopback HTTP
  broker, plugin manifest/skill and a self-contained Node bundle.
- `services/codex-connection.ts`: opt-in browser pairing, serialized command
  execution, heartbeat and explicit disconnect.
- `services/codex-host.ts`: allowlisted adapter to existing native authoring
  services. Writes are attributed to Codex. Programs use the existing isolated
  iframe sandbox; provider configuration, network publishing, uploads and paid
  generation services are not exposed. The generic command path also blocks
  remote asset creation and procedural motion specs, whose image layers can fetch
  external URLs; existing local timeline clips remain editable.
- The toolbar's Codex control displays connection status and lets the user paste
  a pairing link or disconnect. Pairing also works by opening the link directly,
  including same-document hash navigation.

## Build and install locally

Requires Node.js 22+ and the repository's web dependencies.

```sh
cd web
npm install
npm run build:codex-plugin
```

The distributable folder is `web/packages/codex-bridge/dist/velocut`. It includes
`.codex-plugin/plugin.json`, `.mcp.json`, the Director skill and scene API reference,
and `scripts/server.cjs` with its runtime dependencies bundled. No npm install is
needed inside the installed plugin. `.mcp.json` uses Codex's `${PLUGIN_ROOT}`
substitution, so a cached installation does not depend on the source checkout.

For a personal development install, use Codex's Plugin Creator skill to create a
`velocut` scaffold and personal marketplace entry, then build over that new source:

```sh
node packages/codex-bridge/build.mjs --out "$HOME/plugins/velocut"
codex plugin add velocut@personal
```

Use the actual marketplace name if the personal marketplace has another name.
When updating an already-installed source, follow Plugin Creator's cachebuster
and reinstall flow. Start a new Codex task to pick up newly installed tools.
The portable artifact can also be packaged for another supported marketplace.

## Use

1. Start the editor with `npm run dev` in `web/` (or let Codex start it from the
   repository). Use the URL actually printed by Vite.
2. In a new Codex task with the plugin, ask: “Connect to my local Velocut editor.”
3. `velocut_connect` returns a temporary local pairing URL. Open it in the browser,
   or paste it into the editor's Codex control. No provider key is requested.
4. `velocut_sessions` returns explicit page/session and project identities. All
   subsequent tools require the intended session ID. Multiple projects/tabs are
   supported without using a guessed foreground page.
5. Ask Codex to model/direct. It can inspect assets and geometry, create/edit/
   arrange scenes, import a user-specified GLB, run local editing programs,
   navigate the Director and receive real rendered images.

Example request:

> Build a cafe with a table and four chairs, add warm lighting, and show me a
> front view and a camera shot. Keep the scene editable.

Reloading/switching the editor creates a new page session. List sessions again.
MCP processes use independent ephemeral ports, so different Codex tasks do not
contend for a shared global listener. The listener stops with its MCP process;
no separate background daemon or persistent connection token is installed.

## Protocol and failure behavior

The Node broker binds only to `127.0.0.1`. Pairing requires a random capability and
an explicitly paired loopback editor origin. Each registered page gets a separate
session credential. Browser requests require Authorization, validate the Host and
Origin, and use JSON. Pairing fragments are removed from the address bar and kept
only in that tab's session storage to reconnect across reloads.

Commands are queued by explicit session, delivered once and processed serially.
Results are correlated to both request and page; another session cannot answer a
request. A delivered command that times out is reported as uncertain and is never
automatically replayed. Inspect state before retrying. Explicit browser disconnect
aborts the local execution context and denies any subsequent document commit.
Changes already committed remain in normal undo history.

Tools: connect, sessions, document, scene_assets, scene_create, scene_inspect,
scene_edit, scene_arrange, observe, director, apply, history, script, import_model
(all prefixed `velocut_`). Observations carry MCP image blocks rather than base64
inside text. Import reads only a user-specified regular `.glb` file with a GLB 2
header and a 64 MiB cap; the editor validates embedded dependencies before commit.

## Verification

```sh
npm run build
npm test
npx playwright test --workers=1
```

The normal `npm test` includes the bridge tests, and Playwright global setup
builds the bundle automatically, including in clean CI jobs.
`test:codex-plugin` can also run the bridge suite alone. It verifies authentication/origin rules, session isolation,
timeouts/no replay, cancellation before delivery, MCP stdio startup/tool discovery
and image result formatting. `e2e/codex-plugin.spec.ts` starts the actual packaged
MCP process and controls real Chromium pages through it, covering edits, vision,
local GLB import, multiple projects, human conflicts and disconnect during compile.

Plugin and Skill manifests are additionally checked with Plugin Creator's
`validate_plugin.py` and Skill Creator's `quick_validate.py` (requires PyYAML).


## Completion record

- Production editor build passes.
- 76 existing engine/scene tests and 7 bridge/MCP tests pass through `npm test`.
- All 22 browser tests pass, including the 3 real packaged-MCP integration tests.
- The bundle negotiates both MCP 2026 and legacy 2025-11-25 clients.
- Plugin and skill validators pass; the personal plugin is installed and enabled.
- Actual model reasoning stays in Codex. The integration tests use an MCP client
  against real browser pages; they do not require or invoke a second LLM API.

Install/update completion still requires a new Codex task to load the new tool
set; it does not require rebuilding the editor or adding model credentials.
