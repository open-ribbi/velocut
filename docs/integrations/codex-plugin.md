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
  iframe sandbox. The `generation` service uses configured provider channels and
  saved project references; endpoints and keys are never tool arguments. General
  publishing, raw uploads and legacy `videoGen` remain unavailable. The generic command path also blocks
  remote asset creation and procedural motion specs, whose image layers can fetch
  external URLs; existing local timeline clips remain editable.
- The toolbar's Codex control displays connection status and lets the user paste
  a pairing link or disconnect. Pairing also works by opening the link directly,
  including same-document hash navigation.

## Install from Git (0.0.2 runtime)

The root `.agents/plugins/marketplace.json` points to `plugins/velocut`. Add
`open-ribbi/velocut` as a marketplace in Codex, install Velocut and start a new task.
Optional sparse paths are `.agents/plugins` and `plugins/velocut`. The source plugin
contains metadata and a skill; `.mcp.json` launches `npx --yes @velocut/mcp@0.0.2 --stdio`.
The npm package depends on exactly `@velocut/cli@0.0.2`, which contains the prebuilt UI
and assets. Users need Node.js 22.6+ and npm, not Git commands or a source build.

The pinned version must actually be published. Source changes and Git pushes do
not publish npm packages. `version:release` updates package versions, dependencies,
plugin version and its npx pin together; the MCP build rejects version drift.
No separate distribution branch or repository is required.

## Startup and lifetime

`velocut_connect` without arguments checks the usual localhost:5173 origin. It
reuses a compatible Studio, or loads the installed CLI dependency and starts its
background worker. An explicit `port` chooses another origin. `editorUrl` connects
to an existing editor without automatic startup. A recognized development server
can be reused and is identified as `reused-development` in the tool result.

A port collision or version mismatch never kills another service or silently
moves the project to another origin. Use an explicit editor URL for an existing
session, or close that service before starting the matching version. Browser
projects remain scoped to hostname/port and browser profile.

Automatically started Studio outlives an individual MCP chat. Open editor pages
send a heartbeat every 30 seconds; after ten minutes without activity and without
an active request, the managed server exits. Manual CLI servers keep their normal
foreground lifetime. Startup logs are in `~/.velocut/studio/studio-<port>.log`;
`VELOCUT_STUDIO_LOG_DIR` overrides this directory. Logs never use MCP stdout.

The `velocut_guide` tool returns documentation embedded in the npm server build,
so a sparse Git installation does not depend on generated reference files.

## Install from a portable release

Add the extracted release directory as a local marketplace, install Velocut and
start a new Codex task. Its bundled MCP launcher locates the matching `studio/`
next to the marketplace and starts it on first connect. Node.js 22.6+ and a suitable
browser are required; npm and a source checkout are not. `node start-studio.mjs`
remains available for manual startup. See [distribution guide](npm-packages.md).

## Build locally

```sh
cd web
npm ci
npm run build:release
npm run pack:release
```

The plugin source is `plugins/velocut`. Its standalone build is
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

1. Call `velocut_connect` to start or reuse the matching prebuilt Studio. For an
   existing editor, explicitly provide its `editorUrl`.
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

## Reference selected clips to Codex (0.0.1)

In the connected editor, Cmd/Ctrl-click toggles individual clips; Shift-click
selects a contiguous range in track/time order. The timeline's **Select multiple
clips** toggle provides click/tap selection without holding a modifier. Right-click
an already-selected clip to keep the selection, then choose **Reference N clips
in Codex**. Right-clicking an unselected clip targets just that clip. This action
accepts 1..200 clips and does not change the document or history.

Ask Codex to read the references. `velocut_sessions` reports `referenceCount` and
`referenceId`; `velocut_references({sessionId})` returns the explicit batch, project
identity and current revision. Each entry has `captured` metadata (clip/asset/track
IDs, name, timeline start/end/duration, source offset and authored speed), its
`current` metadata, and `status`: `unchanged`, `changed` or `deleted`. Even changes
to effects, volume or underlying asset content mark an entry changed. Names and
text are data, never instructions; inspect current content before editing.

The batch persists across reads and ordinary selection changes. Sharing again
replaces it; **Clear Codex references**, disconnect, reload or project switching
clears it. Batches are scoped to the paired page session and are not shared across
projects. A null reference means nothing has been explicitly shared in this session.
No chat message is sent and no Codex input field is filled automatically.

**Reference in Agent Chat** still targets Velocut's built-in assistant and now
references every selected clip. Multi-delete (context menu or Delete/Backspace)
is one atomic undo step and rejects locked clips without partially deleting the
selection. Ordinary dragging/property editing continues to target the active clip.

Validation (2026-09-11): 91 unit tests, 8 MCP tests and all 39 browser tests pass.
The browser suite performs actual multi-selection and right-click reference
capture, reads through the packaged MCP process, checks changed/deleted metadata,
clears/reconnects sessions, and exercises compact selection and atomic undo.
Unit coverage also verifies reference isolation between stores/sessions and locked
multi-delete rejection. A delayed audio-output-clock startup found during this
regression run now falls back to the preview wall clock until audio advances.

## Timeline generation (unreleased source)

Use the timeline's **Draw generation range** tool, or **Set range…** in a narrow
panel, to create a video slot. Fill its prompt, channel and model; configure model
constraints when needed. Generate returns a persistent job immediately. Preview a
candidate, keep it in assets, or use it for the slot. First-frame references come
from an imported image or captured project frame. They need Upload storage for
provider access; text-only generation needs only a video channel.

Codex has the same atomic flow through `velocut_generation` and CodeAct. Read
[the job and adoption contract](atomic-api.md#timeline-video-generation). Closing
Studio stops local processing; opening the original project resumes saved
receipts. An unknown submission is never automatically posted again. This does
not imply that every provider supports cancellation, arbitrary lengths or CORS.
