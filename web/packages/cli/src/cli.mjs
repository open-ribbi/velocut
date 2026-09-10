#!/usr/bin/env node
import { doctor, startStudio, VERSION } from './server.mjs';
const args = process.argv.slice(2),
  command = args.shift();
const help = `Velocut ${VERSION}
  velocut studio [--port 5173] [--no-open] [--json]
  velocut doctor [--json]
  velocut --version

Studio runs locally; keep its hostname/port stable to reopen browser projects.
Install the Velocut Codex plugin and ask it to connect to the printed URL.
No source checkout, build tools, or additional model API key is needed.`;
try {
  if (!command || ['--help', 'help', '-h'].includes(command)) console.log(help);
  else if (command === '--version') console.log(VERSION);
  else if (command === 'doctor') {
    if (args.some((a) => a !== '--json')) throw new Error('Unknown doctor option');
    const r = await doctor();
    console.log(
      args.includes('--json')
        ? JSON.stringify(r)
        : Object.entries(r)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n'),
    );
    if (!r.ok) process.exitCode = 1;
  } else if (command === 'studio') {
    let port = 5173;
    const i = args.indexOf('--port');
    if (i >= 0) {
      const value = args[i + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error('--port requires a number');
      port = Number(value);
      args.splice(i, 2);
    }
    if (args.some((a) => !['--no-open', '--json'].includes(a)))
      throw new Error('Unknown studio option');
    const app = await startStudio({ port, open: !args.includes('--no-open') });
    console.log(
      args.includes('--json')
        ? JSON.stringify({ url: app.url, version: VERSION })
        : `Velocut Studio: ${app.url}\nKeep this terminal open. Press Ctrl+C to stop.`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else throw new Error(`Unknown command: ${command}. Use --help.`);
} catch (error) {
  console.error(
    error.code === 'EADDRINUSE'
      ? 'Port is already in use. Reuse the existing Studio, or explicitly choose --port. Browser projects are separate for each origin.'
      : error.message,
  );
  process.exitCode = 1;
}
