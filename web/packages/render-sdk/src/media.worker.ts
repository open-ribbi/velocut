// services/media.worker.ts — demux + decode, fully off the main thread.
//
//   File → streamed into mp4box.js (progressive demux, consumed buffers
//   released) → sample INDEX (byte offsets + timestamps only) → on demand:
//   File.slice() byte-range reads → EncodedVideoChunk → WebCodecs
//   VideoDecoder (hardware) → VideoFrames TRANSFERRED to the main thread.
//
// The compressed stream is NEVER memory-resident: a File is a disk handle,
// and slice().arrayBuffer() reads just the bytes a decode batch needs (the
// OS page cache makes repeats free). Steady-state memory per asset is the
// index (~40 bytes/sample — a 23-minute clip is ~2 MB), not the gigabytes
// the bitstream itself would cost. This is the same sample-table+lazy-IO
// design native editors use.
//
// Push model: the main thread streams `target` messages (the source time
// each asset currently needs, plus whether the transport is playing); the
// worker steers decoding toward the target and transfers every useful frame
// out. The main thread keeps a small presentation window of frames and
// composites synchronously — it never touches compressed data or decoders.
//
// Decode-order invariants (B-frames): samples are fed in file order; cts is
// non-monotonic across samples, so presentation lookups go through byCts.

import * as MP4Box from 'mp4box';

export interface ProbeResult {
  durationUs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export type MainToWorker =
  | { type: 'open'; id: number; file: File }
  | { type: 'target'; id: number; timeUs: number; playing: boolean }
  | { type: 'audio'; id: number; reqId: number; fromUs: number; durUs: number }
  | { type: 'frameAt'; id: number; reqId: number; timeUs: number }
  | { type: 'streamReset'; id: number; everyUs?: number; pw?: number; ph?: number }
  | { type: 'streamPull'; id: number; reqId: number }
  | { type: 'streamDispose'; id: number }
  | { type: 'dispose'; id: number };

export type WorkerToMain =
  | { type: 'ready'; id: number; probe: ProbeResult }
  | { type: 'openError'; id: number; message: string }
  | { type: 'frame'; id: number; timestampUs: number; durationUs: number; frame: VideoFrame }
  | {
      type: 'pcm';
      id: number;
      reqId: number;
      sampleRate: number;
      channels: number;
      startUs: number;
      frames: number;
      planes: ArrayBuffer[];
    }
  | { type: 'pcmError'; id: number; reqId: number; message: string }
  | { type: 'exportFrame'; id: number; reqId: number; frame: VideoFrame | null }
  | { type: 'streamFrame'; id: number; reqId: number; frame: VideoFrame | null; cts: number };

/** Feed past the target so B-frame reordering releases it. */
const REORDER_AHEAD = 8;
/** Extra decode-ahead while playing (keeps the pipeline a few frames warm). */
const PLAY_AHEAD = 10;

const ctx = self as unknown as Worker;

/** Extract codec description (avcC/hvcC box payload) for VideoDecoder. */
function extractDescription(mp4: any, trackId: number): Uint8Array | undefined {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8, stream.getPosition() - 8); // strip box header
    }
  }
  return undefined;
}

/** AudioSpecificConfig from the esds box — required by AudioDecoder for
 *  raw (non-ADTS) AAC as stored in MP4. */
function extractAudioSpecificConfig(mp4: any, trackId: number): Uint8Array | undefined {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const dsi = entry.esds?.esd?.descs?.[0]?.descs?.[0];
    if (dsi?.data) return new Uint8Array(dsi.data);
  }
  return undefined;
}

/** AudioDecoder rejects bare/ambiguous codec strings — mp4box commonly reports
 *  just 'mp4a' for AAC audio in MOV containers (MP4 usually gives the full
 *  'mp4a.40.2'). Complete it from the AudioSpecificConfig's object type (top 5
 *  bits of the ASC), defaulting to AAC-LC. */
function normalizeAudioCodec(codec: string, asc?: Uint8Array): string {
  if (codec === 'mp4a' || codec === 'mp4a.40') {
    let aot = 2; // AAC-LC
    if (asc && asc.length) {
      const t = asc[0] >> 3;
      if (t >= 1 && t <= 30) aot = t;
    }
    return `mp4a.40.${aot}`;
  }
  return codec;
}

