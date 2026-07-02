// tts.ts — text → speech (the first GENERATIVE primitive), pluggable + configurable.
//
// Architecture (mirrors the effect registry's "register once, everyone reads"):
//   - TextToSpeech       : the capability interface (text → waveform).
//   - TtsProvider        : a registered backend (id, label, advertised voices/
//                          languages, a create(config) factory). Drop a new one
//                          in with registerTtsProvider — no other file changes.
//   - ConfigurableTts    : the instance the app uses. It reads a config (which
//                          provider id + provider config) at call time and
//                          delegates, so the active backend is chosen by
//                          configuration, not code. Swap MMS↔Kokoro↔MiniMax by
//                          flipping a setting.
//
// This is what lets the editor CREATE narration it doesn't have, not just
// rearrange existing media. Generated audio lands as a normal OPFS-backed audio
// clip (see services/tts.ts), so it mixes, exports, and undoes like everything.

export interface SynthResult {
  /** Mono PCM waveform. */
  samples: Float32Array;
  sampleRate: number;
}

export interface SynthOptions {
  /** 'chinese' | 'english' | … selects the voice/model. */
  language?: string;
  /** Provider-specific voice id. */
  voice?: string;
  /** Speaking rate multiplier (provider may ignore). */
  speed?: number;
}

/** Text → speech waveform. Any backend implements this. */
export interface TextToSpeech {
  synthesize(text: string, opts?: SynthOptions): Promise<SynthResult>;
}

/** A registered TTS backend — self-describing so the UI/agent can enumerate
 *  what's available and how to configure it. */
export interface TtsProvider {
  id: string;
  label: string;
  /** Whether it runs in the browser (no key/network) or needs a cloud key. */
  kind: 'local' | 'cloud';
  /** Advertised languages / voice ids (for discovery; not exhaustive). */
  languages?: string[];
  voices?: string[];
  /** Build an instance with provider-specific config (model, key, endpoint…). */
  create(config?: Record<string, unknown>): TextToSpeech;
}

const PROVIDERS = new Map<string, TtsProvider>();

/** Register a TTS backend. Last registration of an id wins. */
export function registerTtsProvider(p: TtsProvider): void {
  PROVIDERS.set(p.id, p);
}

/** All registered providers (for UI/agent discovery). */
export function ttsProviders(): TtsProvider[] {
  return [...PROVIDERS.values()];
}

/** Build an instance of a provider by id (throws if unknown). */
export function createTts(id: string, config?: Record<string, unknown>): TextToSpeech {
  const p = PROVIDERS.get(id);
  if (!p) throw new Error(`unknown TTS provider: ${id} (have: ${[...PROVIDERS.keys()].join(', ')})`);
  return p.create(config);
}

export interface TtsConfig {
  /** Active provider id; defaults to the first registered (mms). */
  provider?: string;
  /** Provider-specific config passed to create(). */
  config?: Record<string, unknown>;
}

/** The app-facing TextToSpeech: resolves the active provider from a config
 *  callback at call time and delegates. Instances are cached per (id, config)
 *  so repeated calls reuse a loaded model. The config source (e.g. localStorage)
 *  is injected by the app — this module stays free of storage concerns. */
export class ConfigurableTts implements TextToSpeech {
  private cache = new Map<string, TextToSpeech>();
  constructor(private readConfig: () => TtsConfig = () => ({})) {}

  active(): TextToSpeech {
    const { provider, config } = this.readConfig();
    const id = provider || ttsProviders()[0]?.id;
    if (!id) throw new Error('no TTS provider registered');
    const key = id + '\u0000' + JSON.stringify(config ?? null);
    let inst = this.cache.get(key);
    if (!inst) {
      inst = createTts(id, config);
      this.cache.set(key, inst);
    }
    return inst;
  }

  synthesize(text: string, opts?: SynthOptions): Promise<SynthResult> {
    return this.active().synthesize(text, opts);
  }
}

// --------------------------------------------------------------- built-in: MMS/VITS

