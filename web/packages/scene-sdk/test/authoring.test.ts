import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySceneEdits, normalizeSceneSpec } from '../src/authoring.ts';
import { validateSceneSpec, type SceneSpec } from '../src/types.ts';

const base: SceneSpec = { version: 1, durationUs: 2_000_000 };

test('legacy prop IDs are deterministic, collision-free and stable across commits', () => {
  const old: SceneSpec = { ...base, props: [{ model: 'prop/cube' }, { id: 'prop_1', model: 'prop/sphere' }] };
  const normalized = normalizeSceneSpec(old);
  assert.deepEqual(normalized.props?.map((p) => p.id), ['prop_2', 'prop_1']);
  assert.equal(old.props![0].id, undefined);
  const next = applySceneEdits(normalized, [{ type: 'remove', id: 'prop_1' }]).spec;
  assert.equal(normalizeSceneSpec(next).props![0].id, 'prop_2');
});

test('group duplication remaps hierarchy, bone attachments and internal gaze', () => {
  const source: SceneSpec = { ...base, groups: [{ id: 'table' }],
    characters: [{ id: 'a', parentId: 'table', model: 'char/mannequin', gaze: { character: 'b' } },
      { id: 'b', parentId: 'table', model: 'char/mannequin' }],
    props: [{ id: 'cup', model: 'prop/lathe', points: [[0.1, 0], [0.2, 1]], attachTo: { character: 'a', bone: 'handR' } }] };
  const { spec, changedIds } = applySceneEdits(source, [{ type: 'duplicate', id: 'table', newId: 'second', offset: { x: 3 } }]);
  assert.equal(spec.groups![1].position?.x, 3);
  assert.equal(spec.characters![2].parentId, 'second');
  assert.deepEqual(spec.characters![2].gaze, { character: 'second/b' });
  assert.equal(spec.props![1].attachTo!.character, 'second/a');
  assert.equal(changedIds.length, 4);
  assert.equal(source.characters!.length, 2);
});

test('batch failure is atomic; references and hierarchy cannot silently break', () => {
  const source: SceneSpec = { ...base, groups: [{ id: 'g' }], props: [{ id: 'p', parentId: 'g', model: 'prop/cube' }] };
  const before = JSON.stringify(source);
  assert.throws(() => applySceneEdits(source, [
    { type: 'update', id: 'p', patch: { color: '#ff0000' } },
    { type: 'update', id: 'g', patch: { parentId: 'g' } },
  ]), /cycle/);
  assert.equal(JSON.stringify(source), before);
  assert.throws(() => applySceneEdits(source, [{ type: 'remove', id: 'g' }]), /children/);
  assert.equal(applySceneEdits(source, [{ type: 'remove', id: 'g', cascade: true }]).spec.props?.length, 0);
  assert.throws(() => applySceneEdits(source, [{ type: 'update', id: 'p', patch: { parentId: 'missing' } }]), /unknown parent/);
});

test('deleting a tracked character explicitly clears camera and gaze references', () => {
  const source: SceneSpec = { ...base, characters: [
    { id: 'hero', model: 'char/mannequin' }, { id: 'other', model: 'char/mannequin', gaze: { character: 'hero' } },
  ], camera: { lookAt: { character: 'hero' } } };
  assert.throws(() => applySceneEdits(source, [{ type: 'remove', id: 'hero' }]), /references/);
  const { spec } = applySceneEdits(source, [{ type: 'remove', id: 'hero', cascade: true }]);
  assert.equal(spec.characters![0].gaze, undefined);
  assert.deepEqual(spec.camera!.lookAt, { x: 0, y: 1, z: 0 });
});

test('duplicate offsets animated positions without flattening keys or mutating source', () => {
  const source: SceneSpec = { ...base, props: [{ id: 'p', model: 'prop/cube', position: { x: [{ t: 0, v: 1 }, { t: 1, v: 3 }] } }] };
  const { spec } = applySceneEdits(source, [{ type: 'duplicate', id: 'p', newId: 'q', offset: { x: 5, y: 1 } }]);
  assert.deepEqual(spec.props![1].position, { x: [{ t: 0, v: 6 }, { t: 1, v: 8 }], y: 1.5 });
  assert.equal(source.props!.length, 1);
});

test('transform/material validation rejects malformed values and unsupported physics parenting', () => {
  for (const patch of [{ rotationX: NaN }, { rotationZ: [] }, { scale: 0 }, { material: { metalness: 2 } },
    { material: { roughnes: 0.4 } }, { material: { opacity: Infinity } }]) {
    assert.throws(() => applySceneEdits({ ...base, props: [{ id: 'p', model: 'prop/cube' }] }, [
      { type: 'update', id: 'p', patch: patch as never },
    ]));
  }
  assert.match(validateSceneSpec({ ...base, groups: [{ id: 'g' }], props: [{ id: 'p', model: 'prop/cube', parentId: 'g', physics: 'dynamic' }] })!, /world-root/);
  assert.equal(validateSceneSpec({ ...base, props: [{ id: 'p', model: 'prop/cube', rotationX: 45, rotationZ: [{ t: 0, v: 0 }, { t: 1, v: 90 }], material: { metalness: 0.8, opacity: 0.5 } }] }), null);
});

