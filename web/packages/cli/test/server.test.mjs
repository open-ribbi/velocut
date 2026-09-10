import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStudio } from '../dist/server.mjs';

test('Studio serves only its bundle and handles browser-required headers and ranges', async (t) => {
  const app = await startStudio({ port: 0, open: false });
  t.after(() => app.close());
  const result = await fetch(app.url);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(result.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal((await fetch(app.url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(app.url + '/%2e%2e%2fpackage.json')).status, 403);
  assert.equal((await fetch(app.url + '/.env')).status, 403);
  assert.equal((await fetch(app.url + '/unknown.js')).status, 404);
  assert.equal((await fetch(app.url + '/sunset-loop.mp4')).status, 404);
  const range = await fetch(app.url + '/scene-assets/manifest.json', {
    headers: { Range: 'bytes=0-15' },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  assert.equal(
    (
      await fetch(app.url + '/scene-assets/manifest.json', {
        headers: { Range: 'bytes=99999999-' },
      })
    ).status,
    416,
  );
  const head = await fetch(app.url, { method: 'HEAD' });
  assert.equal(await head.text(), '');
  const hostile = await new Promise((resolve, reject) => {
    const r = request(app.url, { headers: { Host: 'untrusted.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', reject);
    r.end();
  });
  assert.equal(hostile, 403);
  await assert.rejects(startStudio({ port: Number(new URL(app.url).port), open: false }), {
    code: 'EADDRINUSE',
  });
});

test('CLI validates options and doctor does not need a source checkout', () => {
  const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
  const doctor = JSON.parse(
    execFileSync(process.execPath, [cli, 'doctor', '--json'], { encoding: 'utf8' }),
  );
  assert.equal(doctor.ok, true);
  assert.throws(
    () =>
      execFileSync(process.execPath, [cli, 'studio', '--port', 'not-a-number'], { stdio: 'pipe' }),
    (e) => e.status === 1,
  );
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'studio', '--port', '65536'], { stdio: 'pipe' }),
    (e) => e.status === 1,
  );
});
