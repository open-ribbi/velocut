// SceneInspector — structured manual editing for 3D scene clips.
//
// The human half of "agent-first, human-adjustable": every control edits the
// SAME in-document spec the agent writes, through the SAME command
// (setAssetSpec), so each change is one attributed, undoable history node and
// other tabs/peers see it immediately. The form covers the common fields;
// the JSON tab is the escape hatch for anything it doesn't surface yet
// (keyframed values show as read-only badges in the form).

import { useEffect, useMemo, useState } from 'react';
import type { Asset } from '@velocut/protocol';
import type { Animatable } from '@velocut/render-sdk';
import {
  loadSceneManifest,
  validateSceneSpec,
  POSE_PRESETS,
  type SceneAssetManifest,
  type SceneSpec,
} from '@velocut/scene-sdk';
import type { Store } from '../state/store';
import { DirectorPanel } from './DirectorPanel';

/** Deep-clone + mutate + dispatch: one edit = one setAssetSpec node. */
function useSpecEditor(store: Store, asset: Asset) {
  const spec = useMemo<SceneSpec | null>(() => {
    try {
      return asset.spec ? (JSON.parse(asset.spec) as SceneSpec) : null;
    } catch {
      return null;
    }
  }, [asset.spec]);

  const patch = (mutate: (draft: SceneSpec) => void): string | null => {
    if (!spec) return 'invalid spec';
    const draft = structuredClone(spec);
    mutate(draft);
    const err = validateSceneSpec(draft);
    if (err) return err;
    const r = store.dispatch({ type: 'setAssetSpec', assetId: asset.id, spec: JSON.stringify(draft) });
    return r.ok ? null : r.error.message;
  };
  return { spec, patch };
}

/** Constant Animatable → number input; keyframed → read-only badge (edit via
 *  the JSON tab, which can express the full grammar). */
function AnimatableField({
  value,
  fallback,
  step = 0.1,
  onChange,
}: {
  value: Animatable | undefined;
  fallback: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <span className="kf-chip" title="Keyframed — edit via the JSON tab">
        ◆ {value.length} keys
      </span>
    );
  }
  return (
    <input
      type="number"
      step={step}
      value={Math.round(((value ?? fallback) as number) * 100) / 100}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function Vec3Row({
  label,
  value,
  onAxis,
}: {
  label: string;
  value: { x?: Animatable; y?: Animatable; z?: Animatable } | undefined;
  onAxis: (axis: 'x' | 'y' | 'z', v: number) => void;
}) {
  return (
    <div className="prop-row scene-vec3">
      <span className="prop-label">{label}</span>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <AnimatableField key={axis} value={value?.[axis]} fallback={0} onChange={(v) => onAxis(axis, v)} />
      ))}
    </div>
  );
}

