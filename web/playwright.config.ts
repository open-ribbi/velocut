import { browserOptions } from './scripts/browser-options.mjs';
// E2E smoke configuration. The suite is designed to stay green on headless CI
// runners: it exercises boot, import (image), timeline editing, persistence and
// the project switcher — but asserts nothing that requires working WebGPU or
// proprietary codecs (the preview degrades to an error card without WebGPU and
// the app survives; H.264 decode/encode is not guaranteed on CI Chromium).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  // Cold CI runners re-transform every module through the Vite dev server on
  // a reload; the app takes well over the 5s default to re-bootstrap.
  expect: { timeout: 15_000 },
  // One retry on CI with a trace: a transient infra hiccup doesn't block the
  // gate, and a real failure leaves a trace artifact to diagnose.
  retries: process.env.CI ? 1 : 0,
  // Storage (IndexedDB/OPFS) is per browser context; tests that span reloads
  // keep their context, and each test file starts from a clean slate.
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    launchOptions: browserOptions,
    headless: browserOptions.headless,
    channel: browserOptions.channel,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
