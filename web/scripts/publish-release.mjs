/** Explicit maintainer action; never called by install/build or ordinary CI. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { npm } from './npm.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../artifacts');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const verified = JSON.parse(
  await readFile(resolve(root, 'distribution-verification.json'), 'utf8'),
);
if (!verified.ok) throw new Error('Distribution verification is required');
const execute = process.argv.includes('--execute');
if (
  process.argv.some(
    (a) =>
      !['--execute', '--dry-run'].includes(a) && a !== process.argv[0] && a !== process.argv[1],
  )
)
  throw new Error('Use --dry-run (default) or --execute');
for (const pkg of manifest.packages) {
  const file = resolve(root, pkg.file),
    hash = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  if (
    hash !== pkg.sha256 ||
    !verified.packages.some((v) => v.name === pkg.name && v.sha256 === hash)
  )
    throw new Error(`Artifact ${pkg.name} differs from its tested bytes`);
  // Publish in dependency order. Registry authentication and namespace ownership
  // belong to the maintainer; no credentials or account-specific values are stored.
  npm(
    [
      'publish',
      file,
      '--access',
      'public',
      ...(!execute ? ['--dry-run'] : process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : []),
    ],
    { stdio: 'inherit' },
  );
}