export function SceneInspector({ store, asset }: { store: Store; asset: Asset }) {
  const { spec, patch } = useSpecEditor(store, asset);
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [manifest, setManifest] = useState<SceneAssetManifest | null>(null);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [director, setDirector] = useState(false);

  useEffect(() => {
    let alive = true;
    loadSceneManifest()
      .then((m) => alive && setManifest(m))
      .catch(() => alive && setManifest(null));
    return () => {
      alive = false;
    };
  }, []);

  if (!spec) {
    return (
      <div className="prop-group">
        <div className="group-title">3D Scene</div>
        <div className="empty-hint">This scene's spec is missing or unreadable.</div>
      </div>
    );
  }

  const run = (mutate: (draft: SceneSpec) => void) => setError(patch(mutate));
  const characterModels = Object.keys(manifest?.characters ?? {});
  const clipNames = (model: string) => Object.keys(manifest?.characters[model]?.clips ?? {});
  const propModels = Object.keys(manifest?.props ?? {});

  return (
    <div className="prop-group scene-inspector">
      <div className="group-title">
        3D Scene
        <span className="scene-tabs">
          <button className={tab === 'form' ? 'active' : ''} onClick={() => setTab('form')}>
            Form
          </button>
          <button
            className={tab === 'json' ? 'active' : ''}
            onClick={() => {
              setJsonDraft(JSON.stringify(spec, null, 2));
              setTab('json');
            }}
          >
            JSON
          </button>
        </span>
      </div>
      {error && <div className="scene-error">{error}</div>}
      <button className="fx-add director-open" onClick={() => setDirector(true)}>
        🎬 Open Director (stage view)
      </button>
      {director && <DirectorPanel store={store} asset={asset} onClose={() => setDirector(false)} />}

      {tab === 'json' ? (
        <>
          <textarea
            className="scene-json"
            value={jsonDraft ?? JSON.stringify(spec, null, 2)}
            spellCheck={false}
            onChange={(e) => setJsonDraft(e.target.value)}
          />
          <button
            className="fx-add"
            onClick={() => {
              try {
                const parsed = JSON.parse(jsonDraft ?? '') as SceneSpec;
                const err = validateSceneSpec(parsed);
                if (err) return setError(err);
                const r = store.dispatch({ type: 'setAssetSpec', assetId: asset.id, spec: JSON.stringify(parsed) });
                setError(r.ok ? null : r.error.message);
              } catch (e) {
                setError('JSON parse error: ' + (e instanceof Error ? e.message : String(e)));
              }
            }}
          >
            Apply JSON
          </button>
        </>
      ) : (
        <>
          <div className="prop-row">
            <span className="prop-label">Environment</span>
            <select
              value={spec.environment ?? 'env/stage'}
              onChange={(e) => run((d) => (d.environment = e.target.value))}
            >
              {Object.entries(manifest?.environments ?? { 'env/stage': { label: 'Plain stage' } }).map(([id, e]) => (
                <option key={id} value={id}>
                  {e.label ?? id}
                </option>
              ))}
            </select>
          </div>
          <div className="prop-row">
            <span className="prop-label">Lighting</span>
            <select value={spec.lighting ?? 'day'} onChange={(e) => run((d) => (d.lighting = e.target.value as SceneSpec['lighting']))}>
              {['day', 'night', 'indoor'].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <div className="group-title">Characters</div>
          {(spec.characters ?? []).map((c, ci) => (
            <div className="fx-block" key={c.id}>
              <div className="fx-head">
                <span>{c.id}</span>
                <button className="fx-remove" onClick={() => run((d) => d.characters!.splice(ci, 1))}>
                  ×
                </button>
              </div>
              <div className="prop-row">
                <span className="prop-label">Model</span>
                <select value={c.model} onChange={(e) => run((d) => (d.characters![ci].model = e.target.value))}>
                  {(characterModels.length ? characterModels : [c.model]).map((m) => (
                    <option key={m} value={m}>
                      {manifest?.characters[m]?.label ?? m}
                    </option>
                  ))}
                </select>
              </div>
              <Vec3Row
                label="Position"
                value={c.position}
                onAxis={(axis, v) => run((d) => ((d.characters![ci].position ??= {})[axis] = v))}
              />
              <div className="prop-row">
                <span className="prop-label">Rotation Y</span>
                <AnimatableField
                  value={c.rotationY}
                  fallback={0}
                  step={5}
                  onChange={(v) => run((d) => (d.characters![ci].rotationY = v))}
                />
              </div>
              {manifest?.characters[c.model]?.file.startsWith('builtin:mannequin') && (
                <>
                  <div className="prop-row">
                    <span className="prop-label">Pose</span>
                    <select
                      value={typeof c.pose === 'string' ? c.pose : (c.pose?.preset ?? 'standing')}
                      onChange={(e) =>
                        run((d) => {
                          const cur = d.characters![ci].pose;
                          // Keep joint overrides (edit them in the JSON tab).
                          if (cur && typeof cur === 'object' && cur.joints) cur.preset = e.target.value;
                          else d.characters![ci].pose = e.target.value;
                        })
                      }
                    >
                      {Object.keys(POSE_PRESETS).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    {typeof c.pose === 'object' && c.pose?.joints && (
                      <span className="kf-chip" title="Per-joint overrides — edit via the JSON tab">
                        ◆ joints
                      </span>
                    )}
                  </div>
                  <div className="prop-row">
                    <span className="prop-label">Color</span>
                    <input
                      type="color"
                      value={c.color ?? '#4f8ef7'}
                      onChange={(e) => run((d) => (d.characters![ci].color = e.target.value))}
                    />
                  </div>
                </>
              )}
              <div className="prop-row">
                <span className="prop-label">Gaze</span>
                <select
                  value={c.gaze === 'camera' ? 'camera' : c.gaze ? `char:${c.gaze.character}` : ''}
                  onChange={(e) =>
                    run((d) => {
                      const v = e.target.value;
                      if (!v) delete d.characters![ci].gaze;
                      else if (v === 'camera') d.characters![ci].gaze = 'camera';
                      else d.characters![ci].gaze = { character: v.slice(5) };
                    })
                  }
                >
                  <option value="">None</option>
                  <option value="camera">Camera</option>
                  {(spec.characters ?? [])
                    .filter((o) => o.id !== c.id)
                    .map((o) => (
                      <option key={o.id} value={`char:${o.id}`}>
                        Look at {o.id}
                      </option>
                    ))}
                </select>
              </div>
              <div className="scene-actions">
                {(c.actions ?? []).map((a, ai) => (
                  <div className="prop-row scene-action" key={ai}>
                    <select
                      value={a.clip}
                      onChange={(e) => run((d) => (d.characters![ci].actions![ai].clip = e.target.value))}
                    >
                      {(clipNames(c.model).length ? clipNames(c.model) : [a.clip]).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      title="Start (s)"
                      value={a.start}
                      onChange={(e) => run((d) => (d.characters![ci].actions![ai].start = Number(e.target.value)))}
                    />
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      title="Cross-fade (s)"
                      value={a.fade ?? 0.3}
                      onChange={(e) => run((d) => (d.characters![ci].actions![ai].fade = Number(e.target.value)))}
                    />
                    <button
                      className="kf-btn"
                      title="Remove action"
                      onClick={() => run((d) => d.characters![ci].actions!.splice(ai, 1))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="fx-add"
                  onClick={() =>
                    run((d) => {
                      const clips = clipNames(c.model);
                      (d.characters![ci].actions ??= []).push({ clip: clips[0] ?? 'Idle', start: 0 });
                    })
                  }
                >
                  + Action
                </button>
              </div>
            </div>
          ))}
          <button
            className="fx-add"
            onClick={() =>
              run((d) => {
                const model = characterModels[0] ?? 'char/robot';
                const n = (d.characters?.length ?? 0) + 1;
                (d.characters ??= []).push({ id: `char${n}`, model, position: { x: 0, z: 0 }, actions: [{ clip: 'Idle', start: 0 }] });
              })
            }
          >
            + Character
          </button>

          <div className="group-title">Props</div>
          {(spec.props ?? []).map((p, pi) => (
            <div className="prop-row scene-action" key={pi}>
              <select value={p.model} onChange={(e) => run((d) => (d.props![pi].model = e.target.value))}>
                {(propModels.length ? propModels : [p.model]).map((m) => (
                  <option key={m} value={m}>
                    {manifest?.props[m]?.label ?? m}
                  </option>
                ))}
              </select>
              <input
                type="color"
                value={p.color ?? '#8fa3bf'}
                onChange={(e) => run((d) => (d.props![pi].color = e.target.value))}
              />
              <select
                title="Attach to a character bone (hand-held / worn)"
                value={p.attachTo ? `${p.attachTo.character}:${p.attachTo.bone ?? 'handR'}` : ''}
                onChange={(e) =>
                  run((d) => {
                    const v = e.target.value;
                    if (!v) delete d.props![pi].attachTo;
                    else {
                      const [character, bone] = v.split(':');
                      d.props![pi].attachTo = { character, bone };
                      d.props![pi].position = { x: 0, y: 0, z: 0 };
                    }
                  })
                }
              >
                <option value="">World</option>
                {(spec.characters ?? []).flatMap((c) =>
                  Object.keys(manifest?.characters[c.model]?.bones ?? {}).map((slot) => (
                    <option key={`${c.id}:${slot}`} value={`${c.id}:${slot}`}>
                      {c.id} · {slot}
                    </option>
                  )),
                )}
              </select>
              <button className="kf-btn" title="Remove prop" onClick={() => run((d) => d.props!.splice(pi, 1))}>
                ×
              </button>
            </div>
          ))}
          <button className="fx-add" onClick={() => run((d) => (d.props ??= []).push({ model: propModels[0] ?? 'prop/cube', position: { x: 2, z: -1 } }))}>
            + Prop
          </button>

          <div className="group-title">Camera</div>
          <div className="prop-row">
            <span className="prop-label">FOV</span>
            <AnimatableField
              value={spec.camera?.fov}
              fallback={40}
              step={1}
              onChange={(v) => run((d) => ((d.camera ??= {}).fov = v))}
            />
          </div>
          <Vec3Row
            label="Position"
            value={spec.camera?.position}
            onAxis={(axis, v) => run((d) => (((d.camera ??= {}).position ??= {})[axis] = v))}
          />
          <div className="prop-row">
            <span className="prop-label">Look at</span>
            <select
              value={spec.camera?.lookAt && 'character' in spec.camera.lookAt ? 'character' : 'point'}
              onChange={(e) =>
                run((d) => {
                  const cam = (d.camera ??= {});
                  cam.lookAt = e.target.value === 'character' ? { character: d.characters?.[0]?.id ?? '' } : { x: 0, y: 1, z: 0 };
                })
              }
            >
              <option value="point">Point</option>
              <option value="character">Track character</option>
            </select>
            {spec.camera?.lookAt && 'character' in spec.camera.lookAt && (
              <select
                value={spec.camera.lookAt.character}
                onChange={(e) => run((d) => ((d.camera ??= {}).lookAt = { character: e.target.value }))}
              >
                {(spec.characters ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            )}
          </div>
          {spec.camera?.lookAt && !('character' in spec.camera.lookAt) && (
            <Vec3Row
              label="Look point"
              value={spec.camera.lookAt}
              onAxis={(axis, v) =>
                run((d) => {
                  const cam = (d.camera ??= {});
                  if (!cam.lookAt || 'character' in cam.lookAt) cam.lookAt = {};
                  cam.lookAt[axis] = v;
                })
              }
            />
          )}
        </>
      )}
    </div>
  );
}
