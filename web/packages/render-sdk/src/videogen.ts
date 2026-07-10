// videogen.ts — text/image → video (generative), pluggable + configurable.
//
// Mirrors tts.ts exactly: a capability interface (VideoGenerator), a registry
// of provider KINDS (protocol implementations), and per-channel configuration
// (base URL + API key) supplied by the app at create time. The split matters
// because the video-gen relay market all converges on the same protocol
// shapes: one implementation covers every channel that speaks it — adding a
// channel is configuration (URL + key), not code. A provider with a genuinely
// different protocol is one registerVideoGenProvider call.
//
// Built-in kind 'task-api': the async-task pattern most video-gen relays
// converge on: POST {base}/api/v1/tasks {model, params} → task_id, then poll
// GET {base}/api/v1/tasks/{id} until completed/failed. Bearer auth.

export interface VideoGenRequest {
  /** Channel-defined model id (as the configured relay names it). */
  model: string;
  /** Scene/motion description (most providers cap ~500 chars). */
  prompt: string;
  /** Requested clip length, seconds (provider clamps to its range). */
  durationS?: number;
  /** Provider-defined tier: '480p' | '720p' | '1080p' | '4k'. */
  resolution?: string;
  /** '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9' | 'adaptive'. */
  ratio?: string;
  /** Generate a synced audio track (provider default usually true). */
  generateAudio?: boolean;
  /** Image-to-video conditioning: public URLs (providers don't take base64). */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  signal?: AbortSignal;
  /** Progress callback: provider status ('pending'/'processing'/…) + seconds elapsed. */
  onStatus?: (status: string, elapsedS: number) => void;
}

export interface VideoGenResult {
  /** Generated video URL — often short-lived (24h): download promptly. */
  videoUrl: string;
  durationS?: number;
  resolution?: string;
  ratio?: string;
  /** Credits charged by the channel, if reported. */
  cost?: number;
  taskId?: string;
}

/** Prompt (+ optional image conditioning) → a generated video URL. */
export interface VideoGenerator {
  generate(req: VideoGenRequest): Promise<VideoGenResult>;
}

/** Endpoint configuration a channel supplies — the part that differs between
 *  channels speaking the same protocol. */
export interface VideoGenEndpointConfig {
  /** API root, no trailing slash (e.g. 'https://api.example.com'). */
  baseUrl: string;
  apiKey: string;
  pollIntervalMs?: number;
  /** Overall generation deadline (default 10 min). */
  timeoutMs?: number;
}

/** A registered protocol implementation — self-describing so the UI/agent can
 *  enumerate what's available. */
export interface VideoGenProviderKind {
  id: string;
  label: string;
  create(config: VideoGenEndpointConfig): VideoGenerator;
}

const KINDS = new Map<string, VideoGenProviderKind>();

/** Register a video-gen protocol implementation. Last registration of an id wins. */
export function registerVideoGenProvider(k: VideoGenProviderKind): void {
  KINDS.set(k.id, k);
}

/** All registered protocol kinds (for UI/agent discovery). */
export function videoGenProviders(): VideoGenProviderKind[] {
  return [...KINDS.values()];
}

/** Build a generator for a kind + endpoint config (throws if unknown). */
export function createVideoGen(kindId: string, config: VideoGenEndpointConfig): VideoGenerator {
  const k = KINDS.get(kindId);
  if (!k) throw new Error(`unknown video-gen provider kind: ${kindId} (have: ${[...KINDS.keys()].join(', ')})`);
  return k.create(config);
}

// --------------------------------------------------------- built-in: task-api

interface TaskSubmitResponse {
  task_id?: string;
  status?: string;
  detail?: { error_code?: string; message?: string };
}

interface TaskStatusResponse {
  id?: string;
  status?: string; // pending → processing → completed / failed
  result?: { video_url?: string; duration?: number; resolution?: string; ratio?: string };
  error_message?: string;
  cost?: number;
  detail?: { error_code?: string; message?: string };
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/** The async-task protocol generator. Field names follow the de-facto relay
 *  convention (snake_case params, first_frame_image/last_frame_image, …). */
export class TaskApiVideoGen implements VideoGenerator {
  // No parameter properties: node's type-stripping test runner can't parse
  // them (same reason motionspec.ts stays plain).
  private config: VideoGenEndpointConfig;
  constructor(config: VideoGenEndpointConfig) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    if (!req.prompt?.trim()) throw new Error('videoGen: prompt is required');
    if (!req.model) throw new Error('videoGen: model is required');
    const params: Record<string, unknown> = { prompt: req.prompt };
    if (req.durationS != null) params.duration = Math.round(req.durationS);
    if (req.resolution) params.resolution = req.resolution;
    if (req.ratio) params.ratio = req.ratio;
    if (req.generateAudio != null) params.generate_audio = req.generateAudio;
    if (req.firstFrameUrl) params.first_frame_image = req.firstFrameUrl;
    if (req.lastFrameUrl) params.last_frame_image = req.lastFrameUrl;
    if (req.referenceImageUrls?.length) params.reference_images = req.referenceImageUrls;
    if (req.referenceVideoUrls?.length) params.reference_videos = req.referenceVideoUrls;

    const submit = await fetch(`${this.base()}/api/v1/tasks`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: req.model, params }),
      signal: req.signal,
    });
    const submitBody = (await submit.json().catch(() => ({}))) as TaskSubmitResponse;
    if (!submit.ok || !submitBody.task_id) {
      const msg = submitBody.detail?.message ?? JSON.stringify(submitBody).slice(0, 200);
      throw new Error(`videoGen submit failed (HTTP ${submit.status}): ${msg}`);
    }
    const taskId = submitBody.task_id;

    const started = Date.now();
    const pollMs = this.config.pollIntervalMs ?? 5000;
    const deadline = started + (this.config.timeoutMs ?? 10 * 60_000);
    req.onStatus?.(submitBody.status ?? 'pending', 0);

    for (;;) {
      await sleep(pollMs, req.signal);
      if (Date.now() > deadline) {
        throw new Error(`videoGen timed out after ${Math.round((Date.now() - started) / 1000)}s (task ${taskId} may still complete server-side)`);
      }
      const poll = await fetch(`${this.base()}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: this.headers(),
        signal: req.signal,
      });
      const body = (await poll.json().catch(() => ({}))) as TaskStatusResponse;
      if (!poll.ok) {
        const msg = body.detail?.message ?? `HTTP ${poll.status}`;
        throw new Error(`videoGen poll failed: ${msg}`);
      }
      const elapsedS = Math.round((Date.now() - started) / 1000);
      req.onStatus?.(body.status ?? 'unknown', elapsedS);
      if (body.status === 'completed') {
        const url = body.result?.video_url;
        if (!url) throw new Error('videoGen: task completed but returned no video_url');
        return {
          videoUrl: url,
          durationS: body.result?.duration,
          resolution: body.result?.resolution,
          ratio: body.result?.ratio,
          cost: body.cost,
          taskId,
        };
      }
      if (body.status === 'failed') {
        throw new Error(`videoGen failed: ${body.error_message ?? 'unknown provider error'}`);
      }
      // pending / processing → keep polling
    }
  }
}

registerVideoGenProvider({
  id: 'task-api',
  label: 'Async task API (submit \u2192 poll relays)',
  create: (cfg) => new TaskApiVideoGen(cfg),
});
