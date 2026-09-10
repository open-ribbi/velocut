import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function validatePackage(dir) {
  const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
  if (pkg.private) throw new Error(`${pkg.name} is private`);
  const paths = [];
  function collect(value) {
    if (typeof value === 'string') paths.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(pkg.exports);
  collect(pkg.bin);
  if (pkg.types) paths.push(pkg.types);
  for (const path of paths) {
    if (!path.startsWith('./') || path.includes('../') || path.startsWith('./src/'))
      throw new Error(`Non-portable export ${pkg.name}: ${path}`);
    if (path.includes('*')) {
      const folder = resolve(dir, dirname(path)),
        pattern = new RegExp(
          '^' + path.split('/').pop().replaceAll('.', '\\.').replace('*', '.*') + '$',
        );
      if (!(await readdir(folder)).some((name) => pattern.test(name)))
        throw new Error(`Missing export files: ${path}`);
    } else if (!(await stat(resolve(dir, path))).isFile())
      throw new Error(`Missing export: ${path}`);
  }
  await stat(resolve(dir, 'LICENSE'));
  if (pkg.name === '@velocut/cli') for (const name of await readdir(resolve(dir, 'dist/studio'))) {
    if (!['index.html', 'assets', 'scene-assets', 'wasm'].includes(name)) throw new Error(`Unexpected Studio release file: ${name}`);
  }
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {}))
    if (dep.startsWith('@velocut/') && version !== pkg.version)
      throw new Error(`Uncoordinated dependency ${pkg.name}: ${dep}@${version}`);
  return pkg;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await validatePackage(process.cwd());
