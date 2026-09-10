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
  ASSEMBLY_DEFAULTS,
  type AssemblyTemplate,
  constructionCamera,
  SCENE_VIEWS,
  normalizeSceneSpec,
  sceneObjects,
  nextSceneId,
  type SceneEdit,
  applySpecCamera,
  buildStage,
  expandShots,
  withImportedModels,
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
import { directorController, type DirectorSession } from '../services/director-session';
import { sceneResources } from '../services/scene-resources';
import { importSceneModel, arrangeScene, editScene, replaceSceneSpec } from '../services/scene';
import { LightFields, MeshFields } from './SceneModelFields';
import { NumberField, AnimatableField, Vec3Row } from './SceneFields';

export type Sel = { kind: 'character' | 'prop' | 'group' | 'light'; id: string };

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
  session,
}: {
  store: Store;
  asset: Asset;
  onClose: () => void;
  session: DirectorSession;
}) {
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importKind, setImportKind] = useState<'prop' | 'character'>('prop');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controller = directorController(store);
  const t = session.timeS;
  const tRef = useRef(0);
  tRef.current = t;
  const [error, setError] = useState<string | null>(null);
  const selRef = useRef<Sel | null>(null);
  const mode = session.mode;
  const setMode = (mode: DirectorSession['mode']) => controller.update({ mode });
  const modeRef = useRef<DirectorSession['mode']>('translate');
  modeRef.current = mode;
  const [baseManifest, setManifest] = useState<SceneAssetManifest | null>(null);
  // Set by the effect: imperative attach/detach of gizmo + highlight, so
  // selection changes don't rebuild the stage.
  const attachRef = useRef<((s: Sel | null) => void) | null>(null);
  // Live orbit viewpoint, read by the "set camera here" button.
  const orbitPosRef = useRef<[number, number, number]>([8, 6, 10]);
  const orbitCameraRef = useRef<import('three').PerspectiveCamera | import('three').OrthographicCamera | null>(null);
  const appliedViewRevisionRef = useRef(-1);
  const orbitTargetRef = useRef<[number, number, number]>([0, 1, 0]);
  const specText = asset.spec;

  const spec = (() => {
    try {
      return specText ? (normalizeSceneSpec(JSON.parse(specText) as SceneSpec)) : null;
    } catch {
      return null;
    }
  })();
  const manifest = baseManifest && spec ? withImportedModels(baseManifest, spec) : baseManifest;
  const durationS = spec ? spec.durationUs / 1e6 : 0;
  const selected = spec ? sceneObjects(spec).find((e) => e.object.id === session.objectId) : undefined;
  const sel: Sel | null = selected ? { kind: selected.kind, id: selected.object.id! } : null;
  selRef.current = sel;
  useEffect(() => { attachRef.current?.(selRef.current); }, [session.objectId]);

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
    controller.update({ objectId: s?.id ?? null });
    attachRef.current?.(s);
  };

  /** One edit = one validated setAssetSpec (one undo step). */
  const mutateSpec = async (mutate: (draft: SceneSpec) => void) => {
    if (!specText) return;
    const current = store.getState();
    if (current.doc.assets.find((a) => a.id === asset.id)?.spec !== specText) return setError('Scene changed; try the edit again.');
    const draft = normalizeSceneSpec(JSON.parse(specText) as SceneSpec);
    mutate(draft);
    const err = validateSceneSpec(draft);
    if (err) return setError(err);
    const r = await replaceSceneSpec(store, asset.id, draft, current.revision);
    setError(r.ok ? null : r.message);
  };

  const runEdits = async (edits: SceneEdit[]) => {
    const r = await editScene(store, { assetId: asset.id, expectedRevision: store.getState().revision, edits });
    setError(r.ok ? null : r.message);
  };

  // Scrub also drives the main preview: seek to the same moment inside the
  // clip so the flat render and the stage stay side-by-side comparable.
  const clip = store
    .getState()
    .doc.tracks.flatMap((tr) => tr.clips)
    .find((c) => c.assetId === asset.id);
  const scrub = (next: number) => {
    controller.update({ timeS: next });
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
        parsed = expandShots(normalizeSceneSpec(JSON.parse(specText) as SceneSpec));
      } catch {
        setError('Spec is not valid JSON');
        return;
      }
      try {
        stage = await buildStage(parsed, undefined, sceneResources(store));
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

      let w = canvas.clientWidth || 960;
      let h = canvas.clientHeight || 540;
      renderer = new three.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;

      // Free orbit camera for staging — restored from the last frame's
      // viewpoint, because this whole effect re-runs on every spec commit
      // and losing your camera on each edit is unusable.
      let orbit: import('three').PerspectiveCamera | import('three').OrthographicCamera = orbitCameraRef.current?.clone() ?? new three.PerspectiveCamera(50, w / h, 0.1, 500);
      orbit.position.set(...orbitPosRef.current);
      let controls = new OrbitControls(orbit, canvas);
      controls.target.set(...orbitTargetRef.current);
      controls.enableRotate = controller.getSnapshot()?.view === 'perspective';
      let changingObject = false;
      const recordView = () => {
        if (changingObject) return;
        const current = controller.getSnapshot(); if (!current || current.view === 'shot') return;
        controller.update({ view: current.view, camera: {
          position: orbit.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number],
          up: orbit.up.toArray() as [number, number, number],
          ...(orbit instanceof three.PerspectiveCamera ? { projection: 'perspective', fov: orbit.fov } : { projection: 'orthographic', height: (orbit.top - orbit.bottom) / orbit.zoom }),
        } });
      };
      controls.addEventListener('end', recordView);
      // …plus the SPEC camera shown as a frustum, so blocking happens with the
      // real shot in view.
      const specCam = new three.PerspectiveCamera(40, (parsed.width ?? 16) / (parsed.height ?? 9), 0.5, 12);
      const shotCam = new three.PerspectiveCamera(40, (parsed.width ?? 16) / (parsed.height ?? 9), 0.1, 500);
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

      for (const l of stage.lights) {
        const marker = new three.Mesh(new three.SphereGeometry(0.12, 12, 8), new three.MeshBasicMaterial({ color: l.spec.color ?? '#ffffff' }));
        marker.name = 'Director light handle'; l.root.add(marker);
        if (l.spec.type === 'spot' || l.spec.type === 'directional') l.root.add(new three.ArrowHelper(new three.Vector3(0, 0, -1), new three.Vector3(), 0.8, 0xffdd77));
      }
      const selectedRoot = (): import('three').Object3D | null => {
        const s = selRef.current;
        if (!s || !stage) return null;
        const entry = [...stage.characters, ...stage.props, ...stage.groups, ...stage.lights].find((e) => e.spec.id === s.id);
        if (!entry) return null;
        if (s.kind === 'prop' && (entry as (typeof stage.props)[number]).attachComp != null) return null;
        return entry.root;
      };

      attachRef.current = (s: Sel | null) => {
        selRef.current = s;
        const root = selectedRoot();
        if (root) {
          root.parent!.add(proxy);
          proxy.position.copy(root.position);
          proxy.rotation.copy(root.rotation);
          proxy.scale.copy(root.scale);
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
      let dragStart: { pos: import('three').Vector3; rotation: import('three').Euler; scale: import('three').Vector3; axis: string | null; lastYaw: number; yawAccum: number } | null = null;
      gizmo.addEventListener('objectChange', () => {
        if (!dragStart) return;
        const cur = yawOf();
        dragStart.yawAccum += wrapPi(cur - dragStart.lastYaw);
        dragStart.lastYaw = cur;
      });
      gizmo.addEventListener('dragging-changed', (ev: { value?: unknown }) => {
        const dragging = !!ev.value;
        changingObject = dragging;
        controls.enabled = !dragging;
        if (dragging) {
          dragStart = { pos: proxy.position.clone(), rotation: proxy.rotation.clone(), scale: proxy.scale.clone(), axis: gizmo.axis, lastYaw: yawOf(), yawAccum: 0 };
          return;
        }
        // Release → commit one undoable spec edit.
        if (!dragStart) return;
        const dx = round2(proxy.position.x - dragStart.pos.x);
        const dy = round2(proxy.position.y - dragStart.pos.y);
        const dz = round2(proxy.position.z - dragStart.pos.z);
        const rotation = proxy.rotation.clone();
        const original = dragStart;
        const scaling = proxy.scale.clone().divide(original.scale);
        const yawDelta = Math.round((original.yawAccum * 180) / Math.PI);
        dragStart = null;
        const selection = selRef.current;
        if (!selection) return;
        const rotationDelta = ['x', 'y', 'z'].map((axis) => {
          const k = axis as 'x' | 'y' | 'z';
          return round2(wrapPi(rotation[k] - original.rotation[k]) * 180 / Math.PI);
        });
        // Preserve multi-turn yaw for legacy yaw-only objects.
        const yawOnly = original.axis === 'Y' && Math.abs(original.rotation.x) < 1e-6 && Math.abs(original.rotation.z) < 1e-6 &&
          Math.abs(Math.sin(rotation.x)) < 1e-6 && Math.abs(Math.sin(rotation.z)) < 1e-6;
        if (yawOnly) rotationDelta.splice(0, 3, 0, yawDelta, 0);
        if (!dx && !dy && !dz && !rotationDelta.some(Boolean) && scaling.distanceTo(new three.Vector3(1, 1, 1)) < 1e-6) return;
        void mutateSpec((d) => {
          const o = sceneObjects(d).find((e) => e.object.id === selection.id)?.object;
          if (!o) return;
          if (modeRef.current === 'translate') {
            o.position ??= {};
            if (dx) o.position.x = shiftAxis(o.position.x, 0, dx);
            if (dy) o.position.y = shiftAxis(o.position.y, selection.kind === 'prop' ? 0.5 : 0, dy);
            if (dz) o.position.z = shiftAxis(o.position.z, 0, dz);
          } else if (modeRef.current === 'rotate') {
            for (const [i, k] of (['rotationX', 'rotationY', 'rotationZ'] as const).entries()) {
              if (rotationDelta[i]) o[k] = shiftAxis(o[k], 0, rotationDelta[i]);
            }
          } else {
            const v = typeof o.scale === 'number' ? { x: o.scale, y: o.scale, z: o.scale } : o.scale ?? {};
            o.scale = { x: round2((v.x ?? 1) * scaling.x), y: round2((v.y ?? 1) * scaling.y), z: round2((v.z ?? 1) * scaling.z) };
          }
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
          ...stage.lights.map((l) => ({ sel: { kind: 'light' as const, id: l.spec.id }, root: l.root })),
          ...stage.characters.map((c) => ({ sel: { kind: 'character' as const, id: c.spec.id }, root: c.root })),
          // Bone-attached props ride their character — not gizmo targets.
          ...stage.props
            .map((p) => ({ sel: { kind: 'prop' as const, id: p.spec.id! }, root: p.root, attached: p.attachComp != null }))
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
      const resize = new ResizeObserver(() => {
        if (!renderer) return;
        w = Math.max(1, canvas.clientWidth); h = Math.max(1, canvas.clientHeight);
        renderer.setSize(w, h, false);
        if (orbit instanceof three.PerspectiveCamera) orbit.aspect = w / h;
        else {
          const halfHeight = (orbit.top - orbit.bottom) / 2;
          orbit.left = -halfHeight * w / h; orbit.right = halfHeight * w / h;
        }
        orbit.updateProjectionMatrix();
      });
      resize.observe(canvas);
      cleanup = () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        gizmo.dispose();
        controls.dispose();
        resize.disconnect();
      };

      // Re-apply the selection that survived a spec-commit rebuild.
      stage.poseAt(tRef.current, { cameraPos: specCameraPosition(parsed, tRef.current) });
      attachRef.current(selRef.current);

      let viewRevision = appliedViewRevisionRef.current;
      let lastTime = performance.now();
      const loop = () => {
        if (disposed || !stage || !renderer) return;
        const currentSession = controller.getSnapshot();
        if (!currentSession) return;
        const now = performance.now();
        if (currentSession.playing) {
          const next = Math.min(parsed.durationUs / 1e6, currentSession.timeS + Math.min(0.1, (now - lastTime) / 1000));
          controller.update({ timeS: next, playing: next < parsed.durationUs / 1e6 });
          tRef.current = next;
        }
        lastTime = now;
        stage.poseAt(tRef.current, { cameraPos: specCameraPosition(parsed, tRef.current) });
        if (currentSession.viewRevision !== viewRevision) {
          viewRevision = currentSession.viewRevision;
          appliedViewRevisionRef.current = viewRevision;
          if (currentSession.view !== 'shot') {
            const focusId = currentSession.focusId && sceneObjects(parsed).some((e) => e.object.id === currentSession.focusId) ? currentSession.focusId : undefined;
            const frame = constructionCamera(stage, w, h, currentSession.view, focusId, currentSession.camera);
            controls.dispose();
            orbit = frame.camera;
            controls = new OrbitControls(orbit, canvas);
            controls.addEventListener('end', recordView);
            controls.target.copy(frame.target);
            controls.enableRotate = currentSession.view === 'perspective';
            gizmo.camera = orbit;
          }
        }
        const shotView = currentSession.view === 'shot';
        controls.enabled = !shotView && !gizmo.dragging;
        gizmo.enabled = !shotView;
        gizmo.getHelper().visible = !shotView;
        helper.visible = !shotView;
        gizmo.setMode(modeRef.current);
        gizmo.showX = true;
        gizmo.showZ = true;
        const root = selectedRoot();
        if (root) {
          if (gizmo.dragging) {
            // Object follows the gizmo's proxy (ghost preview of the edit).
            // The local quaternion/scale preview matches the proxy; release
            // turns the sampled difference into declarative track offsets.
            root.position.copy(proxy.position);
            if (modeRef.current === 'rotate') root.quaternion.copy(proxy.quaternion);
            if (modeRef.current === 'scale') root.scale.copy(proxy.scale);
          } else {
            proxy.position.copy(root.position);
            proxy.rotation.copy(root.rotation);
            proxy.scale.copy(root.scale);
          }
          selBox.box.setFromObject(root);
          selBox.visible = true;
        } else {
          selBox.visible = false;
        }
        for (const l of stage.lights) for (const child of l.root.children) { if (child !== l.light && !('target' in l.light && child === (l.light as import('three').DirectionalLight).target)) child.visible = !shotView; }
        if (shotView) selBox.visible = false;
        applySpecCamera(specCam, parsed, stage, tRef.current);
        if (shotView) applySpecCamera(shotCam, parsed, stage, tRef.current);
        helper.update();
        controls.update();
        orbitPosRef.current = [orbit.position.x, orbit.position.y, orbit.position.z];
        orbitTargetRef.current = [controls.target.x, controls.target.y, controls.target.z];
        orbitCameraRef.current = orbit;
        renderer.setViewport(0, 0, w, h);
        if (shotView) {
          // Show the authored aspect ratio without stretching the shot.
          const vw = Math.min(w, h * shotCam.aspect), vh = vw / shotCam.aspect;
          const left = (w - vw) / 2, bottom = (h - vh) / 2;
          renderer.setClearColor('#101318'); renderer.clear();
          renderer.setViewport(left, bottom, vw, vh);
          renderer.setScissor(left, bottom, vw, vh); renderer.setScissorTest(true);
          renderer.render(stage.scene, shotCam);
          renderer.setScissorTest(false);
        } else renderer.render(stage.scene, orbit);
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
  const selChar = sel?.kind === 'character' ? spec?.characters?.find((o) => o.id === sel.id) : undefined;
  const selProp = sel?.kind === 'prop' ? spec?.props?.find((o) => o.id === sel.id) : undefined;
  const selGroup = sel?.kind === 'group' ? spec?.groups?.find((o) => o.id === sel.id) : undefined;
  const selLight = sel?.kind === 'light' ? spec?.lights?.find((o) => o.id === sel.id) : undefined;
  const selObj = selChar ?? selProp ?? selGroup ?? selLight;
  const isMannequin = !!selChar && !!manifest?.characters[selChar.model]?.file.startsWith('builtin:');
  const characterModels = Object.keys(manifest?.characters ?? {});
  const propModels = Object.keys(manifest?.props ?? {});
  const clipNames = (model: string) => Object.keys(manifest?.characters[model]?.clips ?? {});

  /** Mutate the selected object (character or prop) in one commit. */
  const mutateSel = (fn: (o: NonNullable<typeof selObj>, d: SceneSpec) => void) => {
    if (!sel) return;
    mutateSpec((d) => {
      const o = sceneObjects(d).find((e) => e.object.id === sel.id)?.object;
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
          <button className={'director-tool' + (mode === 'rotate' ? ' active' : '')} onClick={() => setMode('rotate')} title="Rotate in 3D (gizmo rings)">
            ⟳ Rotate
          </button>
          <button className={'director-tool' + (mode === 'scale' ? ' active' : '')} onClick={() => setMode('scale')}>Scale</button>
          <select aria-label="Director view" value={session.view} onChange={(e) => controller.update({ view: e.target.value as DirectorSession['view'] })}>
            {SCENE_VIEWS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <button className="director-tool" onClick={() => controller.update({ focusId: sel?.id ?? null })}>Focus</button>
          <button className="director-tool" onClick={() => controller.update({ playing: !session.playing, ...(t >= durationS ? { timeS: 0 } : {}) })}>{session.playing ? 'Pause' : 'Play'}</button>
          <button className="director-tool" disabled={session.view !== 'perspective'} onClick={setCameraHere} title="Point the shot camera exactly where you are looking now">
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
          <div className="group-title">Objects</div>
          {spec && sceneObjects(spec).map(({ kind, object }) => (
            <button key={object.id} className={'director-key' + (sel?.id === object.id ? ' active' : '')}
              onClick={() => select({ kind, id: object.id! })}>{object.parentId ? '↳ ' : ''}{object.name ?? object.id}</button>
          ))}
          <button className="fx-add" onClick={() => spec && runEdits([{ type: 'add', kind: 'group', object: { id: nextSceneId(spec, 'group') } }])}>+ Group</button>
          <div className="prop-row"><span className="prop-label">Build</span><select aria-label="Build assembly" value="" onChange={(e) => {
            if (spec && e.target.value) void runEdits([{ type: 'assembly', id: nextSceneId(spec, e.target.value), recipe: { template: e.target.value as AssemblyTemplate } }]);
          }}><option value="">Choose assembly…</option>{Object.keys(ASSEMBLY_DEFAULTS).map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
          <div className="prop-row">
            <select aria-label="Import model as" value={importKind} onChange={(e) => setImportKind(e.target.value as 'prop' | 'character')}><option value="prop">Static model</option><option value="character">Animated model</option></select>
            <button className="fx-add" disabled={importing} onClick={() => importRef.current?.click()}>{importing ? 'Importing…' : 'Import GLB'}</button>
            <input ref={importRef} hidden type="file" accept=".glb,model/gltf-binary" onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
              setImporting(true);
              const r = await importSceneModel(store, { assetId: asset.id, file, kind: importKind });
              setImporting(false); setError(r.ok ? null : r.message);
              if (r.ok) controller.update({ objectId: r.objectId, focusId: r.objectId });
            }} />
          </div>
          <button className="fx-add" onClick={() => spec && runEdits([{ type: 'add', kind: 'light', object: {
            id: nextSceneId(spec, 'light'), type: 'spot', position: { x: 2, y: 4, z: 2 }, rotationX: -65, rotationY: 25, intensity: 100,
          } }])}>+ Light</button>
          {selObj && sel && (
            <div className="director-selcard">
              <div className="group-title">
                {selObj.name ?? selObj.id}
                <button
                  className="fx-remove"
                  title="Remove from scene"
                  onClick={() => {
                    const s = sel;
                    select(null);
                    void runEdits([{ type: 'remove', id: s.id, cascade: true }]);
                  }}
                >
                  ×
                </button>
              </div>
              {!selGroup && !selLight && <div className="prop-row">
                <span className="prop-label">Model</span>
                <select
                  value={(selChar ?? selProp)!.model}
                  onChange={(e) => (selChar ? switchCharacterModel(e.target.value) : mutateSel((o) => {
                    const p = o as NonNullable<SceneSpec['props']>[number];
                    p.model = e.target.value;
                    delete p.vertices; delete p.faces; delete p.uvs;
                    delete p.path; delete p.radius; delete p.closed; delete p.holes; delete p.bevel;
                    if (p.model === 'prop/lathe') { p.points = [[0.2, 0], [0.3, 0.2], [0.15, 0.8], [0.2, 1]]; delete p.depth; }
                    else if (p.model === 'prop/extrude') { p.points = [[-0.5, 0], [0.5, 0], [0, 1]]; p.depth = 0.1; }
                    else { delete p.points; delete p.depth; if (p.model === 'prop/mesh') { p.vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]; p.faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]; } if (p.model === 'prop/tube') { p.path = [[0, 0, 0], [0.5, 1, 0], [1, 1, 0]]; p.radius = 0.05; } }
                  }))}
                >
                  {((selChar ? characterModels : propModels).length ? (selChar ? characterModels : propModels) : [(selChar ?? selProp)!.model]).map((m) => (
                    <option key={m} value={m}>
                      {(selChar ? manifest?.characters[m]?.label : manifest?.props[m]?.label) ?? m}
                    </option>
                  ))}
                </select>
              </div>}
              <div className="prop-row"><span className="prop-label">Name</span><input key={sel.id + (selObj.name ?? '')} defaultValue={selObj.name ?? ''} onBlur={(e) => { const name = e.target.value; if (name !== (selObj.name ?? '')) void mutateSel((o) => { o.name = name; }); }} /></div>
              <div className="prop-row"><span className="prop-label">Parent</span><select value={selObj.parentId ?? ''} onChange={(e) => mutateSel((o) => { if (e.target.value) o.parentId = e.target.value; else delete o.parentId; })}><option value="">World (local transform)</option>{(spec?.groups ?? []).filter((g) => g.id !== sel.id).map((g) => <option key={g.id} value={g.id}>{g.name ?? g.id}</option>)}</select></div>
              <Vec3Row label="Position" value={selObj.position} onAxis={(axis, v) => mutateSel((o) => ((o.position ??= {})[axis] = v))} />
              {(['rotationX', 'rotationY', 'rotationZ'] as const).map((axis) => (
                <div className="prop-row" key={axis}><span className="prop-label">Rotate {axis.slice(-1)}</span>
                  <AnimatableField value={selObj[axis]} fallback={0} step={15} onChange={(v) => mutateSel((o) => { o[axis] = v; })} />
                </div>
              ))}
              {(['x', 'y', 'z'] as const).map((axis) => (
                <div className="prop-row" key={axis}><span className="prop-label">Scale {axis.toUpperCase()}</span>
                  <NumberField step={0.1} min={0.01} value={typeof selObj.scale === 'number' ? selObj.scale : selObj.scale?.[axis] ?? 1}
                    onCommit={(v) => mutateSel((o) => {
                      o.scale = typeof o.scale === 'number' ? { x: o.scale, y: o.scale, z: o.scale } : { ...o.scale };
                      o.scale[axis] = v;
                    })} />
                </div>
              ))}
              {!selLight && <button className="fx-add" onClick={async () => {
                const r = await arrangeScene(store, { assetId: asset.id, ids: [sel.id], mode: 'ground', timeS: t });
                setError(r.ok ? null : r.message);
              }}>Place on ground</button>}
              {selLight && <LightFields value={selLight} onChange={(patch) => mutateSel((o) => Object.assign(o, patch))} />}
              {selProp?.model === 'prop/mesh' && <MeshFields value={selProp} onChange={(patch) => mutateSel((o) => Object.assign(o, patch))} />}
              {selGroup?.assembly && <>
                <div className="group-title">Assembly dimensions</div>
                {Object.entries({ ...ASSEMBLY_DEFAULTS[selGroup.assembly.template], ...selGroup.assembly.parameters }).map(([field, value]) => (
                  <div className="prop-row" key={field}><span className="prop-label">{field}</span>
                    <NumberField value={value} min={0.001} step={field === 'steps' ? 1 : 0.1} onCommit={(v) => runEdits([{ type: 'assembly', id: sel.id,
                      recipe: { template: selGroup.assembly!.template, parameters: { ...selGroup.assembly!.parameters, [field]: v } } }])} />
                  </div>
                ))}
                <div className="empty-hint">Changing dimensions rebuilds generated parts; custom children and part materials stay.</div>
              </>}
              <button className="fx-add" onClick={() => spec && runEdits([{ type: 'duplicate', id: sel.id, newId: nextSceneId(spec, sel.kind), offset: { x: 1 } }])}>Duplicate</button>
              {selProp && (['roughness', 'metalness', 'opacity'] as const).map((field) => (
                <div className="prop-row" key={field}><span className="prop-label">{field}</span>
                  {selProp.model.startsWith('model/') && selProp.material?.[field] == null ?
                    <button className="kf-btn" onClick={() => mutateSel((o) => { ((o as NonNullable<SceneSpec['props']>[number]).material ??= {})[field] = field === 'roughness' ? 0.6 : field === 'opacity' ? 1 : 0; })}>Inherited · override</button> :
                    <NumberField min={0} max={1} step={0.1} value={selProp.material?.[field] ?? (field === 'roughness' ? 0.6 : field === 'opacity' ? 1 : 0)}
                      onCommit={(v) => mutateSel((o) => { ((o as NonNullable<SceneSpec['props']>[number]).material ??= {})[field] = v; })} />}

                </div>
              ))}
              {selProp?.model.startsWith('model/') && <>
                <button className="fx-add" onClick={() => mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).color = '#ffffff'; })}>Set white tint</button>
                <button className="fx-add" onClick={() => runEdits([{ type: 'update', id: sel.id, patch: {}, clear: ['color', 'material'] }])}>Restore source materials</button>
              </>}
              {selProp?.points && <div className="scene-actions">
                <div className="prop-label">{selProp.model === 'prop/lathe' ? 'Profile [radius, height]' : 'Outline [x, y]'}</div>
                <textarea key={sel.id + JSON.stringify(selProp.points)} className="scene-json" defaultValue={JSON.stringify(selProp.points)}
                  onBlur={(e) => { try { const points = JSON.parse(e.target.value); if (JSON.stringify(points) !== JSON.stringify(selProp.points)) void mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).points = points; }); } catch { setError('Points must be JSON coordinate pairs.'); } }} />
                {selProp.model === 'prop/extrude' && <div className="prop-row"><span className="prop-label">Depth</span>
                  <NumberField value={selProp.depth ?? 0.1} min={0.001} onCommit={(v) => mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).depth = v; })} /></div>}
              </div>}
              {selProp?.model === 'prop/extrude' && <>
                <div className="prop-row"><span className="prop-label">Bevel</span><NumberField value={selProp.bevel ?? 0} min={0} max={1} step={0.01} onCommit={(v) => mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).bevel = v; })} /></div>
                <div className="prop-label">Hole outlines</div>
                <textarea key={sel.id + JSON.stringify(selProp.holes)} className="scene-json" defaultValue={JSON.stringify(selProp.holes ?? [])}
                  onBlur={(e) => { try { const holes = JSON.parse(e.target.value); if (JSON.stringify(holes) !== JSON.stringify(selProp.holes ?? [])) void mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).holes = holes; }); } catch { setError('Holes must be JSON arrays of coordinate pairs.'); } }} />
              </>}
              {selProp?.model === 'prop/tube' && <>
                <div className="prop-label">Path [x, y, z]</div>
                <textarea key={sel.id + JSON.stringify(selProp.path)} className="scene-json" defaultValue={JSON.stringify(selProp.path)}
                  onBlur={(e) => { try { const path = JSON.parse(e.target.value); if (JSON.stringify(path) !== JSON.stringify(selProp.path)) void mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).path = path; }); } catch { setError('Path must be JSON coordinate triples.'); } }} />
                <div className="prop-row"><span className="prop-label">Radius</span><NumberField value={selProp.radius ?? 0.05} min={0.001} max={100} step={0.01} onCommit={(v) => mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).radius = v; })} /></div>
                <label><input type="checkbox" checked={selProp.closed ?? false} onChange={(e) => mutateSel((o) => { (o as NonNullable<SceneSpec['props']>[number]).closed = e.target.checked; })} /> Closed path</label>
              </>}
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
              {!selGroup && <div className="prop-row">
                <span className="prop-label">Color</span>
                <input
                  type="color"
                  value={(selObj as { color?: string }).color ?? (selChar ? MANNEQUIN_DEFAULT_COLOR : selLight || selProp?.model.startsWith('model/') ? '#ffffff' : '#8fa3bf')}
                  onChange={(e) => mutateSel((o) => ((o as { color?: string }).color = e.target.value))}
                />
              </div>}
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
