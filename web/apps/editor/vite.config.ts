import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

// Video generation channels — dev-only CORS relay. Channel APIs (e.g.
// api.huimengi.com) allowlist origins and reject localhost, and their result
// CDNs (aliyun OSS signed URLs) send no CORS headers at all — so the browser
// can't reach either directly in dev. The path encodes the target:
// /videogen-proxy/<host>/path?query → https://<host>/path?query.
// A custom middleware (not server.proxy: vite's bare http-proxy has no
// per-request routing) so ONE rule covers the API host and whatever CDN host
// each result lands on. Unlike the MiniMax/Gemini proxies, NO key is injected —
// the channel key is user-configured and travels in the browser's own
// Authorization header; this relay only lends its origin.
function videoGenProxy(): Plugin {
  return {
    name: 'velocut-videogen-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/videogen-proxy', (req, res) => {
        void (async () => {
          const [, host = '', ...rest] = (req.url ?? '').split('/');
          if (!/^[a-z0-9.-]+$/i.test(host) || !host.includes('.')) {
            res.statusCode = 400;
            res.end('videogen-proxy: bad target host');
            return;
          }
          const headers: Record<string, string> = {};
          for (const k of ['authorization', 'content-type', 'accept'] as const) {
            const v = req.headers[k];
            if (typeof v === 'string') headers[k] = v;
          }
          try {
            const method = req.method ?? 'GET';
            const upstream = await fetch(`https://${host}/${rest.join('/')}`, {
              method,
              headers,
              ...(method === 'GET' || method === 'HEAD'
                ? {}
                : { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' as const }),
            });
            res.statusCode = upstream.status;
            for (const k of ['content-type', 'content-length']) {
              const v = upstream.headers.get(k);
              if (v) res.setHeader(k, v);
            }
            if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
            else res.end();
          } catch (e) {
            res.statusCode = 502;
            res.end(`videogen-proxy: upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
      });
    },
  };
}

// MiniMax TTS secret stays SERVER-SIDE (the production-correct pattern): the
// proxy injects the Authorization header so the browser never holds the key.
// Source: env MINIMAX_API_KEY, else a gitignored apps/editor/.minimax-key file.
function minimaxKey(): string {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY.trim();
  try {
    return readFileSync(fileURLToPath(new URL('./.minimax-key', import.meta.url)), 'utf8').trim();
  } catch {
    return '';
  }
}

// Google (Gemini) grounded-search key — same server-side pattern as MiniMax.
// Source: env GOOGLE_API_KEY, else a gitignored apps/editor/.google-key file.
function googleKey(): string {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY.trim();
  try {
    return readFileSync(fileURLToPath(new URL('./.google-key', import.meta.url)), 'utf8').trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react(), videoGenProxy()],
  resolve: {
    alias: {
      '@velocut/protocol': fileURLToPath(new URL('../../packages/protocol/src/types.ts', import.meta.url)),
      '@velocut/core-ts': fileURLToPath(new URL('../../packages/core-ts/src/engine.ts', import.meta.url)),
      // Specific subpath BEFORE the package alias — the plain key is a prefix
      // match, which would mangle '@velocut/render-sdk/motionspec'.
      '@velocut/render-sdk/motionspec': fileURLToPath(new URL('../../packages/render-sdk/src/motionspec.ts', import.meta.url)),
      '@velocut/render-sdk': fileURLToPath(new URL('../../packages/render-sdk/src/index.ts', import.meta.url)),
      '@velocut/agent-sdk': fileURLToPath(new URL('../../packages/agent-sdk/src/index.ts', import.meta.url)),
      '@velocut/collab-sdk': fileURLToPath(new URL('../../packages/collab-sdk/src/index.ts', import.meta.url)),
    },
  },
  server: {
    headers: {
      // Reserved for future SharedArrayBuffer / multithreaded workers (cross-origin isolation)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Dev-only: route the in-app agent through a local Anthropic-compatible
    // proxy when one is running (e.g. claude-plus on :3141). Same-origin from
    // the browser, so no CORS. Inject window.__velocutAgentTransport to use it.
    proxy: {
      '/llm-proxy': {
        target: 'http://127.0.0.1:3141',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/llm-proxy/, ''),
      },
      // Cloud TTS (MiniMax) — same-origin proxy (dodges CORS) that ALSO injects
      // the secret server-side, so the browser never holds the key (only the
      // non-secret GroupId travels in the URL). MiniMaxTextToSpeech posts to
      // /minimax-proxy/v1/t2a_v2?GroupId=… with no Authorization header.
      '/minimax-proxy': {
        target: 'https://api.minimaxi.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/minimax-proxy/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = minimaxKey();
            if (key) proxyReq.setHeader('Authorization', `Bearer ${key}`);
          });
        },
      },
      // Web search (Gemini grounded search) — same-origin proxy that injects the
      // Google key server-side. The browser posts the Gemini request body to
      // /gemini-proxy/v1beta/models/<model>:generateContent with no key; the
      // proxy adds x-goog-api-key. Reuses evo-backend's proven grounded-search.
      '/gemini-proxy': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gemini-proxy/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = googleKey();
            if (key) proxyReq.setHeader('x-goog-api-key', key);
          });
        },
      },
    },
  },
  build: { target: 'esnext' },
});
