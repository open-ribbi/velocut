export type MediaTaskKind = 'preview' | 'observe' | 'export' | 'proxy';
type Lane = 'codec' | 'heavy';
const PRIORITY: Record<MediaTaskKind, number> = { preview: 3, observe: 2, export: 1, proxy: 0 };
class Preempted extends Error {}
interface Job<T = any> {
  kind: MediaTaskKind; lane: Lane; key?: string; signal?: AbortSignal;
  onDiscard?: (value: T) => void;
  operation: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void; reject: (error: unknown) => void;
  controller?: AbortController; removeListener?: () => void;
}

/** Host-local admission control. A running operation retains its slot until its
 * cleanup settles. Only idempotent proxy builds may be aborted and restarted. */
export class MediaTaskScheduler {
  private queue: Job[] = [];
  private running = new Set<Job>();
  private previewOwners = new Set<object>();
  private totals = { completed: 0, failed: 0, cancelled: 0, preemptions: 0, peakRunning: 0 };
  constructor(private limits = { codec: 2, heavy: 1, queued: 128 }) {
    for (const value of Object.values(limits)) if (!Number.isInteger(value) || value < 1) throw Error('Invalid media task budget');
  }
  snapshot() {
    return { ...this.totals, queued: this.queue.length, running: this.running.size,
      previewOwners: this.previewOwners.size,
      tasks: [...this.running, ...this.queue].map(job => ({kind:job.kind,lane:job.lane,state:this.running.has(job)?'running':'queued'})) };
  }
  setPreviewActive(owner: object, active: boolean) {
    if (active) this.previewOwners.add(owner); else this.previewOwners.delete(owner);
    if (active) this.preemptProxies();
    this.drain();
  }
  run<T>(kind: MediaTaskKind, operation: (signal: AbortSignal) => Promise<T>, options: {
    lane?: Lane; key?: string; signal?: AbortSignal; onDiscard?: (value: T) => void;
  } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.queue.length >= this.limits.queued) return Promise.reject(Error('Media task queue is full'));
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { kind, lane: options.lane ?? (kind === 'proxy' || kind === 'export' ? 'heavy' : 'codec'),
        key: options.key, signal: options.signal, onDiscard: options.onDiscard, operation, resolve, reject };
      const abort = () => {
        if (this.running.has(job)) job.controller!.abort(job.signal!.reason);
        else {
          this.queue = this.queue.filter(item => item !== job);
          job.removeListener?.(); this.totals.cancelled++; reject(job.signal!.reason); this.drain();
        }
      };
      job.signal?.addEventListener('abort', abort, {once:true});
      job.removeListener = () => job.signal?.removeEventListener('abort', abort);
      this.queue.push(job);
      if (kind !== 'proxy') this.preemptProxies();
      this.drain();
    });
  }
  private preemptProxies() {
    for (const job of this.running) if (job.kind === 'proxy' && !job.controller!.signal.aborted) {
      this.totals.preemptions++; job.controller!.abort(new Preempted('Proxy yielded to foreground media'));
    }
  }
  private drain() {
    this.queue.sort((a,b) => PRIORITY[b.kind] - PRIORITY[a.kind]);
    for (const job of [...this.queue]) {
      if (!this.queue.includes(job)) continue;
      if (job.kind === 'proxy' && (this.previewOwners.size || [...this.running, ...this.queue].some(other => other !== job && other.kind !== 'proxy'))) continue;
      if ([...this.running].filter(other => other.lane === job.lane).length >= this.limits[job.lane]) continue;
      if (job.key && [...this.running].some(other => other.key === job.key)) continue;
      this.queue.splice(this.queue.indexOf(job),1);
      this.running.add(job); job.controller = new AbortController();
      this.totals.peakRunning = Math.max(this.totals.peakRunning,this.running.size);
      void this.execute(job);
    }
  }
  private async execute(job: Job) {
    const signal = job.controller!.signal;
    try {
      const value = await job.operation(signal);
      if (signal.aborted) job.onDiscard?.(value);
      signal.throwIfAborted();
      this.totals.completed++; job.resolve(value);
    } catch (error) {
      if (signal.reason instanceof Preempted && !job.signal?.aborted) {
        this.queue.push(job); // Retry only after foreground work has relinquished resources.
      } else {
        if (signal.aborted) this.totals.cancelled++; else this.totals.failed++;
        job.reject(job.signal?.aborted ? job.signal.reason : error);
      }
    } finally {
      this.running.delete(job);
      if (!this.queue.includes(job)) job.removeListener?.();
      this.drain();
    }
  }
}

/** Shared by libraries in this JS realm; separate tabs/processes have separate budgets. */
export const mediaTasks = new MediaTaskScheduler();
