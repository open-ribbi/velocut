import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
/** Invoke npm through Node so paths with spaces and Windows .cmd wrappers are safe. */
export function npm(args, options = {}) {
  const cli =
    process.env.npm_execpath ??
    resolve(
      dirname(process.execPath),
      process.platform === 'win32'
        ? 'node_modules/npm/bin/npm-cli.js'
        : '../lib/node_modules/npm/bin/npm-cli.js',
    );
  return execFileSync(process.execPath, [cli, ...args], options);
}
