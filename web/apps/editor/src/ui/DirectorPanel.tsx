// DirectorPanel — the stage view: orbit the compiled 3D scene, select any
// character/prop and manipulate it with transform gizmos, scrub time, and see
// the spec camera as a frustum.
//
// A richer input device over the same fields the SceneInspector edits: every
// gesture commits ONE setAssetSpec (ghost-then-commit, like the preview's
// transform gizmos), so manual blocking is attributed, undoable and instantly
// visible to the agent — no UI-only state. The viewport shares the scene
// graph + posing math with the export interpreter (scene-sdk buildStage), so
// what you stage is exactly what renders.
//
// Interaction model (LibTV-style direct manipulation):
//   click an object  → select (highlight box + gizmo + side-panel fields)
//   gizmo drag       → move (XYZ arrows) or rotate (Y ring); commit on release
//   click empty      → deselect; drag empty space orbits, wheel zooms
//   📷 Set camera    → snap the shot camera to the current orbit viewpoint

import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@velocut/protocol';
import type { Animatable } from '@velocut/render-sdk';
import {
  applySpecCamera,
  buildStage,
  expandShots,
  loadSceneManifest,
  specCameraPosition,
  validateSceneSpec,
  MANNEQUIN_DEFAULT_COLOR,
  POSE_PRESETS,
  type SceneAssetManifest,
  type SceneSpec,
  type Stage,
} from '@velocut/scene-sdk';
import type { Store } from '../state/store';
import { AnimatableField, Vec3Row } from './SceneFields';

export type Sel = { kind: 'character' | 'prop'; index: number };
type GizmoMode = 'translate' | 'rotate';

/** Translate an animatable axis by delta: constants move, keyframe tracks
 *  shift every key — "drag the character" means "move its whole path". */
function shiftAxis(v: Animatable | undefined, base: number, delta: number): Animatable {
  const r = (n: number) => Math.round(n * 100) / 100;
  if (Array.isArray(v)) return v.map((k) => ({ ...k, v: r(k.v + delta) }));
  return r((v ?? base) + delta);
}

/** Shot beats: explicit shot starts when a cut list exists, else all camera
 *  keyframe times. */
