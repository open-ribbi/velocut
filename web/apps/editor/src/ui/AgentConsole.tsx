// ui/AgentConsole.tsx — chat with the editing agent.
//
// Natural language in, edits out: each turn runs the @velocut/agent-sdk
// tool-use loop, whose tools call store.dispatch — the exact code path UI
// gestures use. Tool calls render as cards so the user sees every command
// the model applied (and can undo them like any other edit).

import { useRef, useState } from 'react';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgentTurn, type AgentEvent } from '@velocut/agent-sdk';
import { type MediaLibrary, type Transcriber, type Observer, type TextToSpeech, type ShotAnalysis, effectPromptDoc } from '@velocut/render-sdk';
import type { Store, UiState } from '../state/store';
import { captionAsset } from '../services/caption';
import { observeForAgent } from '../services/observe';
import { synthesizeNarration } from '../services/tts';
import { runAgentScript } from '../services/script';
import { createMotionClip, type MotionClipOptions } from '../services/motion';
import { createSceneClip, type SceneClipOptions } from '../services/scene';
import { loadSceneManifest, scenePromptDoc } from '@velocut/scene-sdk';
import { searchWeb } from '../services/search';
import {
  loadLlmConfig,
  saveLlmConfig,
  modelOptions,
  testLlmConnection,
  OFFICIAL_BASE_URL,
  BUILTIN_MODELS,
  type LlmConfig,
} from '../services/llm';
import {
  loadVideoGenConfig,
  saveVideoGenConfig,
  testVideoGenChannel,
  describeVideoGenChannels,
  sandboxVideoGen,
  type VideoGenChannel,
  type VideoGenConfig,
} from '../services/videogen';
import { loadUploadConfig, saveUploadConfig, testUploadStorage, sandboxUploads, type UploadConfig } from '../services/upload';
import { videoGenProviders, uploaderKinds } from '@velocut/render-sdk';
import { useFloatingDock } from './useDraggable';

interface ChatItem {
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'error';
  text: string;
  /** tool cards: true/false = result; undefined = pending (toolStart placeholder). */
  ok?: boolean;
  /** observe: the images the agent saw (glass-box — shown inline, click to zoom). */
  images?: { base64: string; mediaType: string }[];
  /** observe (no-image modes): structured data for an inline sparkline. */
  obs?: { mode: string; data: unknown };
  /** apply: where this edit landed, so the card can jump the playhead / select. */
  jump?: { clipId?: string; atUs?: number };
}

/** Where an apply command landed, for the clickable tool card: the clip it
 *  touched + a representative instant. Batch commands aren't single-targeted. */
function applyJump(input: unknown): { clipId?: string; atUs?: number } | undefined {
  const cmd = (input as { command?: Record<string, unknown> })?.command;
  if (!cmd || cmd.type === 'batch') return undefined;
  const clipId = typeof cmd.clipId === 'string' ? cmd.clipId : undefined;
  const atUs = ['atUs', 'startUs', 'toUs']
    .map((k) => cmd[k])
    .find((v) => typeof v === 'number') as number | undefined;
  return clipId == null && atUs == null ? undefined : { clipId, atUs };
}

/** Inline sparkline for the no-image observe modes — the visual peer of the
 *  image card: it shows the human the same curve the agent cut on.
 *  shots → frame-diff curve + adaptive threshold + cut boundaries;
 *  audio → loudness + silence bands + energy peaks; scan → scene-change score. */
