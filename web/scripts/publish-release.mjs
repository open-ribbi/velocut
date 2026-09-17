/** Explicit maintainer action; never called by install/build or ordinary CI. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm } from './npm.mjs';
import { verifyReleaseArtifacts } from './release-artifacts.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../artifacts');
const manifest = await verifyReleaseArtifacts(root);
const execute = process.argv.includes('--execute');
if (
  process.argv.some(
    (a) =>
      !['--execute', '--dry-run'].includes(a) && a !== process.argv[0] && a !== process.argv[1],
  )
)
  throw new Error('Use --dry-run (default) or --execute');
for (const pkg of manifest.packages) {
  const file = resolve(root, pkg.file);
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
