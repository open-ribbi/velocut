import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySceneEdits, type SceneEdit } from '../src/authoring.ts';
import type { SceneSpec } from '../src/types.ts';

const base: SceneSpec = { version: 1, durationUs: 2_000_000, props: [
  { id: 'a', model: 'prop/cube', position: { x: [{ t: 0, v: 1 }, { t: 1, v: 3 }], z: 7 }, rotationY: [{ t: 0, v: 10 }, { t: 1, v: 30 }], scale: { x: 2, y: 3 } },
  { id: 'b', model: 'prop/cube' }, { id: 'c', model: 'prop/cube' }, { id: 'd', model: 'prop/cube' },
] };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('batch transforms preserve omitted axes and animated paths, sampled absolute and relative', () => {
  const r = applySceneEdits(base, [
    { type: 'transform', ids: ['a', 'b'], timeS: 1, transform: { position: { x: 10 }, rotation: { y: 90 }, scale: { z: 4 } } },
    { type: 'transform', ids: ['a'], relative: true, transform: { position: { y: 1 }, rotation: { y: 15 }, scale: { x: 0.5 } } },
  ]);
  assert.deepEqual(r.spec.props![0].position, { x: [{ t: 0, v: 8 }, { t: 1, v: 10 }], y: 1.5, z: 7 });
  assert.deepEqual(r.spec.props![0].rotationY, [{ t: 0, v: 85 }, { t: 1, v: 105 }]);
  assert.deepEqual(r.spec.props![0].scale, { x: 1, y: 3, z: 4 });
  assert.equal(r.spec.props![1].position?.x, 10);
  assert.deepEqual(r.changedIds, ['a', 'b']);
  assert.deepEqual(base.props![0].position?.x, [{ t: 0, v: 1 }, { t: 1, v: 3 }]);
});

test('multi-root copies remap cross-root gaze and attachments and return complete ID maps', () => {
  const source: SceneSpec = { version: 1, durationUs: 2_000_000,
    characters: [{ id: 'hero', model: 'char/mannequin', gaze: { character: 'other' } }, { id: 'other', model: 'char/mannequin' }],
    props: [{ id: 'hat', model: 'prop/cube', attachTo: { character: 'hero', bone: 'head' } }],
  };
  const r = applySceneEdits(source, [{ type: 'duplicateMany', ids: ['hero', 'other'], copies: [{ prefix: 'pair1' }, { prefix: 'pair2', transform: { rotation: { y: 45 } } }] }]);
  assert.equal(r.spec.characters!.length, 6);
  assert.deepEqual(r.spec.characters![2].gaze, { character: 'pair1/other' });
  assert.equal(r.spec.props![2].attachTo!.character, 'pair2/hero');
  assert.deepEqual(r.copies[0], { prefix: 'pair1', rootIds: ['pair1/hero', 'pair1/other'], idMap: { hero: 'pair1/hero', other: 'pair1/other', hat: 'pair1/hat' } });
  assert.equal(r.createdIds.length, 6);
  assert.equal(r.spec.characters![4].rotationY, 45);
});

test('relative copy transforms retain selection spacing and do not move descendants twice', () => {
  const source: SceneSpec = { version: 1, durationUs: 1_000_000,
    groups: [{ id: 'g', position: { x: 2 } }],
    props: [{ id: 'p', parentId: 'g', model: 'prop/cube', position: { x: 1 } }, { id: 'q', model: 'prop/cube', position: { x: 8 } }],
  };
  const r = applySceneEdits(source, [{ type: 'duplicateMany', ids: ['g', 'q'], copies: [{ prefix: 'copy', relative: true, transform: { position: { x: 10 } } }] }]);
  assert.equal(r.spec.groups![1].position!.x, 12);
  assert.equal(r.spec.props!.find(p => p.id === 'copy/p')!.position!.x, 1);
  assert.equal(r.spec.props!.find(p => p.id === 'copy/q')!.position!.x, 18);
  assert.equal(r.spec.props!.find(p => p.id === 'copy/p')!.parentId, 'copy/g');
});

test('copy an assembly and lay out the copies in the same atomic batch', () => {
  const r = applySceneEdits({ version: 1, durationUs: 1_000_000 }, [
    { type: 'assembly', id: 'chair', recipe: { template: 'chair' } },
    { type: 'duplicateMany', ids: ['chair'], copies: [{ prefix: 'one' }, { prefix: 'two' }, { prefix: 'three' }] },
    { type: 'layout', ids: ['chair', 'one/chair', 'two/chair', 'three/chair'], layout: { mode: 'grid', columns: 2, spacing: { x: 2, z: 3 }, origin: { x: -1 } } },
    { type: 'assembly', id: 'one/chair', recipe: { template: 'chair', parameters: { width: 1.2 } } },
  ]);
  assert.deepEqual(r.spec.groups?.map(g => g.position), [{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 3 }, { x: 1, y: 0, z: 3 }]);
  assert.ok(r.spec.props!.filter(p => p.parentId === 'one/chair').every(p => p.id!.startsWith('one/chair/')));
});

