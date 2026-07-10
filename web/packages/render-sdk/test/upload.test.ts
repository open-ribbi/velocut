// Unit tests for the upload kinds: request shapes and contracts with fetch
// stubbed (SigV4 signature correctness is verified against a real MinIO in
// the browser E2E pass — a mock can't validate crypto).
// Run: node --experimental-strip-types --test packages/render-sdk/test/upload.test.ts

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { S3Uploader, RelayUploader, createUploader, uploaderKinds } from '../src/upload.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init?: RequestInit; headers: Record<string, string> };

function captureFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // aws4fetch passes a Request object; normalize both forms.
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    calls.push({ url: req.url, init, headers });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test('s3: PUT to endpoint/bucket/prefix-uuid.ext with SigV4 auth; publicBase read URL', async () => {
  const calls = captureFetch(200, '');
  const up = new S3Uploader({
    endpoint: 'https://s3.example.com/',
    bucket: 'previz',
    region: 'auto',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    prefix: 'velocut/',
    publicBase: 'https://cdn.example.com',
  });
  const { url } = await up.upload(new Blob(['x'], { type: 'image/png' }), { name: 'frame.png' });
  assert.equal(calls.length, 1);
  const put = calls[0];
  assert.match(put.url, /^https:\/\/s3\.example\.com\/previz\/velocut\/[0-9a-f-]{36}\.png$/);
  assert.equal(put.headers['content-type'], 'image/png');
  // SigV4 header shape (correct credential scope; MinIO validates the crypto).
  assert.match(put.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request,/);
  assert.ok(put.headers['x-amz-date']);
  // Public read URL mirrors the object key under publicBase.
  const key = put.url.split('/previz/')[1];
  assert.equal(url, `https://cdn.example.com/velocut/${key.split('velocut/')[1]}`);
});

test('s3: without publicBase the read URL is a 7-day presigned GET', async () => {
  captureFetch(200, '');
  const up = new S3Uploader({ endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' });
  const { url } = await up.upload(new Blob(['x'], { type: 'video/mp4' }));
  const u = new URL(url);
  assert.match(u.pathname, /^\/b\/[0-9a-f-]{36}\.mp4$/);
  assert.equal(u.searchParams.get('X-Amz-Expires'), String(7 * 24 * 3600));
  assert.ok(u.searchParams.get('X-Amz-Signature'), 'presigned query signature present');
});

test('s3: virtual-host style — empty bucket appends the key to the endpoint', async () => {
  const calls = captureFetch(200, '');
  const up = new S3Uploader({ endpoint: 'https://previz.oss.example.com', accessKeyId: 'AK', secretAccessKey: 'SK', publicBase: 'https://previz.oss.example.com' });
  await up.upload(new Blob(['x'], { type: 'image/png' }));
  assert.match(calls[0].url, /^https:\/\/previz\.oss\.example\.com\/[0-9a-f-]{36}\.png$/);
});

test('s3: upstream rejection surfaces status + body', async () => {
  captureFetch(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
  const up = new S3Uploader({ endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'BAD' });
  await assert.rejects(() => up.upload(new Blob(['x'])), /HTTP 403.*SignatureDoesNotMatch/s);
});

test('relay: POST bytes with content-type + bearer; {url} comes back', async () => {
  const calls = captureFetch(200, { url: 'https://cdn.example.com/o/abc.mp4' });
  const up = new RelayUploader({ endpoint: 'https://relay.example.com/upload', authToken: 'tok' });
  const { url } = await up.upload(new Blob(['x'], { type: 'video/mp4' }), { name: 'previz.mp4' });
  assert.equal(url, 'https://cdn.example.com/o/abc.mp4');
  const post = calls[0];
  assert.equal(post.url, 'https://relay.example.com/upload');
  assert.equal(post.headers['authorization'], 'Bearer tok');
  assert.equal(post.headers['content-type'], 'video/mp4');
  assert.equal(post.headers['x-filename'], 'previz.mp4');
});

test('relay: a response without {url} is a loud error', async () => {
  captureFetch(200, { ok: true });
  const up = new RelayUploader({ endpoint: 'https://relay.example.com/upload' });
  await assert.rejects(() => up.upload(new Blob(['x'])), /no \{url\}/);
});

test('registry: built-ins present; unknown kind fails loudly', () => {
  const ids = uploaderKinds().map((k) => k.id);
  assert.ok(ids.includes('s3') && ids.includes('relay'));
  assert.throws(() => createUploader('nope', {}), /unknown uploader kind/);
});
