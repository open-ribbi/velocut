// ui/TimelinePanel.tsx — canvas-drawn timeline.
//
// Rendering reads (doc, selection, playhead) from the store plus a local
// "ghost" for in-flight gestures. Gestures NEVER mutate state directly: the
// ghost previews locally, and pointer-up commits a single protocol command
// (moveClip / trimClip / moveTrack). If the engine rejects it (overlap/locked),
// the UI simply redraws from the unchanged document — validation lives in
// exactly one place for humans and agents alike.
//
// Track management lives in right-click menus (clip menu + track menu) rather
// than on-canvas buttons; the header stays a clean label with mute/lock status
// tags. Track height is UI-local (collapse is a view concern, not a document
// fact), and the track area scrolls vertically under a fixed ruler — so the
// layout is a running sum of per-track heights offset by a scroll position.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Clip, TimeUs } from '@velocut/protocol';
import type { MediaLibrary } from '@velocut/render-sdk';
import type { Store, UiState } from '../state/store';
import { referenceToAgent } from '../services/reference';
import { draggedAsset, type DraggedAsset } from '../services/dnd';

const RULER_H = 30;
const TRACK_H = 54;
const COLLAPSED_H = 20;
const TRACK_GAP = 6;
const HEADER_W = 130;
const HANDLE_PX = 6;
const SNAP_PX = 8;
const MIN_CLIP_US = 50_000;

type Gesture =
  | { kind: 'scrub' }
  | {
      kind: 'move';
      clipId: string;
      grabOffsetUs: TimeUs;
      fromTrackIdx: number;
      ghostStartUs: TimeUs;
      ghostTrackIdx: number;
      snapLineUs: TimeUs | null;
    }
  | {
      kind: 'trim';
      clipId: string;
      edge: 'in' | 'out';
      ghostToUs: TimeUs;
      snapLineUs: TimeUs | null;
    }
  | {
      kind: 'reorder';
      trackId: string;
      fromIdx: number;
      ghostIdx: number;
    };

type Menu =
  | { x: number; y: number; kind: 'clip'; clipId: string }
  | { x: number; y: number; kind: 'track'; trackId: string };

const TRACK_COLORS: Record<string, [string, string]> = {
  video: ['#2d5f8a', '#3f7fb5'],
  text: ['#7a5f2d', '#a8843f'],
  audio: ['#2d7a4f', '#3fa86c'],
};

