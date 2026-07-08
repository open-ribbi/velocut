// DirectorPanel — the stage view: orbit the compiled 3D scene, drag characters
// and props to block them, scrub time, and see the spec camera as a frustum.
//
// A richer input device over the same fields the SceneInspector edits: every
// gesture commits ONE setAssetSpec (ghost-then-commit, like the preview's
// transform gizmos), so manual blocking is attributed, undoable and instantly
// visible to the agent — no UI-only state. The viewport shares the scene
// graph + posing math with the export interpreter (scene-sdk buildStage), so
// what you stage is exactly what renders.

import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@velocut/protocol';
import type { Animatable } from '@velocut/render-sdk';
import {
  applySpecCamera,
  buildStage,
  expandShots,
  specCameraPosition,
  validateSceneSpec,
  type SceneSpec,
  type Stage,
} from '@velocut/scene-sdk';
import type { Store } from '../state/store';

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

export function DirectorPanel({ store, asset, onClose }: { store: Store; asset: Asset; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  tRef.current = t;
  const [error, setError] = useState<string | null>(null);
  const [dragHint, setDragHint] = useState<string | null>(null);
  const specText = asset.spec;

  const spec = (() => {
    try {
      return specText ? (JSON.parse(specText) as SceneSpec) : null;
    } catch {
      return null;
    }
  })();
  const durationS = spec ? spec.durationUs / 1e6 : 0;

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !specText) return;
    let disposed = false;
    let raf = 0;
    let stage: Stage | null = null;
    let renderer: import('three').WebGLRenderer | null = null;
    let cleanupPointers: (() => void) | null = null;

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
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      if (disposed) return;

      const w = canvas.clientWidth || 960;
      const h = canvas.clientHeight || 540;
      renderer = new three.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;

      // Free orbit camera for staging…
      const orbit = new three.PerspectiveCamera(50, w / h, 0.1, 500);
      orbit.position.set(8, 6, 10);
      const controls = new OrbitControls(orbit, canvas);
      controls.target.set(0, 1, 0);
      // …plus the SPEC camera shown as a frustum, so blocking happens with the
      // real shot in view.
      const specCam = new three.PerspectiveCamera(40, (parsed.width ?? 16) / (parsed.height ?? 9), 0.5, 12);
      const helper = new three.CameraHelper(specCam);
      stage.scene.add(helper);

      // ------------------------------------------------ drag-to-block
      const ray = new three.Raycaster();
      const groundPlane = new three.Plane(new three.Vector3(0, 1, 0), 0);
      const ndc = new three.Vector2();
      let drag: {
        kind: 'character' | 'prop';
        index: number;
        startHit: import('three').Vector3;
        ghost: [number, number];
      } | null = null;

      const pick = (ev: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, orbit);
      };
      const groundHit = () => {
        const out = new three.Vector3();
        return ray.ray.intersectPlane(groundPlane, out) ? out : null;
      };

      const onDown = (ev: PointerEvent) => {
        if (!stage) return;
        pick(ev);
        const targets: Array<{ kind: 'character' | 'prop'; index: number; root: import('three').Object3D }> = [
          ...stage.characters.map((c, i) => ({ kind: 'character' as const, index: i, root: c.root })),
          ...stage.props.map((p, i) => ({ kind: 'prop' as const, index: i, root: p.root })),
        ];
        for (const cand of targets) {
          if (ray.intersectObject(cand.root, true).length > 0) {
            const hit = groundHit();
            if (!hit) return;
            drag = { kind: cand.kind, index: cand.index, startHit: hit.clone(), ghost: [0, 0] };
            controls.enabled = false;
            canvas.setPointerCapture(ev.pointerId);
            setDragHint(cand.kind === 'character' ? stage.characters[cand.index].spec.id : stage.props[cand.index].spec.model);
            return;
          }
        }
      };
      const onMove = (ev: PointerEvent) => {
        if (!drag || !stage) return;
        pick(ev);
        const hit = groundHit();
        if (!hit) return;
        drag.ghost = [hit.x - drag.startHit.x, hit.z - drag.startHit.z];
      };
      const onUp = () => {
        if (!drag || !stage) return;
        const [dx, dz] = drag.ghost;
        const d = drag;
        drag = null;
        controls.enabled = true;
        setDragHint(null);
        if (Math.hypot(dx, dz) < 0.05) return; // click, not a drag
        // Commit: shift the whole path by the drag delta — one undoable step.
        const draft = JSON.parse(specText!) as SceneSpec;
        if (d.kind === 'character') {
          const c = draft.characters?.[d.index];
          if (!c) return;
          c.position = c.position ?? {};
          c.position.x = shiftAxis(c.position.x, 0, dx);
          c.position.z = shiftAxis(c.position.z, 0, dz);
        } else {
          const p = draft.props?.[d.index];
          if (!p) return;
          p.position = p.position ?? {};
          p.position.x = shiftAxis(p.position.x, 0, dx);
          p.position.z = shiftAxis(p.position.z, 0, dz);
        }
        const err = validateSceneSpec(draft);
        if (err) return setError(err);
        const r = store.dispatch({ type: 'setAssetSpec', assetId: asset.id, spec: JSON.stringify(draft) });
        if (!r.ok) setError(r.error.message);
        // The spec change re-runs this effect (new specText) and rebuilds.
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      cleanupPointers = () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };

      const loop = () => {
        if (disposed || !stage || !renderer) return;
        stage.poseAt(tRef.current, { cameraPos: specCameraPosition(parsed, tRef.current) });
        // Ghost: while dragging, offset the grabbed object visually.
        if (drag) {
          const target = drag.kind === 'character' ? stage.characters[drag.index]?.root : stage.props[drag.index]?.root;
          if (target) {
            target.position.x += drag.ghost[0];
            target.position.z += drag.ghost[1];
          }
        }
        applySpecCamera(specCam, parsed, stage, tRef.current);
        helper.update();
        controls.update();
        renderer.render(stage.scene, orbit);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanupPointers?.();
      renderer?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specText, asset.id]);

  const keys = spec ? cameraKeyTimes(spec) : [];

  return (
    <div className="director-overlay">
      <div className="director-head">
        <span className="director-title">Director · {asset.name}</span>
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
          <div className="group-title">Camera keys</div>
          {keys.length === 0 && <div className="empty-hint">No camera keyframes (static shot)</div>}
          {keys.map((k) => (
            <button key={k} className={'director-key' + (Math.abs(k - t) < 0.001 ? ' active' : '')} onClick={() => scrub(k)}>
              {k.toFixed(2)}s
            </button>
          ))}
          <div className="empty-hint director-hint">
            {dragHint
              ? `Moving ${dragHint} — release to commit`
              : 'Drag a character/prop on the ground to re-block it (one undo step). Orbit: drag empty space · wheel to zoom. The wireframe frustum is the shot camera.'}
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
