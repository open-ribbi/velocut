import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Anthropic from '@anthropic-ai/sdk';
import { App } from './App';
import { Container } from './di/container';
import { TOKENS } from './di/tokens';
import { createEngine } from './services/engine';
import { MediaLibrary, RendererClient, Playback, AudioEngine, WhisperTranscriber, Exporter, Observer, ConfigurableTts, ttsProviders, localTts, validateMotionSpec, type TtsConfig } from '@velocut/render-sdk';
import { CollabSession, loadMedia, kvGet, kvPut } from '@velocut/collab-sdk';
import { FontLibrary } from './services/fonts';
import { captionAsset } from './services/caption';
import { observeForAgent, type ObserveInput } from './services/observe';
import { synthesizeNarration } from './services/tts';
import { runAgentScript } from './services/script';
import { createMotionClip, syncMotionAsset, migrateLegacyMotionSpecs, type MotionClipOptions } from './services/motion';
import { checkSpecCommand, createSceneClip, pruneSceneRenderers, syncSceneAsset, type SceneClipOptions } from './services/scene';
import { loadSceneManifest, scenePromptDoc } from '@velocut/scene-sdk';
import { searchWeb } from './services/search';
import { generateVideoClip, describeVideoGenChannels, sandboxVideoGen, type VideoGenClipOptions } from './services/videogen';
import { uploadFrame, uploadClip, sandboxUploads } from './services/upload';
import { Store } from './state/store';
import { HistoryTree } from './state/history';
import { ensureActiveProject, storageKeys, listProjects, createProject, renameProject, deleteProject, openProject, registerFlushBeforeSwitch } from './services/projects';
import type { Command } from '@velocut/protocol';
import './styles.css';

export { TOKENS };

/** Stable local editor identity for history attribution, persisted per browser. */
function localActor(): { kind: 'user'; peerId: string; name: string } {
  let peerId = localStorage.getItem('velocut.peerId');
  if (!peerId) {
    peerId = 'u' + Date.now().toString(36) + Math.floor(performance.now()).toString(36);
    localStorage.setItem('velocut.peerId', peerId);
  }
  const name = localStorage.getItem('velocut.peerName') || 'You';
  return { kind: 'user', peerId, name };
}

/** Load the persisted branching history (survives reloads). */
async function loadHistory(key: string): Promise<HistoryTree | undefined> {
  try {
    const raw = await kvGet(key);
    if (!raw) return undefined;
    return HistoryTree.deserialize(JSON.parse(new TextDecoder().decode(raw)));
  } catch (e) {
    console.warn('[velocut] history restore failed:', e);
    return undefined;
  }
}

/** Debounced persist of the history tree to IndexedDB. `flush` lands a pending
 *  write and awaits it (used before app-controlled reloads); the pagehide hook
 *  is a best-effort backstop for user-initiated instant reloads. */
function makeHistorySaver(key: string): { save: (tree: HistoryTree) => void; flush: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: HistoryTree | null = null;
  const write = async () => {
    if (!latest) return;
    await kvPut(key, new TextEncoder().encode(JSON.stringify(latest.serialize()))).catch(() => {});
  };
  const flush = async () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    await write();
  };
  window.addEventListener('pagehide', () => void flush());
  return {
    flush,
    save: (tree: HistoryTree) => {
      latest = tree;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void write();
      }, 600);
    },
  };
}

