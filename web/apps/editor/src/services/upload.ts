// services/upload.ts — conditioning uploads: configuration + frame/clip
// capture + the upload:// handle table.
//
// uploadFrame renders the composite at an instant to a PNG; uploadClip
// renders one clip in isolation to an mp4 (the previz → reference-video
// path). Both push through the configured MediaUploader (render-sdk kinds;
// nothing is configured by default) and register an OPAQUE `upload://` handle
// mapping to the real URL. Handles are what sandboxed scripts see: a script
// can reference "the frame/clip the host just rendered" in videoGen calls,
// but can never smuggle in an attacker URL — the handle table only ever
// contains URLs this module produced against the user-configured store.

import { createUploader, isolateClip, Exporter, type MediaLibrary, type Observer } from '@velocut/render-sdk';
import type { Store } from '../state/store';

export interface UploadConfig {
  /** Uploader kind id from the render-sdk registry ('s3' | 'relay' | …). */
  kind: string;
  /** Kind-specific config (endpoint, credentials, …). */
  config: Record<string, unknown>;
}

const STORAGE = 'velocut.upload';

export function loadUploadConfig(): UploadConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UploadConfig>;
    if (typeof parsed.kind !== 'string' || !parsed.kind) return null;
    return { kind: parsed.kind, config: parsed.config ?? {} };
  } catch {
    return null;
  }
}

export function saveUploadConfig(cfg: UploadConfig | null): void {
  if (cfg) localStorage.setItem(STORAGE, JSON.stringify(cfg));
  else localStorage.removeItem(STORAGE);
}

function uploader(): ReturnType<typeof createUploader> | null {
  const cfg = loadUploadConfig();
  if (!cfg) return null;
  return createUploader(cfg.kind, cfg.config);
}

/** One round trip: PUT a tiny probe object and try to read it back through
 *  the returned URL. Verifies endpoint, credentials, CORS and public
 *  readability (the part video-gen providers depend on) in one go. */
export async function testUploadStorage(cfg: UploadConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const u = createUploader(cfg.kind, cfg.config);
    const probe = new Blob([`velocut upload probe ${new Date().toISOString()}`], { type: 'text/plain' });
    const { url } = await u.upload(probe, { name: 'probe.txt', contentType: 'text/plain' });
    const read = await fetch(url).catch(() => null);
    if (read?.ok) return { ok: true, message: `Uploaded and read back — ${url.split('?')[0]}` };
    return {
      ok: false,
      message: `Upload succeeded but reading the URL back failed (HTTP ${read?.status ?? 'network/CORS error'}). Check the bucket's public access / publicBase. URL: ${url.slice(0, 120)}`,
    };
  } catch (e) {
    return {
      ok: false,
      message: `${e instanceof Error ? e.message : String(e)} — check endpoint/credentials, and that the store allows browser (CORS) PUT from this origin.`,
    };
  }
}

// -------------------------------------------------------------- handles

/** upload:// handle → real URL. Session-scoped: handles die with the page,
 *  which matches their purpose (immediately feeding a videoGen call). */
const handles = new Map<string, string>();

function registerHandle(url: string): string {
  const h = `upload://${crypto.randomUUID()}`;
  handles.set(h, url);
  return h;
}

/** Resolve an upload:// handle (videogen reference params accept these). */
export function resolveUploadHandle(ref: string): string | null {
  return handles.get(ref) ?? null;
}

export interface UploadCaptureResult {
  ok: boolean;
  /** Opaque reference for videoGen calls (safe to hand to sandboxed scripts). */
  handle?: string;
  /** The real URL (host-path callers only — never returned over sandbox RPC). */
  url?: string;
  durationUs?: number;
  message?: string;
}

/** Sandbox RPC entries (ScriptApi.uploadFrame/uploadClip): same capture, but
 *  the result carries ONLY the opaque handle — a sandboxed program can
 *  reference what the host just uploaded without ever learning where the
 *  user's store lives. Shared by both script hosts. */
export function sandboxUploads(store: Store, media: MediaLibrary, observer: Observer): {
  uploadFrame: (o: unknown) => Promise<unknown>;
  uploadClip: (o: unknown) => Promise<unknown>;
} {
  const strip = ({ url: _url, ...rest }: UploadCaptureResult): unknown => rest;
  return {
    uploadFrame: async (o) => strip(await uploadFrame(store, observer, (o ?? {}) as { timeUs: number })),
    uploadClip: async (o) => strip(await uploadClip(store, media, (o ?? {}) as { clipId: string; maxS?: number })),
  };
}

/** Longest side of an uploaded conditioning frame. */
const FRAME_TARGET = 1920;
/** Reference-video budget most providers enforce (seconds). */
const CLIP_MAX_S = 15;

/** Render the composite at `timeUs` and upload it as a PNG. */
export async function uploadFrame(
  store: Store,
  observer: Observer,
  opts: { timeUs: number; name?: string },
): Promise<UploadCaptureResult> {
  const up = uploader();
  if (!up) return { ok: false, message: 'No upload storage configured — open Agent settings → Upload storage.' };
  const fg = store.evaluate(Math.max(0, Math.round(opts.timeUs)));
  const grabbed = await observer.grab({ kind: 'graph', fg }, FRAME_TARGET);
  if (!grabbed) return { ok: false, message: 'uploadFrame: nothing renderable at that time.' };
  const canvas = new OffscreenCanvas(grabbed.bitmap.width, grabbed.bitmap.height);
  canvas.getContext('2d')!.drawImage(grabbed.bitmap, 0, 0);
  grabbed.bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  try {
    const { url } = await up.upload(blob, { name: opts.name ?? 'frame.png', contentType: 'image/png' });
    return { ok: true, handle: registerHandle(url), url };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Render ONE clip in isolation (its own layer only, from its own start) to
 *  an mp4 and upload it — the previz-as-reference-video path. Length is
 *  capped at the providers' reference budget. */
export async function uploadClip(
  store: Store,
  media: MediaLibrary,
  opts: { clipId: string; maxS?: number; name?: string; onProgress?: (frac: number) => void },
): Promise<UploadCaptureResult> {
  const up = uploader();
  if (!up) return { ok: false, message: 'No upload storage configured — open Agent settings → Upload storage.' };
  const doc = store.getState().doc;
  const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === opts.clipId);
  if (!clip) return { ok: false, message: `uploadClip: no clip '${opts.clipId}'` };
  const durationUs = Math.min(clip.durationUs, Math.round((opts.maxS ?? CLIP_MAX_S) * 1e6));

  let blob: Blob;
  try {
    blob = await new Exporter(media).export({
      width: doc.width,
      height: doc.height,
      fpsNum: doc.fpsNum,
      fpsDen: doc.fpsDen,
      durationUs,
      // The clip alone, on its own clock — previz references shouldn't carry
      // whatever else the timeline composits at that range.
      evaluate: (t) => isolateClip(store.evaluate(clip.startUs + t), clip.id),
      audioClips: [],
      onProgress: opts.onProgress ? (frac) => opts.onProgress!(frac) : undefined,
    });
  } catch (e) {
    return { ok: false, message: `uploadClip: render failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const { url } = await up.upload(blob, { name: opts.name ?? 'previz.mp4', contentType: 'video/mp4' });
    return { ok: true, handle: registerHandle(url), url, durationUs };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
