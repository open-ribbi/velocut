// services/llm.ts — LLM provider configuration (BYOK, industry-standard shape).
//
// The agent speaks the Anthropic Messages protocol; what's configurable is
// WHERE it speaks it (base URL) and HOW it authenticates — the same contract
// every "bring your own key" tool exposes. Any Anthropic-protocol-compatible
// relay/gateway works (LiteLLM, one-api/new-api, claude-plus, corporate
// proxies): point the base URL at it and use whatever key it issued.
//
// Trust note (mirrored in SECURITY.md): the key lives only in this browser's
// localStorage. Configuring a third-party base URL means your key, prompts and
// observation frames go to THAT service instead of Anthropic — a deliberate,
// user-made choice. Browser-direct calls also require the gateway to allow
// cross-origin requests (the official API needs its CORS opt-in header, which
// the SDK/test below send automatically).

export interface LlmConfig {
  /** Anthropic-protocol endpoint root (no trailing /v1). */
  baseUrl: string;
  apiKey: string;
  /** How the key is presented: `x-api-key` (Anthropic native) or
   *  `Authorization: Bearer` (common for gateways). */
  auth: 'x-api-key' | 'bearer';
  model: string;
  /** User-added model ids (relays often expose custom names). */
  customModels: string[];
}

export const OFFICIAL_BASE_URL = 'https://api.anthropic.com';
export const BUILTIN_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

const STORAGE = 'velocut.llm';
// Pre-config storage (migrated on first load, then removed).
const LEGACY_KEY = 'velocut.anthropicApiKey';
const LEGACY_MODEL = 'velocut.agentModel';

const DEFAULTS: LlmConfig = {
  baseUrl: OFFICIAL_BASE_URL,
  apiKey: '',
  auth: 'x-api-key',
  model: BUILTIN_MODELS[0],
  customModels: [],
};

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      return {
        ...DEFAULTS,
        ...parsed,
        auth: parsed.auth === 'bearer' ? 'bearer' : 'x-api-key',
        customModels: Array.isArray(parsed.customModels) ? parsed.customModels.filter((m) => typeof m === 'string') : [],
      };
    }
  } catch {
    /* fall through to migration/defaults */
  }
  // One-time migration from the pre-config keys.
  const legacyKey = localStorage.getItem(LEGACY_KEY);
  const legacyModel = localStorage.getItem(LEGACY_MODEL);
  const cfg: LlmConfig = {
    ...DEFAULTS,
    apiKey: legacyKey ?? '',
    model: legacyModel ?? DEFAULTS.model,
  };
  if (legacyKey || legacyModel) {
    saveLlmConfig(cfg);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(LEGACY_MODEL);
  }
  return cfg;
}

export function saveLlmConfig(cfg: LlmConfig): void {
  localStorage.setItem(STORAGE, JSON.stringify(cfg));
}

export function modelOptions(cfg: LlmConfig): string[] {
  const all = [...BUILTIN_MODELS, ...cfg.customModels];
  if (cfg.model && !all.includes(cfg.model)) all.push(cfg.model);
  return all;
}

/** Auth + protocol headers for a raw Anthropic-protocol request. */
export function llmHeaders(cfg: LlmConfig): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (cfg.auth === 'bearer') h['authorization'] = `Bearer ${cfg.apiKey}`;
  else h['x-api-key'] = cfg.apiKey;
  // The official API requires an explicit opt-in for browser-direct calls;
  // harmless for gateways.
  h['anthropic-dangerous-direct-browser-access'] = 'true';
  return h;
}

/** Probe the endpoint with a minimal 1-token message — the standard
 *  "Test connection" affordance. Verifies URL, auth, CORS and the model id
 *  in one round trip; costs a few tokens. */
export async function testLlmConnection(cfg: LlmConfig): Promise<{ ok: boolean; message: string }> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: llmHeaders(cfg),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (r.ok) return { ok: true, message: `Connected — ${cfg.model} responded.` };
    const body = (await r.text()).slice(0, 300);
    let detail = body;
    try {
      detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
    } catch {
      /* not JSON */
    }
    return { ok: false, message: `HTTP ${r.status}: ${detail}` };
  } catch (e) {
    // fetch() rejects on network/CORS failures without a status.
    return {
      ok: false,
      message: `${String(e instanceof Error ? e.message : e)} — check the URL, and that the endpoint allows browser (CORS) requests.`,
    };
  }
}