function cameraKeyTimes(spec: SceneSpec): number[] {
  if (spec.shots?.length) return spec.shots.map((s) => s.start);
  const times = new Set<number>();
  const collect = (a: Animatable | undefined) => {
    if (Array.isArray(a)) for (const k of a) times.add(k.t);
  };
  collect(spec.camera?.fov);
  const pos = spec.camera?.position;
  collect(pos?.x);
  collect(pos?.y);
  collect(pos?.z);
  const look = spec.camera?.lookAt;
  if (look && !('character' in look)) {
    collect(look.x);
    collect(look.y);
    collect(look.z);
  }
  return [...times].sort((a, b) => a - b);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function DirectorPanel({
  store,
  asset,
  onClose,
  initialSel = null,
}: {
  store: Store;
  asset: Asset;
  onClose: () => void;
  /** Pre-select an object (e.g. clicked in the inspector's object list). */
  initialSel?: Sel | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  tRef.current = t;
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(initialSel);
  const selRef = useRef<Sel | null>(initialSel);
  const [mode, setMode] = useState<GizmoMode>('translate');
  const modeRef = useRef<GizmoMode>('translate');
  modeRef.current = mode;
  const [manifest, setManifest] = useState<SceneAssetManifest | null>(null);
  // Set by the effect: imperative attach/detach of gizmo + highlight, so
  // selection changes don't rebuild the stage.
  const attachRef = useRef<((s: Sel | null) => void) | null>(null);
  // Live orbit viewpoint, read by the "set camera here" button.
  const orbitPosRef = useRef<[number, number, number]>([8, 6, 10]);
  const orbitTargetRef = useRef<[number, number, number]>([0, 1, 0]);
  const specText = asset.spec;

  const spec = (() => {
    try {
      return specText ? (JSON.parse(specText) as SceneSpec) : null;
    } catch {
      return null;
    }
  })();
  const durationS = spec ? spec.durationUs / 1e6 : 0;

  useEffect(() => {
    let alive = true;
    loadSceneManifest()
      .then((m) => alive && setManifest(m))
      .catch(() => alive && setManifest(null));
    return () => {
      alive = false;
    };
  }, []);

  const select = (s: Sel | null) => {
    selRef.current = s;
    setSel(s);
    attachRef.current?.(s);
  };

  /** One edit = one validated setAssetSpec (one undo step). */
  const mutateSpec = (mutate: (draft: SceneSpec) => void) => {
    if (!specText) return;
    const draft = JSON.parse(specText) as SceneSpec;
    mutate(draft);
    const err = validateSceneSpec(draft);
    if (err) return setError(err);
    const r = store.dispatch({ type: 'setAssetSpec', assetId: asset.id, spec: JSON.stringify(draft) });
    setError(r.ok ? null : r.error.message);
  };

  // Scrub also drives the main preview: seek to the same moment inside the
  // clip so the flat render and the stage stay side-by-side comparable.
  const clip = store
    .getState()
    .doc.tracks.flatMap((tr) => tr.clips)
    .find((c) => c.assetId === asset.id);
  const scrub = (next: number) => {
    setT(next);
    if (clip) store.seek(clip.startUs + Math.round(next * 1e6));
  };

  /** Snap the shot camera to the current orbit viewpoint — the "look through
   *  the viewfinder, then keep it" move. With a cut list, the shot under the
   *  playhead is updated; character-tracking lookAt is preserved. */
  const setCameraHere = () => {
    const [px, py, pz] = orbitPosRef.current.map(round2);
    const [tx, ty, tz] = orbitTargetRef.current.map(round2);
    mutateSpec((d) => {
      let cam = d.camera;
      if (d.shots?.length) {
        let active = d.shots[0];
        for (const s of d.shots) if (s.start <= tRef.current + 1e-6) active = s;
        cam = active.camera;
      } else {
        cam = d.camera ??= {};
      }
      cam.position = { x: px, y: py, z: pz };
      if (!cam.lookAt || !('character' in cam.lookAt)) cam.lookAt = { x: tx, y: ty, z: tz };
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !specText) return;
    let disposed = false;
    let raf = 0;
    let stage: Stage | null = null;
    let renderer: import('three').WebGLRenderer | null = null;
    let cleanup: (() => void) | null = null;

    (async () => {
      let parsed: SceneSpec;
      try {
        // Expand the cut list so the frustum shows the real shot camera.
        parsed = expandShots(JSON.parse(specText) as SceneSpec);
      } catch {
        setError('Spec is not valid JSON');
        return;
      }
      try {
        stage = await buildStage(parsed);
      } catch (e) {
        setError('Stage build failed: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }
      if (disposed) return;
      setError(null);
      const three = stage.three;
      const [{ OrbitControls }, { TransformControls }] = await Promise.all([
        import('three/examples/jsm/controls/OrbitControls.js'),
        import('three/examples/jsm/controls/TransformControls.js'),
      ]);
      if (disposed) return;

      const w = canvas.clientWidth || 960;
      const h = canvas.clientHeight || 540;
      renderer = new three.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;

      // Free orbit camera for staging — restored from the last frame's
      // viewpoint, because this whole effect re-runs on every spec commit
      // and losing your camera on each edit is unusable.
      const orbit = new three.PerspectiveCamera(50, w / h, 0.1, 500);
      orbit.position.set(...orbitPosRef.current);
      const controls = new OrbitControls(orbit, canvas);
      controls.target.set(...orbitTargetRef.current);
      // …plus the SPEC camera shown as a frustum, so blocking happens with the
      // real shot in view.
      const specCam = new three.PerspectiveCamera(40, (parsed.width ?? 16) / (parsed.height ?? 9), 0.5, 12);
      const helper = new three.CameraHelper(specCam);
      stage.scene.add(helper);

      // ---------------------------------------------- selection + gizmo
      // The gizmo drives a proxy, not the object: poseAt() re-derives every
      // object transform per frame, so the object itself is never a stable
      // handle. Outside a drag the proxy follows the object; during a drag the
      // object follows the proxy; on release the delta is committed to the
      // spec and poseAt takes over again.
      const proxy = new three.Group();
      stage.scene.add(proxy);
      const gizmo = new TransformControls(orbit, canvas);
      gizmo.setSpace('world');
      stage.scene.add(gizmo.getHelper());
      const selBox = new three.Box3Helper(new three.Box3(), 0xffb84d);
      selBox.visible = false;
      stage.scene.add(selBox);

      const selectedRoot = (): import('three').Object3D | null => {
        const s = selRef.current;
        if (!s || !stage) return null;
        const entry = s.kind === 'character' ? stage.characters[s.index] : stage.props[s.index];
        if (!entry) return null;
        if (s.kind === 'prop' && (entry as (typeof stage.props)[number]).attachComp != null) return null;
        return entry.root;
      };

      attachRef.current = (s: Sel | null) => {
        selRef.current = s;
        const root = selectedRoot();
        if (root) {
          proxy.position.copy(root.position);
          proxy.rotation.copy(root.rotation);
          gizmo.attach(proxy);
        } else {
          gizmo.detach();
        }
        selBox.visible = !!root;
      };

      // Yaw is read via a YXZ euler and UNWRAPPED incrementally during the
      // drag: a raw `rotation.y` delta reflects at ±90° (XYZ euler gimbal
      // flip), which read as "the ring bounces back and can't pass 180°".
      // Accumulating shortest-angle steps per change event supports any
      // total rotation, including multiple turns.
      const eul = new three.Euler();
      const yawOf = () => eul.setFromQuaternion(proxy.quaternion, 'YXZ').y;
      const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
      let dragStart: { pos: import('three').Vector3; lastYaw: number; yawAccum: number } | null = null;
      gizmo.addEventListener('objectChange', () => {
        if (!dragStart) return;
        const cur = yawOf();
        dragStart.yawAccum += wrapPi(cur - dragStart.lastYaw);
        dragStart.lastYaw = cur;
      });
      gizmo.addEventListener('dragging-changed', (ev: { value?: unknown }) => {
        const dragging = !!ev.value;
        controls.enabled = !dragging;
        if (dragging) {
          dragStart = { pos: proxy.position.clone(), lastYaw: yawOf(), yawAccum: 0 };
          return;
        }
        // Release → commit one undoable spec edit.
        if (!dragStart) return;
        const dx = round2(proxy.position.x - dragStart.pos.x);
        const dy = round2(proxy.position.y - dragStart.pos.y);
        const dz = round2(proxy.position.z - dragStart.pos.z);
        const dRotY = Math.round((dragStart.yawAccum * 180) / Math.PI);
        dragStart = null;
        const s = selRef.current;
        if (!s) return;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && Math.abs(dz) < 0.01 && dRotY === 0) return;
        mutateSpec((d) => {
          const o = s.kind === 'character' ? d.characters?.[s.index] : d.props?.[s.index];
          if (!o) return;
          if (dx || dy || dz) {
            o.position = o.position ?? {};
            if (dx) o.position.x = shiftAxis(o.position.x, 0, dx);
            if (dy) o.position.y = shiftAxis(o.position.y, 0, dy);
            if (dz) o.position.z = shiftAxis(o.position.z, 0, dz);
          }
          if (dRotY) o.rotationY = shiftAxis(o.rotationY, 0, dRotY);
        });
        // The spec change re-runs this effect (new specText) and rebuilds;
        // selection survives via selRef.
      });

      // Click (not drag) picks; empty click clears. Gizmo handles win.
      const ray = new three.Raycaster();
      const ndc = new three.Vector2();
      let downAt: [number, number] | null = null;
      const onDown = (ev: PointerEvent) => {
        downAt = gizmo.axis == null ? [ev.clientX, ev.clientY] : null;
      };
      const onUp = (ev: PointerEvent) => {
        if (!downAt || !stage) return;
        const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
        downAt = null;
        if (moved > 5 || gizmo.dragging) return;
        const r = canvas.getBoundingClientRect();
        ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, orbit);
        const targets: Array<{ sel: Sel; root: import('three').Object3D }> = [
          ...stage.characters.map((c, i) => ({ sel: { kind: 'character' as const, index: i }, root: c.root })),
          // Bone-attached props ride their character — not gizmo targets.
          ...stage.props
            .map((p, i) => ({ sel: { kind: 'prop' as const, index: i }, root: p.root, attached: p.attachComp != null }))
            .filter((p) => !p.attached),
        ];
        let best: { sel: Sel; dist: number } | null = null;
        for (const cand of targets) {
          const hits = ray.intersectObject(cand.root, true);
          if (hits.length && (!best || hits[0].distance < best.dist)) best = { sel: cand.sel, dist: hits[0].distance };
        }
        select(best?.sel ?? null);
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      cleanup = () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        gizmo.dispose();
      };

      // Re-apply the selection that survived a spec-commit rebuild.
      attachRef.current(selRef.current);

      const loop = () => {
        if (disposed || !stage || !renderer) return;
        stage.poseAt(tRef.current, { cameraPos: specCameraPosition(parsed, tRef.current) });
        gizmo.setMode(modeRef.current);
        gizmo.showX = modeRef.current === 'translate';
        gizmo.showZ = modeRef.current === 'translate';
        const root = selectedRoot();
        if (root) {
          if (gizmo.dragging) {
            // Object follows the gizmo's proxy (ghost preview of the edit).
            // Rotation adds the UNWRAPPED accumulated yaw on top of the pose
            // (reading proxy.rotation.y directly reflects at ±90°).
            root.position.copy(proxy.position);
            if (modeRef.current === 'rotate') root.rotation.y += dragStart?.yawAccum ?? 0;
          } else {
            proxy.position.copy(root.position);
            proxy.rotation.copy(root.rotation);
          }
          selBox.box.setFromObject(root);
          selBox.visible = true;
        } else {
          selBox.visible = false;
        }
        applySpecCamera(specCam, parsed, stage, tRef.current);
        helper.update();
        controls.update();
        orbitPosRef.current = [orbit.position.x, orbit.position.y, orbit.position.z];
        orbitTargetRef.current = [controls.target.x, controls.target.y, controls.target.z];
        renderer.render(stage.scene, orbit);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup?.();
      attachRef.current = null;
      // NO forceContextLoss here: this effect re-runs on every spec commit
      // and reuses the SAME canvas — a lost context stays lost on that
      // canvas, blanking every rebuild. One on-screen canvas = one context
      // total; the browser reclaims it when the panel unmounts.
      renderer?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specText, asset.id]);

  const keys = spec ? cameraKeyTimes(spec) : [];
  const selChar = sel?.kind === 'character' ? spec?.characters?.[sel.index] : undefined;
  const selProp = sel?.kind === 'prop' ? spec?.props?.[sel.index] : undefined;
  const selObj = selChar ?? selProp;
  const isMannequin = !!selChar && !!manifest?.characters[selChar.model]?.file.startsWith('builtin:');
  const characterModels = Object.keys(manifest?.characters ?? {});
  const propModels = Object.keys(manifest?.props ?? {});
  const clipNames = (model: string) => Object.keys(manifest?.characters[model]?.clips ?? {});

  /** Mutate the selected object (character or prop) in one commit. */
  const mutateSel = (fn: (o: NonNullable<typeof selObj>, d: SceneSpec) => void) => {
    if (!sel) return;
    mutateSpec((d) => {
      const o = sel.kind === 'character' ? d.characters?.[sel.index] : d.props?.[sel.index];
      if (o) fn(o, d);
    });
  };

  /** Switching a character's model keeps the spec compilable: actions that
   *  the new model doesn't have are dropped (they now fail loudly), and
   *  pose/actions swap when crossing the mannequin/GLTF line. */
  const switchCharacterModel = (model: string) => {
    mutateSel((o) => {
      const c = o as NonNullable<SceneSpec['characters']>[number];
      c.model = model;
      if (manifest?.characters[model]?.file.startsWith('builtin:')) {
        delete c.actions;
        c.pose = c.pose ?? 'standing';
      } else {
        delete c.pose;
        const clips = manifest?.characters[model]?.clips ?? {};
        c.actions = (c.actions ?? []).filter((a) => clips[a.clip]);
        if (!c.actions.length) {
          const first = Object.keys(clips)[0];
          if (first) c.actions = [{ clip: first, start: 0 }];
        }
      }
    });
  };

  return (
    <div className="director-overlay">
      <div className="director-head">
        <span className="director-title">Director · {asset.name}</span>
        <span className="director-toolbar">
          <button className={'director-tool' + (mode === 'translate' ? ' active' : '')} onClick={() => setMode('translate')} title="Move (gizmo arrows)">
            ↔ Move
          </button>
          <button className={'director-tool' + (mode === 'rotate' ? ' active' : '')} onClick={() => setMode('rotate')} title="Rotate around Y (gizmo ring)">
            ⟳ Rotate
          </button>
          <button className="director-tool" onClick={setCameraHere} title="Point the shot camera exactly where you are looking now">
            📷 Set camera here
          </button>
        </span>
        <span className="director-time">
          {t.toFixed(2)}s / {durationS.toFixed(2)}s
        </span>
        <button className="director-close" onClick={onClose}>
          ×
        </button>
      </div>
      {error && <div className="scene-error">{error}</div>}
      <div className="director-body">
        <canvas ref={canvasRef} className="director-canvas" />
        <div className="director-side">
          {selObj && sel && (
            <div className="director-selcard">
              <div className="group-title">
                {selChar ? (selChar.id ?? 'character') : (selProp?.model ?? 'prop')}
                <button
                  className="fx-remove"
                  title="Remove from scene"
                  onClick={() => {
                    const s = sel;
                    select(null);
                    mutateSpec((d) => {
                      if (s.kind === 'character') d.characters?.splice(s.index, 1);
                      else d.props?.splice(s.index, 1);
                    });
                  }}
                >
                  ×
                </button>
              </div>
              <div className="prop-row">
                <span className="prop-label">Model</span>
                <select
                  value={selObj.model}
                  onChange={(e) => (selChar ? switchCharacterModel(e.target.value) : mutateSel((o) => (o.model = e.target.value)))}
                >
                  {((selChar ? characterModels : propModels).length ? (selChar ? characterModels : propModels) : [selObj.model]).map((m) => (
                    <option key={m} value={m}>
                      {(selChar ? manifest?.characters[m]?.label : manifest?.props[m]?.label) ?? m}
                    </option>
                  ))}
                </select>
              </div>
              <Vec3Row label="Position" value={selObj.position} onAxis={(axis, v) => mutateSel((o) => ((o.position ??= {})[axis] = v))} />
              <div className="prop-row">
                <span className="prop-label">Rotate Y</span>
                <AnimatableField value={selObj.rotationY} fallback={0} step={15} onChange={(v) => mutateSel((o) => (o.rotationY = v))} />
              </div>
              <div className="prop-row">
                <span className="prop-label">Scale</span>
                <input
                  type="number"
                  step={0.1}
                  min={0.05}
                  value={typeof selObj.scale === 'number' ? selObj.scale : (selObj.scale?.x ?? 1)}
                  onChange={(e) => mutateSel((o) => (o.scale = Number(e.target.value)))}
                />
              </div>
              {isMannequin && (
                <div className="prop-row">
                  <span className="prop-label">Pose</span>
                  <select
                    value={typeof selChar!.pose === 'string' ? selChar!.pose : (selChar!.pose?.preset ?? 'standing')}
                    onChange={(e) =>
                      mutateSel((o) => {
                        const c = o as NonNullable<SceneSpec['characters']>[number];
                        if (c.pose && typeof c.pose === 'object' && c.pose.joints) c.pose.preset = e.target.value;
                        else c.pose = e.target.value;
                      })
                    }
                  >
                    {Object.keys(POSE_PRESETS).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  {typeof selChar!.pose === 'object' && selChar!.pose?.joints && (
                    <span className="kf-chip" title="Per-joint overrides — edit via the inspector's JSON tab">◆ joints</span>
                  )}
                </div>
              )}
              <div className="prop-row">
                <span className="prop-label">Color</span>
                <input
                  type="color"
                  value={(selObj as { color?: string }).color ?? (selChar ? MANNEQUIN_DEFAULT_COLOR : '#8fa3bf')}
                  onChange={(e) => mutateSel((o) => ((o as { color?: string }).color = e.target.value))}
                />
              </div>
              {selChar && (
                <div className="prop-row">
                  <span className="prop-label">Gaze</span>
                  <select
                    value={selChar.gaze === 'camera' ? 'camera' : selChar.gaze ? `char:${selChar.gaze.character}` : ''}
                    onChange={(e) =>
                      mutateSel((o) => {
                        const c = o as NonNullable<SceneSpec['characters']>[number];
                        const v = e.target.value;
                        if (!v) delete c.gaze;
                        else if (v === 'camera') c.gaze = 'camera';
                        else c.gaze = { character: v.slice(5) };
                      })
                    }
                  >
                    <option value="">None</option>
                    <option value="camera">Camera</option>
                    {(spec?.characters ?? [])
                      .filter((o) => o.id !== selChar.id)
                      .map((o) => (
                        <option key={o.id} value={`char:${o.id}`}>
                          Look at {o.id}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              {selChar && !isMannequin && (
                <div className="scene-actions">
                  <div className="prop-label">Actions (clip · start s · fade s)</div>
                  {(selChar.actions ?? []).map((a, ai) => (
                    <div className="prop-row scene-action" key={ai}>
                      <select
                        value={a.clip}
                        onChange={(e) =>
                          mutateSel((o) => ((o as NonNullable<SceneSpec['characters']>[number]).actions![ai].clip = e.target.value))
                        }
                      >
                        {(clipNames(selChar.model).length ? clipNames(selChar.model) : [a.clip]).map((n) => (
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
                        onChange={(e) =>
                          mutateSel((o) => ((o as NonNullable<SceneSpec['characters']>[number]).actions![ai].start = Number(e.target.value)))
                        }
                      />
                      <input
                        type="number"
                        step={0.1}
                        min={0}
                        title="Cross-fade (s)"
                        value={a.fade ?? 0.3}
                        onChange={(e) =>
                          mutateSel((o) => ((o as NonNullable<SceneSpec['characters']>[number]).actions![ai].fade = Number(e.target.value)))
                        }
                      />
                      <button
                        className="kf-btn"
                        title="Remove action"
                        onClick={() => mutateSel((o) => (o as NonNullable<SceneSpec['characters']>[number]).actions!.splice(ai, 1))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="fx-add"
                    onClick={() =>
                      mutateSel((o) => {
                        const c = o as NonNullable<SceneSpec['characters']>[number];
                        const clips = clipNames(selChar.model);
                        (c.actions ??= []).push({ clip: clips[0] ?? 'Idle', start: 0 });
                      })
                    }
                  >
                    + Action
                  </button>
                </div>
              )}
              {selProp && (
                <div className="prop-row">
                  <span className="prop-label">Attach</span>
                  <select
                    title="Attach to a character bone (hand-held / worn)"
                    value={selProp.attachTo ? `${selProp.attachTo.character}:${selProp.attachTo.bone ?? 'handR'}` : ''}
                    onChange={(e) =>
                      mutateSel((o) => {
                        const p = o as NonNullable<SceneSpec['props']>[number];
                        const v = e.target.value;
                        if (!v) delete p.attachTo;
                        else {
                          const [character, bone] = v.split(':');
                          p.attachTo = { character, bone };
                          p.position = { x: 0, y: 0, z: 0 };
                        }
                      })
                    }
                  >
                    <option value="">World</option>
                    {(spec?.characters ?? []).flatMap((c) =>
                      Object.keys(manifest?.characters[c.model]?.bones ?? {}).map((slot) => (
                        <option key={`${c.id}:${slot}`} value={`${c.id}:${slot}`}>
                          {c.id} · {slot}
                        </option>
                      )),
                    )}
                  </select>
                </div>
              )}
            </div>
          )}
          <div className="group-title">Camera keys</div>
          {keys.length === 0 && <div className="empty-hint">No camera keyframes (static shot)</div>}
          {keys.map((k) => (
            <button key={k} className={'director-key' + (Math.abs(k - t) < 0.001 ? ' active' : '')} onClick={() => scrub(k)}>
              {k.toFixed(2)}s
            </button>
          ))}
          <div className="empty-hint director-hint">
            {sel
              ? 'Drag the gizmo to move/rotate — releasing commits one undo step. Click empty ground to deselect.'
              : 'Click a character or prop to select it. Drag empty space to orbit · wheel to zoom. The wireframe frustum is the shot camera; 📷 snaps it to your current view.'}
          </div>
        </div>
      </div>
      <input
        className="director-scrub"
        type="range"
        min={0}
        max={durationS}
        step={1 / 30}
        value={t}
        onChange={(e) => scrub(Number(e.target.value))}
      />
    </div>
  );
}
