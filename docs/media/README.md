# README screenshots

These are unmodified screenshots of the running Velocut Studio, captured with
Playwright in a new, isolated browser context. They share a procedural Sunroom
fixture built through the real packaged MCP bridge. Connection status and
history are real; no chat transcript or generated UI mockup is inserted.
The scene uses built-in geometry and furniture assemblies, with no external
photos, user projects, provider credentials or imported model files.

| File | Viewport | Shows |
| --- | --- | --- |
| `editor.png` | 1440 × 940 | Program monitor, three scene clips, title track and properties |
| `director.png` | 1440 × 940 | Live 3D workspace, table hierarchy, gizmo and property editing |
| `history.png` | 1440 × 940 | Actual MCP and local editing operations in project history |
| `compact.png` | 440 × 760 | Narrow Director layout with bottom navigation |

To regenerate from the current source, run from `web/`:

```sh
npm ci
npx playwright install chromium
npm run docs:screenshots
```

The command builds the editor, SDKs and MCP bundle, serves Studio on an ephemeral
loopback port, captures the fixture and closes its browser/server. It does not
connect to an already-open project. On displayless Linux use the same software
Vulkan environment as distribution CI and run with
`VELOCUT_HEADED=1 xvfb-run -a npm run docs:screenshots`.

The scene fixture and capture sequence live in
[`capture-readme.mjs`](../../web/scripts/capture-readme.mjs). The screenshots
currently illustrate the 0.0.1 interface. Keep the English and Chinese README
captions aligned when updating these images.
