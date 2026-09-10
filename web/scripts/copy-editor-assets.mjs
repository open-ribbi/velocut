import { cp, mkdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(web,'apps/editor/dist');
// Never copy the entire development public/ folder: it may contain private,
// gitignored test media. The scene SDK owns the releasable scene assets.
await cp(resolve(web,'packages/scene-sdk/assets'),resolve(out,'scene-assets'),{recursive:true});
if(process.env.VELOCUT_INCLUDE_WASM==='1') {
  await mkdir(resolve(out,'wasm'),{recursive:true});
  for(const file of ['velocut_wasm.js','velocut_wasm_bg.wasm'])await cp(resolve(web,'apps/editor/public/wasm',file),resolve(out,'wasm',file));
}
