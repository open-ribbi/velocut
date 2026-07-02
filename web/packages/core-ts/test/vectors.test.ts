// Runs the SAME golden vectors as crates/velocut-core/tests/vectors.rs.
// Any divergence between the Rust and TS engines fails here.
// Run: node --experimental-strip-types --test packages/core-ts/test/vectors.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsEngine } from '../src/engine.ts';
import type { Command, VDocument } from '@velocut/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, '../../../../protocol/vectors');

type Step =
  | { apply: Command }
  | { applyErr: { cmd: Command; code: string } }
  | { undo: true }
  | { redo: true };

interface Vector {
  name: string;
  steps: Step[];
  expect: {
    clips?: Array<{
      id: string;
      trackId?: string;
      startUs?: number;
      durationUs?: number;
      sourceInUs?: number;
      speed?: number;
    }>;
    clipCounts?: Record<string, number>;
    eval?: Array<{
      timeUs: number;
      layers: Array<{ clipId: string; sourceTimeUs?: number; opacity?: number; x?: number }>;
    }>;
  };
}

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-3;

function findClip(doc: VDocument, id: string) {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id === id) return { trackId: track.id, clip };
    }
  }
  return null;
}

const files = readdirSync(vectorsDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

assert.ok(files.length > 0, 'no vectors found');

for (const file of files) {
  const vec: Vector = JSON.parse(readFileSync(join(vectorsDir, file), 'utf8'));
  test(`${file}: ${vec.name}`, () => {
    const engine = new TsEngine('test', 1920, 1080, 30, 1);

    vec.steps.forEach((step, i) => {
      if ('apply' in step) {
        const resp = engine.apply(step.apply);
        assert.ok(resp.ok, `step ${i}: expected ok, got ${JSON.stringify(resp)}`);
      } else if ('applyErr' in step) {
        const resp = engine.apply(step.applyErr.cmd);
        assert.ok(!resp.ok, `step ${i}: expected error, got ok`);
        if (!resp.ok) {
          assert.equal(resp.error.code, step.applyErr.code, `step ${i}: wrong error code`);
        }
      } else if ('undo' in step) {
        const resp = engine.undo();
        assert.ok(resp.ok, `step ${i}: nothing to undo`);
      } else if ('redo' in step) {
        const resp = engine.redo();
        assert.ok(resp.ok, `step ${i}: nothing to redo`);
      } else {
        assert.fail(`step ${i}: unknown step ${JSON.stringify(step)}`);
      }
    });

    const doc = engine.document();

    for (const want of vec.expect.clips ?? []) {
      const found = findClip(doc, want.id);
      assert.ok(found, `clip ${want.id} not found`);
      const { trackId, clip } = found!;
      if (want.trackId !== undefined) assert.equal(trackId, want.trackId, `${want.id} track`);
      if (want.startUs !== undefined) assert.equal(clip.startUs, want.startUs, `${want.id} startUs`);
      if (want.durationUs !== undefined)
        assert.equal(clip.durationUs, want.durationUs, `${want.id} durationUs`);
      if (want.sourceInUs !== undefined)
        assert.equal(clip.sourceInUs, want.sourceInUs, `${want.id} sourceInUs`);
      if (want.speed !== undefined) assert.ok(approx(clip.speed, want.speed), `${want.id} speed`);
    }

    for (const [trackId, count] of Object.entries(vec.expect.clipCounts ?? {})) {
      const track = doc.tracks.find((t) => t.id === trackId);
      assert.ok(track, `track ${trackId} not found`);
      assert.equal(track!.clips.length, count, `clip count on ${trackId}`);
    }

    for (const evalCase of vec.expect.eval ?? []) {
      const fg = engine.evaluate(evalCase.timeUs);
      assert.equal(
        fg.layers.length,
        evalCase.layers.length,
        `eval t=${evalCase.timeUs} layer count: got ${JSON.stringify(fg.layers)}`,
      );
      for (const want of evalCase.layers) {
        const layer = fg.layers.find((l) => l.clipId === want.clipId);
        assert.ok(layer, `eval t=${evalCase.timeUs} missing layer ${want.clipId}`);
        if (want.sourceTimeUs !== undefined)
          assert.equal(layer!.sourceTimeUs, want.sourceTimeUs, `t=${evalCase.timeUs} sourceTime`);
        if (want.opacity !== undefined)
          assert.ok(
            approx(layer!.transform.opacity, want.opacity),
            `t=${evalCase.timeUs} opacity: got ${layer!.transform.opacity}`,
          );
        if (want.x !== undefined)
          assert.ok(
            approx(layer!.transform.x, want.x),
            `t=${evalCase.timeUs} x: got ${layer!.transform.x}`,
          );
      }
    }
  });
}