function ObserveViz({ mode, data }: { mode: string; data: unknown }) {
  const W = 280;
  const H = 44;
  if (mode === 'shots') {
    const d = data as { diffCurve?: number[]; threshold?: number; shots?: { startUs: number }[]; fromUs?: number; toUs?: number };
    const curve = d.diffCurve ?? [];
    if (curve.length < 2) return null;
    const max = Math.max(0.001, ...curve, d.threshold ?? 0);
    const pts = curve.map((v, i) => `${((i / (curve.length - 1)) * W).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`).join(' ');
    const span = (d.toUs ?? 0) - (d.fromUs ?? 0) || 1;
    const cuts = (d.shots ?? []).slice(1).map((s) => ((s.startUs - (d.fromUs ?? 0)) / span) * W);
    const thY = d.threshold != null ? H - (d.threshold / max) * H : null;
    return (
      <svg className="obs-viz" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {cuts.map((x, i) => (
          <line key={i} x1={x} y1={0} x2={x} y2={H} className="obs-cut" />
        ))}
        {thY != null && <line x1={0} y1={thY} x2={W} y2={thY} className="obs-thresh" />}
        <polyline points={pts} className="obs-line" />
      </svg>
    );
  }
  if (mode === 'audio') {
    const d = data as { loudness?: number[]; silences?: { startUs: number; endUs: number }[]; peaks?: { atUs: number }[]; fromUs?: number; toUs?: number };
    const curve = d.loudness ?? [];
    const span = (d.toUs ?? 0) - (d.fromUs ?? 0) || 1;
    const norm = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60)); // -60..0 dBFS → 0..1
    const pts = curve.length >= 2 ? curve.map((v, i) => `${((i / (curve.length - 1)) * W).toFixed(1)},${(H - norm(v) * H).toFixed(1)}`).join(' ') : '';
    const bands = (d.silences ?? []).map((s) => ({ x: ((s.startUs - (d.fromUs ?? 0)) / span) * W, w: ((s.endUs - s.startUs) / span) * W }));
    const peaks = (d.peaks ?? []).map((p) => ((p.atUs - (d.fromUs ?? 0)) / span) * W);
    if (!pts && !bands.length) return null;
    return (
      <svg className="obs-viz" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {bands.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={Math.max(1, b.w)} height={H} className="obs-silence" />
        ))}
        {peaks.map((x, i) => (
          <line key={i} x1={x} y1={0} x2={x} y2={H} className="obs-peak" />
        ))}
        {pts && <polyline points={pts} className="obs-line" />}
      </svg>
    );
  }
  if (mode === 'scan') {
    const d = data as { windows?: { atUs: number; sceneScore: number; silent: boolean }[] };
    const ws = d.windows ?? [];
    if (ws.length < 2) return null;
    const max = Math.max(1, ...ws.map((w) => w.sceneScore));
    const pts = ws.map((w, i) => `${((i / (ws.length - 1)) * W).toFixed(1)},${(H - (w.sceneScore / max) * H).toFixed(1)}`).join(' ');
    const sil = ws.map((w, i) => (w.silent ? (i / (ws.length - 1)) * W : -1)).filter((x) => x >= 0);
    return (
      <svg className="obs-viz" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {sil.map((x, i) => (
          <line key={i} x1={x} y1={H - 4} x2={x} y2={H} className="obs-silence-tick" />
        ))}
        <polyline points={pts} className="obs-line" />
      </svg>
    );
  }
  return null;
}

function toolSummary(e: Extract<AgentEvent, { kind: 'tool' }>): string {
  if (e.name === 'velocut_apply') {
    const cmd = (e.input as { command?: { type?: string; clipId?: string } })?.command;
    let suffix = '';
    if (e.ok) {
      try {
        const env = JSON.parse(e.detail) as { revision?: number };
        suffix = ` → rev ${env.revision}`;
      } catch {
        /* keep bare */
      }
    } else {
      suffix = ` ✗ ${e.detail.slice(0, 120)}`;
    }
    // Surface the clip id so it matches the chip on the timeline clip.
    return `${cmd?.type ?? 'apply'}${cmd?.clipId ? ' ' + cmd.clipId : ''}${suffix}`;
  }
  if (e.name === 'velocut_get_document') return 'Read project document';
  if (e.name === 'velocut_observe') {
    const mode = (e.input as { mode?: string })?.mode ?? 'frame';
    return `👁 Observe (${mode})${e.ok ? '' : ' ✗ ' + e.detail.slice(0, 80)}`;
  }
  if (e.name === 'velocut_tts') {
    const t = ((e.input as { text?: string })?.text ?? '').slice(0, 16);
    if (e.ok) {
      try {
        const r = JSON.parse(e.detail) as { durationUs?: number };
        return `🔊 Narration "${t}" → ${((r.durationUs ?? 0) / 1e6).toFixed(1)}s`;
      } catch {
        return `🔊 Narration "${t}"`;
      }
    }
    return `🔊 Narration ✗ ${e.detail.slice(0, 80)}`;
  }
  if (e.name === 'velocut_evaluate')
    return `Inspect structure at ${(((e.input as { timeUs?: number })?.timeUs ?? 0) / 1e6).toFixed(2)}s`;
  if (e.name === 'velocut_transcribe') {
    if (e.ok) {
      try {
        const r = JSON.parse(e.detail) as { count?: number };
        return `Auto subtitles → ${r.count ?? 0} lines`;
      } catch {
        return 'Auto subtitles';
      }
    }
    return `Auto subtitles ✗ ${e.detail.slice(0, 80)}`;
  }
  return e.name;
}