test('swept paths and cutout/beveled extrusions validate their real geometry inputs', () => {
  const valid: SceneSpec = { ...base, props: [
    { model: 'prop/tube', path: [[0, 0, 0], [0, 1, 0], [1, 1, 0]], radius: 0.1 },
    { model: 'prop/extrude', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]], holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]], bevel: 0.05 },
  ] };
  assert.equal(validateSceneSpec(valid), null);
  for (const prop of [
    { model: 'prop/tube', path: [[0, 0, 0], [0, 0, 0]] },
    { model: 'prop/tube', path: [[0, 0, 0], [0, 1, 0]], radius: 0 },
    { model: 'prop/tube', path: [[0, 0, 0], [0, 1, 0]], closed: true },
    { model: 'prop/cube', bevel: 0.1 },
    { ...valid.props![1], holes: [[[0, 0], [1, 1]]] },
  ]) assert.notEqual(validateSceneSpec({ ...base, props: [prop] }), null);
});

test('assemblies regenerate editable parts and preserve custom children/materials after duplication', () => {
  const made = applySceneEdits(base, [{ type: 'assembly', id: 'table', recipe: { template: 'table' } }]).spec;
  const styled = applySceneEdits(made, [
    { type: 'update', id: 'table/top', patch: { color: '#ffffff', material: { roughness: 0.2 } } },
    { type: 'add', kind: 'prop', object: { id: 'custom', parentId: 'table', model: 'prop/sphere' } },
    { type: 'duplicate', id: 'table', newId: 'copy' },
    { type: 'assembly', id: 'copy', recipe: { template: 'table', parameters: { width: 3, height: 1 } } },
  ]).spec;
  assert.equal(styled.props?.find((p) => p.id === 'copy/top')?.color, '#ffffff');
  assert.deepEqual(styled.props?.find((p) => p.id === 'copy/top')?.material, { roughness: 0.2 });
  assert.equal((styled.props?.find((p) => p.id === 'copy/top')?.scale as { x: number }).x, 3);
  assert.equal(styled.props?.find((p) => p.id === 'copy/custom')?.parentId, 'copy');
  assert.equal(styled.props?.filter((p) => p.parentId === 'copy').length, 6);
  assert.throws(() => applySceneEdits(made, [{ type: 'assembly', id: 'table', recipe: { template: 'table', parameters: { thickness: 10 } } }]), /thickness/);
});

test('arrays duplicate whole assemblies with incremental offsets and reject partial collisions', () => {
  const made = applySceneEdits(base, [
    { type: 'assembly', id: 'chair', recipe: { template: 'chair' } },
    { type: 'array', id: 'chair', prefix: 'seat', copies: 3, offset: { x: 2 } },
  ]).spec;
  assert.deepEqual(made.groups?.map((g) => g.position?.x ?? 0), [0, 2, 4, 6]);
  assert.equal(made.props?.length, 24);
  const snapshot = JSON.stringify(made);
  assert.throws(() => applySceneEdits(made, [{ type: 'array', id: 'chair', prefix: 'seat', copies: 4, offset: { x: 1 } }]), /duplicate/);
  assert.equal(JSON.stringify(made), snapshot);
});

test('editable mesh topology rejects invalid/degenerate faces while preserving authored UVs', () => {
  const mesh = { id: 'm', model: 'prop/mesh', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], uvs: [[0, 0], [1, 0], [0, 1]] };
  assert.equal(validateSceneSpec({ ...base, props: [mesh] }), null);
  for (const faces of [[[0, 1, 9]], [[0, 0, 1]], [[0, 0.5, 2]]]) assert.match(validateSceneSpec({ ...base, props: [{ ...mesh, faces }] })!, /indices/);
  assert.match(validateSceneSpec({ ...base, props: [{ ...mesh, vertices: [[0,0,0], [1,0,0], [2,0,0]] }] })!, /degenerate/);
  assert.match(validateSceneSpec({ ...base, props: [{ ...mesh, uvs: [[0,0]] }] })!, /uvs/);
});

test('lights are named, parentable, duplicable objects with validated photometric controls', () => {
  const r = applySceneEdits(base, [
    { type: 'add', kind: 'group', object: { id: 'rig' } },
    { type: 'add', kind: 'light', object: { id: 'key', parentId: 'rig', type: 'spot', intensity: [{ t: 0, v: 0 }, { t: 1, v: 60 }], angle: 40 } },
    { type: 'duplicate', id: 'rig', newId: 'rig-copy' },
  ]);
  assert.equal(r.spec.lights![1].parentId, 'rig-copy');
  assert.throws(() => applySceneEdits(r.spec, [{ type: 'update', id: 'key', patch: { intensity: -1 } }]), /intensity/);
  assert.throws(() => applySceneEdits(r.spec, [{ type: 'update', id: 'key', patch: { type: 'point' } }]), /spot lights/);
  assert.equal(applySceneEdits(r.spec, [{ type: 'remove', id: 'rig-copy', cascade: true }]).spec.lights!.length, 1);
});
