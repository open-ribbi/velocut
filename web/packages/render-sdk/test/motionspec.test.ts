// Unit tests for the declarative motion-spec validator (pure JSON in/out — the
// compile step needs a 2D canvas and is exercised in the browser, not here).
// Run: node --experimental-strip-types --test packages/render-sdk/test/motionspec.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMotionSpec } from '../src/motionspec.ts';

const minimal = () => ({
  version: 1,
  durationUs: 2_000_000,
  layers: [{ type: 'text', text: 'Hello', x: 100, y: 100 }],
});

test('a minimal text spec validates', () => {
  assert.equal(validateMotionSpec(minimal()), null);
});

test('keyframed values and easings validate', () => {
  const spec = minimal();
  (spec.layers[0] as Record<string, unknown>).opacity = [
    { t: 0, v: 0 },
    { t: 0.5, v: 1, ease: 'power2.out' },
  ];
  assert.equal(validateMotionSpec(spec), null);
});

test('non-object and missing-fields specs are rejected with a message', () => {
  assert.match(validateMotionSpec(null)!, /object/);
  assert.match(validateMotionSpec('nope')!, /object/);
  assert.ok(validateMotionSpec({ version: 1, layers: [] }) !== null, 'missing durationUs must fail');
  assert.ok(validateMotionSpec({ version: 1, durationUs: -5, layers: [] }) !== null, 'negative duration must fail');
});

test('an unknown layer type is rejected by name', () => {
  const spec = { version: 1, durationUs: 1_000_000, layers: [{ type: 'hologram' }] };
  assert.match(validateMotionSpec(spec)!, /hologram/);
});
