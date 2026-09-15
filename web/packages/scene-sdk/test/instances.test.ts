import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applySceneEdits } from '../src/authoring.ts';
import { sceneBudget, type SceneGeometry } from '../src/geometry.ts';
import { buildInstances, syncInstanceBatches } from '../src/instances.ts';
import { validateSceneSpec, type SceneSpec } from '../src/types.ts';

const geometry: SceneGeometry = { vertices: [[0,0,0],[1,0,0],[0,1,0]], faces: [[0,1,2]] };
const base: SceneSpec = { version: 1, durationUs: 2_000_000, geometries: { tile: geometry },
  props: [{ id: 'a', model: 'prop/instance', geometryId: 'tile', color: '#ff0000' }] };

test('geometry CRUD, linked duplication and makeUnique preserve object identity and fail atomically', () => {
  const duplicate = applySceneEdits(base, [{ type: 'duplicate', id: 'a', newId: 'b', offset: { x: 2 } }]);
  assert.equal(duplicate.spec.props![1].geometryId, 'tile');
  assert.equal(duplicate.spec.props![1].vertices, undefined);
  const changed = applySceneEdits(duplicate.spec, [
    { type: 'makeUnique', id: 'b', geometryId: 'private' },
    { type: 'geometry.update', id: 'tile', geometry: { ...geometry, vertices: [[0,0,0],[3,0,0],[0,1,0]] } },
  ]);
  assert.deepEqual(changed.geometryIds, ['private', 'tile']);
  assert.ok(changed.changedIds.includes('a'));
  const b = changed.spec.props![1];
  assert.equal(b.id, 'b'); assert.equal(b.model, 'prop/mesh'); assert.equal(b.geometryId, 'private');
  assert.equal(b.vertices, undefined); assert.equal(changed.spec.geometries!.private.vertices[1][0], 1); assert.equal(b.color, '#ff0000'); assert.equal(b.position!.x, 2);
  assert.throws(() => applySceneEdits(changed.spec, [{ type: 'geometry.remove', id: 'tile' }]), /referenced/);
  const removed = applySceneEdits(changed.spec, [{ type: 'remove', id: 'a' }, { type: 'geometry.remove', id: 'tile' }]);
  assert.deepEqual(Object.keys(removed.spec.geometries!), ['private']); assert.equal(removed.spec.props!.length, 1);
  assert.throws(() => applySceneEdits(base, [{ type: 'geometry.create', id: 'tile', geometry }]), /already exists/);
  assert.throws(() => applySceneEdits(base, [{ type: 'update', id: 'a', patch: { geometryId: 'missing' } }]), /unknown geometry/);
  assert.deepEqual(base.geometries!.tile, geometry); assert.equal(base.props!.length, 1);
});

test('1000 instances fit the native budget and one extra fails with structured counts', () => {
  const props = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, model: 'prop/instance', geometryId: 'tile', position: { x: i % 40, z: Math.floor(i / 40) } }));
  const scene = { ...base, props };
  assert.equal(validateSceneSpec(scene), null);
  const budget = sceneBudget(scene);
  assert.equal(budget.withinLimits, true); assert.equal(budget.used.instanceBatches, 1);
  assert.equal(budget.sharedVertices, 3); assert.equal(budget.used.instanceTriangles, 1000);
  assert.throws(() => applySceneEdits(scene, [{ type: 'duplicate', id: 't0', newId: 'excess' }]), (e: any) => {
    assert.deepEqual(e.budget.violations, [{ field: 'instances', used: 1001, limit: 1000 }]); return true;
  });
  const oversized = { ...scene, props: props.map(p => ({ ...p, name: 'x'.repeat(300) })) };
  assert.equal(sceneBudget(oversized).violations[0].field, 'specBytes');
  assert.match(validateSceneSpec(oversized)!, /specBytes/);
});

test('invalid topology, unsupported instance overrides and render costs are rejected', () => {
  assert.match(validateSceneSpec({ ...base, geometries: { tile: { ...geometry, faces: [[0,1,1]] } } })!, /indices/);
  assert.match(validateSceneSpec({ ...base, geometries: { tile: { ...geometry, vertices: [[0,0,0],[1,0,0],[2,0,0]] } } })!, /degenerate/);
  for (const patch of [{ physics: 'fixed' }, { material: { opacity: 0.5 } }, { vertices: geometry.vertices }, { color: 'red' }]) {
    assert.notEqual(validateSceneSpec({ ...base, props: [{ ...base.props![0], ...patch }] }), null);
  }
  const manyMaterials = { ...base, props: Array.from({ length: 129 }, (_, i) => ({ id: `i${i}`, model: 'prop/instance', geometryId: 'tile', material: { roughness: i / 129 } })) };
  assert.match(validateSceneSpec(manyMaterials)!, /instanceBatches/);
  assert.equal(validateSceneSpec({ ...base, props: [{ ...base.props![0], material: { opacity: 1 } }] }), null);
});

test('GPU batches share geometry, retain per-instance colors and use full parent matrices for picking', () => {
  const spec = applySceneEdits(base, [
    { type: 'duplicate', id: 'a', newId: 'b' },
    { type: 'update', id: 'b', patch: { color: '#00ff00', material: { roughness: 0.6 } } },
  ]).spec;
  const result = buildInstances(THREE, spec);
  assert.equal(result.batches.length, 1);
  assert.equal(result.objects[0].root.geometry, result.objects[1].root.geometry);
  const scene = new THREE.Scene(), parent = new THREE.Group();
  parent.position.set(2,3,4); parent.rotation.z = Math.PI / 4; parent.scale.set(2,1,1);
  scene.add(parent, result.batches[0].mesh); result.objects.forEach(o => parent.add(o.root));
  result.objects[1].root.position.x = 3;
  syncInstanceBatches(scene, result.batches);
  const matrix = new THREE.Matrix4(); result.batches[0].mesh.getMatrixAt(1, matrix);
  matrix.elements.forEach((n, i) => assert.ok(Math.abs(n - result.objects[1].root.matrixWorld.elements[i]) < 1e-6));
  const color = new THREE.Color(); result.batches[0].mesh.getColorAt(1, color); assert.equal(color.getHexString(), '00ff00');
  const point = new THREE.Vector3(0.2,0.2,0).applyMatrix4(result.objects[1].root.matrixWorld);
  const ray = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0,0,2)), new THREE.Vector3(0,0,-1));
  assert.equal(result.objects[1].root.visible, false); // hidden logical mesh is still precisely pickable
  assert.ok(ray.intersectObject(result.objects[1].root).length > 0);
  assert.equal(ray.intersectObject(result.objects[0].root).length, 0);
});
