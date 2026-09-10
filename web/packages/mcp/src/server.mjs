import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { open } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createBroker } from './broker.mjs';

const jsonObject = z.record(z.string(), z.unknown());
const session = { sessionId: z.string().uuid().describe('Explicit connected browser session from velocut_sessions. Never infer the foreground project.') };
const asset = { ...session, assetId: z.string().min(1) };
const expectedRevision = z.number().int().nonnegative().optional();

export function toolResult(value) {
  const result = value && typeof value === 'object' ? value : { result: value };
  const { images, ...data } = result;
  const content = [{ type: 'text', text: JSON.stringify(data) }];
  for (const img of Array.isArray(images) ? images.slice(0, 8) : []) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(img.mediaType) || typeof img.base64 !== 'string') throw new Error('invalid image result from editor');
    content.push({ type: 'image', mimeType: img.mediaType, data: img.base64 });
  }
  return { isError: result.ok === false, content, structuredContent: data };
}

export async function createVelocutServer(options = {}) {
  const broker = await createBroker(options);
  const server = new McpServer({ name: 'velocut', version: '0.1.0' }, { instructions:
    'Control the paired live Velocut editor, using this Codex conversation for reasoning. Connect/open the returned URL, list sessions, and explicitly choose the intended project. Read scene_assets before authoring. Pass read revisions to edits. Observe actual images after edits. Never replay a timed-out write without inspecting state: its outcome may be unknown. Scripts run only in the editor sandbox. Cloud generation, uploads, and model API credentials are not part of this plugin.' });
  const register = (name, description, shape, callback, readOnly = false) => server.registerTool(name, {
    description, inputSchema: z.object(shape), annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
  }, async (args, ctx) => {
    try { return toolResult(await callback(args, ctx.mcpReq.signal)); }
    catch (e) { return toolResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
  });
  const relay = (method, map = (a) => a) => (args, signal) => {
    const { sessionId, ...rest } = args;
    return broker.call(sessionId, method, map(rest), signal);
  };
  register('velocut_connect', 'Create a temporary pairing URL for the local Velocut editor. Open the returned URL in a browser, then call velocut_sessions. If the editor is not running, use velocut studio from the installed CLI or node start-studio.mjs from an extracted release. A source checkout can use npm run dev from web/. No separate model API key is required.',
    { editorUrl: z.string().url().optional().describe('Local HTTP editor URL; default http://localhost:5173') }, ({ editorUrl }) => broker.connect(editorUrl), true);
  register('velocut_sessions', 'List paired live pages with project identities, revisions and last-command state. Select the intended sessionId explicitly for every operation.', {}, () => ({ ok: true, sessions: broker.list() }), true);
  register('velocut_document', 'Read the paired project document and current revision. Does not expose editor/provider settings or API credentials.', session, relay('document'), true);
  register('velocut_scene_assets', 'Get the grounded scene vocabulary, schema guidance and asset manifest. Provide assetId to include that scene’s imported models and animations.', { ...session, assetId: z.string().optional() }, relay('sceneAssets'), true);
  register('velocut_scene_create', 'Create a declarative editable 3D scene clip. First read scene_assets. Compiles before committing and returns assetId/clipId.',
    { ...session, spec: jsonObject, name: z.string().optional(), atUs: z.number().nonnegative().optional(), trackId: z.string().optional() }, relay('sceneClip'));
  register('velocut_scene_inspect', 'Read normalized SceneSpec, revision, evaluated world transforms/bounds and lights at scene-local timeS. Use IDs and geometry rather than guessing coordinates.',
    { ...asset, timeS: z.number().nonnegative().optional() }, relay('sceneInspect'), true);
  register('velocut_scene_edit', 'One validated, compiled, undoable transaction. Operations: add/update/remove/duplicate/array/assembly/scene. Read scene_assets for grammar and pass expectedRevision from inspection.',
    { ...asset, edits: z.array(jsonObject).min(1).max(500), expectedRevision }, relay('sceneEdit'));
  register('velocut_scene_arrange', 'Place objects on the ground/on a reference or align world-bound edges. Accounts for parent transforms; keeps keyframe paths. Bounds placement is not a contact solver.',
    { ...asset, ids: z.array(z.string()).min(1).max(200), mode: z.enum(['ground', 'on', 'align']), referenceId: z.string().optional(), axis: z.enum(['x', 'y', 'z']).optional(), edge: z.enum(['min', 'max', 'center']).optional(), gap: z.number().optional(), timeS: z.number().nonnegative().optional(), expectedRevision }, relay('sceneArrange'));
  register('velocut_observe', 'Render and return real image content plus spatial/metrics data. mode:scene uses scene-local microseconds and source:{assetId}; views shot/front/right/top/perspective, optional objectId or custom camera. Use after authoring to verify results.',
    { ...session, mode: z.enum(['scene', 'frame', 'contact', 'scan']).default('scene'), source: jsonObject.optional(), at: z.number().optional(), from: z.number().optional(), to: z.number().optional(), count: z.number().optional(), view: z.enum(['shot', 'front', 'right', 'top', 'perspective']).optional(), objectId: z.string().optional(), camera: jsonObject.optional(), resolution: z.enum(['thumb', 'preview', 'full']).optional(), metricsOnly: z.boolean().optional() }, relay('observe'), true);
  register('velocut_director', 'Read or control the live Director workspace. options:assetId/open/objectId/focusId/timeS/playing/view/mode/camera. Navigation does not modify authored scene data.',
    { ...session, options: jsonObject.optional() }, relay('directorSession', ({ options }) => options));
  register('velocut_apply', 'Apply a timeline protocol command or batch. Scene writes are validated and compiled before publishing. Prefer scene_edit for object authoring. Use document to obtain exact IDs.',
    { ...session, command: jsonObject, expectedRevision }, relay('apply'));
  register('velocut_history', 'Undo or redo exactly one document history step. Requires current expectedRevision to avoid reversing someone else’s intervening edit.',
    { ...session, action: z.enum(['undo', 'redo']), expectedRevision: z.number().int().nonnegative() }, relay('history'));
  register('velocut_script', 'Run JavaScript in Velocut’s isolated, network-free editor sandbox (top-level await, return JSON). Available methods: document, evaluate, seek, apply, sceneAssets, sceneClip, sceneEdit, sceneArrange, sceneInspect, sceneImportModel, directorSession, observe (numbers only). Use loops to generate geometry or batches. Check result.ok; use the separate observe tool for images.',
    { ...session, code: z.string().min(1).max(256_000) }, relay('script', ({ code }) => code));
  register('velocut_import_model', 'Import a user-specified local self-contained GLB (up to 64 MiB) into the paired project. Preserves geometry/materials/textures and can use embedded animations with kind:character. Returns model/object IDs. No download or upload to an external service.',
    { ...asset, path: z.string().min(1), kind: z.enum(['prop', 'character']).optional(), name: z.string().optional(), expectedRevision }, async ({ sessionId, path, ...args }, signal) => {
      const fullPath = resolve(path);
      if (extname(fullPath).toLowerCase() !== '.glb') throw new Error('choose a .glb model file');
      const handle = await open(fullPath, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 20 || info.size > 64 * 1024 * 1024) throw new Error('GLB must be a regular file from 20 bytes to 64 MiB');
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) { const r = await handle.read(bytes, offset, bytes.length - offset, offset); if (!r.bytesRead) throw new Error('file changed while reading'); offset += r.bytesRead; }
        if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('file is not a valid GLB 2 container');
        return await broker.call(sessionId, 'sceneImportModel', { ...args, name: args.name ?? basename(fullPath), base64: bytes.toString('base64') }, signal);
      } finally { await handle.close(); }
    });
  return { server, broker, close: async () => { await broker.close(); await server.close(); } };
}

export async function main() {
  const app = await createVelocutServer();
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.stdin.on('end', () => void close());
  process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
  await app.server.connect(new StdioServerTransport());
}
