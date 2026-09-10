import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm } from './npm.mjs';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  version = process.argv[2];
if (
  !version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version)
)
  throw new Error('Usage: npm run version:release -- 0.2.0');
for (const name of await readdir(resolve(web, 'packages'))) {
  const file = resolve(web, 'packages', name, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.private) pkg.version = version;
  for (const key of ['dependencies', 'peerDependencies', 'devDependencies'])
    for (const dep of Object.keys(pkg[key] ?? {}))
      if (dep.startsWith('@velocut/') && pkg[key][dep] !== '*') pkg[key][dep] = version;
  await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
}
const app = resolve(web, 'apps/editor/package.json'),
  pkg = JSON.parse(await readFile(app, 'utf8'));
pkg.version = version;
for (const dep of Object.keys(pkg.dependencies))
  if (dep.startsWith('@velocut/') && pkg.dependencies[dep] !== '*') pkg.dependencies[dep] = version;
await writeFile(app, JSON.stringify(pkg, null, 2) + '\n');
const manifest = resolve(web, '../plugins/codex/velocut/.codex-plugin/plugin.json'),
  plugin = JSON.parse(await readFile(manifest, 'utf8'));
plugin.version = version;
await writeFile(manifest, JSON.stringify(plugin, null, 2) + '\n');
for (const name of ['cli', 'mcp']) {
  const source = resolve(web, 'packages', name, 'src/server.mjs');
  let text = await readFile(source, 'utf8');
  text =
    name === 'cli'
      ? text.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${version}';`)
      : text.replace(
          /name: 'velocut', version: '[^']+'/g,
          `name: 'velocut', version: '${version}'`,
        );
  await writeFile(source, text);
}
npm(['install', '--package-lock-only', '--ignore-scripts'], { cwd: web, stdio: 'inherit' });
console.log(
  `Set public packages and plugin to ${version}. Build, pack, and verify before publishing.`,
);
