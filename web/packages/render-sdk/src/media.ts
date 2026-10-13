// services/media.ts — main-thread media library, backed by a decode worker.
//
// Topology (everything heavy lives in media.worker.ts):
//   File ──postMessage──▶ worker: streamed mp4box demux → EncodedVideoChunk
//   table → WebCodecs VideoDecoder ──VideoFrame transfer──▶ here.
//
// This side keeps only a small presentation window of decoded frames per
// asset. frameFor() is synchronous for the render loop: it returns the best
// frame ≤ target from the window and (fire-and-forget) steers the worker
// toward the new target. `version` bumps on every frame arrival so the
// playback loop knows a repaint is worthwhile while paused.

import { mediaTasks, type MediaTaskScheduler, type MediaTaskKind } from './media-scheduler.ts';
import { Muxer, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import type { MainToWorker, ProbeResult, WorkerToMain } from './media.worker.ts';

export type ProbedMedia = ProbeResult;
interface Pending<T> { resolve: (value: T) => void; reject: (error: Error) => void }
export interface SnapshotRenderer {
  render(index: number): VideoFrame;
  width: number; height: number; frameDurUs: number; frameCount: number;
  dispose?(): void;
}
export interface MediaSnapshot {
  open(signal?: AbortSignal): Promise<MediaLibrary>;
  dispose(): void;
}
export interface MediaRequestOptions { signal?: AbortSignal; priority?: MediaTaskKind }


/** One decoded PCM window (planar float32). */
export interface PcmChunk {
  sampleRate: number;
  channels: number;
  startUs: number;
  frames: number;
  planes: Float32Array<ArrayBuffer>[];
}

/** Imported audio is decoded once and stored as planar f32 in OPFS (not kept
 *  resident as an AudioBuffer); requestPcm then reads windows off disk. File
 *  layout: [magic, sampleRate, channels, frames] uint32 header, then each
 *  channel's frames×f32 back-to-back. */
const PCM_MAGIC = 0x56504331; // 'VPC1'
const PCM_HEADER = 16;
interface PcmMeta {
  sampleRate: number;
  channels: number;
  frames: number;
  handle: FileSystemFileHandle;
}
async function pcmDir(scope?: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(scope ? `pcm-${scope}` : 'pcm', { create: true });
}

/** Low-res preview proxies (transcoded once, decoded cheaply for preview). */
const PROXY_MAX_DIM = 1280; // downscale anything larger than this for preview
async function proxyDir(scope?: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(scope ? `proxy-${scope}` : 'proxy', { create: true });
}
async function pickAvc(width: number, height: number, framerate: number): Promise<string> {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42E01F']) {
    if ((await VideoEncoder.isConfigSupported({ codec, width, height, framerate })).supported) return codec;
  }
  return 'avc1.42E01F';
}

/** Keep at most this many decoded frames per asset on the main thread. */
const WINDOW_CAP = 24;
/** Drop frames this far ahead of the target (µs) — stale after a back-seek. */
const KEEP_AHEAD_US = 1_200_000;

interface WindowFrame {
  frame: VideoFrame;
  timestampUs: number;
  durationUs: number;
}

export class RemoteVideoSource {
  /** Presentation window, sorted by timestamp ascending. */
  private frames: WindowFrame[] = [];
  lastAccess = 0;
  private lastPostedUs = NaN;
  private lastPostedPlaying = false;
  private evictedFromUs = Infinity;
  private evictedUntilUs = -Infinity;

  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
  readonly hasAudio: boolean;
  readonly tracks: ProbeResult['tracks'];

  constructor(
    readonly workerId: number,
    probe: ProbeResult,
    private post: (msg: MainToWorker) => void,
  ) {
    this.durationUs = probe.durationUs;
    this.width = probe.width;
    this.height = probe.height;
    this.hasAudio = probe.hasAudio;
    this.tracks = probe.tracks;
  }

  probe(): ProbedMedia {
    return {
      durationUs: this.durationUs,
      width: this.width,
      height: this.height,
      hasAudio: this.hasAudio,
      tracks: structuredClone(this.tracks),
    };
  }

  /** Called by the library when the worker transfers a frame over. */
  receive(frame: VideoFrame, timestampUs: number, durationUs: number) {
    // Re-decodes after seeks resend timestamps we may already hold.
    const existing = this.frames.findIndex((f) => f.timestampUs === timestampUs);
    if (existing >= 0) {
      this.frames[existing].frame.close();
      this.frames[existing] = { frame, timestampUs, durationUs };
      return;
    }
    this.frames.push({ frame, timestampUs, durationUs });
    this.frames.sort((a, b) => a.timestampUs - b.timestampUs);
    while (this.frames.length > WINDOW_CAP) this.frames.shift()!.frame.close();
  }