class Source {
  /** Sample index in DECODE (file) order — bytes stay on disk. */
  private file!: File;
  private offsets: number[] = [];
  private sizes: number[] = [];
  private cts: number[] = [];
  private durs: number[] = [];
  private sync: boolean[] = [];
  private syncIndices: number[] = [];
  /** Sample indices sorted by presentation time. */
  private byCts: number[] = [];
  private config!: VideoDecoderConfig;
  private decoder: VideoDecoder | null = null;
  /** Next sample the pump will read+decode. */
  private feedIndex = 0;
  /** Pump destination (inclusive). */
  private wantIdx = -1;
  private pumping = false;
  /** Bumped on random access — an in-flight pump batch from an older
   *  generation is discarded instead of feeding a restarted decoder. */
  private generation = 0;
  private targetUs = 0;
  private playing = false;
  private avgDurUs = 33_333;
  /** Highest presentation time transferred since the last decoder (re)start —
   *  used to detect a still target starved by the reorder buffer. */
  private lastSentCts = -Infinity;
  private stillCheck: ReturnType<typeof setTimeout> | null = null;
  private stillRetries = 0;

  /** Export path: a separate forward-running decoder that resolves the EXACT
   *  frame at a requested time (the realtime path is best-effort). */
  private expDec: VideoDecoder | null = null;
  private expFeed = 0;
  private expRing = new Map<number, VideoFrame>(); // cts → decoded frame
  private expWant: number | null = null;
  private expResolve: ((f: VideoFrame | null) => void) | null = null;

  /** Streaming path: a forward-only decoder that walks EVERY sample in decode
   *  order and yields frames in presentation order. Unlike the random-access
   *  export path it never re-seeks, so it is immune to open-GOP leading-picture
   *  hangs (iPhone HEVC) and is the right primitive for a full transcode
   *  (proxy build, export). Frames queue up in emit order; the consumer pulls
   *  one at a time and applies its own backpressure. */
  private strDec: VideoDecoder | null = null;
  private strFeed = 0;
  private strQueue: VideoFrame[] = [];
  /** Optional in-worker downsample for streamPull: only frames on the fps grid
   *  are returned, each rescaled to (strPw×strPh). Keeps the heavy 4K→proxy
   *  resize and the 60→30fps decimation off the main thread, and shrinks each
   *  transferred frame ~9× (proxy build). everyUs=0 → pass frames through 1:1. */
  private strEveryUs = 0;
  private strNextUs = 0;
  private strPw = 0;
  private strPh = 0;
  private strCanvas: OffscreenCanvas | null = null;
  private strCtx: OffscreenCanvasRenderingContext2D | null = null;

  /** Audio sample index (AAC frames are all sync — no keyframe logic). */
  private aOffsets: number[] = [];
  private aSizes: number[] = [];
  private aCts: number[] = [];
  private audioConfig: AudioDecoderConfig | null = null;

  probe!: ProbeResult;

  constructor(private id: number) {}

  // ------------------------------------------------------------- loading

