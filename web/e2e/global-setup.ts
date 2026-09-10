import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Keep direct `npx playwright test` (including clean CI jobs) reproducible. */
export default async function setup() {
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../packages/mcp/build.mjs', import.meta.url))]);
}