test('line layout uses requested ID order and shifts keyframes at the sampled time', () => {
  const r = applySceneEdits(base, [{ type: 'layout', ids: ['b', 'a'], timeS: 1, layout: { mode: 'line', origin: { x: 5, y: 2 }, step: { x: -2, z: 1 } } }]);
  assert.deepEqual(r.spec.props![1].position, { x: 5, y: 2, z: 0 });
  assert.deepEqual(r.spec.props![0].position, { x: [{ t: 0, v: 1 }, { t: 1, v: 3 }], y: 2, z: 1 });
});

test('radial rings omit duplicate endpoint, arcs include endpoints and facing follows +Z', () => {
  const ring = applySceneEdits(base, [{ type: 'layout', ids: ['b', 'c', 'd'], layout: { mode: 'radial', radius: 2, center: { x: 1, z: 3 }, facing: 'inward' } }]);
  const ringProps = ring.spec.props!.slice(1);
  ringProps.forEach((p, i) => { close(Math.hypot((p.position!.x as number) - 1, (p.position!.z as number) - 3), 2); close(p.rotationY as number, 180 + i * 120); });
  const arc = applySceneEdits(base, [{ type: 'layout', ids: ['b', 'c', 'd'], layout: { mode: 'radial', radius: 2, center: {}, sweepAngle: -180, facing: 'tangent', rotationOffset: 10 } }]);
  close(arc.spec.props![1].position!.z as number, 2);
  close(arc.spec.props![3].position!.z as number, -2);
  close(arc.spec.props![2].rotationY as number, -170);
});

test('overlapping selections and mismatched parent frames are rejected without mutation', () => {
  const source: SceneSpec = { ...base, groups: [{ id: 'g' }], props: [{ id: 'p', parentId: 'g', model: 'prop/cube' }, { id: 'q', model: 'prop/cube' }] };
  const snapshot = JSON.stringify(source);
  for (const edit of [
    { type: 'transform', ids: ['g', 'p'], transform: { position: { x: 1 } } },
    { type: 'duplicateMany', ids: ['g', 'p'], copies: [{ prefix: 'copy' }] },
    { type: 'layout', ids: ['p', 'q'], layout: { mode: 'line', origin: {}, step: { x: 1 } } },
  ]) assert.throws(() => applySceneEdits(source, [edit as SceneEdit]), /descendant|parent frame/);
  assert.equal(JSON.stringify(source), snapshot);
});

test('late copy ID collisions roll back the entire candidate; bad inputs fail explicitly', () => {
  const snapshot = JSON.stringify(base);
  assert.throws(() => applySceneEdits(base, [{ type: 'duplicateMany', ids: ['b'], copies: [{ prefix: 'copy' }, { prefix: 'copy' }] }]), /duplicate object/);
  const invalid: unknown[] = [
    { type: 'transform', ids: ['b', 'b'], transform: { position: { x: 1 } } },
    { type: 'transform', ids: ['missing'], transform: { position: { x: 1 } } },
    { type: 'transform', ids: ['b'], transform: { position: { x: NaN } } },
    { type: 'transform', ids: ['b'], transform: { scale: { z: 0 } } },
    { type: 'transform', ids: ['b'], timeS: -1, transform: { rotation: { y: 1 } } },
    { type: 'layout', ids: ['b'], layout: { mode: 'grid', columns: 0, spacing: { x: 1, z: 1 }, origin: {} } },
    { type: 'layout', ids: ['b'], layout: { mode: 'radial', radius: -1, center: {} } },
    { type: 'layout', ids: ['b'], layout: { mode: 'radial', radius: 1, center: {}, face: 'inward' } },
    { type: 'layout', ids: ['b'], layout: { mode: 'grid', columns: 2, spacing: { x: 1, z: 1, y: 1 }, origin: {} } },
    { type: 'duplicateMany', ids: ['b'], copies: [{ prefix: 'copy', transform: null }] },
    { type: 'duplicateMany', ids: ['b'], copies: [{ prefix: 'copy', offset: { x: 2 } }] },
    { type: 'duplicateMany', ids: ['b'], copies: [{ prefix: 'copy', relative: 'yes', transform: { position: { x: 1 } } }] },
    { type: 'duplicateMany', ids: ['b'], copies: [] },
    { type: 'duplicateMany', ids: ['b'], copies: Array.from({ length: 101 }, (_, i) => ({ prefix: String(i) })) },
  ];
  for (const edit of invalid) assert.throws(() => applySceneEdits(base, [edit as SceneEdit]));
  assert.equal(JSON.stringify(base), snapshot);
});