export function AgentConsole({
  store,
  media,
  transcriber,
  observer,
  tts,
}: {
  store: Store;
  state: UiState;
  media: MediaLibrary;
  transcriber: Transcriber;
  observer: Observer;
  tts: TextToSpeech;
}) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<LlmConfig>(loadLlmConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const history = useRef<Anthropic.MessageParam[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const dock = useFloatingDock('velocut.agentDockPos', open, () => setOpen(true));

  const scrollDown = () => requestAnimationFrame(() => listRef.current?.scrollTo({ top: 1e9 }));

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setItems((l) => [...l, { role: 'user', text }]);
    setBusy(true);
    scrollDown();
    try {
      // Test hook: Playwright injects a scripted (non-streaming) transport here;
      // the dev app injects a streaming transport (an Anthropic client → /llm-proxy).
      const injected = (window as never as Record<string, unknown>).__velocutAgentTransport;
      const injectedStream = (window as never as Record<string, unknown>).__velocutAgentStream;
      history.current = await runAgentTurn({
        apiKey: cfg.apiKey,
        // undefined = the SDK's official default; anything else is a relay.
        baseURL: cfg.baseUrl === OFFICIAL_BASE_URL ? undefined : cfg.baseUrl,
        auth: cfg.auth,
        model: cfg.model,
        history: history.current,
        userText: text,
        // Effect docs come from the render-sdk registry → adding an effect
        // documents it for the agent without editing agent-sdk.
        systemExtra: effectPromptDoc(),
        host: {
          // Attribute every edit this turn to the AI (with the model + the
          // prompt that triggered it) on the history board.
          dispatch: (cmd) =>
            store.dispatch(cmd, { kind: 'ai', peerId: store.getLocalUser().peerId, name: 'AI', model: cfg.model }, text),
          document: () => store.getState().doc,
          evaluate: store.evaluate,
          caption: (o) => captionAsset(store, media, transcriber, o),
          observe: (input) => observeForAgent(store, observer, input),
          speak: (o) => synthesizeNarration(store, media, tts, o),
          search: (q) => searchWeb(q),
          // A script program runs against the SAME wired surface; its edits are
          // AI-attributed like every other agent edit. observe drops images
          // (a program reads numbers, not pictures).
          runScript: (code) =>
            runAgentScript(
              {
                apply: (cmd) =>
                  store.dispatch(cmd as never, { kind: 'ai', peerId: store.getLocalUser().peerId, name: 'AI', model: cfg.model }, text),
                tts: (o) => synthesizeNarration(store, media, tts, o),
                observe: async (input) => {
                  const r = await observeForAgent(store, observer, input);
                  return { ok: r.ok, summary: r.summary, data: r.data };
                },
                evaluate: store.evaluate,
                document: () => store.getState().doc,
                seek: (t) => store.seek(t),
                motionClip: (o) => createMotionClip(store, media, o as MotionClipOptions),
                sceneClip: (o) => createSceneClip(store, media, o as SceneClipOptions),
                sceneAssets: async () => {
                  const manifest = await loadSceneManifest();
                  return { doc: scenePromptDoc(manifest), manifest };
                },
                // Restricted surface: channel id + model + prompt; reference
                // media only as host-minted upload:// handles.
                videoGen: sandboxVideoGen(store, media),
                videoGenChannels: () => describeVideoGenChannels(),
                ...sandboxUploads(store, media, observer),
              },
              code,
            ),
        },
        createMessage: injected as never,
        createStream: injectedStream as never,
        // Incremental rendering. Use functional setItems so high-frequency deltas
        // append to the latest bubble instead of capturing a stale `items`.
        onEvent: (e) => {
          // A shots observation carries the full segmentation — hand it to the
          // store so the timeline can draw the cut boundaries (#2b). A
          // ShotAnalysis is recognisable by {assetId, shots[]}.
          if (e.kind === 'tool' && e.name === 'velocut_observe' && e.ok && e.data && typeof e.data === 'object') {
            const d = e.data as { assetId?: unknown; shots?: unknown };
            if (typeof d.assetId === 'string' && Array.isArray(d.shots)) {
              store.setShots(d.assetId, e.data as ShotAnalysis);
            }
          }
          setItems((l) => {
            const last = l[l.length - 1];
            const grow = (role: ChatItem['role']): ChatItem[] => {
              const delta = 'delta' in e ? e.delta : '';
              if (last?.role === role) {
                const c = l.slice();
                c[c.length - 1] = { ...last, text: last.text + delta };
                return c;
              }
              return [...l, { role, text: delta }];
            };
            switch (e.kind) {
              // Start events are no-ops: the bubble is created lazily on the
              // first delta, so a block with no streamed content (e.g. thinking
              // text is omitted by default on Opus 4.8, and the dev proxy strips
              // it) never leaves an empty bubble behind.
              case 'textStart':
              case 'thinkingStart':
                return l;
              case 'textDelta':
                return grow('assistant');
              case 'thinkingDelta':
                return grow('thinking');
              case 'toolStart':
                return [...l, { role: 'tool', text: `${e.name} …`, ok: undefined }];
              case 'tool': {
                const card: ChatItem = { role: 'tool', text: toolSummary(e), ok: e.ok };
                // Glass-box observe: carry the images & curve the agent saw (#1).
                if (e.name === 'velocut_observe') {
                  if (e.images?.length) card.images = e.images;
                  if (e.data != null) card.obs = { mode: (e.input as { mode?: string })?.mode ?? 'frame', data: e.data };
                } else if (e.name === 'velocut_apply' && e.ok) {
                  // Navigable edit: clicking the card jumps to where it landed (#2a).
                  card.jump = applyJump(e.input);
                }
                // Backfill the pending toolStart card if one is open.
                if (last?.role === 'tool' && last.ok === undefined) {
                  const c = l.slice();
                  c[c.length - 1] = card;
                  return c;
                }
                return [...l, card];
              }
              case 'text': // non-streaming fallback: whole text block
                return [...l, { role: 'assistant', text: e.text }];
              case 'error':
                return [...l, { role: 'error', text: e.message }];
              default:
                return l;
            }
          });
          scrollDown();
        },
      });
    } catch (e) {
      setItems((l) => [...l, { role: 'error', text: String(e instanceof Error ? e.message : e) }]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  };

  if (!open) {
    return (
      <button
        ref={dock.fabRef}
        className="agent-fab"
        style={dock.fabStyle}
        onPointerDown={dock.onFabPointerDown}
        title="Drag to move · Click to open the AI editing assistant"
      >
        ⌘ Agent
      </button>
    );
  }

  // A dev proxy transport (streaming or non-streaming) substitutes for a key.
  const w = window as never as Record<string, unknown>;
  const hasTransport = typeof w.__velocutAgentTransport === 'function' || typeof w.__velocutAgentStream === 'function';
  if (settingsOpen || (!cfg.apiKey && !hasTransport)) {
    return (
      <div className="agent-console" ref={dock.panelRef} style={dock.panelStyle}>
        <div className="agent-head" onPointerDown={dock.onPanelDragStart}>
          <span className="drag-grip" title="Drag to move">⠿</span>
          <span className="agent-title">AI Assistant — Provider Settings</span>
          <button onClick={() => setOpen(false)}>×</button>
        </div>
        <LlmSettings
          cfg={cfg}
          canClose={Boolean(cfg.apiKey) || hasTransport}
          onSave={(next) => {
            saveLlmConfig(next);
            setCfg(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
        <VideoGenSettings />
        <UploadSettings />
      </div>
    );
  }

  return (
    <div className="agent-console" ref={dock.panelRef} style={dock.panelStyle}>
      <div className="agent-head" onPointerDown={dock.onPanelDragStart}>
        <span className="drag-grip" title="Drag to move">⠿</span>
        <span className="agent-title">AI Editing Assistant</span>
        <select
          value={cfg.model}
          onChange={(e) => {
            const next = { ...cfg, model: e.target.value };
            saveLlmConfig(next);
            setCfg(next);
          }}
        >
          {modelOptions(cfg).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button title="Provider settings (endpoint, key, models)" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        <button onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="agent-chat" ref={listRef}>
        {items.length === 0 && (
          <div className="agent-hint">
            Try: "Split at the playhead and mute the second half" · "Add a 2-second title at the start, fading in" · "Move the subtitles to the bottom of the frame"
          </div>
        )}
        {items.map((m, i) => {
          if (m.role === 'tool') {
            const jump = m.jump;
            const cls =
              'chat-tool' +
              (m.ok === false ? ' chat-fail' : '') +
              (m.ok === undefined ? ' chat-pending' : '') +
              (jump ? ' chat-jump' : '');
            return (
              <div
                key={i}
                className={cls}
                title={jump ? 'Click to jump to this edit' : undefined}
                onClick={
                  jump
                    ? () => {
                        if (jump.clipId) store.select(jump.clipId);
                        if (jump.atUs != null) store.seek(jump.atUs);
                      }
                    : undefined
                }
              >
                <div className="chat-tool-line">
                  ⚙ {m.text}
                  {jump && <span className="chat-jump-arrow"> ↩</span>}
                </div>
                {m.images?.map((img, k) => {
                  const url = `data:${img.mediaType};base64,${img.base64}`;
                  return (
                    <img
                      key={k}
                      className="obs-thumb"
                      src={url}
                      alt="agent observation"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setLightbox(url);
                      }}
                    />
                  );
                })}
                {m.obs && <ObserveViz mode={m.obs.mode} data={m.obs.data} />}
              </div>
            );
          }
          return (
            <div key={i} className={`chat-${m.role}`}>
              {m.role === 'thinking' ? `💭 ${m.text}` : m.text}
            </div>
          );
        })}
        {/* The dots show only until the first streamed token arrives. */}
        {busy && items[items.length - 1]?.role === 'user' && <div className="chat-busy">Thinking…</div>}
      </div>
      <div className="agent-input-row">
        <textarea
          value={input}
          placeholder="Describe your editing intent; press Enter to send"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            e.stopPropagation();
          }}
        />
        <button className="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
      {lightbox && (
        <div className="obs-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="agent observation (enlarged)" />
        </div>
      )}
    </div>
  );
}

/** Video-generation channel settings — the same BYOK contract as LlmSettings,
 *  but plural: each CHANNEL is an endpoint + key + model list speaking one of
 *  the registered protocol kinds (render-sdk registry). Channels are what the
 *  agent names; endpoints/keys never leave this browser's localStorage. */
function VideoGenSettings() {
  const [cfg, setCfg] = useState<VideoGenConfig>(loadVideoGenConfig);
  const [draft, setDraft] = useState<VideoGenChannel | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // null = adding
  const [keyDraft, setKeyDraft] = useState('');
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });
  const kinds = videoGenProviders();

  const persist = (channels: VideoGenChannel[]) => {
    const next = { channels };
    saveVideoGenConfig(next);
    setCfg(next);
  };
  const closeEditor = () => {
    setDraft(null);
    setEditingId(null);
    setKeyDraft('');
    setTest({ busy: false });
  };
  const finalDraft = (): VideoGenChannel | null => {
    if (!draft) return null;
    const models = draft.models.map((m) => m.trim()).filter(Boolean);
    return {
      ...draft,
      id: draft.id.trim(),
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: keyDraft.trim() || draft.apiKey,
      models,
      defaultModel: draft.defaultModel && models.includes(draft.defaultModel) ? draft.defaultModel : models[0],
    };
  };

  if (draft) {
    const d = finalDraft()!;
    const idTaken = editingId !== d.id && cfg.channels.some((c) => c.id === d.id);
    const valid = Boolean(d.id && d.baseUrl && d.apiKey && d.models.length && !idTaken);
    return (
      <div className="videogen-settings">
        <h4>{editingId ? `Edit channel — ${editingId}` : 'Add video generation channel'}</h4>
        <label className="llm-row">
          <span>Channel id</span>
          <input
            value={draft.id}
            placeholder="my-relay (what the agent names)"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
        </label>
        {kinds.length > 1 && (
          <label className="llm-row">
            <span>Protocol</span>
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="llm-row">
          <span>Base URL</span>
          <input
            type="url"
            value={draft.baseUrl}
            placeholder="https://api.your-provider.example"
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
        </label>
        {import.meta.env.DEV && (
          <button
            className="llm-devproxy"
            title="Channel APIs usually reject browser (CORS) requests from localhost — route through the Vite dev proxy instead"
            onClick={() => {
              const host = draft.baseUrl.match(/^https?:\/\/([^/]+)/)?.[1];
              if (host && !draft.baseUrl.includes('/videogen-proxy/')) {
                setDraft({ ...draft, baseUrl: `${location.origin}/videogen-proxy/${host}` });
              }
            }}
          >
            Use local dev proxy (CORS relay)
          </button>
        )}
        <label className="llm-row">
          <span>API key</span>
          <input
            type="password"
            value={keyDraft}
            placeholder={draft.apiKey ? '•••••••• (saved — type to replace)' : 'the key your provider issued'}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
        </label>
        <label className="llm-row">
          <span>Models</span>
          <input
            value={draft.models.join(', ')}
            placeholder="model ids, comma-separated (as your provider names them)"
            onChange={(e) => setDraft({ ...draft, models: e.target.value.split(',').map((s) => s.trim()) })}
          />
        </label>
        {d.models.length > 1 && (
          <label className="llm-row">
            <span>Default model</span>
            <select value={d.defaultModel} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}>
              {d.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
        {idTaken && <div className="llm-test llm-test-fail">A channel with id '{d.id}' already exists.</div>}
        <div className="llm-actions">
          <button
            disabled={!d.baseUrl || !d.apiKey || test.busy}
            onClick={async () => {
              setTest({ busy: true });
              const r = await testVideoGenChannel(d);
              setTest({ busy: false, ...r });
            }}
          >
            {test.busy ? 'Testing…' : 'Test connection'}
          </button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() => {
              persist(editingId ? cfg.channels.map((c) => (c.id === editingId ? d : c)) : [...cfg.channels, d]);
              closeEditor();
            }}
          >
            {editingId ? 'Save channel' : 'Add channel'}
          </button>
          <button onClick={closeEditor}>Cancel</button>
        </div>
        {test.message && <div className={`llm-test ${test.ok ? 'llm-test-ok' : 'llm-test-fail'}`}>{test.message}</div>}
      </div>
    );
  }

  return (
    <div className="videogen-settings">
      <h4>Video generation channels</h4>
      <p>
        BYOK channels for AI video generation (velocut.videoGen / the agent). A channel is an endpoint + key +
        model list; keys stay in this browser. Generation costs the channel's credits.
      </p>
      {cfg.channels.map((c) => (
        <div className="llm-row videogen-channel" key={c.id}>
          <span>
            <b>{c.id}</b>
            {c.label ? ` — ${c.label}` : ''}
          </span>
          <span className="videogen-models">{c.models.join(', ') || 'no models'}</span>
          <button
            onClick={() => {
              setDraft({ ...c });
              setEditingId(c.id);
            }}
          >
            Edit
          </button>
          <button title={`Remove channel ${c.id}`} onClick={() => persist(cfg.channels.filter((x) => x.id !== c.id))}>
            ×
          </button>
        </div>
      ))}
      <div className="llm-actions">
        <button
          onClick={() => {
            setDraft({ id: '', kind: kinds[0]?.id ?? 'task-api', baseUrl: '', apiKey: '', models: [] });
            setEditingId(null);
          }}
        >
          + Add channel
        </button>
      </div>
    </div>
  );
}

/** Per-kind field descriptors for the upload storage form. Secrets are never
 *  echoed back (blank = keep the saved value), same rule as the LLM key. */
const UPLOAD_FIELDS: Record<string, Array<{ key: string; label: string; secret?: boolean; placeholder?: string }>> = {
  s3: [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.example.com (or the bucket domain)' },
    { key: 'bucket', label: 'Bucket', placeholder: 'bucket name (empty if the endpoint IS the bucket)' },
    { key: 'region', label: 'Region', placeholder: 'auto' },
    { key: 'accessKeyId', label: 'Access key' },
    { key: 'secretAccessKey', label: 'Secret key', secret: true },
    { key: 'prefix', label: 'Key prefix', placeholder: 'velocut/ (optional)' },
    { key: 'publicBase', label: 'Public base', placeholder: 'public read URL base (blank → presigned GET, 7 days)' },
  ],
  relay: [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://your-relay.example/upload' },
    { key: 'authToken', label: 'Auth token', secret: true, placeholder: 'optional bearer token' },
  ],
};
const UPLOAD_SECRETS = ['secretAccessKey', 'authToken'];

/** Upload storage settings — where conditioning media (frames / previz clips)
 *  gets uploaded so video-gen providers can fetch it. One store serves every
 *  channel. Unconfigured = the capability doesn't exist. */
function UploadSettings() {
  const kinds = uploaderKinds();
  const [saved, setSaved] = useState<UploadConfig | null>(loadUploadConfig);
  const [draft, setDraft] = useState<UploadConfig | null>(null);
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });

  const openEditor = () => {
    const base = saved ?? { kind: kinds[0]?.id ?? 's3', config: {} };
    setDraft({
      kind: base.kind,
      config: Object.fromEntries(Object.entries(base.config).filter(([k]) => !UPLOAD_SECRETS.includes(k))),
    });
    setTest({ busy: false });
  };
  const finalDraft = (): UploadConfig => {
    const merged: UploadConfig = { kind: draft!.kind, config: { ...draft!.config } };
    for (const [k, v] of Object.entries(merged.config)) {
      if (typeof v === 'string' && !v.trim()) delete merged.config[k];
    }
    // Blank secrets keep their saved values (they are never echoed into the form).
    if (saved && saved.kind === merged.kind) {
      for (const k of UPLOAD_SECRETS) {
        if (!merged.config[k] && saved.config[k]) merged.config[k] = saved.config[k];
      }
    }
    return merged;
  };

  if (draft) {
    const fields = UPLOAD_FIELDS[draft.kind] ?? [{ key: 'endpoint', label: 'Endpoint' }];
    const d = finalDraft();
    const valid = Boolean(d.config.endpoint);
    return (
      <div className="videogen-settings">
        <h4>Upload storage</h4>
        <p>
          Where conditioning media (frames, previz clips) is uploaded so video providers can fetch it by URL.
          Credentials stay in this browser; the store must allow browser (CORS) PUT from this origin.
        </p>
        {kinds.length > 1 && (
          <label className="llm-row">
            <span>Protocol</span>
            <select value={draft.kind} onChange={(e) => setDraft({ kind: e.target.value, config: {} })}>
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {fields.map((f) => (
          <label className="llm-row" key={f.key}>
            <span>{f.label}</span>
            <input
              type={f.secret ? 'password' : 'text'}
              value={(draft.config[f.key] as string) ?? ''}
              placeholder={
                f.secret && saved?.kind === draft.kind && saved.config[f.key]
                  ? '•••••••• (saved — type to replace)'
                  : f.placeholder
              }
              onChange={(e) => setDraft({ ...draft, config: { ...draft.config, [f.key]: e.target.value } })}
            />
          </label>
        ))}
        <div className="llm-actions">
          <button
            disabled={!valid || test.busy}
            onClick={async () => {
              setTest({ busy: true });
              const r = await testUploadStorage(finalDraft());
              setTest({ busy: false, ...r });
            }}
          >
            {test.busy ? 'Testing…' : 'Test upload'}
          </button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() => {
              const next = finalDraft();
              saveUploadConfig(next);
              setSaved(next);
              setDraft(null);
            }}
          >
            Save
          </button>
          <button onClick={() => setDraft(null)}>Cancel</button>
        </div>
        {test.message && <div className={`llm-test ${test.ok ? 'llm-test-ok' : 'llm-test-fail'}`}>{test.message}</div>}
      </div>
    );
  }

  return (
    <div className="videogen-settings">
      <h4>Upload storage</h4>
      {saved ? (
        <div className="llm-row videogen-channel">
          <span>
            <b>{saved.kind}</b>
          </span>
          <span className="videogen-models">{String(saved.config.endpoint ?? '')}</span>
          <button onClick={openEditor}>Edit</button>
          <button
            title="Remove upload storage"
            onClick={() => {
              saveUploadConfig(null);
              setSaved(null);
            }}
          >
            ×
          </button>
        </div>
      ) : (
        <p>Not configured — frame/clip uploads (video-gen reference conditioning) are unavailable.</p>
      )}
      {!saved && (
        <div className="llm-actions">
          <button onClick={openEditor}>Configure</button>
        </div>
      )}
    </div>
  );
}

/** Provider settings — the standard BYOK surface: endpoint (any Anthropic-
 *  protocol-compatible relay), auth scheme, key, model management and a
 *  one-round-trip connection test. */
function LlmSettings({
  cfg,
  canClose,
  onSave,
  onClose,
}: {
  cfg: LlmConfig;
  canClose: boolean;
  onSave: (next: LlmConfig) => void;
  onClose: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl);
  const [auth, setAuth] = useState<LlmConfig['auth']>(cfg.auth);
  // The saved key is never echoed back into the field; typing replaces it.
  const [keyDraft, setKeyDraft] = useState('');
  const [model, setModel] = useState(cfg.model);
  const [customModels, setCustomModels] = useState(cfg.customModels);
  const [newModel, setNewModel] = useState('');
  const [testState, setTestState] = useState<{ busy: boolean; message?: string; ok?: boolean }>({ busy: false });

  const draft = (): LlmConfig => ({
    baseUrl: baseUrl.trim().replace(/\/+$/, '') || OFFICIAL_BASE_URL,
    apiKey: keyDraft.trim() || cfg.apiKey,
    auth,
    model: model.trim() || cfg.model,
    customModels,
  });
  const valid = Boolean(draft().apiKey);

  const addModel = () => {
    const id = newModel.trim();
    if (!id) return;
    if (!customModels.includes(id)) setCustomModels([...customModels, id]);
    setModel(id);
    setNewModel('');
  };

  const options = [...BUILTIN_MODELS, ...customModels];
  if (model && !options.includes(model)) options.push(model);

  return (
    <div className="agent-setup llm-settings">
      <p>
        Works with the official Anthropic API or any Anthropic-protocol-compatible relay (LiteLLM,
        one-api, a corporate gateway). The key is stored only in this browser; requests go directly
        from the browser to the endpoint below, which must allow cross-origin (CORS) requests.
      </p>
      <label className="llm-row">
        <span>Base URL</span>
        <input
          type="url"
          value={baseUrl}
          placeholder={OFFICIAL_BASE_URL}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      {import.meta.env.DEV && (
        <button className="llm-devproxy" onClick={() => setBaseUrl(`${location.origin}/llm-proxy`)}>
          Use local dev proxy (:3141 via Vite)
        </button>
      )}
      <label className="llm-row">
        <span>Auth</span>
        <select value={auth} onChange={(e) => setAuth(e.target.value as LlmConfig['auth'])}>
          <option value="x-api-key">x-api-key (Anthropic)</option>
          <option value="bearer">Authorization: Bearer (gateways)</option>
        </select>
      </label>
      <label className="llm-row">
        <span>API key</span>
        <input
          type="password"
          value={keyDraft}
          placeholder={cfg.apiKey ? '•••••••• (saved — type to replace)' : 'sk-ant-...'}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
      </label>
      <label className="llm-row">
        <span>Model</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {options.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <div className="llm-row">
        <span>Add model</span>
        <input
          value={newModel}
          placeholder="custom model id (as your relay names it)"
          onChange={(e) => setNewModel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addModel()}
        />
        <button disabled={!newModel.trim()} onClick={addModel}>
          +
        </button>
      </div>
      {customModels.length > 0 && (
        <div className="llm-custom-list">
          {customModels.map((m) => (
            <span key={m} className="llm-chip">
              {m}
              <button
                title={`Remove ${m}`}
                onClick={() => {
                  setCustomModels(customModels.filter((x) => x !== m));
                  if (model === m) setModel(BUILTIN_MODELS[0]);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="llm-actions">
        <button
          disabled={!valid || testState.busy}
          onClick={async () => {
            setTestState({ busy: true });
            const r = await testLlmConnection(draft());
            setTestState({ busy: false, ...r });
          }}
        >
          {testState.busy ? 'Testing…' : 'Test connection'}
        </button>
        <button className="primary" disabled={!valid} onClick={() => onSave(draft())}>
          Save
        </button>
        {canClose && <button onClick={onClose}>Cancel</button>}
      </div>
      {testState.message && (
        <div className={`llm-test ${testState.ok ? 'llm-test-ok' : 'llm-test-fail'}`}>{testState.message}</div>
      )}
    </div>
  );
}
