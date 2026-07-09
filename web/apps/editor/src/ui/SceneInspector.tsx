// SceneInspector — scene-level manual editing for 3D scene clips.
//
// The human half of "agent-first, human-adjustable": every control edits the
// SAME in-document spec the agent writes, through the SAME command
// (setAssetSpec), so each change is one attributed, undoable history node and
// other tabs/peers see it immediately.
//
// Division of labor (LibTV-style): this panel owns what belongs to the SCENE
// — environment, lighting, camera, the object roster — while everything about
// ONE object (model, transform, pose, gaze, actions, attachment) lives in the
// Director's selection card, next to the object you're looking at. Clicking a
// roster row opens the Director with that object selected. The JSON tab stays
// the escape hatch for the full grammar (keyframes, shots, morphs, points).

import { useEffect, useMemo, useState } from 'react';
import type { Asset } from '@velocut/protocol';
import {
  loadSceneManifest,
  validateSceneSpec,
  type SceneAssetManifest,
  type SceneSpec,
} from '@velocut/scene-sdk';
import type { Store } from '../state/store';
import { DirectorPanel, type Sel } from './DirectorPanel';
import { AnimatableField, Vec3Row } from './SceneFields';

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

export function SceneInspector({ store, asset }: { store: Store; asset: Asset }) {
  const { spec, patch } = useSpecEditor(store, asset);
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [manifest, setManifest] = useState<SceneAssetManifest | null>(null);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [director, setDirector] = useState<{ open: boolean; sel: Sel | null }>({ open: false, sel: null });

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
  const propModels = Object.keys(manifest?.props ?? {});
  const openDirector = (sel: Sel | null) => setDirector({ open: true, sel });

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
      <button className="fx-add director-open" onClick={() => openDirector(null)}>
        🎬 Open Director (stage view)
      </button>
      {director.open && (
        <DirectorPanel store={store} asset={asset} initialSel={director.sel} onClose={() => setDirector({ open: false, sel: null })} />
      )}

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

          {/* Object roster — per-object editing happens in the Director,
              beside the object itself. A row click opens it pre-selected. */}
          <div className="group-title">Characters</div>
          {(spec.characters ?? []).map((c, ci) => (
            <div className="prop-row scene-object-row" key={c.id}>
              <button
                className="scene-object-open"
                title="Edit on the stage (opens the Director with this object selected)"
                onClick={() => openDirector({ kind: 'character', index: ci })}
              >
                <span className="scene-object-id">{c.id}</span>
                <span className="scene-object-model">{manifest?.characters[c.model]?.label ?? c.model}</span>
              </button>
              <button className="fx-remove" title="Remove" onClick={() => run((d) => d.characters!.splice(ci, 1))}>
                ×
              </button>
            </div>
          ))}
          <button
            className="fx-add"
            onClick={() =>
              run((d) => {
                const model = characterModels[0] ?? 'char/mannequin';
                const n = (d.characters?.length ?? 0) + 1;
                const c: NonNullable<SceneSpec['characters']>[number] = { id: `char${n}`, model, position: { x: 0, z: 0 } };
                if (manifest?.characters[model]?.file.startsWith('builtin:')) c.pose = 'standing';
                else {
                  const first = Object.keys(manifest?.characters[model]?.clips ?? {})[0];
                  if (first) c.actions = [{ clip: first, start: 0 }];
                }
                (d.characters ??= []).push(c);
              })
            }
          >
            + Character
          </button>

          <div className="group-title">Props</div>
          {(spec.props ?? []).map((p, pi) => (
            <div className="prop-row scene-object-row" key={pi}>
              <button
                className="scene-object-open"
                title="Edit on the stage (opens the Director with this object selected)"
                onClick={() => openDirector({ kind: 'prop', index: pi })}
              >
                <span className="scene-object-id">{manifest?.props[p.model]?.label ?? p.model}</span>
                {p.attachTo && <span className="scene-object-model">on {p.attachTo.character}</span>}
              </button>
              <button className="fx-remove" title="Remove" onClick={() => run((d) => d.props!.splice(pi, 1))}>
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