export function TimelinePanel({ store, state, media, height }: { store: Store; state: UiState; media: MediaLibrary; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Peak-envelope cache for audio waveforms, keyed by clip source-window.
  // undefined = never requested, null = loading, Float32Array = ready.
  const waveCache = useRef(new Map<string, Float32Array | null>());
  // UI-local collapsed tracks (thin lanes). A view concern, not a doc fact.
  const collapsed = useRef(new Set<string>());
  // Right-click menu (DOM overlay): clip actions or track actions. Null = hidden.
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // viewport: horizontal scroll (us at left edge), zoom (px/us), vertical scroll (px)
  const view = useRef({ scrollUs: 0, pxPerUs: 100 / 1e6, scrollY: 0 });
  const gesture = useRef<Gesture | null>(null);
  // In-flight asset drag from the AssetPanel: where it would land (ghost).
  // newTrack = the drop is below the lanes and mints a matching track.
  const dropGhost = useRef<{ trackIdx: number; startUs: TimeUs; durUs: TimeUs; ok: boolean; newTrack?: boolean } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---------------------------------------------------------- helpers

  const usToX = (us: TimeUs) => HEADER_W + (us - view.current.scrollUs) * view.current.pxPerUs;
  const xToUs = (x: number) =>
    Math.max(0, Math.round(view.current.scrollUs + (x - HEADER_W) / view.current.pxPerUs));

  // Per-track height (collapsed lanes shrink). Layout is in "content space" (no
  // ruler, no scroll); screen Y adds the ruler and subtracts the scroll.
  const trackH = (ti: number): number => {
    const t = stateRef.current.doc.tracks[ti];
    return t && collapsed.current.has(t.id) ? COLLAPSED_H : TRACK_H;
  };
  const trackContentTop = (ti: number): number => {
    let y = 0;
    for (let i = 0; i < ti; i++) y += trackH(i) + TRACK_GAP;
    return y;
  };
  const trackTop = (ti: number): number => RULER_H + trackContentTop(ti) - view.current.scrollY;
  const contentHeight = (): number => {
    // bottom of the last track — NOT trackContentTop(n), which adds a phantom
    // trailing gap and would let the view scroll one TRACK_GAP past the end.
    const n = stateRef.current.doc.tracks.length;
    return n > 0 ? trackContentTop(n - 1) + trackH(n - 1) : 0;
  };
  const viewportH = (): number => (wrapRef.current?.clientHeight ?? 0) - RULER_H;
  const maxScrollY = (): number => Math.max(0, contentHeight() - viewportH());
  const clampScrollY = () => {
    view.current.scrollY = Math.max(0, Math.min(view.current.scrollY, maxScrollY()));
  };
  const trackIdxAtY = (y: number): number => {
    if (y <= RULER_H) return -1;
    const cy = y - RULER_H + view.current.scrollY; // → content space
    let acc = 0;
    const n = stateRef.current.doc.tracks.length;
    for (let i = 0; i < n; i++) {
      const h = trackH(i);
      if (cy >= acc && cy < acc + h) return i;
      acc += h + TRACK_GAP;
    }
    return -1;
  };
  // Content-space insertion slot for a screen Y (used by reorder).
  const insertIdxAtY = (y: number): number => {
    const cy = y - RULER_H + view.current.scrollY;
    const tracks = stateRef.current.doc.tracks;
    let acc = 0;
    for (let i = 0; i < tracks.length; i++) {
      const h = trackH(i);
      if (cy < acc + h / 2) return i;
      acc += h + TRACK_GAP;
    }
    return tracks.length;
  };

  const snapCandidates = (excludeClipId: string | null): TimeUs[] => {
    const s = stateRef.current;
    const out: TimeUs[] = [0, s.playheadUs];
    for (const t of s.doc.tracks) {
      for (const c of t.clips) {
        if (c.id === excludeClipId) continue;
        out.push(c.startUs, c.startUs + c.durationUs);
      }
    }
    return out;
  };

  const snap = (us: TimeUs, exclude: string | null): { us: TimeUs; line: TimeUs | null } => {
    const thresholdUs = SNAP_PX / view.current.pxPerUs;
    let best: TimeUs | null = null;
    let bestDist = thresholdUs;
    for (const cand of snapCandidates(exclude)) {
      const d = Math.abs(cand - us);
      if (d < bestDist) {
        best = cand;
        bestDist = d;
      }
    }
    return best != null ? { us: best, line: best } : { us, line: null };
  };

  const hitTest = (
    x: number,
    y: number,
  ): { clip: Clip; trackIdx: number; zone: 'in' | 'out' | 'body' } | null => {
    if (x < HEADER_W) return null;
    const ti = trackIdxAtY(y);
    if (ti < 0) return null;
    const track = stateRef.current.doc.tracks[ti];
    for (const clip of track.clips) {
      const x0 = usToX(clip.startUs);
      const x1 = usToX(clip.startUs + clip.durationUs);
      if (x >= x0 && x <= x1) {
        if (x - x0 <= HANDLE_PX) return { clip, trackIdx: ti, zone: 'in' };
        if (x1 - x <= HANDLE_PX) return { clip, trackIdx: ti, zone: 'out' };
        return { clip, trackIdx: ti, zone: 'body' };
      }
    }
    return null;
  };

  // ------------------------------------------- asset drop (from AssetPanel)

  /** Where a dragged asset would land at (x, y): the lane under the cursor if
   *  its kind matches and the span is free, or a to-be-minted track when the
   *  cursor is below the lanes (or the project has none). null = nowhere. */
  const dropPlanAt = (a: DraggedAsset, x: number, y: number): typeof dropGhost.current => {
    if (x < HEADER_W || y <= RULER_H) return null;
    const durUs = a.durationUs > 0 ? a.durationUs : 3_000_000; // images: 3s
    const startUs = snap(xToUs(x), null).us;
    const kind = a.kind === 'audio' ? 'audio' : 'video';
    const ti = trackIdxAtY(y);
    if (ti >= 0) {
      const track = stateRef.current.doc.tracks[ti];
      const free =
        track.kind === kind &&
        !track.locked &&
        !track.clips.some((c) => startUs < c.startUs + c.durationUs && c.startUs < startUs + durUs);
      return { trackIdx: ti, startUs, durUs, ok: free };
    }
    // Below the last lane (or an empty project): offer a new matching track.
    const cy = y - RULER_H + view.current.scrollY;
    if (cy >= contentHeight()) return { trackIdx: stateRef.current.doc.tracks.length, startUs, durUs, ok: true, newTrack: true };
    return null; // the gap between lanes
  };

  /** Fit (contain) media into the canvas — a 4K clip on a 720p doc otherwise
   *  draws at native pixels (6× the canvas) and only its centre shows. ids are
   *  minted deterministically (<kind>_<nextId>), so the new clip scales in the
   *  SAME batch (one undo). */
  const fitCmds = (a: DraggedAsset, clipId: string) => {
    const doc = stateRef.current.doc;
    if (a.kind === 'audio' || !a.width || !a.height) return [];
    const scale = Math.min(doc.width / a.width, doc.height / a.height);
    if (Math.abs(scale - 1) < 0.001) return [];
    return [
      {
        type: 'setTransform' as const,
        clipId,
        transform: { x: 0, y: 0, scaleX: scale, scaleY: scale, rotation: 0, opacity: 1 },
      },
    ];
  };

  const commitDrop = (a: DraggedAsset, plan: NonNullable<typeof dropGhost.current>) => {
    const doc = stateRef.current.doc;
    const resp = plan.newTrack
      ? store.dispatch({
          type: 'batch',
          commands: [
            { type: 'addTrack', kind: a.kind === 'audio' ? 'audio' : 'video' },
            { type: 'addClip', trackId: `track_${doc.nextId}`, assetId: a.id, startUs: plan.startUs, durationUs: plan.durUs },
            ...fitCmds(a, `clip_${doc.nextId + 1}`),
          ],
        })
      : store.dispatch({
          type: 'batch',
          commands: [
            { type: 'addClip', trackId: doc.tracks[plan.trackIdx].id, assetId: a.id, startUs: plan.startUs, durationUs: plan.durUs },
            ...fitCmds(a, `clip_${doc.nextId}`),
          ],
        });
    if (resp.ok) {
      const ev = resp.events.find((e) => e.kind === 'clipAdded');
      if (ev && ev.kind === 'clipAdded') store.select(ev.clipId);
    }
  };

  // Decode one clip's source-window PCM into a peak envelope (abs-max per bin),
  // cache it, and redraw. Fire-and-forget; the canvas shows the clip flat until
  // the envelope lands, then fills in.
  const loadWave = (assetId: string, sourceInUs: number, spanUs: number, key: string) => {
    media
      .requestPcm(assetId, sourceInUs, spanUs)
      .then((pcm) => {
        const BINS = 800;
        const out = new Float32Array(BINS);
        if (pcm?.frames) {
          const ch = pcm.planes[0];
          const per = pcm.frames / BINS;
          for (let b = 0; b < BINS; b++) {
            let mx = 0;
            const s0 = Math.floor(b * per);
            const e0 = Math.min(pcm.frames, Math.floor((b + 1) * per));
            for (let i = s0; i < e0; i++) {
              const a = Math.abs(ch[i]);
              if (a > mx) mx = a;
            }
            out[b] = mx;
          }
        }
        waveCache.current.set(key, out);
        requestAnimationFrame(draw);
      })
      .catch(() => waveCache.current.set(key, new Float32Array(0)));
  };

  // ------------------------------------------------------------- draw

  const draw = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = stateRef.current;
    const g = gesture.current;
    clampScrollY();

    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, W, H);

    // ---- tracks (clipped to the lane area so scrolled content never bleeds
    //      over the ruler, which is drawn on top afterwards)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, W, H - RULER_H);
    ctx.clip();

    s.doc.tracks.forEach((track, ti) => {
      const y = trackTop(ti);
      const h = trackH(ti);
      // Cull off-screen tracks — but keep the SOURCE track of an in-flight move
      // alive, since its dragged clip's ghost is drawn at the (possibly on-screen)
      // destination lane, not at the source track's own rect.
      const ownsMoveGhost = g?.kind === 'move' && g.fromTrackIdx === ti;
      if (!ownsMoveGhost && (y + h <= RULER_H || y >= H)) return;
      const isCol = collapsed.current.has(track.id);
      const reordering = g?.kind === 'reorder' && g.trackId === track.id;
      // The whole picked-up track ghosts to 0.4 (header + lane + clips), set up
      // front so the header dims with its clips instead of staying solid.
      ctx.globalAlpha = reordering ? 0.4 : 1;
      // header
      ctx.fillStyle = '#1d2026';
      ctx.fillRect(0, y, HEADER_W - 6, h);
      ctx.textBaseline = 'top';
      // disclosure chevron (state indicator; double-click header to toggle)
      ctx.fillStyle = '#5b6372';
      ctx.font = '9px system-ui';
      ctx.fillText(isCol ? '▸' : '▾', 6, isCol ? y + (COLLAPSED_H - 9) / 2 : y + 9);
      // name
      ctx.save();
      ctx.beginPath();
      ctx.rect(18, y, HEADER_W - 6 - 18, h);
      ctx.clip();
      ctx.fillStyle = '#aeb6c4';
      ctx.font = '12px system-ui';
      ctx.fillText(track.name, 18, isCol ? y + (COLLAPSED_H - 12) / 2 : y + 6);
      ctx.restore();
      // kind + mute/lock status tags (only when expanded; no emoji clutter)
      if (!isCol) {
        let sx = 18;
        ctx.font = '10px system-ui';
        ctx.fillStyle = '#5b6372';
        ctx.fillText(track.kind, sx, y + 26);
        sx += ctx.measureText(track.kind).width + 7;
        if (track.muted) {
          ctx.fillStyle = '#e8a23f';
          ctx.fillText('muted', sx, y + 26);
          sx += ctx.measureText('muted').width + 7;
        }
        if (track.locked) {
          ctx.fillStyle = '#ffd24d';
          ctx.fillText('locked', sx, y + 26);
        }
      }
      // lane bg
      ctx.fillStyle = '#1a1d23';
      ctx.fillRect(HEADER_W, y, W - HEADER_W, h);

      for (const clip of track.clips) {
        // ghost replaces the live clip while dragging
        let startUs = clip.startUs;
        let durUs = clip.durationUs;
        let laneIdx = ti;
        let ghosted = false;
        if (g?.kind === 'move' && g.clipId === clip.id) {
          startUs = g.ghostStartUs;
          laneIdx = g.ghostTrackIdx;
          ghosted = true;
        } else if (g?.kind === 'trim' && g.clipId === clip.id) {
          if (g.edge === 'in') {
            const end = clip.startUs + clip.durationUs;
            startUs = Math.min(g.ghostToUs, end - MIN_CLIP_US);
            durUs = end - startUs;
          } else {
            durUs = Math.max(MIN_CLIP_US, g.ghostToUs - clip.startUs);
          }
          ghosted = true;
        }
        const laneH = trackH(laneIdx);
        const ly = trackTop(laneIdx);
        const laneCol = collapsed.current.has(s.doc.tracks[laneIdx]?.id);
        const x0 = usToX(startUs);
        const x1 = usToX(startUs + durUs);
        if (x1 < HEADER_W || x0 > W) continue;
        const [c0, c1] = TRACK_COLORS[track.kind] ?? TRACK_COLORS.video;
        const grad = ctx.createLinearGradient(0, ly, 0, ly + laneH);
        grad.addColorStop(0, c1);
        grad.addColorStop(1, c0);
        ctx.fillStyle = grad;
        ctx.globalAlpha = (reordering ? 0.4 : 1) * (ghosted ? 0.65 : 1);
        roundRect(ctx, Math.max(x0, HEADER_W), ly + 3, x1 - Math.max(x0, HEADER_W), laneH - 6, 5);
        ctx.fill();
        ctx.globalAlpha = reordering ? 0.4 : 1;

        if (s.selectedClipId === clip.id) {
          ctx.strokeStyle = '#ffd24d';
          ctx.lineWidth = 2;
          roundRect(ctx, Math.max(x0, HEADER_W), ly + 3, x1 - Math.max(x0, HEADER_W), laneH - 6, 5);
          ctx.stroke();
          ctx.lineWidth = 1;
        }

        // Collapsed lanes are an overview strip: skip handles/wave/label/ticks.
        if (laneCol) continue;

        // trim handles
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        if (x0 >= HEADER_W) ctx.fillRect(x0, ly + 3, HANDLE_PX, laneH - 6);
        ctx.fillRect(x1 - HANDLE_PX, ly + 3, HANDLE_PX, laneH - 6);

        // waveform for audio-bearing clips — lets the user eyeball the audio
        // structure (peaks, silence gaps) the agent reasons over and cuts on.
        const waAsset = clip.assetId ? s.doc.assets.find((a) => a.id === clip.assetId) : null;
        if (waAsset && (waAsset.kind === 'audio' || waAsset.hasAudio) && durUs > 0) {
          const spanUs = Math.round(clip.durationUs * (clip.speed ?? 1));
          const key = `${clip.assetId}:${clip.sourceInUs}:${spanUs}`;
          const peaks = waveCache.current.get(key);
          if (peaks === undefined) {
            waveCache.current.set(key, null);
            loadWave(clip.assetId!, clip.sourceInUs, spanUs, key);
          } else if (peaks && peaks.length) {
            drawWave(ctx, peaks, x0, x1, ly);
          }
        }

        // label — lead with the clip id in a chip so a "clip_322" the agent
        // mentions is findable on the timeline at a glance; asset name/text below.
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.max(x0, HEADER_W) + 4, ly, Math.max(0, x1 - Math.max(x0, HEADER_W) - 8), laneH);
        ctx.clip();
        ctx.textBaseline = 'top';
        const lx = Math.max(x0, HEADER_W) + 8;
        ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
        const idW = ctx.measureText(clip.id).width;
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        roundRect(ctx, lx - 3, ly + 5, idW + 6, 14, 4);
        ctx.fill();
        ctx.fillStyle = '#e6f0ff';
        ctx.fillText(clip.id, lx, ly + 7);
        const asset = clip.assetId ? s.doc.assets.find((a) => a.id === clip.assetId) : null;
        const sub = clip.text ? `T: ${clip.text.content}` : asset?.name ?? '';
        if (sub) {
          ctx.fillStyle = 'rgba(255,255,255,0.82)';
          ctx.font = '11px system-ui';
          ctx.fillText(sub, lx, ly + 23);
        }
        let mx = lx;
        ctx.font = '10px system-ui';
        if (clip.speed !== 1) {
          ctx.fillStyle = '#ffd24d';
          const t = `${clip.speed}x`;
          ctx.fillText(t, mx, ly + 40);
          mx += ctx.measureText(t).width + 8;
        }
        if (Object.keys(clip.keyframes).length > 0) {
          ctx.fillStyle = '#9ad0ff';
          ctx.fillText('◆ keyframes', mx, ly + 40);
        }
        ctx.restore();

        // Shot boundaries from the agent's observe(shots): map each source-µs cut
        // onto this clip's window so the human sees the cut structure the agent
        // reasons over. tl = clipStart + (srcCut - clipSourceIn) / speed.
        const sa = clip.assetId ? s.shots[clip.assetId] : undefined;
        if (sa && sa.shots.length > 1) {
          const speed = clip.speed ?? 1;
          // During an in-trim the engine shifts sourceIn by the dragged delta;
          // mirror that here so ticks stay put instead of sliding with the ghost.
          const srcStart =
            g?.kind === 'trim' && g.clipId === clip.id && g.edge === 'in'
              ? clip.sourceInUs + Math.round((startUs - clip.startUs) * speed)
              : clip.sourceInUs;
          const srcEnd = srcStart + durUs * speed;
          const laneL = Math.max(x0, HEADER_W);
          ctx.strokeStyle = '#39d6c8';
          ctx.lineWidth = 1;
          for (let k = 1; k < sa.shots.length; k++) {
            const src = sa.shots[k].startUs;
            if (src <= srcStart || src >= srcEnd) continue;
            const cx = usToX(startUs + (src - srcStart) / speed);
            if (cx < laneL || cx > x1) continue;
            ctx.beginPath();
            ctx.moveTo(cx, ly + 3);
            ctx.lineTo(cx, ly + 13);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    });

    // ---- asset drop ghost (drag from the AssetPanel): the would-be clip,
    //      blue on a valid lane/span, red where it can't land; a dashed lane
    //      hints the track that a below-the-lanes drop would mint.
    const dg = dropGhost.current;
    if (dg) {
      const gy = dg.newTrack
        ? RULER_H + contentHeight() - view.current.scrollY + (contentHeight() > 0 ? TRACK_GAP : 0)
        : trackTop(dg.trackIdx);
      const gh = dg.newTrack ? TRACK_H : trackH(dg.trackIdx);
      if (dg.newTrack) {
        ctx.fillStyle = 'rgba(127,180,255,0.07)';
        ctx.fillRect(HEADER_W, gy, W - HEADER_W, gh);
        ctx.strokeStyle = 'rgba(127,180,255,0.4)';
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(HEADER_W + 0.5, gy + 0.5, W - HEADER_W - 1, gh - 1);
        ctx.setLineDash([]);
        ctx.fillStyle = '#5b6372';
        ctx.font = '10px system-ui';
        ctx.fillText('new track', 18, gy + 6);
      }
      const gx0 = Math.max(usToX(dg.startUs), HEADER_W);
      const gx1 = usToX(dg.startUs + dg.durUs);
      if (gx1 > HEADER_W && gx0 < W) {
        ctx.fillStyle = dg.ok ? 'rgba(127,180,255,0.35)' : 'rgba(224,82,82,0.3)';
        roundRect(ctx, gx0, gy + 3, Math.max(2, gx1 - gx0), gh - 6, 5);
        ctx.fill();
        ctx.strokeStyle = dg.ok ? '#7fb4ff' : '#e05252';
        roundRect(ctx, gx0, gy + 3, Math.max(2, gx1 - gx0), gh - 6, 5);
        ctx.stroke();
      }
    }

    // ---- reorder insertion line
    if (g?.kind === 'reorder') {
      const y = trackTop(g.ghostIdx);
      ctx.strokeStyle = '#7fb4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y - TRACK_GAP / 2);
      ctx.lineTo(W, y - TRACK_GAP / 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.restore(); // end track clip region

    // ---- ruler (on top of the scrolling track area)
    ctx.fillStyle = '#1d2026';
    ctx.fillRect(0, 0, W, RULER_H);
    const pxPerSec = view.current.pxPerUs * 1e6;
    const stepSec = pxPerSec > 120 ? 0.5 : pxPerSec > 50 ? 1 : pxPerSec > 20 ? 2 : 5;
    const firstSec = Math.floor(view.current.scrollUs / 1e6 / stepSec) * stepSec;
    ctx.font = '10px system-ui';
    ctx.textBaseline = 'top';
    for (let sec = firstSec; ; sec += stepSec) {
      const x = usToX(sec * 1e6);
      if (x > W) break;
      if (x < HEADER_W) continue;
      ctx.strokeStyle = '#3a3f49';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 8);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillStyle = '#8b93a3';
      ctx.fillText(`${sec.toFixed(stepSec < 1 ? 1 : 0)}s`, x + 3, 4);
    }
    // header corner cap over the ruler row
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, HEADER_W - 6, RULER_H);

    // ---- vertical scrollbar (when content overflows)
    const ch = contentHeight();
    const vh = viewportH();
    if (ch > vh && vh > 0) {
      const trackArea = H - RULER_H;
      const barH = Math.max(24, (vh / ch) * trackArea);
      const barY = RULER_H + (view.current.scrollY / maxScrollY()) * (trackArea - barH);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      roundRect(ctx, W - 6, barY, 4, barH, 2);
      ctx.fill();
    }

    // ---- snap line
    const snapUs = g?.kind === 'move' ? g.snapLineUs : g?.kind === 'trim' ? g.snapLineUs : null;
    if (snapUs != null) {
      const x = usToX(snapUs);
      if (x >= HEADER_W) {
        // guard like the playhead: don't paint the guide over the header column
        ctx.strokeStyle = '#ffd24d';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- playhead
    const px = usToX(s.playheadUs);
    if (px >= HEADER_W) {
      ctx.strokeStyle = '#ff5c5c';
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = '#ff5c5c';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }
  };

  // ------------------------------------------------------- interaction

  const removeClip = (clipId: string) => {
    store.dispatch({ type: 'removeClip', clipId });
    if (stateRef.current.selectedClipId === clipId) store.select(null);
  };

  const toggleCollapse = (trackId: string) => {
    if (collapsed.current.has(trackId)) collapsed.current.delete(trackId);
    else collapsed.current.add(trackId);
    clampScrollY();
    draw();
  };

  useEffect(() => {
    const canvas = canvasRef.current!;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // right-click → contextmenu
      setMenu(null);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      canvas.setPointerCapture(e.pointerId);

      // header body below the ruler → drag to reorder the track
      if (y > RULER_H && x < HEADER_W) {
        const ti = trackIdxAtY(y);
        if (ti >= 0) {
          gesture.current = {
            kind: 'reorder',
            trackId: stateRef.current.doc.tracks[ti].id,
            fromIdx: ti,
            ghostIdx: ti,
          };
          canvas.style.cursor = 'grabbing';
        }
        draw();
        return;
      }

      // ruler scrub
      if (y <= RULER_H) {
        if (x >= HEADER_W) {
          gesture.current = { kind: 'scrub' };
          store.seek(xToUs(x));
        }
        draw();
        return;
      }

      // clips
      const hit = hitTest(x, y);
      if (!hit) {
        store.select(null);
        gesture.current = { kind: 'scrub' };
        store.seek(xToUs(x));
        draw();
        return;
      }
      store.select(hit.clip.id);
      const laneCol = collapsed.current.has(stateRef.current.doc.tracks[hit.trackIdx].id);
      if (hit.zone === 'body' || laneCol) {
        gesture.current = {
          kind: 'move',
          clipId: hit.clip.id,
          grabOffsetUs: xToUs(x) - hit.clip.startUs,
          fromTrackIdx: hit.trackIdx,
          ghostStartUs: hit.clip.startUs,
          ghostTrackIdx: hit.trackIdx,
          snapLineUs: null,
        };
      } else {
        gesture.current = {
          kind: 'trim',
          clipId: hit.clip.id,
          edge: hit.zone,
          ghostToUs: hit.zone === 'in' ? hit.clip.startUs : hit.clip.startUs + hit.clip.durationUs,
          snapLineUs: null,
        };
      }
      draw();
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const g = gesture.current;
      if (!g) {
        if (y > RULER_H && x < HEADER_W) {
          canvas.style.cursor = 'grab'; // header = reorder handle
          return;
        }
        const hit = hitTest(x, y);
        canvas.style.cursor =
          hit?.zone === 'in' || hit?.zone === 'out' ? 'ew-resize' : hit ? 'grab' : 'default';
        return;
      }
      if (g.kind === 'scrub') {
        store.seek(xToUs(x));
        return;
      }
      if (g.kind === 'reorder') {
        g.ghostIdx = insertIdxAtY(y);
        draw();
        return;
      }
      if (g.kind === 'move') {
        const raw = Math.max(0, xToUs(x) - g.grabOffsetUs);
        const snapped = snap(raw, g.clipId);
        g.ghostStartUs = snapped.us;
        g.snapLineUs = snapped.line;
        const ti = trackIdxAtY(y);
        const s = stateRef.current;
        if (ti >= 0) {
          const from = s.doc.tracks[g.fromTrackIdx];
          const to = s.doc.tracks[ti];
          if (to.kind === from.kind && !to.locked) g.ghostTrackIdx = ti;
        }
        draw();
        return;
      }
      if (g.kind === 'trim') {
        const snapped = snap(xToUs(x), g.clipId);
        // Clamp to the MIN_CLIP_US floor here (not just in draw()), so the
        // committed toUs on pointerup matches the preview — otherwise a sliver
        // below the floor gets committed while the ghost froze at the floor.
        const clip = stateRef.current.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === g.clipId);
        let to = snapped.us;
        if (clip) {
          to =
            g.edge === 'in'
              ? Math.min(to, clip.startUs + clip.durationUs - MIN_CLIP_US)
              : Math.max(to, clip.startUs + MIN_CLIP_US);
        }
        g.ghostToUs = to;
        g.snapLineUs = to === snapped.us ? snapped.line : null;
        draw();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = 'default';
      if (!g || g.kind === 'scrub') {
        draw();
        return;
      }
      const s = stateRef.current;
      if (g.kind === 'reorder') {
        // ghostIdx is an insertion slot in the ORIGINAL array; account for the
        // removed source when it lands after its old position.
        let to = g.ghostIdx;
        if (to > g.fromIdx) to -= 1;
        if (to !== g.fromIdx) store.dispatch({ type: 'moveTrack', trackId: g.trackId, toIndex: to });
      } else if (g.kind === 'move') {
        const fromTrack = s.doc.tracks[g.fromTrackIdx];
        const toTrack = s.doc.tracks[g.ghostTrackIdx];
        const clip = fromTrack?.clips.find((c) => c.id === g.clipId);
        if (clip && (clip.startUs !== g.ghostStartUs || g.ghostTrackIdx !== g.fromTrackIdx)) {
          store.dispatch({
            type: 'moveClip',
            clipId: g.clipId,
            trackId: g.ghostTrackIdx !== g.fromTrackIdx ? toTrack.id : undefined,
            startUs: g.ghostStartUs,
          });
        }
      } else if (g.kind === 'trim') {
        store.dispatch({ type: 'trimClip', clipId: g.clipId, edge: g.edge, toUs: g.ghostToUs });
      }
      draw();
    };

    const onDblClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x >= HEADER_W || y <= RULER_H) return;
      const ti = trackIdxAtY(y);
      if (ti >= 0) toggleCollapse(stateRef.current.doc.tracks[ti].id);
    };

    const onContextMenu = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // A right-click mid-drag cancels the gesture (the pending pointerup then
      // commits nothing) instead of leaving move/trim/reorder armed under the menu.
      if (gesture.current) {
        gesture.current = null;
        canvas.style.cursor = 'default';
        e.preventDefault();
        draw();
        return;
      }
      if (y <= RULER_H) return; // ruler keeps the native menu
      const hit = hitTest(x, y);
      if (hit) {
        e.preventDefault();
        store.select(hit.clip.id);
        setMenu({ x: e.clientX, y: e.clientY, kind: 'clip', clipId: hit.clip.id });
        return;
      }
      const ti = trackIdxAtY(y);
      if (ti >= 0) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, kind: 'track', trackId: stateRef.current.doc.tracks[ti].id });
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setMenu(null);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.ctrlKey || e.metaKey) {
        // zoom time around the cursor
        const anchorUs = xToUs(x);
        const factor = Math.exp(-e.deltaY * 0.0045);
        const next = Math.min(2000 / 1e6, Math.max(5 / 1e6, view.current.pxPerUs * factor));
        view.current.pxPerUs = next;
        view.current.scrollUs = Math.max(0, anchorUs - (x - HEADER_W) / next);
      } else if (e.shiftKey) {
        // horizontal scroll (mouse-wheel users)
        view.current.scrollUs = Math.max(0, view.current.scrollUs + e.deltaY / view.current.pxPerUs);
      } else {
        // vertical scroll (tracks) + any trackpad horizontal delta
        view.current.scrollY += e.deltaY;
        clampScrollY();
        if (e.deltaX) view.current.scrollUs = Math.max(0, view.current.scrollUs + e.deltaX / view.current.pxPerUs);
      }
      draw();
    };

    // Asset drag from the AssetPanel: ghost the landing spot during dragover,
    // place on drop. preventDefault on dragover is what makes the canvas a
    // legal drop target.
    const onDragOver = (e: DragEvent) => {
      const a = draggedAsset();
      if (!a) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const plan = dropPlanAt(a, e.clientX - rect.left, e.clientY - rect.top);
      if (e.dataTransfer) e.dataTransfer.dropEffect = plan?.ok ? 'copy' : 'none';
      dropGhost.current = plan;
      draw();
    };
    const onDragLeave = () => {
      if (!dropGhost.current) return;
      dropGhost.current = null;
      draw();
    };
    const onDrop = (e: DragEvent) => {
      const a = draggedAsset();
      const plan = dropGhost.current;
      dropGhost.current = null;
      if (!a) return;
      e.preventDefault();
      if (plan?.ok) commitDrop(a, plan);
      draw();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dragover', onDragOver);
    canvas.addEventListener('dragleave', onDragLeave);
    canvas.addEventListener('drop', onDrop);
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrapRef.current!);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dragover', onDragOver);
      canvas.removeEventListener('dragleave', onDragLeave);
      canvas.removeEventListener('drop', onDrop);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // redraw on every store change
  useEffect(() => {
    draw();
  });

  // Keep the right-click menu inside the viewport (the panel sits at the bottom,
  // so a tall track menu opened low would spill off-screen). Runs pre-paint, so
  // the clamp is applied before the menu is visible.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    el.style.left = `${Math.max(pad, Math.min(menu.x, window.innerWidth - r.width - pad))}px`;
    el.style.top = `${Math.max(pad, Math.min(menu.y, window.innerHeight - r.height - pad))}px`;
  }, [menu]);

  // ----- right-click menu (clip or track) -------------------------------

  const menuClip = menu?.kind === 'clip'
    ? state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === menu.clipId)
    : null;
  const canSplit = !!(
    menuClip &&
    state.playheadUs > menuClip.startUs &&
    state.playheadUs < menuClip.startUs + menuClip.durationUs
  );
  const menuTrack = menu?.kind === 'track' ? state.doc.tracks.find((t) => t.id === menu.trackId) : null;
  const menuTrackIdx = menuTrack ? state.doc.tracks.indexOf(menuTrack) : -1;

  const moveTrack = (to: number) => {
    if (menu?.kind === 'track') store.dispatch({ type: 'moveTrack', trackId: menu.trackId, toIndex: to });
    setMenu(null);
  };

  return (
    <div className="timeline-panel" ref={wrapRef} style={height ? { height } : undefined}>
      <canvas ref={canvasRef} />
      {menu && (
        <>
          <div className="ctx-scrim" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
            {menu.kind === 'clip' && (
              <>
                <button
                  disabled={!canSplit}
                  onClick={() => {
                    if (canSplit) store.dispatch({ type: 'splitClip', clipId: menu.clipId, atUs: state.playheadUs });
                    setMenu(null);
                  }}
                >
                  ✂ Split at Playhead
                </button>
                <button
                  onClick={() => {
                    referenceToAgent({ id: menu.clipId });
                    setMenu(null);
                  }}
                >
                  ＠ Reference in Agent Chat
                </button>
                <button
                  className="ctx-danger"
                  onClick={() => {
                    removeClip(menu.clipId);
                    setMenu(null);
                  }}
                >
                  🗑 Delete Clip
                </button>
              </>
            )}
            {menu.kind === 'track' && menuTrack && (
              <>
                <button onClick={() => { store.dispatch({ type: 'setTrackMuted', trackId: menuTrack.id, muted: !menuTrack.muted }); setMenu(null); }}>
                  {menuTrack.muted ? 'Unmute' : 'Mute'}
                </button>
                <button onClick={() => { store.dispatch({ type: 'setTrackLocked', trackId: menuTrack.id, locked: !menuTrack.locked }); setMenu(null); }}>
                  {menuTrack.locked ? 'Unlock' : 'Lock'}
                </button>
                <button onClick={() => { toggleCollapse(menuTrack.id); setMenu(null); }}>
                  {collapsed.current.has(menuTrack.id) ? 'Expand Track' : 'Collapse Track'}
                </button>
                <div className="ctx-sep" />
                <button disabled={menuTrackIdx <= 0} onClick={() => moveTrack(menuTrackIdx - 1)}>
                  ↑ Move Up
                </button>
                <button disabled={menuTrackIdx < 0 || menuTrackIdx >= state.doc.tracks.length - 1} onClick={() => moveTrack(menuTrackIdx + 1)}>
                  ↓ Move Down
                </button>
                <div className="ctx-sep" />
                <button
                  className="ctx-danger"
                  onClick={() => {
                    const n = menuTrack.clips.length;
                    if (n === 0 || window.confirm(`Delete track "${menuTrack.name}" and its ${n} clip(s)?`)) {
                      collapsed.current.delete(menuTrack.id);
                      store.dispatch({ type: 'removeTrack', trackId: menuTrack.id });
                    }
                    setMenu(null);
                  }}
                >
                  🗑 Delete Track
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw a peak-envelope waveform across a clip's rect [x0,x1] (the full clip,
 *  even if x0 is scrolled left of the header — drawing is clipped to the visible
 *  lane). Symmetric fill around the lane's vertical centre. */
function drawWave(ctx: CanvasRenderingContext2D, peaks: Float32Array, x0: number, x1: number, ly: number) {
  const clipL = Math.max(x0, HEADER_W);
  const w = x1 - x0;
  if (x1 - clipL < 2 || w < 2) return;
  const midY = ly + TRACK_H / 2;
  const amp = (TRACK_H - 16) / 2;
  const n = peaks.length;
  const at = (px: number) => peaks[Math.max(0, Math.min(n - 1, Math.floor(((px - x0) / w) * n)))];
  ctx.save();
  ctx.beginPath();
  ctx.rect(clipL, ly + 3, x1 - clipL, TRACK_H - 6);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  for (let px = clipL; px <= x1; px++) {
    const y = midY - at(px) * amp;
    if (px === clipL) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  for (let px = x1; px >= clipL; px--) ctx.lineTo(px, midY + at(px) * amp);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
