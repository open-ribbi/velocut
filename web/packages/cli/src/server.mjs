import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export const VERSION = '0.0.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'studio');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};
export async function doctor() {
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const node = major > 22 || (major === 22 && minor >= 6);
  let assets = false;
  try {
    await stat(resolve(root, 'index.html'));
    await stat(resolve(root, 'scene-assets/manifest.json'));
    assets = true;
  } catch {}
  return {
    ok: node && assets,
    version: VERSION,
    node: process.versions.node,
    assets,
    browser: 'Chrome or Edge with WebGPU and WebCodecs; GPU support is checked in the editor',
    data: 'Projects stay in the browser profile and origin. Keep the same hostname and port.',
  };
}
function launchBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(`Open Studio in your browser: ${url}`));
  child.unref();
}
export async function startStudio({ port = 5173, open = true } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('port must be an integer from 0 to 65535');
  const health = await doctor();
  if (!health.ok)
    throw new Error(
      'Studio bundle is missing or Node.js is older than 22.6. Install the published CLI package or run the repository release build.',
    );
  const publicRoot = await realpath(root);
  let actualPort;
  const server = createServer(async (req, res) => {
    const end = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    try {
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host))
        return end(403, 'Invalid host');
      if (!['GET', 'HEAD'].includes(req.method)) return end(405, 'Only GET and HEAD are supported');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === '/__velocut/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ app: 'velocut', version: VERSION, bridgeProtocol: 2 }));
      }
      const pathname = decodeURIComponent(url.pathname);
      if (
        pathname.includes('\0') ||
        pathname.includes('\\') ||
        pathname.split('/').some((p) => p === '..' || p.startsWith('.'))
      )
        return end(403, 'Invalid path');
      let file = resolve(publicRoot, '.' + pathname);
      if (pathname.endsWith('/')) file = resolve(file, 'index.html');
      try {
        file = await realpath(file);
      } catch {
        return end(
          404,
          'Resource not found. Cloud proxies are available only in the developer server.',
        );
      }
      if (!file.startsWith(publicRoot + sep)) return end(403, 'Invalid path');
      const info = await stat(file);
      if (!info.isFile()) return end(404, 'Resource not found');
      const headers = {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
      };
      let start = 0,
        endByte = info.size - 1,
        status = 200;
      if (req.headers.range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!m || (!m[1] && !m[2])) return end(416, 'Unsupported range');
        if (!m[1]) start = Math.max(0, info.size - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2]) endByte = Math.min(endByte, Number(m[2]));
        }
        if (start > endByte || start >= info.size) {
          res.setHeader('Content-Range', `bytes */${info.size}`);
          return end(416, 'Range outside file');
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${endByte}/${info.size}`;
      }
      headers['Content-Length'] = Math.max(0, endByte - start + 1);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || !info.size) return res.end();
      await pipeline(createReadStream(file, { start, end: endByte }), res);
    } catch (error) {
      if (!res.headersSent) end(400, 'Invalid request');
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  const url = `http://localhost:${actualPort}`;
  if (open) launchBrowser(url);
  return {
    url,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
