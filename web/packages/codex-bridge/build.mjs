import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const out = process.argv.includes('--out') ? resolve(process.argv[process.argv.indexOf('--out') + 1]) : resolve(root, 'dist/velocut');
if (basename(out) !== 'velocut') throw new Error('plugin output folder must be named velocut');
await mkdir(out, { recursive: true });
await cp(resolve(root, 'plugin/velocut'), out, { recursive: true });
await mkdir(resolve(out, 'skills/director/references'), { recursive: true });
const sceneGuide = await readFile(resolve(root, '../../../docs/design/director-authoring.md'), 'utf8');
await writeFile(resolve(out, 'skills/director/references/scene-api.md'), sceneGuide.replaceAll('../integrations/codex-plugin.md', 'codex-plugin.md'));
await cp(resolve(root, '../../../docs/integrations/codex-plugin.md'), resolve(out, 'skills/director/references/codex-plugin.md'));
await mkdir(resolve(out, 'scripts'), { recursive: true });
const bundle = await build({ entryPoints: [resolve(root, 'src/server.mjs')], outfile: resolve(out, 'scripts/server.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'external', metafile: true });
await cp(resolve(root, '../../../LICENSE'), resolve(out, 'LICENSE'));
await mkdir(resolve(out, 'licenses'), { recursive: true });
const dependencies = new Set();
for (const input of Object.keys(bundle.metafile.inputs)) {
  const path = resolve(input), marker = sep + 'node_modules' + sep;
  const index = path.lastIndexOf(marker);
  if (index < 0) continue;
  const parts = path.slice(index + marker.length).split(sep);
  const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join(sep);
  const packageRoot = path.slice(0, index + marker.length) + name;
  if (dependencies.has(packageRoot)) continue;
  dependencies.add(packageRoot);
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try {
      const license = await readFile(resolve(packageRoot, filename));
      await writeFile(resolve(out, 'licenses', name.replaceAll(sep, '_') + '.txt'), license);
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await writeFile(resolve(out, 'README.md'), `# Velocut Codex plugin\n\nRequires Node.js 22+ and a running local Velocut editor. Install this plugin and start a new Codex task. Ask Codex to connect to Velocut; open its pairing link, then edit the explicitly selected project. The model runs in Codex; the editor handles deterministic authoring and rendering. No additional model API key is required.\n\nThis package is self-contained: its MCP service is bundled under scripts/server.cjs. It binds only to an ephemeral loopback port and stops with its MCP process. Pairing is temporary; use the editor's Codex control to disconnect. No model bytes are uploaded to an external service by the plugin.\n`);
console.log(out);
