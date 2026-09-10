# Velocut in Codex

The plugin lets the model in a Codex conversation use the live Velocut editor.
There is no nested LLM call or additional OpenAI API credential. The editor owns
rendering, document state, undo/history and imported model bytes. Scene data and
observations are returned to the Codex conversation for reasoning and vision.

## Components

- `web/packages/mcp`: official MCP SDK v2 server, ephemeral loopback HTTP
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

## Install from a release

A standalone release directory contains the prebuilt Studio launcher and a
relocatable Codex marketplace. Run `node start-studio.mjs`, add the extracted
directory as a marketplace source, install Velocut and start a new Codex task.
No source checkout or npm install is needed; Node.js 22.6+ and a suitable browser
are still required. The plugin alone contains MCP and skills, not the UI.

The generic `@velocut/mcp` npm executable can also be used with other MCP clients.
Use a published version, or install a locally built tarball; package creation
here does not imply npm publication. See [distribution guide](npm-packages.md).

## Build locally

```sh
cd web
npm ci
npm run build:release
npm run pack:release
```

The plugin source is `plugins/codex/velocut`. Its standalone build is
`web/packages/mcp/dist/velocut`: manifest, MCP launcher, bundled runtime,
Director skill, API references and license notices. `${PLUGIN_ROOT}` resolves
inside Codex's installed plugin cache, so it does not depend on the checkout.
The same MCP implementation also builds the npm package's `dist/cli.cjs`.

For a personal development install, use the Plugin Creator skill to create a
scaffold and marketplace entry, then build over that source:

```sh
node packages/mcp/build.mjs --out "$HOME/plugins/velocut"
codex plugin add velocut@personal
```

Use your actual personal marketplace name. Updating an installed development
plugin requires Plugin Creator's cachebuster/reinstall flow and a new task.
Regular release users can add the generated standalone marketplace directory
instead; they do not need to scaffold their own plugin.

## Use

1. Start Studio with the release launcher or installed CLI. For development use
   `npm run dev` in `web/`. Use the actual printed URL.
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


## Compatibility and distribution verification

The browser/bridge protocol negotiates supported versions independently of the
MCP protocol and document revision. New peers prefer protocol 2; compatible
protocol 1 clients remain accepted. An unsupported version set is rejected
before any page session is registered.

The normal browser suite verifies packaged MCP editing, vision, local GLB
imports, multiple projects, attribution, conflicts and disconnect during compile.
`npm run test:distribution` additionally installs CLI/MCP/SDK tarballs outside
the repository and runs scene creation and observation against the prebuilt
editor. See the distribution guide for the cross-platform CI and release gates.
