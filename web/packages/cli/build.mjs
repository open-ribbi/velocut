import {build} from 'esbuild';
import { collectLicenses } from '../../scripts/licenses.mjs';
import { cp, mkdir, rm, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url)),
  out = resolve(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(resolve(root, 'src'), out, { recursive: true });
await build({entryPoints:[resolve(root,'src/models.mjs')],outfile:resolve(out,'models.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
await cp(resolve(root, '../../apps/editor/dist'), resolve(out, 'studio'), { recursive: true });
await cp(resolve(root, '../../../LICENSE'), resolve(root, 'LICENSE'));
await chmod(resolve(out, 'cli.mjs'), 0o755);
await collectLicenses(resolve(root, '../../node_modules'), resolve(out, 'licenses'));
console.log('Built @velocut/cli with prebuilt Studio');