  async load(file: File): Promise<void> {
    this.file = file;
    const mp4 = MP4Box.createFile();
    let videoTrack: any = null;
    let failed: Error | null = null;

    await new Promise<void>((resolve, reject) => {
      mp4.onError = (e: string) => {
        failed = new Error(e);
        reject(failed);
      };
      let audioTrackId = -1;
      mp4.onReady = (info: any) => {
        videoTrack = info.videoTracks?.[0];
        if (!videoTrack) {
          failed = new Error('no video track in file');
          reject(failed);
          return;
        }
        const audioTrack = info.audioTracks?.[0];
        this.probe = {
          durationUs: Math.round((videoTrack.duration / videoTrack.timescale) * 1e6),
          width: videoTrack.video?.width ?? videoTrack.track_width,
          height: videoTrack.video?.height ?? videoTrack.track_height,
          hasAudio: !!audioTrack,
        };
        this.config = {
          codec: videoTrack.codec,
          codedWidth: this.probe.width,
          codedHeight: this.probe.height,
          description: extractDescription(mp4, videoTrack.id),
          hardwareAcceleration: 'prefer-hardware',
        };
        if (audioTrack) {
          audioTrackId = audioTrack.id;
          const asc = extractAudioSpecificConfig(mp4, audioTrack.id);
          this.audioConfig = {
            codec: normalizeAudioCodec(audioTrack.codec, asc),
            sampleRate: audioTrack.audio?.sample_rate ?? 48000,
            numberOfChannels: audioTrack.audio?.channel_count ?? 2,
            description: asc,
          };
          mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: 1000 });
        }
        // Extract progressively while the file streams in.
        mp4.setExtractionOptions(videoTrack.id, null, { nbSamples: 500 });
        mp4.start();
      };
      mp4.onSamples = (trackId: number, _u: unknown, samples: any[]) => {
        if (trackId === audioTrackId) {
          for (const s of samples) {
            this.aOffsets.push(s.offset);
            this.aSizes.push(s.size);
            this.aCts.push(Math.round((s.cts / s.timescale) * 1e6));
          }
        } else {
          for (const s of samples) {
            if (s.is_sync) this.syncIndices.push(this.cts.length);
            this.offsets.push(s.offset);
            this.sizes.push(s.size);
            this.cts.push(Math.round((s.cts / s.timescale) * 1e6));
            this.durs.push(Math.round((s.duration / s.timescale) * 1e6));
            this.sync.push(!!s.is_sync);
          }
        }
        // Only the index is kept; free mp4box's sample buffers immediately.
        const last = samples[samples.length - 1];
        if (last) mp4.releaseUsedSamples(trackId, last.number);
      };
      (async () => {
        const reader = file.stream().getReader();
        let offset = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (failed) {
            void reader.cancel();
            return;
          }
          if (done) break;
          // mp4box wants a plain ArrayBuffer with a fileStart marker.
          const ab =
            value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
              ? value.buffer
              : value.slice().buffer;
          (ab as any).fileStart = offset;
          offset += value.byteLength;
          mp4.appendBuffer(ab);
        }
        mp4.flush();
        resolve();
      })().catch(reject);
    });

    if (!videoTrack) throw new Error('no video track in file');
    if (this.cts.length === 0) throw new Error('no decodable video samples');

    this.byCts = this.cts.map((_, i) => i).sort((a, b) => this.cts[a] - this.cts[b]);
    this.avgDurUs = Math.max(1, Math.round(this.probe.durationUs / this.cts.length));

    const support = await VideoDecoder.isConfigSupported(this.config);
    if (!support.supported) {
      this.config.hardwareAcceleration = 'no-preference';
      const fallback = await VideoDecoder.isConfigSupported(this.config);
      // Fail the import loudly — otherwise configure() throws on every feed
      // and the preview is a silent black screen.
      if (!fallback.supported) throw new Error(`Unsupported video codec: ${this.config.codec}`);
    }
  }

  // ------------------------------------------------------------ decoding

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        console.error('[velocut] decoder error', e);
        // Closed after an error; drop it so the next feed restarts from a
        // keyframe instead of looping "key frame required" failures.
        this.decoder = null;
      },
    });
    this.decoder.configure(this.config);
    return this.decoder;
  }

  private onFrame(frame: VideoFrame) {
    const t = this.targetUs;
    const dur = frame.duration ?? this.avgDurUs;
    // The accept-ahead window must COVER the feed look-ahead, which is
    // counted in frames — at 24fps the same frame count spans more wall
    // time than at 30fps, and a fixed-ms window silently discards the
    // freshly decoded front (the pump never re-feeds, so those times then
    // play back with no frame at all).
    const aheadFrames = REORDER_AHEAD + (this.playing ? PLAY_AHEAD : 0) + 4;
    const aheadUs = aheadFrames * this.avgDurUs;
    if (frame.timestamp > t + aheadUs) {
      frame.close();
      return;
    }
    // Behind the target: while catching up through a long GOP (seek lands
    // deep after a keyframe), still surface a preview every ~150ms so the
    // user watches the scrub approach instead of a stale/black canvas.
    const covers = frame.timestamp + dur >= t - 2 * this.avgDurUs;
    if (!covers && frame.timestamp < this.lastSentCts + 150_000) {
      frame.close();
      return;
    }
    this.lastSentCts = Math.max(this.lastSentCts, frame.timestamp);
    const msg: WorkerToMain = {
      type: 'frame',
      id: this.id,
      timestampUs: frame.timestamp,
      durationUs: dur,
      frame,
    };
    ctx.postMessage(msg, [frame as unknown as Transferable]);
  }

  /** Decode-order index of the chunk presented at timeUs (largest cts ≤ t). */
  private decodeIndexFor(timeUs: number): number {
    let lo = 0,
      hi = this.byCts.length - 1,
      ans = this.byCts[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cts[this.byCts[mid]] <= timeUs) {
        ans = this.byCts[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  private keyframeBefore(chunkIdx: number): number {
    let best = 0;
    for (const k of this.syncIndices) {
      if (k <= chunkIdx) best = k;
      else break;
    }
    return best;
  }

  /** Random-access feed start for the chunk at `targetIdx`. Starts a GOP EARLIER
   *  than the enclosing keyframe: open-GOP I-frames (common in iPhone HEVC and
   *  x264's default) have leading B-pictures that reference the PREVIOUS GOP, so
   *  seeking only to keyframeBefore(target) can't rebuild them and the wanted
   *  frame never emits — a PERMANENT black preview at that frame until something
   *  decodes forward through it (why "seek away and back" clears it). Decoding
   *  one extra GOP is the price of frame-exact random access; both the realtime
   *  steer and the export path start here. */
  private seekStartBefore(targetIdx: number): number {
    const kf = this.keyframeBefore(targetIdx);
    return kf > 0 ? this.keyframeBefore(kf - 1) : 0;
  }

  /** Kick the read+decode pump toward wantIdx. Reads are async (disk), so a
   *  single pump loop drains the work; concurrent kicks just raise wantIdx. */
  private kick() {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  private async pump() {
    const gen = this.generation;
    try {
      while (this.feedIndex <= this.wantIdx && this.feedIndex < this.cts.length) {
        // A fresh decoder (first use, post-error, post-flush) must start at
        // a keyframe; re-decoded frames re-send, so reset the watermark.
        if (!this.decoder || this.decoder.state === 'closed') {
          this.feedIndex = this.keyframeBefore(Math.min(this.feedIndex, this.cts.length - 1));
          this.lastSentCts = -Infinity;
        }
        const start = this.feedIndex;
        const end = Math.min(start + 16, this.wantIdx + 1, this.cts.length);
        // Coalesce contiguous samples (video runs are contiguous between
        // audio interleaves) into as few byte-range reads as possible.
        const reads: Promise<ArrayBuffer>[] = [];
        const slot: { read: number; offset: number }[] = [];
        for (let i = start; i < end; ) {
          let j = i;
          while (j + 1 < end && this.offsets[j + 1] === this.offsets[j] + this.sizes[j]) j++;
          const lo = this.offsets[i];
          const hi = this.offsets[j] + this.sizes[j];
          const read = reads.length;
          reads.push(this.file.slice(lo, hi).arrayBuffer());
          for (let k = i; k <= j; k++) slot.push({ read, offset: this.offsets[k] - lo });
          i = j + 1;
        }
        const buffers = await Promise.all(reads);
        if (gen !== this.generation) return; // restarted while reading
        const dec = this.ensureDecoder();
        for (let k = 0; k < slot.length; k++) {
          const i = start + k;
          dec.decode(
            new EncodedVideoChunk({
              type: this.sync[i] ? 'key' : 'delta',
              timestamp: this.cts[i],
              duration: this.durs[i],
              data: new Uint8Array(buffers[slot[k].read], slot[k].offset, this.sizes[i]),
            }),
          );
        }
        this.feedIndex = end;
      }
    } catch (e) {
      console.error('[velocut] media read error', e);
    } finally {
      this.pumping = false;
      // A restart may have moved the goalposts while we were reading.
      if (gen !== this.generation && this.feedIndex <= this.wantIdx) this.kick();
    }
  }

  steer(timeUs: number, playing: boolean) {
    if (this.cts.length === 0) return;
    if (Math.abs(timeUs - this.targetUs) > 2 * this.avgDurUs) this.stillRetries = 0;
    this.targetUs = timeUs;
    this.playing = playing;
    const targetIdx = this.decodeIndexFor(timeUs);
    this.wantIdx = Math.min(
      targetIdx + REORDER_AHEAD + (playing ? PLAY_AHEAD : 0),
      this.cts.length - 1,
    );

    const aheadOk = this.feedIndex > this.wantIdx && this.feedIndex - this.wantIdx < 60;
    const behind = this.feedIndex <= this.wantIdx && this.wantIdx - this.feedIndex < 120;
    if (behind) {
      this.kick();
    } else if (!aheadOk) {
      // Random access: restart from a GOP before the target (open-GOP safe).
      this.generation++;
      this.decoder?.close();
      this.decoder = null;
      this.feedIndex = this.seekStartBefore(targetIdx);
      this.kick();
    }
    this.scheduleStillCheck();
  }

  /** When paused, frames for the target can sit in the decoder's reorder
   *  buffer forever (it only emits under input pressure). If nothing covering
   *  the target arrived shortly after steering, flush it out. */
  private scheduleStillCheck() {
    if (this.stillCheck) clearTimeout(this.stillCheck);
    if (this.playing) return;
    this.stillCheck = setTimeout(() => {
      this.stillCheck = null;
      if (this.playing) return;
      const covered = this.lastSentCts >= this.targetUs - 2 * this.avgDurUs;
      if (covered) {
        this.stillRetries = 0;
        return;
      }
      if (
        this.pumping ||
        (this.decoder && this.decoder.state === 'configured' && this.decoder.decodeQueueSize > 0)
      ) {
        // Reads or decodes still in flight (long-GOP catch-up can take
        // seconds at 1080p+) — waiting costs no retry budget.
        this.scheduleStillCheck();
        return;
      }
      if (this.stillRetries >= 3) return; // broken stream — stop thrashing
      this.stillRetries++;
      if (this.decoder?.state === 'configured') {
        const dec = this.decoder;
        this.decoder = null; // next feed restarts from a keyframe
        dec.flush().then(
          () => {
            dec.close();
            this.scheduleStillCheck(); // verify the flush actually covered us
          },
          () => {},
        );
      } else {
        // Flushed (or errored) but still uncovered — decode the window again.
        const targetIdx = this.decodeIndexFor(this.targetUs);
        this.generation++;
        this.feedIndex = this.seekStartBefore(targetIdx);
        this.wantIdx = Math.min(targetIdx + REORDER_AHEAD, this.cts.length - 1);
        this.kick();
        this.scheduleStillCheck();
      }
    }, 60);
  }

  // -------------------------------------------------------------- audio

  /** Decode one PCM window [fromUs, fromUs+durUs). Stateless: AAC frames are
   *  independent, so a throwaway AudioDecoder per request keeps this trivially
   *  correct under concurrency and seeks. */
  async decodeAudio(
    fromUs: number,
    durUs: number,
  ): Promise<{ sampleRate: number; channels: number; startUs: number; planes: Float32Array[] }> {
    if (!this.audioConfig || this.aCts.length === 0) throw new Error('no audio track');
    // Sample range: last cts ≤ fromUs … first cts ≥ fromUs+durUs.
    let lo = 0,
      hi = this.aCts.length - 1,
      first = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.aCts[mid] <= fromUs) {
        first = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let last = first;
    while (last + 1 < this.aCts.length && this.aCts[last + 1] < fromUs + durUs) last++;

    // Coalesced byte-range reads (audio runs are contiguous between video).
    const reads: Promise<ArrayBuffer>[] = [];
    const slot: { read: number; offset: number }[] = [];
    for (let i = first; i <= last; ) {
      let j = i;
      while (j + 1 <= last && this.aOffsets[j + 1] === this.aOffsets[j] + this.aSizes[j]) j++;
      const start = this.aOffsets[i];
      const read = reads.length;
      reads.push(this.file.slice(start, this.aOffsets[j] + this.aSizes[j]).arrayBuffer());
      for (let k = i; k <= j; k++) slot.push({ read, offset: this.aOffsets[k] - start });
      i = j + 1;
    }
    const buffers = await Promise.all(reads);

    const datas: AudioData[] = [];
    let decodeError: Error | null = null;
    const dec = new AudioDecoder({
      output: (d) => datas.push(d),
      error: (e) => {
        decodeError = e instanceof Error ? e : new Error(String(e));
      },
    });
    dec.configure(this.audioConfig);
    for (let k = 0; k < slot.length; k++) {
      const i = first + k;
      dec.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: this.aCts[i],
          data: new Uint8Array(buffers[slot[k].read], slot[k].offset, this.aSizes[i]),
        }),
      );
    }
    await dec.flush().catch(() => {});
    // A fatal decode error auto-closes the codec; calling close() again throws
    // and would mask the real error below.
    if (dec.state !== 'closed') dec.close();
    if (decodeError) {
      datas.forEach((d) => d.close());
      throw decodeError;
    }
    if (datas.length === 0) throw new Error('audio decode produced no data');

    const channels = Math.max(1, datas[0].numberOfChannels);
    // Read before close(): HE-AAC (SBR) outputs double the container's
    // declared rate, so trust the decoder.
    const outRate = datas[0].sampleRate;
    const total = datas.reduce((n, d) => n + d.numberOfFrames, 0);
    const planes = Array.from({ length: channels }, () => new Float32Array(total));
    let off = 0;
    for (const d of datas) {
      for (let ch = 0; ch < channels; ch++) {
        d.copyTo(planes[ch].subarray(off, off + d.numberOfFrames), {
          planeIndex: ch,
          format: 'f32-planar',
        });
      }
      off += d.numberOfFrames;
      d.close();
    }
    return { sampleRate: outRate, channels, startUs: this.aCts[first], planes };
  }

  // -------------------------------------------------------- export frames

  private onExportFrame(frame: VideoFrame) {
    // Cache EVERY decoded frame (capped ring) and serve clones — including the
    // one the current request wants. The export asks for output frames at the
    // TIMELINE fps, which often exceeds the source fps, so the SAME source frame
    // gets requested repeatedly. The old code deleted a frame on its first hit;
    // the duplicate then missed the cache and re-seeked, and rapidly closing +
    // recreating a VideoDecoder per duplicate wedged it (it output nothing → the
    // frame resolved null → black video on every shot after the first frame).
    // Keeping the original in the ring and handing out clones makes duplicates
    // and forward steps cheap cache hits with no re-seek.
    this.expRing.get(frame.timestamp)?.close();
    this.expRing.set(frame.timestamp, frame);
    if (this.expResolve && frame.timestamp === this.expWant) {
      const r = this.expResolve;
      this.expResolve = null;
      this.expWant = null;
      r(frame.clone()); // caller owns + closes its clone; the ring keeps the original
    }
    while (this.expRing.size > 24) {
      const oldest = this.expRing.keys().next().value as number;
      this.expRing.get(oldest)?.close();
      this.expRing.delete(oldest);
    }
  }

  /** Resolve the exact decoded frame presented at timeUs (export path). */
  async decodeFrameAt(timeUs: number): Promise<VideoFrame | null> {
    if (this.cts.length === 0) return null;
    const targetIdx = this.decodeIndexFor(timeUs);
    const targetCts = this.cts[targetIdx];
    const cached = this.expRing.get(targetCts);
    if (cached) {
      // Serve a clone and KEEP the ring copy: a higher timeline fps re-requests
      // the same source frame, and forward steps revisit recently-decoded ones.
      return cached.clone();
    }
    // (Re)start from the preceding keyframe on: first use, a backward jump, or a
    // FAR-FORWARD jump. The cache miss above means the wanted frame isn't held,
    // so any target behind the feed cursor (targetIdx < expFeed) was already
    // consumed and evicted — only re-seeking recovers it. B-frame reordering
    // makes the cts→decode-index mapping non-monotonic, so a strictly forward
    // scan still produces small backward steps; the old `expFeed-1` tolerance let
    // targetIdx == expFeed-1 slip through and feed nothing → hang.
    // Far-forward: a recap jumps all over the source (shot N at 134s, shot N+1 at
    // 570s). Without re-seeking, the export would decode EVERY intervening frame
    // (here ~13k) just to reach the target — minutes per cut, indistinguishable
    // from a hang. Seeking to the keyframe before the target skips the gap.
    const FAR_FORWARD = 120; // ~4s @30fps — beyond this, a seek beats decode-through
    if (
      !this.expDec ||
      this.expDec.state === 'closed' ||
      targetIdx < this.expFeed ||
      targetIdx - this.expFeed > FAR_FORWARD
    ) {
      this.expDec?.close();
      for (const f of this.expRing.values()) f.close();
      this.expRing.clear();
      this.expDec = new VideoDecoder({
        output: (f) => this.onExportFrame(f),
        error: (e) => {
          console.error('[velocut] export decode error', e);
          this.expDec = null;
        },
      });
      this.expDec.configure(this.config);
      // Open-GOP safe start (see seekStartBefore) — a GOP before the keyframe.
      this.expFeed = this.seekStartBefore(targetIdx);
    }
    return new Promise<VideoFrame | null>((resolve) => {
      this.expWant = targetCts;
      this.expResolve = resolve;
      void this.pumpExport(targetIdx);
    });
  }

  private async pumpExport(targetIdx: number) {
    const dec = this.expDec;
    if (!dec) {
      this.expResolve?.(null);
      this.expResolve = null;
      return;
    }
    // Feed forward until the wanted frame emerges (onExportFrame clears
    // expResolve) or we've fed well past it. A SINGLE bounded feed can miss a
    // frame with deep B-frame reorder or open-GOP leading pictures: it never
    // pops out of the decoder, nothing re-feeds, and the export promise hangs
    // forever (observed mid-shot on open-GOP sources). So keep pumping — and
    // flush as a fallback to drain the reorder buffer — the way streamPull
    // stays alive. The common case resolves in the first window and exits the
    // loop immediately, so the fast path is unchanged.
    const end = Math.min(targetIdx + REORDER_AHEAD, this.cts.length - 1);
    for (let i = this.expFeed; i <= end; i++) {
      const buf = await this.file.slice(this.offsets[i], this.offsets[i] + this.sizes[i]).arrayBuffer();
      if (dec.state === 'closed') return;
      dec.decode(
        new EncodedVideoChunk({
          type: this.sync[i] ? 'key' : 'delta',
          timestamp: this.cts[i],
          duration: this.durs[i],
          data: new Uint8Array(buf),
        }),
      );
    }
    this.expFeed = end + 1;
    // Past the end with the frame still trapped in the reorder buffer → flush.
    if (this.expFeed >= this.cts.length && this.expResolve && dec.state === 'configured') {
      await dec.flush().catch(() => {});
      if (this.expResolve) {
        this.expResolve(null); // genuinely no such frame
        this.expResolve = null;
      }
    }
  }

  // ------------------------------------------------------ streaming decode

  /** (Re)start the forward streaming decoder at the first sample. When
   *  everyUs/pw/ph are given, streamPull decimates to that fps grid and
   *  downscales each kept frame in-worker. */
  streamReset(everyUs = 0, pw = 0, ph = 0) {
    this.strDec?.close();
    for (const f of this.strQueue) f.close();
    this.strQueue = [];
    this.strDec = new VideoDecoder({
      output: (f) => this.strQueue.push(f),
      error: (e) => {
        console.error('[velocut] stream decode error', e);
        this.strDec = null;
      },
    });
    this.strDec.configure(this.config);
    this.strFeed = 0;
    this.strEveryUs = everyUs;
    this.strNextUs = 0;
    this.strPw = pw;
    this.strPh = ph;
    if (everyUs > 0 && pw > 0 && ph > 0) {
      this.strCanvas = new OffscreenCanvas(pw, ph);
      this.strCtx = this.strCanvas.getContext('2d');
    } else {
      this.strCanvas = null;
      this.strCtx = null;
    }
  }

  /** Pop the next raw decoded frame (presentation order) from the queue,
   *  feeding the decoder in small batches as needed. Null at end of stream. */
  private async nextRawFrame(): Promise<VideoFrame | null> {
    const BATCH = 4; // bound resident 4K frames (~33MB each) — small on purpose
    for (;;) {
      if (this.strQueue.length) return this.strQueue.shift()!;
      if (!this.strDec || this.strDec.state === 'closed') return null;
      if (this.strFeed >= this.cts.length) {
        if (this.strDec.state === 'configured') await this.strDec.flush().catch(() => {});
        return this.strQueue.length ? this.strQueue.shift()! : null;
      }
      const batchEnd = Math.min(this.strFeed + BATCH, this.cts.length);
      for (let i = this.strFeed; i < batchEnd; i++) {
        const buf = await this.file.slice(this.offsets[i], this.offsets[i] + this.sizes[i]).arrayBuffer();
        if (!this.strDec) return null; // closed mid-feed (error callback / dispose)
        this.strDec.decode(
          new EncodedVideoChunk({
            type: this.sync[i] ? 'key' : 'delta',
            timestamp: this.cts[i],
            duration: this.durs[i],
            data: new Uint8Array(buf),
          }),
        );
      }
      this.strFeed = batchEnd;
      // Let the decoder drain this batch; reorder buffering may hold frames
      // until more input arrives, so loop back and feed the next batch.
      let spins = 0;
      while (!this.strQueue.length && this.strDec && this.strDec.decodeQueueSize > 0 && spins++ < 2000) {
        await new Promise<void>((r) => setTimeout(r, 1));
      }
    }
  }

  /** Next frame for the consumer. With a grid configured, skips off-grid source
   *  frames (e.g. 60→30 fps) and returns the kept ones rescaled to the proxy
   *  size — so only the frames actually encoded ever cross to the main thread,
   *  and at 1/9th the pixels. Without a grid, passes raw frames through. */
  async streamPull(): Promise<VideoFrame | null> {
    if (!(this.strEveryUs > 0 && this.strCtx && this.strCanvas)) return this.nextRawFrame();
    for (;;) {
      const f = await this.nextRawFrame();
      if (!f) return null;
      if (f.timestamp + 1 < this.strNextUs) {
        f.close(); // off the fps grid — drop without leaving the worker
        continue;
      }
      this.strCtx.drawImage(f, 0, 0, this.strPw, this.strPh);
      const ts = f.timestamp;
      f.close();
      // Advance the grid cursor past this frame's time.
      this.strNextUs = Math.floor(ts / this.strEveryUs) * this.strEveryUs + this.strEveryUs;
      return new VideoFrame(this.strCanvas, { timestamp: ts });
    }
  }

  streamDispose() {
    this.strDec?.close();
    this.strDec = null;
    for (const f of this.strQueue) f.close();
    this.strQueue = [];
    this.strFeed = 0;
    this.strCanvas = null;
    this.strCtx = null;
    this.strEveryUs = 0;
  }

  dispose() {
    if (this.stillCheck) clearTimeout(this.stillCheck);
    this.generation++;
    this.decoder?.close();
    this.decoder = null;
    this.expDec?.close();
    this.expDec = null;
    this.streamDispose();
    for (const f of this.expRing.values()) f.close();
    this.expRing.clear();
    this.offsets = [];
    this.sizes = [];
    this.cts = [];
    this.durs = [];
    this.sync = [];
    this.aOffsets = [];
    this.aSizes = [];
    this.aCts = [];
  }
}