/** Re-attach OPFS-backed media after a reload or a remote peer's import. */
async function restoreMedia(store: Store, media: MediaLibrary, mediaDir: string) {
  for (const a of store.getState().doc.assets) {
    // Procedural motion assets render from their in-document spec. Synced on
    // EVERY document change (not just when unattached): undo/redo, a history
    // jump or a remote peer can replace the spec under an attached asset, and
    // the compiled renderer must follow. No-op when the spec is unchanged.
    if (a.src.startsWith('motion://')) {
      if (!(await syncMotionAsset(store, media, a))) console.warn('[velocut] motion restore failed:', a.id);
      continue;
    }
    if (a.src.startsWith('scene://')) {
      if (!(await syncSceneAsset(store, media, a))) console.warn('[velocut] scene restore failed:', a.id);
      continue;
    }
    if (media.hasAsset(a.id)) continue;
    if (!a.src.startsWith('opfs://')) continue;
    // Imported audio re-attaches from its OPFS PCM cache — no re-decode.
    if (a.kind === 'audio' && (await media.restoreAudio(a.id))) continue;
    const file = await loadMedia(a.src, mediaDir);
    if (!file) continue;
    try {
      if (a.kind === 'video') {
        media.attachVideo(a.id, await media.probeVideo(file), file);
        // Always reuse an existing low-res proxy (cheap, no transcode) so the
        // preview is smooth on reload. Only the expensive BUILD is opt-in
        // (concurrent 4K decode is heavy) — gated behind velocut.autoProxy.
        if (!(await media.restoreProxy(a.id)) && localStorage.getItem('velocut.autoProxy') === '1') {
          void media.buildProxy(a.id);
        }
      }
      else if (a.kind === 'audio') await media.attachAudio(a.id, (await media.probeAudio(file)).buffer);
      else media.attachImage(a.id, await media.probeImage(file));
    } catch (e) {
      console.warn('[velocut] media restore failed:', a.src, e);
    }
  }
  // Renderers whose asset left the document (undo, delete, remote removal)
  // must free their WebGL context — contexts are a hard browser-capped pool.
  pruneSceneRenderers(store);
}

