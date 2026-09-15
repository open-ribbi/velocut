import type { Store } from './store';
import type { MediaFileInfo } from '@velocut/render-sdk';
import { fault, object, integer } from './atomic-query';

export const RESOURCE_LIMITS = { fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, jobs: 128, running: 2, queued: 16 };
export const RESOURCES_SCHEMA = { type: 'object', additionalProperties: false, required: ['action', 'runtimeId'], properties: {
  action: { enum: ['import', 'get', 'list'] }, runtimeId: { type: 'string' }, requestId: { type: 'string' },
  file: { description: 'SDK File object only; use velocut_import_media for files from MCP.' },
  base64: { type: 'string', maxLength: Math.ceil(RESOURCE_LIMITS.fileBytes / 3) * 4 },
  name: { type: 'string', minLength: 1, maxLength: 256 }, mimeType: { type: 'string', maxLength: 128 }, resourceId: { type: 'string' },
  offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
}, description: 'import requires requestId and exactly one file/base64 payload; get requires resourceId; list accepts only offset/limit. Import does not probe/register/insert.' };
export const JOBS_SCHEMA = { type: 'object', additionalProperties: false, required: ['action', 'runtimeId'], properties: {
  action: { enum: ['submit', 'get', 'list', 'cancel'] }, runtimeId: { type: 'string' }, requestId: { type: 'string' },
  task: { const: 'media.probe' }, resourceId: { type: 'string' }, jobId: { type: 'string' },
  offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
}, description: 'submit requires requestId, task:media.probe, resourceId; get/cancel require jobId; list accepts only offset/limit. get never consumes a result.' };
export interface ResourceStorage {
  /** Logical filenames, confined to one project's storage. Never silently fall back to RAM. */
  write(name: string, data: Blob): Promise<void>;
  read(name: string): Promise<Blob | null>;
  remove(name: string): Promise<void>;
}
export interface MediaResourceAdapter {
  storage: ResourceStorage;
  probe(file: File, signal: AbortSignal): Promise<MediaFileInfo>;
}
const adapters = new WeakMap<Store, MediaResourceAdapter>();
export function configureMediaResources(store: Store, adapter: MediaResourceAdapter) {
  if (adapters.has(store)) throw new Error('Media resources are already bound; use a new Store for another project');
  adapters.set(store, adapter);
}
export interface MediaResource {
  id: string; name: string; mimeType: string; size: number; sha256: string; src: string;
}
type State = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled';
export interface ResourceJob {
  id: string; requestId: string; type: 'resource.import' | 'media.probe'; state: State;
  createdAt: string; updatedAt: string;
  result?: { resource: MediaResource } | { probeId: string; resourceId: string; sha256: string; metadata: MediaFileInfo };
  error?: { code: string; message: string }; cleanupWarning?: string;
}
type Entry = { job: ResourceJob; signature: string; controller: AbortController; run: () => Promise<ResourceJob['result']>; reserved: number; publish?: () => void; cleanup?: () => Promise<void> };
const id = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fault('invalidArg', `${field} must be a bounded identifier`, field);
};
async function digest(data: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await data.arrayBuffer());
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function createResourceJobs(store: Store, runtimeId: string) {
  const resources = new Map<string, { value: MediaResource; storage: ResourceStorage; storageName: string }>();
  const jobs = new Map<string, Entry>(), requestIds = new Map<string, string>(), queue: Entry[] = [];
  let running = 0, reservedBytes = 0, admittingBytes = 0;
  const copy = <T>(v: T): T => structuredClone(v);
  const touch = (entry: Entry, state: State) => { entry.job.state = state; entry.job.updatedAt = new Date().toISOString(); };
  const pump = () => {
    while (running < RESOURCE_LIMITS.running && queue.length) {
      const entry = queue.shift()!;
      if (entry.job.state === 'cancelled') continue;
      running++; touch(entry, 'running');
      void entry.run().then(result => {
        entry.controller.signal.throwIfAborted();
        entry.publish?.();
        entry.job.result = result; touch(entry, 'succeeded');
      }).catch(async error => {
        try { await entry.cleanup?.(); } catch (cleanup) { entry.job.cleanupWarning = `Partial resource cleanup failed: ${String(cleanup).slice(0, 500)}`; }
        touch(entry, entry.controller.signal.aborted ? 'cancelled' : 'failed');
        entry.job.error = { code: entry.controller.signal.aborted ? 'cancelled' : 'jobFailed', message: String(error instanceof Error ? error.message : error).slice(0, 2000) };
        reservedBytes -= entry.reserved; entry.reserved = 0;
      }).finally(() => { entry.run = async () => undefined; delete entry.publish; delete entry.cleanup; running--; pump(); });
    }
  };
  function submit(requestId: string, type: ResourceJob['type'], signature: string, reserved: number, task: (entry: Entry) => Promise<ResourceJob['result']>) {
    id(requestId, 'requestId');
    const previous = requestIds.get(requestId);
    if (previous) {
      const entry = jobs.get(previous)!;
      if (entry.signature !== signature) fault('requestConflict', 'job requestId was used for different input');
      return copy(entry.job);
    }
    if (jobs.size >= RESOURCE_LIMITS.jobs || queue.length >= RESOURCE_LIMITS.queued) fault('resourceLimit', 'job queue or retained job limit reached');
    if (reservedBytes + reserved > RESOURCE_LIMITS.totalBytes) fault('resourceLimit', 'resource byte budget exceeded');
    const jobId = `job_${crypto.randomUUID()}`, now = new Date().toISOString();
    const entry: Entry = { job: { id: jobId, requestId, type, state: 'queued', createdAt: now, updatedAt: now },
      signature, controller: new AbortController(), run: () => task(entry), reserved };
    jobs.set(jobId, entry); requestIds.set(requestId, jobId); reservedBytes += reserved; queue.push(entry);
    queueMicrotask(pump);
    return copy(entry.job);
  }
  function context(input: unknown, allowed: string[]) {
    object(input, allowed, 'resource/job request');
    if (input.runtimeId !== runtimeId) fault('staleRuntime', 'resource/job handles belong to a different runtime', 'runtimeId');
    return input;
  }
  const lookup = (resourceId: unknown) => {
    id(resourceId, 'resourceId'); const resource = resources.get(resourceId as string);
    if (!resource) fault('notFound', 'resource is not available in this project runtime');
    return resource;
  };
  async function readResource(resourceId: unknown) {
    const resource = lookup(resourceId);
    const blob = await resource.storage.read(resource.storageName);
    if (!blob || blob.size !== resource.value.size || await digest(blob) !== resource.value.sha256) fault('resourceChanged', 'resource bytes are missing or changed');
    return { resource, file: new File([blob], resource.value.name, { type: resource.value.mimeType }) };
  }
  const resource = async (input: unknown, signal?: AbortSignal) => {
    const p = context(input, Object.keys(RESOURCES_SCHEMA.properties));
    if (p.action === 'get') { object(p, ['action', 'runtimeId', 'resourceId'], 'resource.get'); return copy(lookup(p.resourceId).value); }
    if (p.action === 'list') {
      object(p, ['action', 'runtimeId', 'offset', 'limit'], 'resource.list');
      const offset = p.offset ?? 0, limit = p.limit ?? 50; integer(offset, 0, Number.MAX_SAFE_INTEGER, 'offset'); integer(limit, 1, 100, 'limit');
      const items = [...resources.values()].map(r => r.value);
      return copy({ items: items.slice(offset as number, (offset as number) + (limit as number)), total: items.length, nextOffset: (offset as number) + (limit as number) < items.length ? (offset as number) + (limit as number) : null });
    }
    if (p.action !== 'import') fault('invalidArg', 'resource action must be import, get or list');
    object(p, ['action', 'runtimeId', 'requestId', 'file', 'base64', 'name', 'mimeType'], 'resource.import');
    const adapter = adapters.get(store); if (!adapter) fault('unsupported', 'project media resource storage is not configured');
    id(p.requestId, 'requestId'); signal?.throwIfAborted();
    let file: File;
    if (p.file instanceof File && p.base64 === undefined) file = p.file;
    else if (typeof p.base64 === 'string' && p.file === undefined) {
      if (p.base64.length > Math.ceil(RESOURCE_LIMITS.fileBytes / 3) * 4 || p.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.base64)) fault('invalidArg', 'invalid or oversized base64 input');
      const decoded = atob(p.base64), bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      file = new File([bytes], typeof p.name === 'string' ? p.name : 'Imported media', { type: typeof p.mimeType === 'string' ? p.mimeType : '' });
    } else fault('invalidArg', 'provide one File or base64 payload');
    if (!file.size || file.size > RESOURCE_LIMITS.fileBytes) fault('resourceLimit', 'media files must contain 1 byte to 64 MiB');
    const name = p.name ?? file.name, mimeType = p.mimeType ?? file.type;
    if (typeof name !== 'string' || !name.trim() || name.length > 256 || typeof mimeType !== 'string' || mimeType.length > 128) fault('invalidArg', 'invalid resource name or mimeType');
    // Make an immutable byte snapshot before the job is accepted.
    const pendingBytes = [...jobs.values()].filter(e => ['queued', 'running', 'cancel_requested'].includes(e.job.state)).reduce((sum, e) => sum + e.reserved, 0);
    if (admittingBytes + pendingBytes + file.size > RESOURCE_LIMITS.totalBytes || (!requestIds.has(p.requestId as string) && reservedBytes + file.size > RESOURCE_LIMITS.totalBytes)) fault('resourceLimit', 'resource byte budget exceeded');
    admittingBytes += file.size;
    try {
      const snapshot = new Blob([await file.arrayBuffer()], { type: mimeType });
      const sha256 = await digest(snapshot); signal?.throwIfAborted();
      return submit(p.requestId as string, 'resource.import', JSON.stringify(['import', name, mimeType, file.size, sha256]), file.size, async entry => {
        const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1].toLowerCase() ?? 'bin';
        const storageName = `resource-${crypto.randomUUID()}.${ext}`;
        const value: MediaResource = { id: `resource_${crypto.randomUUID()}`, name, mimeType, size: snapshot.size, sha256, src: `opfs://${storageName}` };
        entry.cleanup = () => adapter.storage.remove(storageName);
        entry.controller.signal.throwIfAborted();
        await adapter.storage.write(storageName, snapshot);
        entry.controller.signal.throwIfAborted();
        entry.publish = () => { resources.set(value.id, { value, storage: adapter.storage, storageName }); };
        return { resource: value };
      });
    } finally { admittingBytes -= file.size; }
  };
  const job = (input: unknown) => {
    const p = context(input, Object.keys(JOBS_SCHEMA.properties));
    if (p.action === 'submit') {
      object(p, ['action', 'runtimeId', 'requestId', 'task', 'resourceId'], 'jobs.submit');
      if (p.task !== 'media.probe') fault('unsupported', 'the only supported task is media.probe');
      const adapter = adapters.get(store); if (!adapter) fault('unsupported', 'media probing is not configured');
      const resource = lookup(p.resourceId); id(p.requestId, 'requestId');
      return submit(p.requestId as string, 'media.probe', JSON.stringify(['probe', resource.value.id, resource.value.sha256]), 0, async entry => {
        entry.controller.signal.throwIfAborted();
        const { file } = await readResource(resource.value.id); entry.controller.signal.throwIfAborted();
        const metadata = await adapter.probe(file, entry.controller.signal); entry.controller.signal.throwIfAborted();
        if (!['image', 'video', 'audio'].includes(metadata.kind) || typeof metadata.format !== 'string' || metadata.format.length > 64 || !Number.isSafeInteger(metadata.durationUs) || metadata.durationUs < 0 || metadata.durationUs > 24 * 3600e6 ||
            !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 0 || metadata.height < 0 || metadata.width > 16384 || metadata.height > 16384 ||
            typeof metadata.hasAudio !== 'boolean' || !Array.isArray(metadata.tracks) || JSON.stringify(metadata).length > 32768) throw new Error('invalid or oversized media metadata');
        if (!metadata.tracks.every(t => ['video', 'audio'].includes(t.kind) && (t.codec === null || typeof t.codec === 'string' && t.codec.length <= 128) &&
          (t.sampleRate == null || Number.isInteger(t.sampleRate) && t.sampleRate > 0 && t.sampleRate <= 768000) &&
          (t.channels == null || Number.isInteger(t.channels) && t.channels > 0 && t.channels <= 64))) throw new Error('invalid media track metadata');
        // Whole-PCM audio attachment is still used by the renderer; keep this path bounded.
        if (metadata.kind === 'audio' && (metadata.durationUs > 300e6 || file.size > 16 * 1024 * 1024)) throw new Error('audio assets on this path are limited to 5 minutes and 16 MiB');
        return { probeId: entry.job.id, resourceId: resource.value.id, sha256: resource.value.sha256, metadata: copy(metadata) };
      });
    }
    if (p.action === 'list') {
      object(p, ['action', 'runtimeId', 'offset', 'limit'], 'jobs.list');
      const offset = p.offset ?? 0, limit = p.limit ?? 50; integer(offset, 0, Number.MAX_SAFE_INTEGER, 'offset'); integer(limit, 1, 100, 'limit');
      const items = [...jobs.values()].map(e => e.job);
      return copy({ items: items.slice(offset as number, (offset as number) + (limit as number)), total: items.length, nextOffset: (offset as number) + (limit as number) < items.length ? (offset as number) + (limit as number) : null });
    }
    if (p.action !== 'get' && p.action !== 'cancel') fault('invalidArg', 'job action must be submit, get, list or cancel');
    object(p, ['action', 'runtimeId', 'jobId'], 'jobs.get/cancel');
    id(p.jobId, 'jobId'); const entry = jobs.get(p.jobId as string); if (!entry) fault('notFound', 'job not found in this runtime');
    if (p.action === 'cancel' && ['queued', 'running', 'cancel_requested'].includes(entry.job.state)) {
      entry.controller.abort();
      if (entry.job.state === 'queued') { touch(entry, 'cancelled'); reservedBytes -= entry.reserved; entry.reserved = 0; queue.splice(queue.indexOf(entry), 1); entry.run = async () => undefined; }
      else touch(entry, 'cancel_requested');
    }
    return copy(entry.job);
  };
  async function registration(resourceId: string, probeId: string, name?: string) {
    const entry = jobs.get(probeId);
    if (!entry || entry.job.state !== 'succeeded' || entry.job.type !== 'media.probe' || !entry.job.result || !('metadata' in entry.job.result) || entry.job.result.resourceId !== resourceId)
      fault('invalidArg', 'registerAsset requires a successful probe of the same resource', 'probeId');
    const { resource } = await readResource(resourceId);
    const metadata = entry.job.result.metadata;
    return { type: 'addAsset' as const, kind: metadata.kind, name: name ?? resource.value.name, src: resource.value.src,
      durationUs: metadata.durationUs, width: metadata.width, height: metadata.height, hasAudio: metadata.hasAudio };
  }
  return { resource, job, registration, available: () => adapters.has(store), limits: RESOURCE_LIMITS };
}