/** Browser-local VITS TTS via transformers.js — no key, no CORS, no proxy
 *  (mirrors WhisperTranscriber). NOTE: VITS' GatherND/int64 ops currently fail
 *  on this onnxruntime-web build (webgpu) and its quantized weights crash on
 *  wasm — so this runs only where onnxruntime supports VITS. Kept as the
 *  browser-local reference; swap to a cloud provider via config if it won't run. */
export class MmsTextToSpeech implements TextToSpeech {
  private static DEFAULT_MODELS: Record<string, string> = {
    chinese: 'BricksDisplay/vits-cmn',
    english: 'Xenova/mms-tts-eng',
  };
  private pipes = new Map<string, Promise<unknown>>();
  constructor(private config?: { models?: Record<string, string> }) {}

  private modelFor(language?: string): string {
    const models = { ...MmsTextToSpeech.DEFAULT_MODELS, ...(this.config?.models ?? {}) };
    return models[language ?? 'chinese'] ?? models.chinese;
  }

  private pipe(model: string): Promise<unknown> {
    let p = this.pipes.get(model);
    if (!p) {
      p = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        // fp32: the default q8-quantised VITS weights crash onnxruntime on wasm.
        return pipeline('text-to-speech', model, { dtype: 'fp32' });
      })();
      this.pipes.set(model, p);
    }
    return p;
  }

  async synthesize(text: string, opts?: SynthOptions): Promise<SynthResult> {
    const pipe = (await this.pipe(this.modelFor(opts?.language))) as (
      t: string,
    ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
    const out = await pipe(text);
    return { samples: out.audio, sampleRate: out.sampling_rate };
  }
}

// --------------------------------------------------------------- built-in: MiniMax (cloud)

/** MiniMax T2A cloud TTS (high-quality Chinese). Configurable endpoint (default a
 *  same-origin proxy path to dodge CORS), key, groupId, model, voice. The
 *  response is encoded audio (mp3, hex-string) → decoded to a waveform. */
export class MiniMaxTextToSpeech implements TextToSpeech {
  private ctx: AudioContext | null = null;
  constructor(
    private config?: {
      endpoint?: string; // default: /minimax-proxy/v1/t2a_v2 (Vite proxies → api.minimaxi.com)
      apiKey?: string;
      groupId?: string;
      model?: string;
      voice?: string;
    },
  ) {}

  async synthesize(text: string, opts?: SynthOptions): Promise<SynthResult> {
    const c = this.config ?? {};
    const base = c.endpoint ?? '/minimax-proxy/v1/t2a_v2';
    const url = c.groupId ? `${base}?GroupId=${encodeURIComponent(c.groupId)}` : base;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: c.model ?? 'speech-2.8-hd',
        text,
        stream: false,
        voice_setting: { voice_id: opts?.voice ?? c.voice ?? 'male-qn-jingying', speed: opts?.speed ?? 1.0 },
        audio_setting: { format: 'mp3', sample_rate: 32000 },
      }),
    });
    if (!resp.ok) throw new Error(`MiniMax ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const json = (await resp.json()) as { data?: { audio?: string }; base_resp?: { status_msg?: string } };
    const hex = json.data?.audio;
    if (!hex) throw new Error(`MiniMax 无音频返回: ${json.base_resp?.status_msg ?? 'unknown'}`);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    this.ctx ??= new AudioContext();
    const buf = await this.ctx.decodeAudioData(bytes.buffer);
    return { samples: buf.getChannelData(0).slice(), sampleRate: buf.sampleRate };
  }
}

// Register the built-ins. A new backend = one registerTtsProvider call.
registerTtsProvider({
  id: 'mms',
  label: 'MMS/VITS(浏览器内,无需 key)',
  kind: 'local',
  languages: ['chinese', 'english'],
  create: (cfg) => new MmsTextToSpeech(cfg as { models?: Record<string, string> }),
});
registerTtsProvider({
  id: 'minimax',
  label: 'MiniMax(云端,需 key/GroupId)',
  kind: 'cloud',
  languages: ['chinese', 'english'],
  voices: ['male-qn-jingying', 'female-shaonv', 'male-qn-qingse'],
  create: (cfg) => new MiniMaxTextToSpeech(cfg as ConstructorParameters<typeof MiniMaxTextToSpeech>[0]),
});