// ------------------------------------------------------------- dispatch

const sources = new Map<number, Source>();

ctx.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'open': {
      const src = new Source(msg.id);
      sources.set(msg.id, src);
      src.load(msg.file).then(
        () => ctx.postMessage({ type: 'ready', id: msg.id, probe: src.probe } satisfies WorkerToMain),
        (err) => {
          sources.delete(msg.id);
          ctx.postMessage({
            type: 'openError',
            id: msg.id,
            message: String(err instanceof Error ? err.message : err),
          } satisfies WorkerToMain);
        },
      );
      break;
    }
    case 'target':
      sources.get(msg.id)?.steer(msg.timeUs, msg.playing);
      break;
    case 'audio': {
      const src = sources.get(msg.id);
      if (!src) break;
      src.decodeAudio(msg.fromUs, msg.durUs).then(
        (pcm) =>
          ctx.postMessage(
            {
              type: 'pcm',
              id: msg.id,
              reqId: msg.reqId,
              sampleRate: pcm.sampleRate,
              channels: pcm.channels,
              startUs: pcm.startUs,
              frames: pcm.planes[0]?.length ?? 0,
              planes: pcm.planes.map((p) => p.buffer as ArrayBuffer),
            } satisfies WorkerToMain,
            pcm.planes.map((p) => p.buffer as ArrayBuffer),
          ),
        (err) =>
          ctx.postMessage({
            type: 'pcmError',
            id: msg.id,
            reqId: msg.reqId,
            message: String(err instanceof Error ? err.message : err),
          } satisfies WorkerToMain),
      );
      break;
    }
    case 'frameAt': {
      const src = sources.get(msg.id);
      if (!src) {
        ctx.postMessage({ type: 'exportFrame', id: msg.id, reqId: msg.reqId, frame: null } satisfies WorkerToMain);
        break;
      }
      src.decodeFrameAt(msg.timeUs).then(
        (frame) =>
          ctx.postMessage(
            { type: 'exportFrame', id: msg.id, reqId: msg.reqId, frame } satisfies WorkerToMain,
            frame ? [frame as unknown as Transferable] : [],
          ),
        () =>
          ctx.postMessage({ type: 'exportFrame', id: msg.id, reqId: msg.reqId, frame: null } satisfies WorkerToMain),
      );
      break;
    }
    case 'streamReset':
      sources.get(msg.id)?.streamReset(msg.everyUs ?? 0, msg.pw ?? 0, msg.ph ?? 0);
      break;
    case 'streamPull': {
      const src = sources.get(msg.id);
      if (!src) {
        ctx.postMessage({ type: 'streamFrame', id: msg.id, reqId: msg.reqId, frame: null, cts: 0 } satisfies WorkerToMain);
        break;
      }
      src.streamPull().then(
        (frame) =>
          ctx.postMessage(
            { type: 'streamFrame', id: msg.id, reqId: msg.reqId, frame, cts: frame ? frame.timestamp : 0 } satisfies WorkerToMain,
            frame ? [frame as unknown as Transferable] : [],
          ),
        () =>
          ctx.postMessage({ type: 'streamFrame', id: msg.id, reqId: msg.reqId, frame: null, cts: 0 } satisfies WorkerToMain),
      );
      break;
    }
    case 'streamDispose':
      sources.get(msg.id)?.streamDispose();
      break;
    case 'dispose':
      sources.get(msg.id)?.dispose();
      sources.delete(msg.id);
      break;
  }
};
