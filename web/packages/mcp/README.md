# @velocut/mcp

A generic Model Context Protocol server for a running local Velocut Studio.
Requires Node.js 22.6+. The reasoning model belongs to your MCP client; this
package does not invoke a second model or require an additional model API key.

The repository marketplace at `.agents/plugins/marketplace.json` discovers the
lightweight `plugins/velocut` plugin. Its command is `npx --yes @velocut/mcp@0.0.2
--stdio`. Publish the matching npm release before using the Git install route.
`@velocut/cli` is an exact-version dependency and includes the built Studio.

Call `velocut_connect` with no arguments to start or reuse Studio at
`http://localhost:5173`. Open the returned pairing URL with browser tools and select
the project from `velocut_sessions`. `port` explicitly chooses another origin;
`editorUrl` explicitly connects to an already-running editor. Port collisions and
version mismatches do not silently switch origins or terminate another process.

The managed Studio runs independently of MCP chats and exits after ten idle
minutes with no active requests or page heartbeats. Diagnostics are written to
`~/.velocut/studio/studio-<port>.log`; MCP stdout is reserved for its protocol.
`velocut_guide` returns bundled documentation, including in sparse Git installs.

The portable marketplace bundles this same MCP runtime and a matching Studio.
It starts without npm or checkout dependencies. On Windows, clients that cannot
execute `npx` directly can use the installed Node executable with this package's
`dist/cli.cjs`. `--help` and `--version` never start Studio.

`velocut_generation` exposes project-bound asynchronous video generation with
configured provider channels. Use ordinary timeline commands to create slots,
then plan/submit/inspect candidates and explicitly adopt a result. Submission
uses provider credits. The tool accepts no endpoint/key or raw reference URL;
saved first-frame references upload only through the host's configured storage.
Legacy `videoGen` and general upload methods remain unavailable in MCP.
