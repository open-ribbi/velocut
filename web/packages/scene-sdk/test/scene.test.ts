// Unit tests for the pure parts of scene-sdk: spec validation and the action
// sequencing math (deterministic pose resolution). The GL compiler is covered
// by the Playwright E2E path (real browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSceneSpec } from '../src/types.ts';
import { resolveActions, type ClipMeta } from '../src/actions.ts';

// ---------------------------------------------------------------- validation

const base = { version: 1 as const, durationUs: 3_000_000 };

test('validateSceneSpec: accepts a minimal spec and a full spec', () => {
  assert.equal(validateSceneSpec(base), null);
  assert.equal(
    validateSceneSpec({
      ...base,
      environment: 'env/stage',
      lighting: 'night',
      characters: [
        {
          id: 'hero',
          model: 'char/robot',
          position: { x: [{ t: 0, v: -3 }, { t: 3, v: 0 }], z: 0 },
          rotationY: 90,
          actions: [
            { clip: 'Walking', start: 0 },
            { clip: 'Wave', start: 2, fade: 0.4 },
          ],
        },
      ],
      props: [
        { model: 'prop/cube', position: { x: 2 }, color: '#ff0000' },
        { model: 'prop/pillar', position: { x: 1 }, scale: { x: 0.2, y: 3, z: 0.2 } },
        { model: 'prop/sphere', scale: 1.5 },
      ],
      camera: { fov: 35, position: { x: 5, y: 2, z: 7 }, lookAt: { character: 'hero' } },
    }),
    null,
  );
});

test('validateSceneSpec: rejection table', () => {
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/],
    [{ version: 2, durationUs: 1 }, /version/],
    [{ ...base, durationUs: 0 }, /durationUs/],
    [{ ...base, characters: [{ model: 'char/robot' }] }, /string id/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x' }, { id: 'a', model: 'char/x' }] }, /duplicate/],
    [{ ...base, characters: [{ id: 'a', model: 5 }] }, /model/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', actions: [{ clip: 'Walk', start: -1 }] }] }, /start/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', position: { x: 'left' } }] }, /position/],
    [{ ...base, camera: { lookAt: { charcter: 'typo' } } }, /lookAt/],
    [{ ...base, props: [{ position: {} }] }, /model/],
    [{ ...base, props: [{ model: 'prop/cube', scale: 'big' }] }, /scale/],
    [{ ...base, props: [{ model: 'prop/cube', scale: { x: 1, w: 2 } }] }, /scale/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', scale: { y: NaN } }] }, /scale/],
  ];
  for (const [spec, re] of bad) {
    const err = validateSceneSpec(spec);
    assert.ok(err && re.test(err), `expected ${re} for ${JSON.stringify(spec)}, got: ${err}`);
  }
});

// ------------------------------------------------------------ action math

const CLIPS: Record<string, ClipMeta> = {
  Walking: { duration: 1.0, loop: true },
  Wave: { duration: 2.0, loop: false },
  Idle: { duration: 4.0, loop: true },
};

test('resolveActions: single looping action wraps its local time', () => {
  const seq = [{ clip: 'Walking', start: 0 }];
  const p = resolveActions(seq, 2.25, CLIPS);
  assert.equal(p.length, 1);
  assert.equal(p[0].clip, 'Walking');
  assert.ok(Math.abs(p[0].time - 0.25) < 1e-9);
  assert.equal(p[0].weight, 1);
});

test('resolveActions: non-looping action holds its last pose', () => {
  const seq = [{ clip: 'Wave', start: 1 }];
  const p = resolveActions(seq, 10, CLIPS);
  assert.equal(p[0].clip, 'Wave');
  assert.ok(p[0].time < 2.0 && p[0].time > 1.99);
});

test('resolveActions: cross-fade blends the previous and current action', () => {
  const seq = [
    { clip: 'Walking', start: 0 },
    { clip: 'Wave', start: 2, fade: 0.5 },
  ];
  // Mid-fade at t=2.25 → Walking 0.5, Wave 0.5; Walking keeps advancing.
  const p = resolveActions(seq, 2.25, CLIPS);
  assert.equal(p.length, 2);
  const walk = p.find((x) => x.clip === 'Walking')!;
  const wave = p.find((x) => x.clip === 'Wave')!;
  assert.ok(Math.abs(walk.weight - 0.5) < 1e-9);
  assert.ok(Math.abs(wave.weight - 0.5) < 1e-9);
  assert.ok(Math.abs(walk.time - 0.25) < 1e-9); // 2.25 % 1.0
  assert.ok(Math.abs(wave.time - 0.25) < 1e-9); // 2.25 - 2
  // After the fade → only Wave.
  const after = resolveActions(seq, 2.75, CLIPS);
  assert.equal(after.length, 1);
  assert.equal(after[0].clip, 'Wave');
  assert.equal(after[0].weight, 1);
});

test('resolveActions: before the first action → its first frame', () => {
  const seq = [{ clip: 'Wave', start: 5 }];
  const p = resolveActions(seq, 1, CLIPS);
  assert.equal(p[0].clip, 'Wave');
  assert.equal(p[0].time, 0);
});

test('resolveActions: unknown clips are skipped, same-clip fade collapses', () => {
  assert.equal(resolveActions([{ clip: 'Nope', start: 0 }], 1, CLIPS).length, 0);
  const seq = [
    { clip: 'Walking', start: 0 },
    { clip: 'Walking', start: 2, fade: 1 },
  ];
  const p = resolveActions(seq, 2.5, CLIPS);
  assert.equal(p.length, 1);
  assert.equal(p[0].weight, 1);
});

test('resolveActions: determinism — same inputs, same output', () => {
  const seq = [
    { clip: 'Idle', start: 0 },
    { clip: 'Walking', start: 1.5, fade: 0.3 },
    { clip: 'Wave', start: 4, fade: 0.3 },
  ];
  for (const t of [0, 0.7, 1.6, 1.79, 3.2, 4.1, 4.29, 9]) {
    assert.deepEqual(resolveActions(seq, t, CLIPS), resolveActions(seq, t, CLIPS));
  }
});
