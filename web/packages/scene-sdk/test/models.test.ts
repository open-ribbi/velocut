import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGlb } from '../src/models.ts';
import { modelFixture } from './glb-fixture.ts';

test('GLB validation accepts embedded geometry and rejects truncated containers', () => {
  const file = modelFixture();
  assert.doesNotThrow(() => validateGlb(file.buffer as ArrayBuffer));
  assert.throws(() => validateGlb(file.slice(0, file.length - 4).buffer), /length/);
  assert.throws(() => validateGlb(new ArrayBuffer(4)), /GLB/);
});

test('GLB files must be self contained and have a valid node hierarchy', () => {
  for (const mutate of [
    (j: any) => { j.buffers[0].uri = 'https://example.com/mesh.bin'; },
    (j: any) => { j.images = [{ uri: '/private/image.png' }]; },
  ]) assert.throws(() => validateGlb(modelFixture(mutate).buffer as ArrayBuffer), /external URIs/);
  assert.throws(() => validateGlb(modelFixture((j) => { j.nodes[0].children = [0]; }).buffer as ArrayBuffer), /cycle/);
  assert.throws(() => validateGlb(modelFixture((j) => { j.nodes[0].children = [1]; }).buffer as ArrayBuffer), /hierarchy/);
});


test('GLB texture dependencies cannot introduce executable/vector documents', () => {
  assert.throws(() => validateGlb(modelFixture((j) => {
    j.images = [{ uri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }];
  }).buffer as ArrayBuffer), /bitmaps/);
});
