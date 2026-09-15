import { createResourceJobs, RESOURCES_SCHEMA, JOBS_SCHEMA } from './resource-jobs';
import { ATOMIC_COMMAND_SCHEMAS, COMMAND_CATALOG, TRANSACTION_SCHEMA, RESULT_FIELDS, commandDefinition, type NonBatch, type AtomicCommand, type Command, type Envelope, type VDocument, type TransactionRequest, type ResultField } from '@velocut/protocol';
import { TsEngine } from '@velocut/core-ts';
import { EFFECT_REGISTRY } from '@velocut/render-sdk';
import { SCENE_LIMITS } from '@velocut/scene-sdk';
import type { Store } from './store';
import { dispatchSceneAware } from './scene';
import { AtomicFault, fault, object, integer, validateQuery, queryDocument, documentSummary, QUERY_SCHEMA, QUERY_FIELDS } from './atomic-query';
export type { AtomicQuery } from './atomic-query';

const LIMITS = { operations: 200, requestBytes: null, responseBytes: null, snapshots: 8, documentBytes: null, requests: 128 };
type Result = { ok: true; data: unknown; revision: number; runtimeId: string } | {
  ok: false; error: { code: string; message: string; field?: string; operationId?: string; operationIndex?: number; retryable: boolean; outcome: 'not_committed' | 'unknown' }; runtimeId: string;
};
type TxOptions = { dispatch?: (command: Command) => Envelope; check?: (command: Command) => string | null; signal?: AbortSignal };
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) fault('invalidArg', 'request nesting exceeds 32');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v, depth + 1)]));
  fault('invalidArg', 'request must be finite JSON data');
}
function identifier(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fault('invalidArg', `${field} must be 1..128 identifier characters`, field);
}
function localRestriction(c: NonBatch, doc: VDocument) {
  if (c.type === 'addAsset' && !c.src.startsWith('opfs://') && !c.src.startsWith('scene://')) return 'atomic asset registration accepts project opfs:// resources or scene:// specs only; it does not import files';
  if (c.type === 'setAssetSpec' && !doc.assets.find(a => a.id === c.assetId)?.src.startsWith('scene://')) return 'atomic setAssetSpec supports scene assets only; motion authoring is not enabled';
  return null;
}
function entityChanges(before: VDocument, after: VDocument) {
  const groups = (d: VDocument) => ({ assets: d.assets, tracks: d.tracks.map(({ clips, ...t }) => ({ ...t, clipIds: clips.map(c => c.id) })), clips: d.tracks.flatMap(t => t.clips.map(c => ({ ...c, trackId: t.id }))) });
  const a = groups(before), b = groups(after);
  return Object.fromEntries((['assets', 'tracks', 'clips'] as const).map(kind => {
    const old = new Map(a[kind].map(e => [e.id, JSON.stringify(e)]));
    const next = new Map(b[kind].map(e => [e.id, JSON.stringify(e)]));
    return [kind, { created: [...next.keys()].filter(id => !old.has(id)), removed: [...old.keys()].filter(id => !next.has(id)), updated: [...next.keys()].filter(id => old.has(id) && old.get(id) !== next.get(id)) }];
  }));
}

