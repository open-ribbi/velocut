import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_FORMAT_VERSION, migrateDocument, migrateDocumentOrThrow, DocumentFormatError } from '../src/migrate.ts';
import type { VDocument } from '../src/types.ts';

const doc = (): VDocument => ({
  id: 'doc_1',
  name: 'T',
  width: 1280,
  height: 720,
  fpsNum: 30,
  fpsDen: 1,
  assets: [],
  tracks: [],
  nextId: 1,
});

test('missing version is treated as the v1 baseline and loads as-is', () => {
  const r = migrateDocument(doc(), undefined);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.migratedFrom, null); // no migration when already current
});

test('explicit current version loads with no migration', () => {
  const r = migrateDocument(doc(), CURRENT_FORMAT_VERSION);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.migratedFrom, null);
});

test('a future version is refused, not corrupted', () => {
  const r = migrateDocument(doc(), CURRENT_FORMAT_VERSION + 1);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'future');
    assert.equal(r.version, CURRENT_FORMAT_VERSION + 1);
  }
});

test('a non-integer / <1 version is invalid', () => {
  assert.equal(migrateDocument(doc(), 0).ok, false);
  assert.equal(migrateDocument(doc(), 1.5).ok, false);
});

test('garbage that is not a document is rejected structurally', () => {
  assert.equal(migrateDocument(null, 1).ok, false);
  assert.equal(migrateDocument({ tracks: [] }, 1).ok, false); // missing assets
  assert.equal(migrateDocument({ assets: [], tracks: {} }, 1).ok, false); // tracks not an array
});

test('migrateDocumentOrThrow throws a typed error on refusal', () => {
  assert.throws(() => migrateDocumentOrThrow(doc(), CURRENT_FORMAT_VERSION + 1), (e: unknown) => {
    return e instanceof DocumentFormatError && e.reason === 'future';
  });
  const ok = migrateDocumentOrThrow(doc(), 1);
  assert.equal(ok.name, 'T');
});