  /** Synchronous best-effort access for the render loop. */
  requestFrame(targetUs: number, playing: boolean): VideoFrame | null {
    this.lastAccess = performance.now();
    if (targetUs !== this.lastPostedUs || playing !== this.lastPostedPlaying) {
      this.lastPostedUs = targetUs;
      this.lastPostedPlaying = playing;
      const covered=this.frames.some(item=>item.timestampUs<=targetUs && item.timestampUs+item.durationUs>targetUs);
      const refresh=!covered && targetUs>=this.evictedFromUs && targetUs<this.evictedUntilUs;
      if(refresh){this.evictedFromUs=Infinity;this.evictedUntilUs=-Infinity;}
      this.post({ type: 'target', id: this.workerId, timeUs: targetUs, playing, refresh });
    }

    // The best frame is the newest one at or before the target. Evict only
    // frames it supersedes (older than it) and stale look-ahead — never the
    // best itself, even when it lags the target: during a long-GOP catch-up
    // it is the only thing standing between the user and a black canvas.
    let bestIdx = -1;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].timestampUs <= targetUs) bestIdx = i; // sorted asc
      else break;
    }
    this.frames = this.frames.filter((f, i) => {
      const stale = i < bestIdx || f.timestampUs > targetUs + KEEP_AHEAD_US;
      if (stale) f.frame.close();
      return !stale;
    });
    while (this.frames.length > WINDOW_CAP) {
      // Sorted ascending with the best now at the front; trim look-ahead.
      this.frames.pop()!.frame.close();
    }

    const best = this.frames[0]?.timestampUs <= targetUs ? this.frames[0] : null;
    // Fallback: nearest frame after target (better than black).
    return (best ?? this.frames[0])?.frame ?? null;
  }

  /** Best currently-decoded frame WITHOUT steering the decoder — used to
   *  freeze an asset's preview while something else (a proxy build) needs the
   *  hardware decoder exclusively. */
  peekFrame(): VideoFrame | null {
    return this.frames[this.frames.length - 1]?.frame ?? this.frames[0]?.frame ?? null;
  }

  keepLastFrame() { while (this.frames.length > 1) this.frames.shift()!.frame.close(); }
  cacheState() { return {targetUs:this.lastPostedUs,frames:this.frames.map(item=>({timeUs:item.timestampUs,durationUs:item.durationUs}))}; }
  get cachedFrames() { return this.frames.length; }
  get cacheBytes() { return this.frames.length * this.width * this.height * 4; }
  evictFrame() {
    if(!this.frames.length)return;
    // Retain the frame nearest the current target while trimming look-ahead.
    let best=0;
    for(let i=0;i<this.frames.length;i++)if(this.frames[i].timestampUs<=this.lastPostedUs)best=i;
    const index=best>0?0:this.frames.length-1;
    const [item]=this.frames.splice(index,1);
    this.evictedFromUs=Math.min(this.evictedFromUs,item.timestampUs);
    this.evictedUntilUs=Math.max(this.evictedUntilUs,item.timestampUs+item.durationUs);
    item.frame.close();
    if(!this.frames.length)this.lastPostedUs=NaN;
  }
  disposeFrames() {
    this.lastPostedUs = NaN;
    for (const f of this.frames) f.frame.close();
    this.frames = [];
  }
}

// ---------------------------------------------------------------- library

/** Maps assetId → live media source. The document stores only asset
 *  metadata + src locator; decoders and frames live in the worker and the
 *  per-asset presentation windows here. */
