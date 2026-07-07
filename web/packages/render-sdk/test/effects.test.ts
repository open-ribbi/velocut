// Unit tests for the effect/transition registry's pure logic (no GPU, no DOM).
// Run: node --experimental-strip-types --test packages/render-sdk/test/effects.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFECT_REGISTRY,
  TRANSITIONS,
  transitionWgsl,
  resolveColorAdjust,
  effectPromptDoc,
} from '../src/effects.ts';

test('the transition registry holds the built-ins and resolves WGSL by kind', () => {
  assert.ok(TRANSITIONS.length >= 11, `expected >= 11 transitions, got ${TRANSITIONS.length}`);
  const dissolve = TRANSITIONS.find((t) => t.kind === 'dissolve');
  assert.ok(dissolve);
  assert.equal(dissolve!.label, 'Dissolve');
  assert.match(transitionWgsl('dissolve')!, /mix\(/);
  assert.equal(transitionWgsl('no-such-kind'), undefined);
});

test('resolveColorAdjust starts from the no-op grade', () => {
  const g = resolveColorAdjust([]);
  assert.equal(g.brightness, 0);
  assert.equal(g.contrast, 1);
  assert.equal(g.saturation, 1);
  assert.equal(g.exposure, 0);
  assert.equal(g.temperature, 0);
});

test('resolveColorAdjust folds known effect params and ignores unknown effects', () => {
  const g = resolveColorAdjust([
    { effect: 'colorGrade', params: { temperature: -0.25, contrast: 1.2 } },
    { effect: 'notARealEffect', params: { contrast: 99 } },
  ]);
  assert.equal(g.temperature, -0.25);
  assert.equal(g.contrast, 1.2);
  assert.equal(g.saturation, 1); // untouched param keeps its default
});

test('every registered effect with params declares defaults inside its min/max', () => {
  for (const e of Object.values(EFFECT_REGISTRY)) {
    for (const p of e.params) {
      assert.ok(
        p.default >= p.min && p.default <= p.max,
        `${e.name}.${p.key}: default ${p.default} outside [${p.min}, ${p.max}]`,
      );
    }
  }
});

test('effectPromptDoc documents the registry under the heading schema.ts points at', () => {
  const doc = effectPromptDoc();
  // schema.ts's addEffect summary says: params: see "color grading".
  assert.match(doc, /^## Color grading \/ effects/m);
  assert.match(doc, /colorGrade/);
  assert.match(doc, /brightnessContrast/);
});
