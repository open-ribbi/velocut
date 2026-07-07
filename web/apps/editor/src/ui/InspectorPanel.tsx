import { useEffect, useRef, useState } from 'react';
import type { Property, Transform, TextPayload } from '@velocut/protocol';
import type { Store, UiState } from '../state/store';
import { EFFECT_REGISTRY, TRANSITIONS } from '@velocut/render-sdk';
import type { FontLibrary } from '../services/fonts';

export function InspectorPanel({
  store,
  state,
  fonts,
  width,
}: {
  store: Store;
  state: UiState;
  fonts: FontLibrary;
  width?: number;
}) {
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [, forceUpdate] = useState(0);
  useEffect(() => fonts.subscribe(() => forceUpdate((n) => n + 1)), [fonts]);

  const clip = state.selectedClipId
    ? state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === state.selectedClipId)
    : null;
  const asset = clip?.assetId ? state.doc.assets.find((a) => a.id === clip.assetId) : null;

  if (!clip) {
    return (
      <div className="inspector-panel" style={width ? { width } : undefined}>
        <div className="panel-title">Properties</div>
        <div className="empty-hint">Select a clip to view its properties</div>
      </div>
    );
  }

  const setTransform = (patch: Partial<Transform>) =>
    store.dispatch({
      type: 'setTransform',
      clipId: clip.id,
      transform: { ...clip.transform, ...patch },
    });

  const addKeyframeHere = (property: Property, value: number) => {
    const local = Math.max(0, Math.min(clip.durationUs, state.playheadUs - clip.startUs));
    store.dispatch({
      type: 'setKeyframe',
      clipId: clip.id,
      property,
      keyframe: { timeUs: local, value, easing: { kind: 'linear' } },
    });
  };

  const patchText = (patch: Partial<TextPayload>) =>
    store.dispatch({ type: 'setText', clipId: clip.id, text: { ...clip.text!, ...patch } });

  const num = (v: number) => Math.round(v * 100) / 100;

  const row = (label: string, property: Property, value: number, step = 1) => (
    <div className="prop-row" key={property}>
      <span className="prop-label">{label}</span>
      <input
        type="number"
        step={step}
        value={num(value)}
        onChange={(e) => setTransform({ [property]: Number(e.target.value) } as Partial<Transform>)}
      />
      <button
        className="kf-btn"
        title="Add keyframe at playhead"
        onClick={() => addKeyframeHere(property, value)}
      >
        ◆
      </button>
    </div>
  );

  return (
    <div className="inspector-panel" style={width ? { width } : undefined}>
      <div className="panel-title">Properties · {clip.id}</div>

      <div className="prop-group">
        <div className="group-title">Transform</div>
        {row('X', 'x', clip.transform.x)}
        {row('Y', 'y', clip.transform.y)}
        {row('Scale X', 'scaleX', clip.transform.scaleX, 0.05)}
        {row('Scale Y', 'scaleY', clip.transform.scaleY, 0.05)}
        {row('Rotation', 'rotation', clip.transform.rotation)}
        {row('Opacity', 'opacity', clip.transform.opacity, 0.05)}
      </div>

      {asset?.hasAudio && (asset.kind === 'video' || asset.kind === 'audio') && (
        <div className="prop-group">
          <div className="group-title">Audio</div>
          <div className="prop-row">
            <span className="prop-label">Volume</span>
            <input
              type="number"
              step={0.05}
              min={0}
              max={4}
              value={num(clip.volume)}
              onChange={(e) =>
                store.dispatch({ type: 'setClipVolume', clipId: clip.id, volume: Number(e.target.value) })
              }
            />
            <button
              className="kf-btn"
              title="Add volume keyframe at playhead (fade-in/out, ducking)"
              onClick={() => addKeyframeHere('volume', clip.volume)}
            >
              ◆
            </button>
          </div>
        </div>
      )}

      {clip.text && (
        <div className="prop-group">
          <div className="group-title">Text</div>
          <textarea
            className="text-edit"
            value={clip.text.content}
            onChange={(e) =>
              store.dispatch({
                type: 'setText',
                clipId: clip.id,
                text: { ...clip.text!, content: e.target.value },
              })
            }
          />
          <div className="prop-row">
            <span className="prop-label">Font</span>
            <select
              className="font-select"
              value={clip.text.fontFamily ?? fonts.options()[0].family}
              onChange={(e) =>
                store.dispatch({
                  type: 'setText',
                  clipId: clip.id,
                  text: { ...clip.text!, fontFamily: e.target.value },
                })
              }
            >
              {fonts.options().map((f) => (
                <option key={f.family} value={f.family}>
                  {f.label}
                  {f.custom ? ' (custom)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button className="font-import" onClick={() => fontInputRef.current?.click()}>
            + Import Font File
          </button>
          <input
            ref={fontInputRef}
            type="file"
            accept=".ttf,.otf,.woff,.woff2,.ttc,font/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const family = await fonts.import(file);
              store.dispatch({ type: 'setText', clipId: clip.id, text: { ...clip.text!, fontFamily: family } });
            }}
          />
          <div className="prop-row">
            <span className="prop-label">Font Size</span>
            <input
              type="number"
              value={clip.text.fontSize ?? 64}
              onChange={(e) =>
                store.dispatch({
                  type: 'setText',
                  clipId: clip.id,
                  text: { ...clip.text!, fontSize: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">Color</span>
            <input
              type="color"
              value={clip.text.color ?? '#ffffff'}
              onChange={(e) => patchText({ color: e.target.value })}
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">Style</span>
            <button
              className="style-btn"
              style={{ fontWeight: 700, opacity: clip.text.bold ? 1 : 0.5 }}
              title="Bold"
              onClick={() => patchText({ bold: !clip.text!.bold })}
            >
              B
            </button>
            <button
              className="style-btn"
              style={{ fontStyle: 'italic', opacity: clip.text.italic ? 1 : 0.5 }}
              title="Italic"
              onClick={() => patchText({ italic: !clip.text!.italic })}
            >
              I
            </button>
            <select
              value={clip.text.align ?? 'center'}
              onChange={(e) => patchText({ align: e.target.value })}
            >
              <option value="left">Align Left</option>
              <option value="center">Center</option>
              <option value="right">Align Right</option>
            </select>
          </div>
          <div className="prop-row">
            <span className="prop-label">Stroke</span>
            <input
              type="color"
              value={clip.text.strokeColor ?? '#000000'}
              onChange={(e) =>
                patchText({ strokeColor: e.target.value, strokeWidth: clip.text!.strokeWidth ?? 4 })
              }
            />
            <input
              type="number"
              min={0}
              title="Stroke width (px)"
              value={clip.text.strokeWidth ?? 0}
              onChange={(e) => patchText({ strokeWidth: Number(e.target.value) })}
            />
            <button className="kf-btn" title="Clear stroke" onClick={() => patchText({ strokeColor: null, strokeWidth: null })}>
              ×
            </button>
          </div>
          <div className="prop-row">
            <span className="prop-label">Shadow</span>
            <input
              type="color"
              value={clip.text.shadowColor ?? '#000000'}
              onChange={(e) =>
                patchText({
                  shadowColor: e.target.value,
                  shadowBlur: clip.text!.shadowBlur ?? 6,
                  shadowX: clip.text!.shadowX ?? 2,
                  shadowY: clip.text!.shadowY ?? 2,
                })
              }
            />
            <input
              type="number"
              min={0}
              title="Blur radius (px)"
              value={clip.text.shadowBlur ?? 0}
              onChange={(e) => patchText({ shadowBlur: Number(e.target.value) })}
            />
            <button className="kf-btn" title="Clear shadow" onClick={() => patchText({ shadowColor: null })}>
              ×
            </button>
          </div>
          <div className="prop-row">
            <span className="prop-label">Background</span>
            <input
              type="color"
              value={clip.text.backgroundColor ?? '#000000'}
              onChange={(e) =>
                patchText({ backgroundColor: e.target.value, backgroundOpacity: clip.text!.backgroundOpacity ?? 0.5 })
              }
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              title="Background opacity"
              value={clip.text.backgroundOpacity ?? 1}
              onChange={(e) => patchText({ backgroundOpacity: Number(e.target.value) })}
            />
            <button className="kf-btn" title="Clear background" onClick={() => patchText({ backgroundColor: null })}>
              ×
            </button>
          </div>
        </div>
      )}

      <div className="prop-group">
        <div className="group-title">Effects</div>
        {clip.effects.map((fx) => {
          const schema = EFFECT_REGISTRY[fx.effect];
          return (
            <div className="fx-block" key={fx.id}>
              <div className="fx-head">
                <span>{schema?.label ?? fx.effect}</span>
                <button
                  className="fx-remove"
                  onClick={() =>
                    store.dispatch({ type: 'removeEffect', clipId: clip.id, effectId: fx.id })
                  }
                >
                  ×
                </button>
              </div>
              {schema?.params.map((p) => (
                <div className="prop-row" key={p.key}>
                  <span className="prop-label">{p.label}</span>
                  <input
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={Number(fx.params[p.key] ?? p.default)}
                    onChange={(e) =>
                      store.dispatch({
                        type: 'setEffectParams',
                        clipId: clip.id,
                        effectId: fx.id,
                        params: { ...fx.params, [p.key]: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              ))}
            </div>
          );
        })}
        {Object.keys(EFFECT_REGISTRY)
          .filter((name) => !clip.effects.some((e) => e.effect === name))
          .map((name) => (
            <button
              key={name}
              className="fx-add"
              onClick={() => {
                const defaults = Object.fromEntries(
                  EFFECT_REGISTRY[name].params.map((p) => [p.key, p.default]),
                );
                store.dispatch({ type: 'addEffect', clipId: clip.id, effect: name, params: defaults });
              }}
            >
              + {EFFECT_REGISTRY[name].label}
            </button>
          ))}
      </div>

      <div className="prop-group">
        <div className="group-title">Transition (from previous clip)</div>
        <div className="prop-row">
          <span className="prop-label">Type</span>
          <select
            value={clip.transition?.kind ?? ''}
            onChange={(e) =>
              store.dispatch({
                type: 'setTransition',
                clipId: clip.id,
                transition: e.target.value
                  ? { kind: e.target.value, durationUs: clip.transition?.durationUs ?? 500000 }
                  : null,
              })
            }
          >
            <option value="">None</option>
            {TRANSITIONS.map((t) => (
              <option key={t.kind} value={t.kind}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {clip.transition && (
          <div className="prop-row">
            <span className="prop-label">Duration (s)</span>
            <input
              type="number"
              step={0.1}
              min={0.1}
              value={num(clip.transition.durationUs / 1e6)}
              onChange={(e) =>
                store.dispatch({
                  type: 'setTransition',
                  clipId: clip.id,
                  transition: {
                    kind: clip.transition!.kind,
                    durationUs: Math.max(1, Math.round(Number(e.target.value) * 1e6)),
                  },
                })
              }
            />
          </div>
        )}
      </div>

      <div className="prop-group">
        <div className="group-title">Keyframes</div>
        {Object.entries(clip.keyframes).length === 0 && (
          <div className="empty-hint">Click ◆ next to a property to add a keyframe at the playhead</div>
        )}
        {Object.entries(clip.keyframes).map(([prop, kfs]) => (
          <div key={prop} className="kf-list">
            <span className="prop-label">{prop}</span>
            {(kfs ?? []).map((k) => (
              <span
                key={k.timeUs}
                className="kf-chip"
                title="Click to delete"
                onClick={() =>
                  store.dispatch({
                    type: 'removeKeyframe',
                    clipId: clip.id,
                    property: prop as Property,
                    timeUs: k.timeUs,
                  })
                }
              >
                {(k.timeUs / 1e6).toFixed(2)}s={num(k.value)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
