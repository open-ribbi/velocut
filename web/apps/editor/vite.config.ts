import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
  plugins: [react()],
  resolve: {
    alias: {
      '@velocut/protocol': fileURLToPath(new URL('../../packages/protocol/src/types.ts', import.meta.url)),
      '@velocut/core-ts': fileURLToPath(new URL('../../packages/core-ts/src/engine.ts', import.meta.url)),
      '@velocut/render-sdk': fileURLToPath(new URL('../../packages/render-sdk/src/index.ts', import.meta.url)),
      '@velocut/agent-sdk': fileURLToPath(new URL('../../packages/agent-sdk/src/index.ts', import.meta.url)),
      '@velocut/collab-sdk': fileURLToPath(new URL('../../packages/collab-sdk/src/index.ts', import.meta.url)),
    },
  },
  server: {
    headers: {
      // 为后续 SharedArrayBuffer / 多线程 worker 预留(cross-origin isolation)
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
