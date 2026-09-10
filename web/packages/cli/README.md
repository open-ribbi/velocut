# @velocut/cli

Launch the prebuilt Velocut editor without cloning its source or installing a
compiler. Node.js 22.6+ and a browser with WebGPU/WebCodecs are required.

After registry publication:

```sh
npx @velocut/cli@0.1.0 studio
```

For an unpublished local release, install its `.tgz`, then run
`node node_modules/@velocut/cli/dist/cli.mjs studio`.

- `studio --no-open` prints the URL without opening a browser.
- `studio --port 5173` chooses a port; `--port 0` requests an ephemeral port for tests.
- `studio --json` prints machine-readable startup information.
- `doctor --json` checks Node and bundled assets; GPU availability is checked in the browser.
- `--version` prints the package version.

The server binds to loopback only. It serves bundled assets, proper MIME types,
byte ranges and COOP/COEP headers; it does not serve your filesystem or proxy
remote URLs. Ctrl+C stops it. A busy port is reported, not silently changed:
projects live in browser IndexedDB/OPFS, scoped to the browser profile, hostname
and port. Use the same printed origin to reopen them. Do not clear site storage
without exporting anything you need.

Install the Codex plugin or configure `@velocut/mcp` in an MCP client, then ask
it to connect to the printed Studio URL. Model reasoning stays in that client.
The npm launcher does not include Node itself or a browser. Browser-local
rendering, import, editing and export work without model credentials. Optional
cloud search/TTS/dev relays from Vite are not included in this static server;
provider endpoints must support direct browser requests where applicable.