export class MediaLibrary {
  private worker: Worker;
  private lifetime = new AbortController();
  private requestPrefix = crypto.randomUUID();
  readonly scheduler: MediaTaskScheduler;
  private priority: MediaTaskKind;
  private cacheBudget: number;
  private proxyJobs = new Map<string, Promise<void>>();
  private requestTimeoutMs: number;
  private ownedRenderers: Array<() => void> = [];
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (s: RemoteVideoSource) => void; reject: (e: Error) => void }
  >();
  private byWorkerId = new Map<number, RemoteVideoSource>();
  private videoSources = new Map<string, RemoteVideoSource>();
  /** Low-res preview proxies (decoded for frameFor; exactFrame uses original). */
  private proxySources = new Map<string, RemoteVideoSource>();
  private proxyBuilding = new Set<string>();
  /** Dedicated second decoders for the transition OUTGOING side (see frameForFrom). */
  private fromSources = new Map<string, RemoteVideoSource>();
  private fromOpening = new Set<string>();
  /** Dedicated FULL-RES second decoders for the transition outgoing side during
   *  export (frame-exact, unlike the proxy-based fromSources). */
  private exactFromSources = new Map<string, RemoteVideoSource>();
  private exactFromOpening = new Map<string, Promise<RemoteVideoSource | null>>();
  /** Retained original File per video asset, so the outgoing side can open a
   *  dedicated second decoder even when no proxy exists. A File is a cheap OS
   *  handle (not the bytes), so holding one per asset is inexpensive. */
  private originalFiles = new Map<string, File>();
  private imageFrames = new Map<string, VideoFrame>();
  /** Procedural "motion" assets (velocut.motionClip): a 2D-canvas animation
   *  whose frames are rendered ON DEMAND from a stored draw program (a GSAP-
   *  seeked timeline + a canvas draw), never buffered. Like the text clip, the
   *  SPEC is kept and rasterized per frame — so a long clip costs ~one resident
   *  frame and export re-renders deterministically (no 36k-VideoFrame blowup).
   *  `render(index)` draws frame `index` (0-based) and returns a FRESH VideoFrame;
   *  preview caches the last one (closed when the index changes), export takes a
   *  fresh frame each call (the exporter owns + closes it). */
  private motionSources = new Map<
    string,
    {
      render: (index: number) => VideoFrame;
      width: number;
      height: number;
      frameDurUs: number;
      frameCount: number;
      preview?: { index: number; frame: VideoFrame };
    }
  >();
  /** Fully-decoded PCM for imported audio files (music): one AudioBuffer per
   *  asset, sliced on demand. Memory is one decode per track — fine for
   *  editing-length music; long stems would warrant a streaming path. */
  /** OPFS-backed imported audio (windowed reads, not resident). */
  private pcm = new Map<string, PcmMeta>();
  /** Fallback when OPFS is unavailable / a write fails — kept resident. */
  private audioBuffers = new Map<string, AudioBuffer>();
  private decodeCtx: AudioContext | null = null;
  private playing = false;
  private nextPcmReq = 1;
  private pendingPcm = new Map<
    number,
    { resolve: (c: PcmChunk) => void; reject: (e: Error) => void }
  >();
  private nextFrameReq = 1;
  private pendingFrame = new Map<number, Pending<VideoFrame | null>>();
  private pendingStream = new Map<number, Pending<{ frame: VideoFrame; cts: number } | null>>();

  /** Bumped on every decoded-frame arrival; the playback loop repaints while
   *  paused only when this (or the document) changed. */
  version = 0;

  constructor(
    /** Project id scoping the OPFS pcm/proxy caches (asset ids are only unique
     *  per project). Omitted = the legacy unscoped directories. */
    private storageScope?: string,
    options: { workerUrl?: string | URL; scheduler?: MediaTaskScheduler; priority?: MediaTaskKind; frameCacheBytes?: number; requestTimeoutMs?: number } = {},
  ) {
    this.scheduler = options.scheduler ?? mediaTasks;
    this.priority = options.priority ?? 'observe';
    this.cacheBudget = options.frameCacheBytes ?? 128 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!(this.cacheBudget > 0) || !(this.requestTimeoutMs > 0)) throw Error('Invalid media resource budget');
    this.worker = options.workerUrl ? new Worker(options.workerUrl, { type: 'module' }) : new Worker(new URL('./media.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.onMessage(e.data);
    this.worker.onerror = () => this.dispose();
    this.worker.onmessageerror = () => this.dispose();
  }

  private post = (msg: MainToWorker) => {
    this.lifetime.signal.throwIfAborted();
    this.worker.postMessage(msg);
  };

  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }

  private request<T>(map: Map<number, Pending<T>>, id: number, msg: MainToWorker, signal: AbortSignal, cancel?: () => void): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); map.delete(id); };
      const abort = () => { if (cancel) { cancel(); finish(); reject(signal.reason); } };
      const timer = setTimeout(() => {
        // Terminating the worker is the only reliable way to release a wedged codec.
        const error = Error('Media worker request timed out');
        finish(); reject(error); this.dispose();
      }, this.requestTimeoutMs);
      map.set(id,{resolve:value=>{finish();resolve(value);},reject:error=>{finish();reject(error);}});
      signal.addEventListener('abort', abort, {once:true});
      try { this.post(msg); } catch(error) { finish(); reject(error); }
    });
  }

  diagnostics(detail = false) {
    return { frameCacheBytes: [...this.byWorkerId.values()].reduce((n,s)=>n+s.cacheBytes,0),
      frameCacheBudget: this.cacheBudget, pendingRequests: this.pending.size + this.pendingPcm.size + this.pendingFrame.size + this.pendingStream.size,
      ...(detail ? {sourceCaches:[...this.byWorkerId].slice(0,32).map(([id,source])=>({id,...source.cacheState()}))} : {}),
      sources: this.byWorkerId.size, proxyJobs: this.proxyJobs.size, scheduling: this.scheduler.snapshot() };
  }

  private trimFrameCache() {
    const sources=[...this.byWorkerId.values()].sort((a,b)=>a.lastAccess-b.lastAccess);
    let bytes=sources.reduce((n,s)=>n+s.cacheBytes,0),count=sources.reduce((n,s)=>n+s.cachedFrames,0);
    // First trim look-ahead fairly: retain one frame per source when possible.
    for(const minimum of [1,0])for(const source of sources){
      while(bytes>this.cacheBudget && source.cachedFrames>minimum && count>1){
        const before=source.cacheBytes;source.evictFrame();bytes-=before-source.cacheBytes;count--;
      }
    }
  }

  private onMessage(msg: WorkerToMain) {
    if (this.lifetime.signal.aborted) {
      if ('frame' in msg) msg.frame?.close();
      return;
    }
    switch (msg.type) {
      case 'ready': {
        if (!this.pending.has(msg.id)) { this.post({ type: 'dispose', id: msg.id }); break; }
        const source = new RemoteVideoSource(msg.id, msg.probe, this.post);
        this.byWorkerId.set(msg.id, source);
        this.pending.get(msg.id)?.resolve(source);
        this.pending.delete(msg.id);
        break;
      }
      case 'openError':
        this.pending.get(msg.id)?.reject(new Error(msg.message));
        this.pending.delete(msg.id);
        break;
      case 'frame': {
        const source = this.byWorkerId.get(msg.id);
        if (!source) {
          msg.frame.close();
          return;
        }
        source.receive(msg.frame, msg.timestampUs, msg.durationUs);
        this.trimFrameCache();
        this.version++;
        break;
      }
      case 'pcm': {
        const pending = this.pendingPcm.get(msg.reqId);
        this.pendingPcm.delete(msg.reqId);
        pending?.resolve({
          sampleRate: msg.sampleRate,
          channels: msg.channels,
          startUs: msg.startUs,
          frames: msg.frames,
          planes: msg.planes.map((b) => new Float32Array(b)),
        });
        break;
      }
      case 'pcmError': {
        const pending = this.pendingPcm.get(msg.reqId);
        this.pendingPcm.delete(msg.reqId);
        pending?.reject(new Error(msg.message));
        break;
      }
      case 'exportFrame': {
        const resolve = this.pendingFrame.get(msg.reqId);
        this.pendingFrame.delete(msg.reqId);
        if (resolve) resolve.resolve(msg.frame); else msg.frame?.close();
        break;
      }
      case 'frameError': {
        const pending = this.pendingFrame.get(msg.reqId) ?? this.pendingStream.get(msg.reqId);
        pending?.reject(new Error(msg.message));
        break;
      }
      case 'streamFrame': {
        const resolve = this.pendingStream.get(msg.reqId);
        this.pendingStream.delete(msg.reqId);
        if (resolve) resolve.resolve(msg.frame ? { frame: msg.frame, cts: msg.cts } : null); else msg.frame?.close();
        break;
      }
    }
  }

  /** Capture immutable source identities now; allocate export workers/renderers
   * only when open() is admitted by the scheduler. Live renderer closures are
   * deliberately never reused: callers must compile procedural assets from the
   * captured document through an explicit factory. */
  capture(assetIds: string[], renderers = new Map<string, () => Promise<SnapshotRenderer>>()): MediaSnapshot {
    this.lifetime.signal.throwIfAborted();
    const captured: Array<{id:string;video?:File;image?:VideoFrame;pcm?:PcmMeta;pcmFile?:Promise<File>;audio?:AudioBuffer;renderer?:()=>Promise<SnapshotRenderer>}> = [];
    let disposed = false;
    const release = () => { if(disposed)return;disposed=true;for(const item of captured)item.image?.close(); };
    try {
      for (const id of new Set(assetIds)) {
        const video = this.originalFiles.get(id), image = this.imageFrames.get(id), pcm = this.pcm.get(id), audio = this.audioBuffers.get(id), renderer = renderers.get(id);
        if (renderer) captured.push({id,renderer});
        else if (video) captured.push({id,video});
        else if (image) captured.push({id,image:image.clone()});
        else if (pcm) {
          const pcmFile=pcm.handle.getFile();void pcmFile.catch(()=>{});
          captured.push({id,pcm:{...pcm},pcmFile});
        } else if (audio) {
          const copy=new AudioBuffer({length:audio.length,numberOfChannels:audio.numberOfChannels,sampleRate:audio.sampleRate});
          for(let ch=0;ch<audio.numberOfChannels;ch++)copy.copyToChannel(audio.getChannelData(ch),ch);
          captured.push({id,audio:copy});
        } else throw Error(`Cannot snapshot missing or unsupported media: ${id}`);
      }
    } catch(error) { release();throw error; }
    return {
      dispose: release,
      open: async signal => {
        if (disposed) throw Error('Media snapshot was released');
        signal?.throwIfAborted();
        const copy=new MediaLibrary(this.storageScope,{scheduler:this.scheduler,priority:'export',frameCacheBytes:this.cacheBudget,requestTimeoutMs:this.requestTimeoutMs});
        const abort=()=>copy.dispose();signal?.addEventListener('abort',abort,{once:true});
        try {
          for (const item of captured) {
            signal?.throwIfAborted();
            if (disposed) throw Error('Media snapshot was released');
            if(item.video)copy.attachVideo(item.id,await copy.probeVideo(item.video),item.video);
            else if(item.image)copy.attachImage(item.id,item.image.clone());
            else if(item.pcm) {
              const file=await item.pcmFile!;
              copy.pcm.set(item.id,{...item.pcm,handle:{getFile:async()=>file} as FileSystemFileHandle});
            } else if(item.audio)copy.audioBuffers.set(item.id,item.audio);
            else if(item.renderer) {
              const renderer=await item.renderer();
              if(signal?.aborted){renderer.dispose?.();signal.throwIfAborted();}
              copy.ownedRenderers.push(()=>renderer.dispose?.());
              copy.attachMotion(item.id,renderer.render,renderer);
            }
          }
          signal?.throwIfAborted();
          if(disposed)throw Error('Media snapshot was released');
          return copy;
        } catch(error) { copy.dispose();throw error; }
        finally { signal?.removeEventListener('abort',abort); }
      },
    };
  }

  /** Frame-exact decode for export (resolves the exact frame at sourceTimeUs). */
  exactFrame(assetId: string, sourceTimeUs: number, options: MediaRequestOptions = {}): Promise<VideoFrame | null> {
    return this.scheduler.run(options.priority ?? this.priority, signal => this.readExactFrame(assetId, sourceTimeUs, signal), {
      lane:'codec', key:`${this.requestPrefix}:exact:${assetId}`, signal:this.signal(options.signal), onDiscard:frame=>frame?.close(),
    });
  }

  private readExactFrame(assetId: string, sourceTimeUs: number, signal: AbortSignal): Promise<VideoFrame | null> {
    const video = this.videoSources.get(assetId);
    if (!video) {
      const motion = this.motionSources.get(assetId);
      // Export owns + closes the returned frame, so hand back a FRESH render
      // (not the preview cache) every call — deterministic at the frame index.
      if (motion) return Promise.resolve(motion.render(this.motionIndex(motion, sourceTimeUs)));
      // Same ownership contract: the caller closes what exactFrame returns, so
      // hand out a clone — closing the library-resident frame would blank every
      // future preview/export of this asset until the page reloads.
      const img = this.imageFrames.get(assetId);
      return Promise.resolve(img ? img.clone() : null);
    }
    const reqId = this.nextFrameReq++;
    return this.request(this.pendingFrame, reqId, {type:'frameAt',id:video.workerId,reqId,timeUs:sourceTimeUs}, signal,
      () => { if (!this.lifetime.signal.aborted) this.post({type:'releaseDecoders',id:video.workerId}); });
  }

  /** Frame-exact decode for a transition's OUTGOING ("from") side during export.
   *  Same problem as the preview {@link frameForFrom}: a same-asset transition
   *  needs two far-apart source positions per frame, and one decoder seeking
   *  between them every frame thrashes (export crawls). So the outgoing side gets
   *  its OWN dedicated full-res decoder; each side then advances ~1 frame forward
   *  with no long seek. Falls back to the shared exact decoder if no original is
   *  retained. Call {@link releaseExactFromDecoders} when the export ends. */
  exactFrameFrom(assetId: string, sourceTimeUs: number, options: MediaRequestOptions = {}): Promise<VideoFrame | null> {
    return this.scheduler.run(options.priority ?? this.priority, signal => this.readExactFrameFrom(assetId, sourceTimeUs, signal), {
      lane:'codec', key:`${this.requestPrefix}:exact-from:${assetId}`, signal:this.signal(options.signal), onDiscard:frame=>frame?.close(),
    });
  }
  private async readExactFrameFrom(assetId: string, sourceTimeUs: number, signal: AbortSignal): Promise<VideoFrame | null> {
    let src = this.exactFromSources.get(assetId);
    if (!src) {
      const file = this.originalFiles.get(assetId);
      if (!file) return this.readExactFrame(assetId, sourceTimeUs, signal);
      let opening = this.exactFromOpening.get(assetId);
      if (!opening) {
        opening = this.probeVideo(file).then(
          (s) => (this.exactFromSources.set(assetId, s), s),
          () => null,
        );
        this.exactFromOpening.set(assetId, opening);
      }
      const opened = await opening;
      if (!opened) return this.readExactFrame(assetId, sourceTimeUs, signal);
      src = opened;
    }
    const reqId = this.nextFrameReq++;
    signal.throwIfAborted();
    const id=src.workerId;
    return this.request(this.pendingFrame, reqId, {type:'frameAt',id,reqId,timeUs:sourceTimeUs}, signal,
      () => { if (!this.lifetime.signal.aborted) this.post({type:'releaseDecoders',id}); });
  }

  /** Dispose the dedicated export outgoing-side decoders (free their hardware
   *  decode sessions). Safe to call when no export is running. */
  releaseExactFromDecoders(): void {
    for (const s of this.exactFromSources.values()) {
      this.post({ type: 'dispose', id: s.workerId });
      this.byWorkerId.delete(s.workerId);
    }
    this.exactFromSources.clear();
    this.exactFromOpening.clear();
  }

  /** Begin a forward streaming decode of a video asset from its first frame.
   *  Pull frames in presentation order with {@link pullStreamFrame}, then
   *  {@link endStream}. Immune to the open-GOP seeking hangs of exactFrame —
   *  the right primitive for a full sequential transcode. */
  startStream(assetId: string, grid?: { everyUs: number; pw: number; ph: number }): void {
    const video = this.videoSources.get(assetId);
    if (video) this.post({ type: 'streamReset', id: video.workerId, ...grid });
  }

  /** Next decoded frame (presentation order) of the active stream, or null at
   *  end. Caller owns the returned VideoFrame and must close it. */
  pullStreamFrame(assetId: string): Promise<{ frame: VideoFrame; cts: number } | null> {
    const video = this.videoSources.get(assetId);
    if (!video) return Promise.resolve(null);
    const reqId = this.nextFrameReq++;
    return this.request(this.pendingStream, reqId, {type:'streamPull',id:video.workerId,reqId}, this.lifetime.signal);

  }

  endStream(assetId: string): void {
    const video = this.videoSources.get(assetId);
    if (video) this.post({ type: 'streamDispose', id: video.workerId });
  }

  /** Decode one audio window for an asset (used by the AudioEngine). Imported
   *  audio files slice their decoded buffer; video assets pull AAC from the
   *  worker. */
  requestPcm(assetId: string, fromUs: number, durUs: number, options: MediaRequestOptions = {}): Promise<PcmChunk> {
    return this.scheduler.run(options.priority ?? (this.playing ? 'preview' : this.priority), signal => this.readPcm(assetId,fromUs,durUs,signal), {
      lane:'codec', signal:this.signal(options.signal),
    });
  }
  private readPcm(assetId: string, fromUs: number, durUs: number, signal: AbortSignal): Promise<PcmChunk> {
    const meta = this.pcm.get(assetId);
    if (meta) return this.readPcmWindow(meta, fromUs, durUs);
    const buf = this.audioBuffers.get(assetId);
    if (buf) return Promise.resolve(this.sliceBuffer(buf, fromUs, durUs));
    const video = this.videoSources.get(assetId);
    if (!video || !video.hasAudio) return Promise.reject(new Error('no audio for asset'));
    const reqId = this.nextPcmReq++;
    return this.request(this.pendingPcm, reqId, {type:'audio',id:video.workerId,reqId,fromUs,durUs}, signal);

  }

  private sliceBuffer(buf: AudioBuffer, fromUs: number, durUs: number): PcmChunk {
    const sr = buf.sampleRate;
    const start = Math.min(buf.length, Math.max(0, Math.floor((fromUs / 1e6) * sr)));
    const frames = Math.max(0, Math.min(buf.length - start, Math.ceil((durUs / 1e6) * sr)));
    const planes: Float32Array<ArrayBuffer>[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      planes.push(buf.getChannelData(c).slice(start, start + frames) as Float32Array<ArrayBuffer>);
    }
    return { sampleRate: sr, channels: buf.numberOfChannels, startUs: Math.round((start / sr) * 1e6), frames, planes };
  }

  /** Read one PCM window off the OPFS planar-f32 file — a byte-range slice per
   *  channel, so the whole track never sits in RAM. */
  private async readPcmWindow(meta: PcmMeta, fromUs: number, durUs: number): Promise<PcmChunk> {
    const { sampleRate, channels, frames, handle } = meta;
    const start = Math.min(frames, Math.max(0, Math.floor((fromUs / 1e6) * sampleRate)));
    const n = Math.max(0, Math.min(frames - start, Math.ceil((durUs / 1e6) * sampleRate)));
    const file = await handle.getFile();
    const planes: Float32Array<ArrayBuffer>[] = [];
    for (let c = 0; c < channels; c++) {
      const off = PCM_HEADER + (c * frames + start) * 4;
      const ab = n > 0 ? await file.slice(off, off + n * 4).arrayBuffer() : new ArrayBuffer(0);
      planes.push(new Float32Array(ab));
    }
    return { sampleRate, channels, startUs: Math.round((start / sampleRate) * 1e6), frames: n, planes };
  }

  /** Decode a whole audio file (mp3/m4a/wav/…) for music import. */
  async probeAudio(file: File): Promise<{ buffer: AudioBuffer; durationUs: number; hasAudio: true }> {
    this.decodeCtx ??= new AudioContext();
    const buffer = await this.decodeCtx.decodeAudioData(await file.arrayBuffer());
    return { buffer, durationUs: Math.round(buffer.duration * 1e6), hasAudio: true };
  }

  /** Persist decoded audio to OPFS as planar f32 and keep only metadata
   *  resident; falls back to keeping the AudioBuffer in RAM if OPFS fails. */
  async attachAudio(assetId: string, buffer: AudioBuffer): Promise<void> {
    try {
      const dir = await pcmDir(this.storageScope);
      const handle = await dir.getFileHandle(`${assetId}.pcm`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(
        new Uint32Array([PCM_MAGIC, buffer.sampleRate, buffer.numberOfChannels, buffer.length]).buffer,
      );
      for (let c = 0; c < buffer.numberOfChannels; c++) await writable.write(buffer.getChannelData(c));
      await writable.close();
      this.pcm.set(assetId, {
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        frames: buffer.length,
        handle,
      });
    } catch {
      this.audioBuffers.set(assetId, buffer); // OPFS unavailable → resident fallback
    }
  }

  /** Re-attach an imported audio asset from its OPFS PCM (no re-decode). Returns
   *  false if no PCM file exists (caller then decodes + attachAudio). */
  async restoreAudio(assetId: string): Promise<boolean> {
    try {
      const dir = await pcmDir(this.storageScope);
      const handle = await dir.getFileHandle(`${assetId}.pcm`);
      const file = await handle.getFile();
      if (file.size < PCM_HEADER) return false;
      const head = new Uint32Array(await file.slice(0, PCM_HEADER).arrayBuffer());
      if (head[0] !== PCM_MAGIC || head[3] === 0) return false;
      this.pcm.set(assetId, { sampleRate: head[1], channels: head[2], frames: head[3], handle });
      return true;
    } catch {
      return false;
    }
  }

  /** Demux + probe run in the worker; resolves once metadata is known. */
  probeVideo(file: File): Promise<RemoteVideoSource> {
    const id = this.nextId++;
    return this.request(this.pending, id, {type:'open',id,file}, this.lifetime.signal);
  }

  /** Release a temporary probe source. Never release media already attached to an asset. */
  releaseVideoProbe(source: RemoteVideoSource): void {
    if ([...this.videoSources.values(), ...this.fromSources.values()].includes(source)) throw new Error('cannot release an attached video source');
    source.disposeFrames();
    this.byWorkerId.delete(source.workerId);
    this.post({ type: 'dispose', id: source.workerId });
  }

  async probeImage(file: File): Promise<VideoFrame> {
    const bitmap = await createImageBitmap(file);
    const frame = new VideoFrame(bitmap, { timestamp: 0 });
    bitmap.close();
    return frame;
  }

  attachVideo(assetId: string, source: RemoteVideoSource, file?: File) {
    this.videoSources.set(assetId, source);
    // Keep the original for the transition outgoing side's dedicated decoder.
    if (file) this.originalFiles.set(assetId, file);
  }

  attachImage(assetId: string, frame: VideoFrame) {
    this.imageFrames.set(assetId, frame);
    this.version++;
  }

  /** Register a procedural canvas-animation asset (see {@link motionSources}).
   *  `render(index)` rasterizes frame `index` and returns a fresh VideoFrame. */
  attachMotion(
    assetId: string,
    render: (index: number) => VideoFrame,
    opts: { width: number; height: number; frameDurUs: number; frameCount: number },
  ) {
    // Re-attach (a spec edit / undo / remote change recompiles the source):
    // close the old source's resident preview frame instead of leaking it to GC.
    this.motionSources.get(assetId)?.preview?.frame.close();
    this.motionSources.set(assetId, { render, ...opts });
    this.version++;
  }

  /** Quantize a source time to a motion frame index, clamped to the clip. */
  private motionIndex(m: { frameDurUs: number; frameCount: number }, sourceTimeUs: number): number {
    return Math.max(0, Math.min(m.frameCount - 1, Math.floor(sourceTimeUs / m.frameDurUs)));
  }

  /** Transport state — widens the worker's decode-ahead window during play. */
  setPlaying(playing: boolean) {
    this.playing = playing;
    this.scheduler.setPreviewActive(this, playing);
  }

  /** Whether live media (decoder or image frame) is attached for an asset —
   *  used by persistence to re-attach OPFS-backed media after a reload. */
  hasAsset(assetId: string): boolean {
    return (
      this.videoSources.has(assetId) ||
      this.imageFrames.has(assetId) ||
      this.motionSources.has(assetId) ||
      this.pcm.has(assetId) ||
      this.audioBuffers.has(assetId)
    );
  }

  /** Probed media duration in µs (videos only; images have no duration). */
  probedDuration(assetId: string): number | null {
    return this.videoSources.get(assetId)?.durationUs ?? null;
  }

  /** Realtime frame access used by the render loop — prefers the low-res proxy
   *  (cheap to decode/seek); the renderer samples it across the original-sized
   *  quad (assetSize stays the original), so it just looks lower-res. */
  frameFor(assetId: string, sourceTimeUs: number): VideoFrame | null {
    const proxy = this.proxySources.get(assetId);
    if (proxy) return proxy.requestFrame(sourceTimeUs, this.playing);
    const video = this.videoSources.get(assetId);
    if (video) {
      // While a proxy is building, the build holds a forward-running hardware
      // decoder for this asset; do NOT also steer the realtime decoder — two
      // concurrent 4K decoders can exhaust the GPU. Freeze on the last frame.
      if (this.proxyBuilding.has(assetId)) return video.peekFrame();
      return video.requestFrame(sourceTimeUs, this.playing);
    }
    const motion = this.motionSources.get(assetId);
    if (motion) {
      // Render on demand, keeping ONE resident preview frame: same index → reuse,
      // new index → close the old frame and rasterize the new one. The renderer
      // does not own/close frames returned by frameFor, so we manage lifecycle.
      const index = this.motionIndex(motion, sourceTimeUs);
      if (motion.preview?.index === index) return motion.preview.frame;
      motion.preview?.frame.close();
      const frame = motion.render(index);
      motion.preview = { index, frame };
      return frame;
    }
    return this.imageFrames.get(assetId) ?? null;
  }

  /** Frame for a transition's OUTGOING ("from") side.
   *
   *  A cross-clip transition needs the outgoing and incoming sides decoded
   *  simultaneously. Two cases:
   *   - DIFFERENT asset: the outgoing asset has its own realtime decoder, which
   *     is otherwise idle (its clip already ended) — steer it normally.
   *   - SAME asset (`conflicting`): one decoder can't serve two distant source
   *     positions without flip-flopping. The outgoing side gets its OWN
   *     dedicated second decoder; until it opens we only PEEK the shared decoder
   *     (never steer it — steering would corrupt the incoming side too). */
  frameForFrom(assetId: string, sourceTimeUs: number, conflicting: boolean): VideoFrame | null {
    const src = this.fromSources.get(assetId);
    if (src) return src.requestFrame(sourceTimeUs, this.playing);
    if (!conflicting) return this.frameFor(assetId, sourceTimeUs); // own idle decoder
    // Same asset as the incoming side: open a dedicated decoder, freeze meanwhile.
    if (!this.fromOpening.has(assetId)) {
      this.fromOpening.add(assetId);
      void this.openFromSource(assetId).finally(() => this.fromOpening.delete(assetId));
    }
    return (this.proxySources.get(assetId) ?? this.videoSources.get(assetId))?.peekFrame() ?? null;
  }

  /** Open a dedicated second decoder for the outgoing side. Prefers the low-res
   *  OPFS proxy (cheap to run alongside the incoming decoder); falls back to a
   *  second decoder of the retained original when no proxy exists. */
  private async openFromSource(assetId: string): Promise<void> {
    try {
      const dir = await proxyDir(this.storageScope);
      await dir.getFileHandle(`${assetId}.done`); // throws unless a complete proxy exists
      const file = await (await dir.getFileHandle(`${assetId}.mp4`)).getFile();
      this.fromSources.set(assetId, await this.probeVideo(file));
      this.version++;
      return;
    } catch {
      // No proxy — fall through to a second decoder of the original.
    }
    const original = this.originalFiles.get(assetId);
    if (!original) return; // nothing to open from; next call retries
    this.fromSources.set(assetId, await this.probeVideo(original));
    this.version++;
  }

  /** True once a preview proxy is attached for the asset. */
  hasProxy(assetId: string): boolean {
    return this.proxySources.has(assetId);
  }

  /** Re-attach an existing OPFS proxy (built in a prior session). The `.done`
   *  marker guards against partially-written proxies. */
  async restoreProxy(assetId: string): Promise<boolean> {
    try {
      const dir = await proxyDir(this.storageScope);
      await dir.getFileHandle(`${assetId}.done`); // throws if the build never finished
      const file = await (await dir.getFileHandle(`${assetId}.mp4`)).getFile();
      const proxy = await this.probeVideo(file);
      this.proxySources.set(assetId, proxy);
      this.version++;
      return true;
    } catch {
      return false;
    }
  }

  /** Transcode an asset's original to a low-res OPFS proxy, then attach it for
   *  preview. No-op if the asset is already small or a proxy exists. Heavy but
   *  one-time; meant to run in the background after import. */
  buildProxy(assetId: string, opts?: { fps?: number; force?: boolean; onProgress?: (frac: number) => void; signal?: AbortSignal }): Promise<void> {
    const existing=this.proxyJobs.get(assetId); if(existing)return existing;
    const job=this.scheduler.run('proxy', signal=>this.runProxy(assetId,{...opts,signal}), {signal:this.signal(opts?.signal)});
    this.proxyJobs.set(assetId,job);
    void job.finally(()=>this.proxyJobs.delete(assetId)).catch(()=>{});
    return job;
  }
  private async runProxy(assetId: string, opts: { fps?: number; force?: boolean; onProgress?: (frac: number) => void; signal: AbortSignal }): Promise<void> {
    const original = this.videoSources.get(assetId);
    if (!original || this.proxySources.has(assetId) || this.proxyBuilding.has(assetId)) return;
    // Small videos decode fine at native res — a proxy would only add overhead.
    // `force` (testing) bypasses this but never upscales (scale clamped ≤ 1).
    if (!opts?.force && Math.max(original.width, original.height) <= PROXY_MAX_DIM) return;
    // Claim the slot SYNCHRONOUSLY, before any await — restoreMedia re-fires
    // buildProxy on every store change, so two calls would otherwise both clear
    // the guard, open the same OPFS writable, and corrupt each other.
    this.proxyBuilding.add(assetId);
    let streaming = false;
    let encoder: VideoEncoder | undefined, writable: FileSystemWritableFileStream | undefined;
    let complete = false;
    try {
      if (await this.restoreProxy(assetId)) return;
      const scale = Math.min(1, PROXY_MAX_DIM / Math.max(original.width, original.height));
      const pw = Math.max(2, Math.round((original.width * scale) / 2) * 2);
      const ph = Math.max(2, Math.round((original.height * scale) / 2) * 2);
      const fps = opts?.fps ?? 30;
      const frameDurUs = 1e6 / fps;

      const dir = await proxyDir(this.storageScope);
      await dir.removeEntry(`${assetId}.done`).catch(() => {});
      const handle = await dir.getFileHandle(`${assetId}.mp4`, { create: true });
      writable = await handle.createWritable();
      const muxer = new Muxer({
        target: new FileSystemWritableFileStreamTarget(writable),
        video: { codec: 'avc', width: pw, height: ph },
        fastStart: false,
      });
      encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => console.error('[velocut] proxy encode error', e),
      });
      encoder.configure({
        codec: await pickAvc(pw, ph, fps),
        width: pw,
        height: ph,
        framerate: fps,
        bitrate: Math.round(pw * ph * fps * 0.07),
        latencyMode: 'realtime', // a preview proxy — fast encode over peak quality
      });
      const keyint = Math.max(1, Math.round(fps)); // 1s GOP → snappy seeking

      // The worker does a single forward decode (no seeking — immune to the
      // open-GOP hang), decimates to the proxy fps grid, and downscales each
      // kept frame, so only ~proxy-fps frames at proxy size cross to the main
      // thread. We just re-time onto a clean CFR grid and encode.
      // Free the realtime decoder's resident 4K window first: frameFor freezes
      // this asset's preview for the duration (peekFrame), so those frames are
      // dead weight, and dropping them keeps GPU memory for the single build
      // decoder + encoder.
      opts.signal.throwIfAborted();
      original.keepLastFrame();
      this.post({type:'releaseDecoders',id:original.workerId});
      this.startStream(assetId, { everyUs: Math.round(frameDurUs), pw, ph });
      streaming = true;
      let outN = 0;
      for (;;) {
        opts.signal.throwIfAborted();
        const pulled = await this.pullStreamFrame(assetId);
        if (!pulled) break;
        if(opts.signal.aborted){pulled.frame.close();opts.signal.throwIfAborted();}
        const ts = pulled.cts;
        const vf = new VideoFrame(pulled.frame, { timestamp: ts, duration: Math.max(pulled.frame.duration ?? 0, Math.round(frameDurUs)) });
        encoder.encode(vf, { keyFrame: outN % keyint === 0 });
        vf.close();
        pulled.frame.close();
        outN++;
        while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
        opts?.onProgress?.(Math.min(1, pulled.cts / Math.max(1, original.durationUs)));
      }
      this.endStream(assetId);
      streaming = false;

      opts.signal.throwIfAborted();
      await encoder.flush();
      encoder.close();
      muxer.finalize();
      await writable.close();
      opts.signal.throwIfAborted();
      await (await dir.getFileHandle(`${assetId}.done`, { create: true })).createWritable().then((w) => w.close());

      const proxy = await this.probeVideo(await handle.getFile());
      this.proxySources.set(assetId, proxy);
      this.version++;
      complete = true;
    } catch (e) {
      throw e;
    } finally {
      if (streaming && !this.lifetime.signal.aborted) this.endStream(assetId);
      if (encoder && encoder.state !== 'closed') encoder.close();
      if (!complete) await writable?.abort().catch(()=>{});
      this.proxyBuilding.delete(assetId);
    }
  }

  assetSize(assetId: string): { width: number; height: number } | null {
    const video = this.videoSources.get(assetId);
    if (video) return { width: video.width, height: video.height };
    const img = this.imageFrames.get(assetId);
    if (img) return { width: img.displayWidth, height: img.displayHeight };
    const motion = this.motionSources.get(assetId);
    if (motion) return { width: motion.width, height: motion.height };
    return null;
  }

  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new DOMException('Media library disposed','AbortError'));
    this.scheduler.setPreviewActive(this,false);
    this.worker.terminate();
    const error = new DOMException('Media library disposed','AbortError');
    for (const pending of [...this.pending.values(),...this.pendingPcm.values(),...this.pendingFrame.values(),...this.pendingStream.values()]) pending.reject(error);
    this.pending.clear(); this.pendingPcm.clear(); this.pendingFrame.clear(); this.pendingStream.clear();
    void this.decodeCtx?.close();
    this.decodeCtx = null;
    this.pcm.clear(); // OPFS files persist as the decoded cache
    this.audioBuffers.clear();
    for (const s of this.byWorkerId.values()) s.disposeFrames();
    for (const f of this.imageFrames.values()) f.close();
    for (const m of this.motionSources.values()) m.preview?.frame.close();
    this.fromSources.clear(); // frames freed by the byWorkerId disposeFrames loop
    this.exactFromSources.clear();
    this.exactFromOpening.clear();
    this.originalFiles.clear();
    this.byWorkerId.clear();
    this.videoSources.clear();
    this.proxySources.clear();
    this.imageFrames.clear();
    this.motionSources.clear();
    for (const dispose of this.ownedRenderers.splice(0)) dispose();
  }
}
