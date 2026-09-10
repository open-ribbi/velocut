import { validatePackage } from './validate-package.mjs';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm } from './npm.mjs';
import { createHash } from 'node:crypto';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(web, '../artifacts');
const names = ['protocol', 'core-ts', 'render-sdk', 'scene-sdk', 'runtime', 'mcp', 'cli'];
await mkdir(out, { recursive: true });
const manifest = {
  version: JSON.parse(await readFile(resolve(web, 'packages/protocol/package.json'), 'utf8'))
    .version,
  packages: [],
};
for (const name of names) {
  const dir = resolve(web, 'packages', name),
    pkg = await validatePackage(dir);
  if (pkg.private || pkg.version !== manifest.version)
    throw new Error(`Invalid release identity ${name}`);
  const result = JSON.parse(
    npm(['pack', '--json', '--pack-destination', out, '--ignore-scripts'], {
      cwd: dir,
      encoding: 'utf8',
    }),
  )[0];
  if (result.files.some((f) => f.path.includes('node_modules/') || f.path.startsWith('src/')))
    throw new Error(`Source-only files leaked into ${name}`);
  const bytes = await readFile(resolve(out, result.filename));
  manifest.packages.push({
    name: pkg.name,
    version: pkg.version,
    file: result.filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  });
}
// A complete, relocatable local marketplace. No reference to the developer's
// checkout, personal marketplace or npm cache exists in the installed plugin.
const plugin = JSON.parse(await readFile(resolve(web, 'packages/mcp/dist/velocut/.codex-plugin/plugin.json'), 'utf8'));
if (plugin.version !== manifest.version) throw new Error('Plugin/package version mismatch');
const market = resolve(out, `velocut-${manifest.version}`);
await rm(market, { recursive: true, force: true });
await mkdir(resolve(market, '.agents/plugins'), { recursive: true });
await cp(resolve(web, 'packages/mcp/dist/velocut'), resolve(market, 'plugins/velocut'), {
  recursive: true,
});
await writeFile(
  resolve(market, '.agents/plugins/marketplace.json'),
  JSON.stringify(
    {
      name: 'velocut',
      interface: { displayName: 'Velocut' },
      plugins: [
        {
          name: 'velocut',
          source: { source: 'local', path: './plugins/velocut' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
await cp(resolve(web, 'packages/cli/dist'), resolve(market, 'studio'), { recursive: true });
await writeFile(
  resolve(market, 'start-studio.mjs'),
  "if (process.argv.length === 2) process.argv.push('studio');\nawait import('./studio/cli.mjs');\n",
);
await writeFile(
  resolve(market, 'README.md'),
  `# Velocut ${manifest.version}\n\nRequires Node.js 22.6+ and Chrome/Edge. No npm install or source checkout is needed.\n\nRun: node start-studio.mjs\n\nKeep the printed origin stable to reopen your browser-local projects.\n\nThis folder is also a relocatable Codex marketplace: add this folder using Codex's plugin marketplace UI or codex plugin marketplace add <this-folder>, then install Velocut and start a new task. Ask it to connect to the running Studio URL. The plugin bundles its MCP server and requires no additional model key.\n`,
);
await cp(resolve(web, '../LICENSE'), resolve(market, 'LICENSE'));
await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
