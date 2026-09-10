import { BoxGeometry } from 'three';

/** An actual embedded cube with a named translation animation; no downloads. */
export function modelFixture(change?: (json: any) => void, textured = false): Uint8Array {
  const geo = new BoxGeometry(1, 1, 1);
  const arrays = [geo.getAttribute('position').array, geo.getAttribute('normal').array,
    geo.index!.array, new Float32Array([0, 1]), new Float32Array([0, 0, 0, 2, 0, 0])];
  if (textured) {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP8w4AdsOAQH6QSANBkARqrv8JBAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
    arrays.push(png, geo.getAttribute('uv').array);
  }
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let offset = 0;
  for (const a of arrays) { offset = Math.ceil(offset / 4) * 4; views.push({ buffer: 0, byteOffset: offset, byteLength: a.byteLength }); offset += a.byteLength; }
  const binary = new Uint8Array(Math.ceil(offset / 4) * 4);
  arrays.forEach((a, i) => binary.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), views[i].byteOffset));
  const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'ImportedCube' }],
    buffers: [{ byteLength: binary.byteLength }], bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: arrays[0].length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: arrays[1].length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: arrays[2].length, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
    ], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.1, 1], roughnessFactor: 0.5, metallicFactor: 0 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    animations: [{ name: 'Move', samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
  };
  if (textured) {
    json.images = [{ bufferView: 5, mimeType: 'image/png' }]; json.textures = [{ source: 0 }];
    json.accessors.push({ bufferView: 6, componentType: 5126, count: arrays[6].length / 2, type: 'VEC2' });
    json.meshes[0].primitives[0].attributes.TEXCOORD_0 = 5;
    json.materials[0].pbrMetallicRoughness.baseColorFactor = [1,1,1,1];
    json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  change?.(json);
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = Math.ceil(encoded.length / 4) * 4;
  const result = new Uint8Array(12 + 8 + jsonSize + 8 + binary.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, jsonSize, true); view.setUint32(16, 0x4e4f534a, true);
  result.fill(32, 20, 20 + jsonSize); result.set(encoded, 20);
  view.setUint32(20 + jsonSize, binary.length, true); view.setUint32(24 + jsonSize, 0x004e4942, true); result.set(binary, 28 + jsonSize);
  geo.dispose(); return result;
}
