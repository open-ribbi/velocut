import { readdir, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Include installed third-party notices in portable bundles, which have no
 * node_modules tree to carry them. Extra build-tool notices are harmless. */
export async function collectLicenses(nodeModules, out) {
  await mkdir(out, { recursive: true });
  const seen = new Set(),
    index = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = resolve(dir, entry.name);
      if (entry.name.startsWith('@')) {
        await visit(path);
        continue;
      }
      let pkg, root;
      try {
        root = await realpath(path);
        pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (seen.has(root) || pkg.name?.startsWith('@velocut/')) continue;
      seen.add(root);
      const notices = [];
      for (const file of await readdir(root, { withFileTypes: true }))
        if (file.isFile() && /^(licen[sc]e|copying|notice)(\.|$)/i.test(file.name)) {
          const name = `${pkg.name.replaceAll('/', '_')}@${pkg.version}-${file.name}`;
          await writeFile(resolve(out, name), await readFile(resolve(root, file.name)));
          notices.push(name);
        }
      index.push({ name: pkg.name, version: pkg.version, license: pkg.license, notices });
      await visit(resolve(root, 'node_modules'));
    }
  }
  await visit(nodeModules);
  await writeFile(
    resolve(out, 'index.json'),
    JSON.stringify(
      index.sort((a, b) => a.name.localeCompare(b.name)),
      null,
      2,
    ) + '\n',
  );
}
