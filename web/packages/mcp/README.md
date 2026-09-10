# @velocut/mcp

A generic Model Context Protocol server for a running local Velocut Studio.
Requires Node.js 22.6+. The reasoning model belongs to your MCP client; this
package does not invoke a second model or require an additional model API key.

After the package is published, configure your MCP client with command `npx`
and arguments `-y`, `@velocut/mcp@0.0.1`. The `velocut-mcp` executable defaults to
stdio. `--help` and `--version` do not start a server. Pin a release in shared
configurations. For unpublished builds install the release `.tgz` first and use
`node node_modules/@velocut/mcp/dist/cli.cjs`.

Start Studio separately, call `velocut_connect` with the printed local editor
URL, open the pairing URL, and choose the intended session from
`velocut_sessions`. Then create, edit, inspect and observe scenes. Navigation
and authored camera edits are distinct; writes use optimistic revisions and
normal undo/history. The connection only accepts loopback HTTP editors.

The Codex plugin is another distribution of this same server with a Director
skill and API references. It bundles the server, rather than downloading a
potentially different version on each launch. The plugin does not include the
browser editor. On Windows, a client unable to execute `npx` directly should
use the installed Node executable and this package's `dist/cli.cjs` path.
