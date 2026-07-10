// services/videogen.ts — AI video generation: channel configuration + the
// generate-and-land pipeline.
//
// Configuration mirrors services/llm.ts (BYOK): channels live only in this
// browser's localStorage; each channel is {kind, baseUrl, apiKey, models} —
// the protocol implementation (kind) comes from render-sdk's provider
// registry, so channels speaking the same protocol differ only by data.
//
// Security invariants (SECURITY.md): provider calls happen HOST-side only.
// A sandboxed script can name a configured channel id and a model — never a
// base URL, key, or reference-media URL — so prompt-injected code cannot
// point the host at an attacker endpoint or exfiltrate via provider-side
// URL fetches. The full surface (reference URLs) is reserved for the user
// paths: window.velocut.videoGen and the settings UI.

import { createVideoGen, videoGenProviders, type MediaLibrary, type VideoGenRequest } from '@velocut/render-sdk';
import { saveMedia } from '@velocut/collab-sdk';
import type { Store } from '../state/store';
import { activeStorage } from './projects';

export interface VideoGenChannel {
  /** User-chosen channel id (what scripts/agents name), e.g. 'my-relay'. */
  id: string;
  label?: string;
  /** Protocol implementation id from the render-sdk registry. */
  kind: string;
  baseUrl: string;
  apiKey: string;
  /** Model ids this channel offers (advertised to the agent). */
  models: string[];
  defaultModel?: string;
}

export interface VideoGenConfig {
  channels: VideoGenChannel[];
}

const STORAGE = 'velocut.videogen';

export function loadVideoGenConfig(): VideoGenConfig {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VideoGenConfig>;
      const channels = Array.isArray(parsed.channels) ? parsed.channels : [];
      return {
        channels: channels
          .filter((c): c is VideoGenChannel => Boolean(c && typeof c.id === 'string' && typeof c.baseUrl === 'string'))
          .map((c) => ({
            ...c,
            kind: c.kind || 'task-api',
            models: Array.isArray(c.models) ? c.models.filter((m) => typeof m === 'string') : [],
          })),
      };
    }
  } catch {
    /* fall through */
  }
  return { channels: [] };
}

export function saveVideoGenConfig(cfg: VideoGenConfig): void {
  localStorage.setItem(STORAGE, JSON.stringify(cfg));
}

/** The channel surface safe to show an agent/script: no URLs, no keys. */
export function describeVideoGenChannels(): Array<{ id: string; label?: string; models: string[]; defaultModel?: string }> {
  return loadVideoGenConfig().channels.map((c) => ({
    id: c.id,
    label: c.label,
    models: c.models,
    defaultModel: c.defaultModel,
  }));
}

/** Probe a channel with a zero-cost request (query a bogus task id): one round
 *  trip verifies URL, CORS and auth. A structured 404 means everything up to
 *  authorization works; 401/403 isolates a bad key. */
