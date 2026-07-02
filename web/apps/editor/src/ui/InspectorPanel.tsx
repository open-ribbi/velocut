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

  if (!clip) {
    return (
      <div className="inspector-panel" style={width ? { width } : undefined}>
        <div className="panel-title">属性</div>
        <div className="empty-hint">选中一个 clip 查看属性</div>
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
        title="在播放头处打关键帧"
        onClick={() => addKeyframeHere(property, value)}
      >
        ◆
      </button>
    </div>
  );

  return (
    <div className="inspector-panel" style={width ? { width } : undefined}>
      <div className="panel-title">属性 · {clip.id}</div>

      <div className="prop-group">
        <div className="group-title">变换</div>
        {row('X', 'x', clip.transform.x)}
        {row('Y', 'y', clip.transform.y)}
        {row('缩放X', 'scaleX', clip.transform.scaleX, 0.05)}
        {row('缩放Y', 'scaleY', clip.transform.scaleY, 0.05)}
        {row('旋转', 'rotation', clip.transform.rotation)}
        {row('透明度', 'opacity', clip.transform.opacity, 0.05)}
      </div>

      {clip.text && (
        <div className="prop-group">
          <div className="group-title">文字</div>
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
            <span className="prop-label">字体</span>
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
                  {f.custom ? ' (自定义)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button className="font-import" onClick={() => fontInputRef.current?.click()}>
            + 导入字体文件
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
            <span className="prop-label">字号</span>
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
            <span className="prop-label">颜色</span>
            <input
              type="color"
              value={clip.text.color ?? '#ffffff'}
              onChange={(e) => patchText({ color: e.target.value })}
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">样式</span>
            <button
              className="style-btn"
              style={{ fontWeight: 700, opacity: clip.text.bold ? 1 : 0.5 }}
              title="加粗"
              onClick={() => patchText({ bold: !clip.text!.bold })}
            >
              B
            </button>
            <button
              className="style-btn"
              style={{ fontStyle: 'italic', opacity: clip.text.italic ? 1 : 0.5 }}
              title="斜体"
              onClick={() => patchText({ italic: !clip.text!.italic })}
            >
              I
            </button>
            <select
              value={clip.text.align ?? 'center'}
              onChange={(e) => patchText({ align: e.target.value })}
            >
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
            </select>
          </div>
          <div className="prop-row">
            <span className="prop-label">描边</span>
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
              title="描边宽度(像素)"
              value={clip.text.strokeWidth ?? 0}
              onChange={(e) => patchText({ strokeWidth: Number(e.target.value) })}
            />
            <button className="kf-btn" title="清除描边" onClick={() => patchText({ strokeColor: null, strokeWidth: null })}>
              ×
            </button>
          </div>
          <div className="prop-row">
            <span className="prop-label">阴影</span>
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
              title="模糊半径(像素)"
              value={clip.text.shadowBlur ?? 0}
              onChange={(e) => patchText({ shadowBlur: Number(e.target.value) })}
            />
            <button className="kf-btn" title="清除阴影" onClick={() => patchText({ shadowColor: null })}>
              ×
            </button>
          </div>
          <div className="prop-row">
            <span className="prop-label">背景</span>
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
              title="背景不透明度"
              value={clip.text.backgroundOpacity ?? 1}
              onChange={(e) => patchText({ backgroundOpacity: Number(e.target.value) })}
            />
            <button className="kf-btn" title="清除背景" onClick={() => patchText({ backgroundColor: null })}>
              ×
            </button>
          </div>
        </div>
      )}

      <div className="prop-group">
        <div className="group-title">特效</div>
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
        <div className="group-title">转场（与前一片段之间）</div>
        <div className="prop-row">
          <span className="prop-label">类型</span>
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
            <option value="">无</option>
            {TRANSITIONS.map((t) => (
              <option key={t.kind} value={t.kind}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {clip.transition && (
          <div className="prop-row">
            <span className="prop-label">时长(秒)</span>
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
        <div className="group-title">关键帧</div>
        {Object.entries(clip.keyframes).length === 0 && (
          <div className="empty-hint">点属性旁的 ◆ 在播放头处打关键帧</div>
        )}
        {Object.entries(clip.keyframes).map(([prop, kfs]) => (
          <div key={prop} className="kf-list">
            <span className="prop-label">{prop}</span>
            {(kfs ?? []).map((k) => (
              <span
                key={k.timeUs}
                className="kf-chip"
                title="点击删除"
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
