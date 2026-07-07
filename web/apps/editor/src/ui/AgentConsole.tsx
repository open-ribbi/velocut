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
import { searchWeb } from '../services/search';
import { useFloatingDock } from './useDraggable';

const KEY_STORAGE = 'velocut.anthropicApiKey';
const MODEL_STORAGE = 'velocut.agentModel';
const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

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
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '');
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_STORAGE) ?? MODELS[0]);
  const [keyDraft, setKeyDraft] = useState('');
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
        apiKey,
        model,
        history: history.current,
        userText: text,
        // Effect docs come from the render-sdk registry → adding an effect
        // documents it for the agent without editing agent-sdk.
        systemExtra: effectPromptDoc(),
        host: {
          // Attribute every edit this turn to the AI (with the model + the
          // prompt that triggered it) on the history board.
          dispatch: (cmd) =>
            store.dispatch(cmd, { kind: 'ai', peerId: store.getLocalUser().peerId, name: 'AI', model }, text),
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
                  store.dispatch(cmd as never, { kind: 'ai', peerId: store.getLocalUser().peerId, name: 'AI', model }, text),
                tts: (o) => synthesizeNarration(store, media, tts, o),
                observe: async (input) => {
                  const r = await observeForAgent(store, observer, input);
                  return { ok: r.ok, summary: r.summary, data: r.data };
                },
                evaluate: store.evaluate,
                document: () => store.getState().doc,
                seek: (t) => store.seek(t),
                motionClip: (o) => createMotionClip(store, media, o as MotionClipOptions),
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
  if (!apiKey && !hasTransport) {
    return (
      <div className="agent-console" ref={dock.panelRef} style={dock.panelStyle}>
        <div className="agent-head" onPointerDown={dock.onPanelDragStart}>
          <span className="drag-grip" title="Drag to move">⠿</span>
          <span className="agent-title">AI Editing Assistant — Setup</span>
          <button onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="agent-setup">
          <p>
            Enter your Anthropic API key to edit with natural language. The key is stored only in this
            browser (localStorage); requests go directly from the browser to Anthropic.
          </p>
          <input
            type="password"
            value={keyDraft}
            placeholder="sk-ant-..."
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button
            className="primary"
            disabled={!keyDraft.trim()}
            onClick={() => {
              localStorage.setItem(KEY_STORAGE, keyDraft.trim());
              setApiKey(keyDraft.trim());
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-console" ref={dock.panelRef} style={dock.panelStyle}>
      <div className="agent-head" onPointerDown={dock.onPanelDragStart}>
        <span className="drag-grip" title="Drag to move">⠿</span>
        <span className="agent-title">AI Editing Assistant</span>
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            localStorage.setItem(MODEL_STORAGE, e.target.value);
          }}
        >
          {MODELS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button
          title="Clear API key"
          onClick={() => {
            localStorage.removeItem(KEY_STORAGE);
            setApiKey('');
          }}
        >
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