async function bootstrap() {
  // Which project this session runs in decides every storage key below.
  const project = await ensureActiveProject();
  const storage = storageKeys(project.id);

  const engine = await createEngine({
    name: project.name,
    width: 1280,
    height: 720,
    fpsNum: 30,
    fpsDen: 1,
  });

  const restoredHistory = await loadHistory(storage.history);
  const historySaver = makeHistorySaver(storage.history);

  const container = new Container()
    .registerValue(TOKENS.Engine, engine)
    .register(
      TOKENS.Store,
      (c) =>
        new Store(c.resolve(TOKENS.Engine), {
          localUser: localActor(),
          restoredHistory,
          onHistory: historySaver.save,
        }),
    )
    .register(TOKENS.Media, () => new MediaLibrary(storage.mediaScope))
    .register(TOKENS.Renderer, () => new RendererClient())
    .register(TOKENS.Observer, (c) => new Observer(c.resolve(TOKENS.Media)))
    .register(TOKENS.Audio, (c) => new AudioEngine(c.resolve(TOKENS.Media)))
    .register(TOKENS.Fonts, (c) => new FontLibrary(c.resolve(TOKENS.Renderer)))
    .register(TOKENS.Transcriber, () => new WhisperTranscriber())
    // TTS backend is config-selectable: localStorage velocut.tts = provider id
    // ('mms' | 'minimax'), velocut.ttsConfig = JSON provider config (model/key/
    // groupId/voice). Defaults to the first registered provider (mms).
    .register(
      TOKENS.Tts,
      () =>
        new ConfigurableTts((): TtsConfig => {
          let config: Record<string, unknown> | undefined;
          try {
            config = JSON.parse(localStorage.getItem('velocut.ttsConfig') || 'null') ?? undefined;
          } catch {
            config = undefined;
          }
          return { provider: localStorage.getItem('velocut.tts') || undefined, config };
        }),
    )
    .register(
      TOKENS.Playback,
      (c) =>
        new Playback(
          c.resolve(TOKENS.Store),
          c.resolve(TOKENS.Media),
          c.resolve(TOKENS.Renderer),
          c.resolve(TOKENS.Audio),
        ),
    );

  const store = container.resolve(TOKENS.Store);
  const media = container.resolve(TOKENS.Media);

  // Local-first persistence + multi-tab CRDT sync: restores the last
  // session's document from IndexedDB, then mirrors every edit to Y.
  // Room + storage key are per project, so tabs on different projects
  // neither sync nor clobber each other.
  const collab = new CollabSession(store, storage.room, storage.ydoc);
  await collab.start();
  // Project switching reloads the page; land pending persists first so the
  // last edits in the outgoing project are never raced by the navigation.
  registerFlushBeforeSwitch(async () => {
    await collab.flushNow();
    await historySaver.flush();
  });
  // One-time fold of pre-v2 motion specs (IndexedDB kv) into Asset.spec, so
  // spec edits participate in undo/history/sync like any other document state.
  await migrateLegacyMotionSpecs(store);
  await restoreMedia(store, media, storage.mediaDir);
  void container.resolve(TOKENS.Fonts).restore();
  // Remote peers may import assets — re-attach their OPFS media lazily.
  // A change landing while a restore is in flight (scene compiles take real
  // time) must schedule ONE trailing re-run, not be dropped — otherwise the
  // attached renderer silently stays compiled from a stale spec.
  let restoring = false;
  let restorePending = false;
  const scheduleRestore = () => {
    if (restoring) {
      restorePending = true;
      return;
    }
    restoring = true;
    void restoreMedia(store, media, storage.mediaDir).finally(() => {
      restoring = false;
      if (restorePending) {
        restorePending = false;
        scheduleRestore();
      }
    });
  };
  store.subscribe(scheduleRestore);

  // Raw applies (agent scripts, DevTools) can carry setAssetSpec — validate
  // the spec BEFORE the engine stores it opaquely: an invalid spec in the
  // document renders stale (last good compile) until reload, then black.
  const guardedDispatch = (cmd: Command) => {
    const specErr = checkSpecCommand(store, cmd as Parameters<typeof checkSpecCommand>[1], validateMotionSpec);
    if (specErr) return { ok: false, error: { code: 'invalidSpec', message: specErr } } as ReturnType<typeof store.dispatch>;
    return store.dispatch(cmd);
  };

  // Agent API — the same dispatch path the UI uses. An external agent (or
  // you, in DevTools) can edit the project with plain JSON commands:
  //   velocut.apply({type:'splitClip', clipId:'clip_2', atUs:1500000})
  (window as any).velocut = {
    apply: (cmd: Command | string) =>
      guardedDispatch(typeof cmd === 'string' ? JSON.parse(cmd) : cmd),
    undo: () => store.undo(),
    redo: () => store.redo(),
    doc: () => store.getState().doc,
    evaluate: (timeUs: number) => store.evaluate(timeUs),
    caption: (o: { assetId?: string; fontSize?: number; color?: string } = {}) =>
      captionAsset(store, media, container.resolve(TOKENS.Transcriber), o),
    observe: (input: ObserveInput = {}) => observeForAgent(store, container.resolve(TOKENS.Observer), input),
    tts: (o: { text: string; atUs?: number; trackId?: string; language?: string }) =>
      synthesizeNarration(store, media, container.resolve(TOKENS.Tts), o),
    // Procedural motion-graphics clip from a declarative spec — same surface the
    // agent's velocut.motionClip reaches (persisted, so it survives reload).
    motionClip: (o: MotionClipOptions) => createMotionClip(store, media, o),
    // Declarative 3D scene clip (Scene Director) — same seam as motionClip.
    sceneClip: (o: SceneClipOptions) => createSceneClip(store, media, o),
    // AI video generation via a configured channel (Agent settings → Video
    // generation). Full option surface incl. reference URLs — this is the
    // USER path; the sandbox RPC below is the restricted one.
    videoGen: (o: VideoGenClipOptions) => generateVideoClip(store, media, o),
    videoGenChannels: () => describeVideoGenChannels(),
    // Conditioning uploads (frame PNG / isolated-clip mp4 → the configured
    // store). Host path returns the real URL alongside the upload:// handle.
    uploadFrame: (o: { timeUs: number; name?: string }) => uploadFrame(store, container.resolve(TOKENS.Observer), o),
    uploadClip: (o: { clipId: string; maxS?: number; name?: string }) => uploadClip(store, media, o),
    // Web research (grounded search) — same surface the agent's velocut_search reaches.
    search: (query: string) => searchWeb(query),
    // Run an editing program in one call (the velocut_script host surface) — same
    // API the agent's runScript reaches. velocut.script("for(...){ await velocut.tts(...); velocut.apply(...) }").
    script: (code: string) =>
      runAgentScript(
        {
          apply: (cmd) => guardedDispatch(typeof cmd === 'string' ? JSON.parse(cmd) : (cmd as Command)),
          // Sandbox path forces LOCAL (in-browser) TTS: a cloud provider would POST
          // the script's (attacker-controllable) text to a third-party endpoint from
          // the HOST realm, an egress the sandbox's connect-src 'none' can't cover.
          // The UI and the discrete velocut_tts tool keep the configurable provider.
          tts: (o) => {
            const local = localTts();
            if (!local) return Promise.resolve({ ok: false, message: 'Sandboxed scripts only allow local TTS; no local speech backend is available.' });
            return synthesizeNarration(store, media, local, o);
          },
          observe: async (input) => {
            const r = await observeForAgent(store, container.resolve(TOKENS.Observer), input as ObserveInput);
            return { ok: r.ok, summary: r.summary, data: r.data };
          },
          evaluate: (t: number) => store.evaluate(t),
          document: () => store.getState().doc,
          seek: (t: number) => store.seek(t),
          motionClip: (o) => createMotionClip(store, media, o as MotionClipOptions),
          sceneClip: (o) => createSceneClip(store, media, o as SceneClipOptions),
          sceneAssets: async () => {
            const manifest = await loadSceneManifest();
            return { doc: scenePromptDoc(manifest), manifest };
          },
          // Sandbox video-gen: channel id + model + prompt, reference media
          // only as upload:// handles (endpoint/key resolve from host config).
          videoGen: sandboxVideoGen(store, media),
          videoGenChannels: () => describeVideoGenChannels(),
          ...sandboxUploads(store, media, container.resolve(TOKENS.Observer)),
        },
        code,
      ),
    // TTS backend discovery/config: ttsProviders() lists backends; set
    // localStorage velocut.tts='minimax' + velocut.ttsConfig='{"apiKey":…,"groupId":…}'.
    ttsProviders: () => ttsProviders().map((p) => ({ id: p.id, label: p.label, kind: p.kind, languages: p.languages, voices: p.voices })),
    engine: engine.kind,
    store,
    seek: (timeUs: number) => store.seek(timeUs),
    media,
    Exporter, // debug: new velocut.Exporter(velocut.media).export({...}) for bounded test exports
    audio: container.resolve(TOKENS.Audio),
    transcriber: container.resolve(TOKENS.Transcriber),
    collab,
    // Multi-project surface (also what the UI switcher calls).
    projects: {
      active: () => project,
      list: listProjects,
      create: createProject,
      open: openProject,
      rename: renameProject,
      delete: deleteProject,
    },
  };

  // Dev convenience: route the in-app agent through a local Anthropic-compatible
  // proxy (e.g. claude-plus on :3141, reached via Vite's /llm-proxy) so you can
  // test the agent without pasting a real API key. Enable with:
  //   localStorage.setItem('velocut.devProxy','1')  then reload.
  if (import.meta.env.DEV && localStorage.getItem('velocut.devProxy') === '1') {
    // Non-streaming fallback (also the Playwright script-transport injection point).
    (window as any).__velocutAgentTransport = async (params: Record<string, unknown>) => {
      const { thinking: _drop, ...rest } = params;
      const r = await fetch('/llm-proxy/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'dummy', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(rest),
      });
      if (!r.ok) throw new Error('proxy ' + r.status + ': ' + (await r.text()).slice(0, 200));
      return r.json();
    };
    // Streaming transport: an Anthropic client pointed at the same-origin
    // /llm-proxy. The SDK makes the request (with stream:true), parses the SSE,
    // and returns a MessageStream — agent-sdk's createStream. The proxy doesn't
    // support extended thinking, so we strip it (the real-key path keeps it).
    const devAgent = new Anthropic({
      apiKey: 'dummy',
      baseURL: `${location.origin}/llm-proxy`,
      dangerouslyAllowBrowser: true,
    });
    (window as any).__velocutAgentStream = (params: Record<string, unknown>) => {
      const { thinking: _drop, ...rest } = params;
      return devAgent.messages.stream(rest as never);
    };
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App container={container} />
    </StrictMode>,
  );
}

bootstrap();

// The app is a stateful singleton graph (DI container, WASM engine, decode
// worker, WebGPU device) — a partial hot swap tears it apart. Any HMR update
// that bubbles to the entry gets a clean reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}