/** Shared by transports and the UI. Records live only as long as this Store. */
export function createAtomicRuntime(store: Store) {
  const runtimeId = crypto.randomUUID();
  const mediaJobs = createResourceJobs(store, runtimeId);
  const snapshots = new Map<string, { doc: VDocument; revision: number }>();
  const requests = new Map<string, { payload: string; state: 'pending' | 'completed'; result?: Result; promise: Promise<Result> }>();
  const ok = (data: unknown, revision = store.getState().revision): Result => {
    const result = { ok: true as const, data, revision, runtimeId };
    return structuredClone(result);
  };
  const error = (e: unknown, operationId?: string, operationIndex?: number, outcome: 'not_committed' | 'unknown' = 'not_committed'): Result => ({ ok: false,
    error: { code: e instanceof AtomicFault ? e.code : 'invalidArg', message: e instanceof Error ? e.message : String(e),
      ...(e instanceof AtomicFault && e.field ? { field: e.field } : {}), ...(operationId ? { operationId } : {}), ...(operationIndex !== undefined ? { operationIndex } : {}),
      retryable: e instanceof AtomicFault && e.code === 'conflict', outcome: e instanceof AtomicFault && e.code === 'staleRuntime' ? 'unknown' : outcome }, runtimeId });
  const checkRuntime = (id: unknown) => { if (id !== runtimeId) fault('staleRuntime', 'runtime changed; old requests cannot be replayed. Read state and reconcile first.', 'runtimeId'); };
  const normalize = (input: unknown) => canonical(input);

  const query = (input: unknown): Result => {
    try {
      const q = validateQuery(normalize(input));
      if (q.kind === 'selection') { const s = store.getState(); return ok({ clipIds: s.selectedClipIds, activeClipId: s.selectedClipId }); }
      const snapshot = q.snapshotId ? snapshots.get(q.snapshotId) : undefined;
      if (q.snapshotId && !snapshot) fault('snapshotExpired', 'snapshot is unavailable; never fall back to live data', 'snapshotId');
      const state = store.getState(), doc = snapshot?.doc ?? state.doc, revision = snapshot?.revision ?? state.revision;
      if (q.kind === 'snapshot') {
        const snapshotId = crypto.randomUUID();
        if (snapshots.size >= LIMITS.snapshots) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(snapshotId, { doc: structuredClone(doc), revision });
        return ok({ snapshotId, document: documentSummary(doc) }, revision);
      }
      return ok(queryDocument(doc, q), revision);
    } catch (e) { return error(e); }
  };

  const capabilities = (input: unknown = {}, context: { preview?: boolean; transport?: string } = {}): Result => {
    try {
      const q = normalize(input); object(q, ['name', 'namespace', 'offset', 'limit'], 'capabilities');
      const names = Object.keys(ATOMIC_COMMAND_SCHEMAS) as AtomicCommand['type'][];
      const entries = [
        ...names.map(name => ({ name, namespace: 'commands', category: 'command', available: name === 'registerAsset' ? mediaJobs.available() : true, transactional: true, summary: name === 'registerAsset' ? 'Register a probed project resource without inserting a clip' : COMMAND_CATALOG.find(c => c.type === name)!.summary })),
        { name: 'query', namespace: 'runtime', category: 'query', available: true, transactional: false, summary: 'Snapshot/entity queries, projection and pagination. Selection is live only.' },
        { name: 'transaction', namespace: 'runtime', category: 'command', available: true, transactional: false, summary: 'Validate/commit/status; requires runtimeId, expectedRevision and a requestId for commit.' },
        ...['sceneEdit', 'sceneArrange', 'sceneInspect', 'sceneGeometry', 'sceneAssets', 'sceneClip', 'directorSession', 'observe'].map(name => ({ name, namespace: 'legacy', category: name.includes('Inspect') || name === 'sceneAssets' ? 'query' : name === 'observe' ? 'observe' : name === 'directorSession' ? 'session' : 'command', available: !!context.transport, transactional: false, summary: 'Existing separate API; not an operation within the new transaction.' })),
        { name: 'previewSession', namespace: 'legacy', category: 'session', available: !!context.preview, transactional: false, summary: 'Requires a configured preview transport.' },
        ...['tts', 'motionClip', 'videoGen'].map(name => ({ name, namespace: 'legacy', category: 'job',
          available: !!context.transport && context.transport !== 'mcp', transactional: false,
          summary: name === 'videoGen' ? 'Legacy editor/builtin-agent entry; requires a configured channel (configuration is not inspected here). Disabled in MCP.' : 'Legacy editor/builtin-agent entry, outside document transactions. Disabled in MCP.',
        })),
        { name: 'resource.import', namespace: 'runtime', category: 'job', available: mediaJobs.available(), transactional: false, summary: 'resources action:import (SDK File/base64), or MCP velocut_import_media with an explicit path. Returns an import job only.' },
        { name: 'media.probe', namespace: 'runtime', category: 'job', available: mediaJobs.available(), transactional: false, summary: 'jobs action:submit, task:media.probe, resourceId and requestId. Returns a metadata-probe job only.' },
        ...['resources', 'jobs'].map(name => ({ name, namespace: 'runtime', category: 'job', available: mediaJobs.available(), transactional: false, summary: 'Runtime-scoped resource import/probe jobs. Explicit registration and insertion are separate operations.' })),
        ...['transcribe', 'renderVideo'].map(name => ({ name, namespace: 'pending', category: 'job', available: false, transactional: false, summary: 'No unified callable entry by this name. Existing app/discrete tools may have separate entry points.' })),
      ];
      if (q.name !== undefined) {
        if (typeof q.name !== 'string') fault('invalidArg', 'name must be a string');
        const entry = entries.find(e => e.name === q.name); if (!entry) fault('notFound', 'unknown capability');
        return ok({ ...entry, ...(names.includes(q.name as AtomicCommand['type']) ? commandDefinition(q.name as AtomicCommand['type']) : q.name === 'query' ? { inputSchema: QUERY_SCHEMA, fieldCatalog: QUERY_FIELDS } : q.name === 'transaction' ? { inputSchema: TRANSACTION_SCHEMA } : q.name === 'resources' || q.name === 'resource.import' ? { inputSchema: RESOURCES_SCHEMA, limits: mediaJobs.limits } : q.name === 'jobs' || q.name === 'media.probe' ? { inputSchema: JOBS_SCHEMA, limits: mediaJobs.limits } : {}),
          ...(q.name === 'observe' ? { modes: ['frame', 'contact', 'scan', 'audio', 'shots', 'scene'], scriptImages: false } : {}) });
      }
      if (q.namespace !== undefined && !['commands', 'runtime', 'legacy', 'pending', 'effects'].includes(q.namespace as string)) fault('invalidArg', 'unknown namespace');
      const offset = q.offset ?? 0, limit = q.limit ?? 50; integer(offset, 0, Number.MAX_SAFE_INTEGER, 'offset'); integer(limit, 1, 100, 'limit');
      const list = q.namespace === 'effects' ? Object.values(EFFECT_REGISTRY).map(({ name, label, params, aiHint }) => ({ name, label, params, summary: aiHint, namespace: 'effects' })) : entries.filter(e => !q.namespace || e.namespace === q.namespace);
      return ok({ schemaVersion: 1, transport: context.transport ?? 'runtime', retention: 'in-memory Store lifetime; runtimeId changes after reload', limits: LIMITS, sceneLimits: SCENE_LIMITS,
        constraints: ['Command schemas describe resolved inputs; listed referenceFields also accept ref(operationId, field).', 'Asset registration is metadata only; no automatic import or insertion.', 'setAssetSpec is limited to scene assets; cloud/motion jobs are not transaction operations.', 'Ranges use integer microseconds and half-open overlap tests; scene properties remain parent-local as documented.'],
        items: list.slice(offset as number, (offset as number) + (limit as number)), total: list.length, nextOffset: (offset as number) + (limit as number) < list.length ? (offset as number) + (limit as number) : null });
    } catch (e) { return error(e); }
  };

  const execute = async (plan: Exclude<TransactionRequest, { action: 'status' }>, options: TxOptions): Promise<Result> => {
    let operationId: string | undefined, operationIndex: number | undefined, submitting = false;
    try {
      options.signal?.throwIfAborted();
      const before = store.getState();
      if (before.revision !== plan.expectedRevision) fault('conflict', 'document changed; query again', 'expectedRevision');
      const engine = new TsEngine(); engine.load(before.doc);
      const resolved: NonBatch[] = [], results = new Map<string, Partial<Record<ResultField, string>>>();
      for (const [i, operation] of plan.operations.entries()) {
        operationIndex = i; operationId = undefined;
        object(operation, ['id', 'command'], 'operation'); identifier(operation.id, 'id'); operationId = operation.id;
        if (results.has(operation.id)) fault('invalidArg', 'duplicate operation id', 'id');
        const command = structuredClone(operation.command) as unknown as Record<string, unknown>;
        if (!command || typeof command !== 'object' || typeof command.type !== 'string' || !Object.hasOwn(ATOMIC_COMMAND_SCHEMAS, command.type)) fault('unsupported', 'unknown command or nested batch; use an operation sequence', 'command.type');
        const schema = ATOMIC_COMMAND_SCHEMAS[command.type as AtomicCommand['type']];
        for (const field of ['assetId', 'trackId', 'clipId', 'effectId']) {
          const value = command[field];
          if (!value || typeof value !== 'object') continue;
          object(value, ['$ref'], field); object(value.$ref, ['operationId', 'field'], `${field}.$ref`);
          const ref = value.$ref;
          if (typeof ref.operationId !== 'string' || !RESULT_FIELDS.includes(ref.field as ResultField)) fault('invalidRef', 'invalid operation result reference', field);
          const result = results.get(ref.operationId)?.[ref.field as ResultField];
          if (!result) fault('invalidRef', 'reference must name an existing result of an earlier operation', field);
          command[field] = result;
        }
        const parsed = schema.strict().safeParse(command);
        if (!parsed.success) { const issue = parsed.error.issues[0]; fault('invalidArg', issue.message, issue.path.join('.')); }
        const parsedCommand = parsed.data as AtomicCommand;
        const c: NonBatch = parsedCommand.type === 'registerAsset' ? await mediaJobs.registration(parsedCommand.resourceId, parsedCommand.probeId, parsedCommand.name) : parsedCommand;
        const blocked = localRestriction(c, engine.document()) ?? options.check?.(c);
        if (blocked) fault('unsupported', blocked);
        const oldEffects = c.type === 'addEffect' ? new Set(engine.document().tracks.flatMap(t => t.clips).find(c0 => c0.id === c.clipId)?.effects.map(e => e.id)) : new Set();
        const applied = engine.apply(c); if (!applied.ok) fault(applied.error.code, applied.error.message);
        const output: Partial<Record<ResultField, string>> = {};
        for (const e of applied.events) {
          if (e.kind === 'assetAdded') output.assetId = e.assetId;
          if (e.kind === 'trackAdded') output.trackId = e.trackId;
          if (e.kind === 'clipAdded') { if (c.type === 'splitClip') { output.leftClipId = c.clipId; output.rightClipId = e.clipId; } else output.clipId = e.clipId; }
        }
        if (c.type === 'addEffect') output.effectId = engine.document().tracks.flatMap(t => t.clips).find(c0 => c0.id === c.clipId)?.effects.find(e => !oldEffects.has(e.id))?.id;
        results.set(operation.id, output); resolved.push(c);
        engine.load(engine.document()); // Drop simulation undo snapshots between operations.
      }
      operationId = undefined; operationIndex = undefined;
      const data = { state: plan.action === 'validate' ? 'validated' : 'committed', results: Object.fromEntries(results), changes: entityChanges(before.doc, engine.document()) };
      ok(data, before.revision); // Ensure the reply can be cloned before mutation.
      const dispatch = (command: Command) => {
        options.signal?.throwIfAborted();
        if (store.getState().revision !== before.revision) fault('conflict', 'document changed while preparing transaction');
        submitting = true;
        return options.dispatch ? options.dispatch(command) : store.dispatch(command);
      };
      const applied = await dispatchSceneAware(store, { type: 'batch', commands: resolved }, dispatch, { dryRun: plan.action === 'validate' });
      if (!applied.ok) { submitting = submitting && store.getState().revision !== before.revision; fault(applied.error.code, applied.error.message); }
      if (plan.action === 'validate') { options.signal?.throwIfAborted(); if (store.getState().revision !== before.revision) fault('conflict', 'document changed during validation'); }
      return ok(data, plan.action === 'validate' ? before.revision : store.getState().revision);
    } catch (e) { return error(e, operationId, operationIndex, submitting ? 'unknown' : 'not_committed'); }
  };

  const transaction = async (input: unknown, options: TxOptions = {}): Promise<Result> => {
    try {
      const p = normalize(input); object(p, ['action', 'runtimeId', 'requestId', 'expectedRevision', 'operations'], 'transaction');
      checkRuntime(p.runtimeId);
      if (p.action === 'status') {
        if ('operations' in p || 'expectedRevision' in p) fault('invalidArg', 'status only accepts runtimeId/requestId');
        identifier(p.requestId, 'requestId');
        const entry = requests.get(p.requestId as string);
        return ok(entry ? { state: entry.state, result: entry.result } : { state: 'unknown', message: 'No record in this runtime; inspect before retrying.' });
      }
      if (p.action !== 'commit' && p.action !== 'validate') fault('invalidArg', 'action must be validate, commit or status');
      integer(p.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      if (!Array.isArray(p.operations) || !p.operations.length || p.operations.length > LIMITS.operations) fault('invalidArg', 'operations must contain 1..200 entries', 'operations');
      if (p.action === 'validate') {
        if (p.requestId !== undefined) fault('invalidArg', 'validation does not accept requestId');
        return execute(p as unknown as TransactionRequest & { action: 'validate' }, options);
      }
      identifier(p.requestId, 'requestId'); const requestId = p.requestId as string, payload = JSON.stringify(p);
      const existing = requests.get(requestId);
      if (existing) {
        if (existing.payload !== payload) fault('requestConflict', 'requestId was already used for a different payload');
        return structuredClone(await existing.promise);
      }
      if (requests.size >= LIMITS.requests) fault('resourceLimit', 'transaction journal is full; retained request IDs are never silently evicted');
      const promise = Promise.resolve().then(() => execute(p as unknown as TransactionRequest & { action: 'commit' }, options));
      const entry: { payload: string; state: 'pending' | 'completed'; result?: Result; promise: Promise<Result> } = { payload, state: 'pending', promise };
      requests.set(requestId, entry);
      const result = await promise; entry.result = structuredClone(result); entry.state = 'completed';
      return structuredClone(result);
    } catch (e) { return error(e); }
  };
  const resources = async (input: unknown, signal?: AbortSignal): Promise<Result> => { try { return ok(await mediaJobs.resource(input, signal)); } catch (e) { return error(e); } };
  const jobs = (input: unknown): Result => { try { return ok(mediaJobs.job(input)); } catch (e) { return error(e); } };
  return { runtimeId, capabilities, query, transaction, resources, jobs };
}
const runtimes = new WeakMap<Store, ReturnType<typeof createAtomicRuntime>>();
export function atomicRuntime(store: Store) {
  let runtime = runtimes.get(store); if (!runtime) { runtime = createAtomicRuntime(store); runtimes.set(store, runtime); }
  return runtime;
}