export async function testVideoGenChannel(ch: VideoGenChannel): Promise<{ ok: boolean; message: string }> {
  const url = `${ch.baseUrl.replace(/\/+$/, '')}/api/v1/tasks/00000000-0000-0000-0000-000000000000`;
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${ch.apiKey}` } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: `HTTP ${r.status}: the API key was rejected.` };
    if (r.status === 404 || r.ok) return { ok: true, message: 'Connected — endpoint and key accepted.' };
    return { ok: false, message: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  } catch (e) {
    return {
      ok: false,
      message: `${String(e instanceof Error ? e.message : e)} — check the URL, and that the endpoint allows browser (CORS) requests. In dev, the local proxy button routes around CORS.`,
    };
  }
}

export interface VideoGenClipOptions {
  prompt: string;
  /** Configured channel id (defaults to the first channel). */
  channel?: string;
  /** Model id (defaults to the channel's defaultModel, then its first model). */
  model?: string;
  durationS?: number;
  resolution?: string;
  ratio?: string;
  generateAudio?: boolean;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  /** Timeline placement (defaults to appending on the Generated track). */
  atUs?: number;
  trackId?: string;
  name?: string;
  onStatus?: (status: string, elapsedS: number) => void;
  signal?: AbortSignal;
}

/** The sandbox-restricted videoGen entry (ScriptApi.videoGen): channel id +
 *  model + prompt only — reference-URL options are rejected so prompt-injected
 *  programs cannot make the provider fetch attacker URLs or steer conditioning
 *  media. Shared by both script hosts (window.velocut.script + the agent). */
export function sandboxVideoGen(store: Store, media: MediaLibrary): (o: unknown) => Promise<VideoGenClipResult> {
  return (o) => {
    const opts = (o ?? {}) as Record<string, unknown>;
    const banned = ['firstFrameUrl', 'lastFrameUrl', 'referenceImageUrls', 'referenceVideoUrls'];
    const hit = banned.find((k) => opts[k] != null);
    if (hit) {
      return Promise.resolve({
        ok: false,
        message: `videoGen: '${hit}' is not available from a sandboxed script (reference media is user-configured only). Generate from the prompt alone.`,
      });
    }
    return generateVideoClip(store, media, opts as unknown as VideoGenClipOptions);
  };
}

export interface VideoGenClipResult {
  ok: boolean;
  assetId?: string;
  clipId?: string;
  trackId?: string;
  atUs?: number;
  durationUs?: number;
  /** Credits the channel reported charging. */
  cost?: number;
  message?: string;
}

/** When the channel is reached through the dev CORS proxy
 *  (/videogen-proxy/<host>/…), route another absolute URL (the result CDN)
 *  through the same proxy — its CORS policy is as unknown as the API's. */
function proxiedUrl(channelBase: string, absoluteUrl: string): string {
  const m = channelBase.match(/^(https?:\/\/[^/]+)\/videogen-proxy\//);
  if (!m) return absoluteUrl;
  try {
    const u = new URL(absoluteUrl);
    return `${m[1]}/videogen-proxy/${u.host}${u.pathname}${u.search}`;
  } catch {
    return absoluteUrl;
  }
}

/**
 * Generate a video and land it as a normal video asset + clip: download the
 * (short-lived) result URL immediately, persist bytes to OPFS, probe, and
 * place on the "Generated" video track — so it scrubs, exports and undoes
 * like imported footage. Shared by window.velocut.videoGen and the sandbox
 * RPC (which pre-filters URL options).
 */
export async function generateVideoClip(store: Store, media: MediaLibrary, opts: VideoGenClipOptions): Promise<VideoGenClipResult> {
  const cfg = loadVideoGenConfig();
  const ch = opts.channel ? cfg.channels.find((c) => c.id === opts.channel) : cfg.channels[0];
  if (!ch) {
    const have = cfg.channels.map((c) => c.id).join(', ') || 'none configured';
    return { ok: false, message: `videoGen: unknown channel '${opts.channel ?? ''}' (configured channels: ${have}). Open Agent settings → Video generation to add one.` };
  }
  if (!ch.apiKey) return { ok: false, message: `videoGen: channel '${ch.id}' has no API key configured.` };
  const model = opts.model ?? ch.defaultModel ?? ch.models[0];
  if (!model) return { ok: false, message: `videoGen: channel '${ch.id}' has no models configured and none was requested.` };
  if (ch.models.length && !ch.models.includes(model)) {
    return { ok: false, message: `videoGen: model '${model}' is not offered by channel '${ch.id}' (available: ${ch.models.join(', ')})` };
  }

  let gen;
  try {
    gen = createVideoGen(ch.kind, { baseUrl: ch.baseUrl, apiKey: ch.apiKey });
  } catch (e) {
    const kinds = videoGenProviders().map((k) => k.id).join(', ');
    return { ok: false, message: `videoGen: ${e instanceof Error ? e.message : String(e)} (registered kinds: ${kinds})` };
  }

  const req: VideoGenRequest = {
    model,
    prompt: opts.prompt,
    durationS: opts.durationS,
    resolution: opts.resolution,
    ratio: opts.ratio,
    generateAudio: opts.generateAudio,
    firstFrameUrl: opts.firstFrameUrl,
    lastFrameUrl: opts.lastFrameUrl,
    referenceImageUrls: opts.referenceImageUrls,
    referenceVideoUrls: opts.referenceVideoUrls,
    onStatus: opts.onStatus,
    signal: opts.signal,
  };

  let result;
  try {
    result = await gen.generate(req);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  // Download NOW — result URLs are typically valid for 24h only.
  let file: File;
  try {
    let resp = await fetch(result.videoUrl, { signal: opts.signal }).catch(() => null);
    if (!resp?.ok) {
      const viaProxy = proxiedUrl(ch.baseUrl, result.videoUrl);
      if (viaProxy !== result.videoUrl) resp = await fetch(viaProxy, { signal: opts.signal });
    }
    if (!resp?.ok) return { ok: false, message: `videoGen: generated, but downloading the video failed (HTTP ${resp?.status ?? 'network/CORS error'}). URL: ${result.videoUrl}` };
    const blob = await resp.blob();
    const base = (opts.name ?? `${model} ${opts.prompt.slice(0, 24)}`).replace(/[\\/:*?"<>|]/g, ' ').trim();
    file = new File([blob], `${base}.mp4`, { type: blob.type || 'video/mp4' });
  } catch (e) {
    return { ok: false, message: `videoGen: download failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Same landing path as imported footage (Toolbar.importFiles).
  const src = await saveMedia(file, activeStorage().mediaDir).catch(() => `local://${file.name}`);
  const source = await media.probeVideo(file);
  const p = source.probe();

  let trackId = opts.trackId;
  if (!trackId) {
    const existing = store.getState().doc.tracks.find((t) => t.kind === 'video' && t.name === 'Generated');
    if (existing) trackId = existing.id;
    else {
      const r = store.dispatch({ type: 'addTrack', kind: 'video', name: 'Generated' });
      const ev = r.ok ? r.events.find((e) => e.kind === 'trackAdded') : undefined;
      trackId = ev?.kind === 'trackAdded' ? ev.trackId : undefined;
    }
  }
  if (!trackId) return { ok: false, message: 'videoGen: failed to create the Generated track.' };
  const track = store.getState().doc.tracks.find((t) => t.id === trackId);
  const atUs = opts.atUs ?? Math.max(0, ...(track?.clips.map((c) => c.startUs + c.durationUs) ?? [0]));

  const aResp = store.dispatch({
    type: 'addAsset',
    kind: 'video',
    src,
    name: opts.name ?? file.name.replace(/\.mp4$/, ''),
    durationUs: p.durationUs,
    width: p.width,
    height: p.height,
    hasAudio: p.hasAudio,
  });
  const aEv = aResp.ok ? aResp.events.find((e) => e.kind === 'assetAdded') : undefined;
  const assetId = aEv?.kind === 'assetAdded' ? aEv.assetId : undefined;
  if (!assetId) return { ok: false, message: 'videoGen: failed to register the video asset.' };
  media.attachVideo(assetId, source, file);

  const cResp = store.dispatch({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs: p.durationUs });
  if (!cResp.ok) return { ok: false, message: `videoGen: failed to place the clip: ${cResp.error?.message ?? ''}` };
  const cEv = cResp.events.find((e) => e.kind === 'clipAdded');
  return {
    ok: true,
    assetId,
    clipId: cEv?.kind === 'clipAdded' ? cEv.clipId : undefined,
    trackId,
    atUs,
    durationUs: p.durationUs,
    cost: result.cost,
  };
}
