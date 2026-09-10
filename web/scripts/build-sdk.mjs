import { build } from 'esbuild';
import { readdir, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const all = ['protocol', 'core-ts', 'render-sdk', 'scene-sdk', 'runtime'];
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? files(resolve(dir, e.name)) : resolve(dir, e.name))),
    )
  ).flat();
}
function jsImports(text) {
  return text
    .replace(
      /((?:from\s*|import\s*|import\s*\()\s*['"])(\.[^'"\n]+)(['"])/g,
      (_, a, path, b) =>
        a +
        (path.endsWith('.ts') ? path.slice(0, -3) + '.js' : extname(path) ? path : path + '.js') +
        b,
    )
    .replace(/(new URL\(['"]\.\/[^'"]+)\.worker\.ts(['"])/g, '$1.worker.js$2');
}
for (const name of process.argv.length > 2 ? process.argv.slice(2) : all) {
  if (!all.includes(name)) throw new Error(`Unknown SDK ${name}`);
  const dir = resolve(web, 'packages', name),
    out = resolve(dir, 'dist');
  const source = (await files(resolve(dir, 'src'))).filter(
    (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'),
  );
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: source,
    outdir: out,
    outbase: resolve(dir, 'src'),
    bundle: false,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
  });
  for (const path of (await files(out)).filter((p) => p.endsWith('.js')))
    await writeFile(path, jsImports(await readFile(path, 'utf8')));
  if (name === 'render-sdk') {
    // Ship self-contained browser workers; consumers need no TypeScript/Vite
    // loader or workspace dependencies to construct a Worker from these URLs.
    for (const worker of ['media', 'render'])
      await build({
        entryPoints: [resolve(dir, `src/${worker}.worker.ts`)],
        outfile: resolve(out, `${worker}.worker.js`),
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        sourcemap: true,
      });
  }
  const config = resolve(dir, 'tsconfig.build.json');
  await writeFile(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: 'src',
          outDir: 'dist',
          types: ['@webgpu/types'],
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  execFileSync(process.execPath, [resolve(web, 'node_modules/typescript/bin/tsc'), '-p', config], {
    cwd: web,
    stdio: 'inherit',
  });
  for (const path of (await files(out)).filter((p) => p.endsWith('.d.ts')))
    await writeFile(path, jsImports(await readFile(path, 'utf8')));
  await cp(resolve(web, '../LICENSE'), resolve(dir, 'LICENSE'));
  if (name === 'scene-sdk') {
    await rm(resolve(web, 'apps/editor/public/scene-assets'), { recursive: true, force: true });
    await cp(resolve(dir, 'assets'), resolve(web, 'apps/editor/public/scene-assets'), {
      recursive: true,
    });
  }
  console.log(`Built @velocut/${name}`);
}
