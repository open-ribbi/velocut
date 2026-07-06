// migrate.ts — the persisted-document format version + migration chain.
//
// The engine (Rust/TS) is a pure reducer over the CURRENT document shape; it
// knows nothing about historical formats. Versioning and migration are a concern
// of the PERSISTENCE boundary (collab-sdk's Yjs store, the editor's history kv):
// they read old bytes and must upgrade them to the shape the engine expects —
// or refuse loudly rather than silently corrupting.
//
// The value of this anchor is forward-looking: when the document schema next
// changes, a migration is REGISTERED here instead of old projects silently
// breaking. Today there are no migrations (v1 is the only shape ever shipped).

import type { VDocument } from './types.ts';

/** The document format the current build reads and writes. Bump when a change to
 *  the persisted Track/Asset/Clip/Document shape isn't backward-compatible, and
 *  register a migration below. */
export const CURRENT_FORMAT_VERSION = 1;

/** Persisted data written before versioning existed has no formatVersion field;
 *  it is, by definition, the first shape. This baseline is FIXED at 1 forever
 *  (never `CURRENT_FORMAT_VERSION`), so a bump correctly identifies old data as
 *  v1 and migrates it. */
const BASELINE_VERSION = 1;

/** A migration upgrades a document from version `k` to `k + 1`. It may mutate or
 *  replace the input; it must return the upgraded document. */
type Migration = (doc: VDocument) => VDocument;

/** Migrations keyed by the version they upgrade FROM. Empty today. Example for a
 *  future v1→v2 (e.g. a new required Track field):
 *    [1]: (doc) => { for (const t of doc.tracks) (t as any).newField ??= 0; return doc; },
 */
const MIGRATIONS: Record<number, Migration> = {};

export type MigrateResult =
  | { ok: true; doc: VDocument; migratedFrom: number | null }
  | { ok: false; reason: 'future'; version: number }
  | { ok: false; reason: 'invalid'; message: string };

/** Thrown by callers that can't express a typed result (e.g. HistoryTree.deserialize). */
export class DocumentFormatError extends Error {
  // Explicit fields (not constructor parameter properties) so this runs under
  // Node's `--experimental-strip-types`, which erases types but can't synthesize
  // parameter-property assignments.
  readonly reason: 'future' | 'invalid';
  readonly version?: number;
  constructor(message: string, reason: 'future' | 'invalid', version?: number) {
    super(message);
    this.name = 'DocumentFormatError';
    this.reason = reason;
    this.version = version;
  }
}

/**
 * Bring a reconstructed document up to the current format, or refuse.
 * - missing `storedVersion` → treated as v1 (every doc ever persisted is v1)
 * - `storedVersion` in the future → refuse (don't corrupt data from a newer app)
 * - otherwise → run the migration chain from `storedVersion` up to current
 *
 * The input must already be parsed into a VDocument-shaped object; this validates
 * only enough structure to catch garbage, not full schema conformance.
 */
export function migrateDocument(raw: unknown, storedVersion?: number): MigrateResult {
  let v = storedVersion ?? BASELINE_VERSION;
  if (!Number.isInteger(v) || v < 1) {
    return { ok: false, reason: 'invalid', message: `formatVersion 非法:${String(storedVersion)}` };
  }
  if (v > CURRENT_FORMAT_VERSION) {
    return { ok: false, reason: 'future', version: v };
  }
  const doc = raw as VDocument | null;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tracks) || !Array.isArray(doc.assets)) {
    return { ok: false, reason: 'invalid', message: '不是有效文档(缺 tracks/assets)。' };
  }
  const from = v;
  let cur = doc;
  while (v < CURRENT_FORMAT_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) return { ok: false, reason: 'invalid', message: `缺少 v${v}→v${v + 1} 的迁移。` };
    cur = m(cur);
    v++;
  }
  return { ok: true, doc: cur, migratedFrom: from === CURRENT_FORMAT_VERSION ? null : from };
}

/** migrateDocument, but throws DocumentFormatError on refusal — for callers whose
 *  signature can't return a typed result. */
export function migrateDocumentOrThrow(raw: unknown, storedVersion?: number): VDocument {
  const r = migrateDocument(raw, storedVersion);
  if (r.ok) return r.doc;
  if (r.reason === 'future') {
    throw new DocumentFormatError(`工程来自更新版本(格式 v${r.version} > v${CURRENT_FORMAT_VERSION})。`, 'future', r.version);
  }
  throw new DocumentFormatError(r.message, 'invalid');
}
