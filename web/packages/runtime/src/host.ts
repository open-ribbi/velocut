import type { Command } from '@velocut/protocol';
import type { MediaLibrary, Observer } from '@velocut/render-sdk';
import {
  loadSceneManifest,
  scenePromptDoc,
  withImportedModels,
  type SceneSpec,
} from '@velocut/scene-sdk';
import type { Store } from './store';
import { observeForAgent, type ObserveInput } from './observe';
import { directorSession, type DirectorSessionOptions } from './director-session';
import {
  sceneAssetBase,
  createSceneClip,
  dispatchSceneAware,
  editScene,
  arrangeScene,
  inspectScene,
  importSceneModel,
  exportSceneModel,
  type SceneExportOptions,
  type SceneClipOptions,
  type SceneEditOptions,
  type SceneArrangeOptions,
  type SceneModelImportOptions,
} from './scene';
import { runAgentScript, type ScriptApi } from './script';

/** Only project editing crosses this boundary: no settings, keys, arbitrary
 * host evaluation, uploads, provider calls or OS access. All writes are attributed. */
export function createProjectHost(
  store: Store,
  media: MediaLibrary,
  observer: Observer,
  project: { id: string; name: string },
  actor: { name: string; peerPrefix: string } = { name: 'MCP', peerPrefix: 'mcp' },
) {
  const info = () => ({
    projectId: project.id,
    projectName: project.name,
    documentName: store.getState().doc.name,
    revision: store.getState().revision,
  });
  const execute = async (
    method: string,
    args: unknown,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (signal?.aborted) throw new Error('MCP connection closed before this operation');
    const dispatch = (cmd: Command) =>
      signal?.aborted
        ? {
            ok: false as const,
            error: { code: 'cancelled', message: 'MCP connection closed before commit' },
          }
        : store.dispatch(cmd, {
            kind: 'ai',
            peerId: `${actor.peerPrefix}:${sessionId}`,
            name: actor.name,
          });
    const commandRestriction = (cmd: Command): string | null => {
      if (cmd?.type === 'batch' && Array.isArray(cmd.commands)) {
        for (const child of cmd.commands) {
          const error = commandRestriction(child);
          if (error) return error;
        }
      }
      if (
        cmd?.type === 'addAsset' &&
        typeof cmd.src === 'string' &&
        !cmd.src.startsWith('opfs://') &&
        !cmd.src.startsWith('scene://')
      ) {
        return 'MCP imports local project assets and scenes only; remote assets and procedural motion creation are not exposed';
      }
      if (
        cmd?.type === 'setAssetSpec' &&
        store
          .getState()
          .doc.assets.some((asset) => asset.id === cmd.assetId && asset.src.startsWith('motion://'))
      ) {
        return 'procedural motion spec editing is not exposed by this local scene plugin';
      }
      return null;
    };
    const guarded = (cmd: Command) => {
      const error = commandRestriction(cmd);
      return error
        ? { ok: false as const, error: { code: 'unsupported', message: error } }
        : dispatchSceneAware(store, cmd, dispatch);
    };
    const a = (args ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'document':
        return { ok: true, ...info(), document: store.getState().doc };
      case 'sceneAssets': {
        let manifest = await loadSceneManifest(sceneAssetBase(store));
        if (a.assetId != null) {
          const asset = store
            .getState()
            .doc.assets.find((entry) => entry.id === a.assetId && entry.src.startsWith('scene://'));
          if (!asset?.spec) return { ok: false, message: 'scene asset not found' };
          manifest = withImportedModels(manifest, JSON.parse(asset.spec) as SceneSpec);
        }
        return { ok: true, doc: scenePromptDoc(manifest), manifest };
      }
      case 'sceneClip':
        return createSceneClip(store, media, args as SceneClipOptions, dispatch);
      case 'sceneEdit':
        return editScene(store, args as SceneEditOptions, dispatch);
      case 'sceneArrange':
        return arrangeScene(store, args as SceneArrangeOptions, dispatch);
      case 'sceneExport': {
        const result = await exportSceneModel(store, args as SceneExportOptions, signal);
        if (!result.ok) return result;
        const { blob, ...metadata } = result;
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.readAsDataURL(blob);
        });
        signal?.throwIfAborted();
        return { ...metadata, base64, byteLength: blob.size };
      }
      case 'sceneImportModel':
        return importSceneModel(store, args as SceneModelImportOptions, dispatch);
      case 'sceneInspect':
        return inspectScene(store, args as { assetId: string; timeS?: number });
      case 'observe':
        return observeForAgent(store, observer, args as ObserveInput);
      case 'directorSession':
        return directorSession(store, args as DirectorSessionOptions | undefined);
      case 'apply': {
        if (a.expectedRevision != null && a.expectedRevision !== store.getState().revision)
          return {
            ok: false,
            error: { code: 'conflict', message: 'document changed; inspect again before editing' },
          };
        return guarded(a.command as Command);
      }
      case 'history': {
        if (a.expectedRevision !== store.getState().revision)
          return {
            ok: false,
            message: 'history revision changed; read the document before undo/redo',
          };
        if (a.action === 'undo') return store.undo();
        if (a.action === 'redo') return store.redo();
        return { ok: false, message: 'history action must be undo or redo' };
      }
      case 'script': {
        if (typeof args !== 'string' || args.length > 256_000)
          return { ok: false, error: 'script must contain at most 256000 characters' };
        const local = (name: string) => (input?: unknown) =>
          execute(name, input, sessionId, signal);
        const unavailable = async (): Promise<never> => {
          throw new Error(
            'this MCP host exposes local scene editing only; cloud generation, uploads and speech are not enabled',
          );
        };
        const api: ScriptApi = {
          document: () => store.getState().doc,
          evaluate: store.evaluate,
          seek: store.seek,
          apply: (cmd) => guarded(cmd as Command),
          sceneAssets: local('sceneAssets'),
          sceneClip: local('sceneClip'),
          sceneEdit: local('sceneEdit'),
          sceneArrange: local('sceneArrange'),
          sceneImportModel: local('sceneImportModel'),
          sceneInspect: local('sceneInspect'),
          directorSession: local('directorSession'),
          observe: async (input) => {
            const r = await observeForAgent(store, observer, input as ObserveInput);
            return { ok: r.ok, summary: r.summary, data: r.data };
          },
          tts: unavailable,
          motionClip: unavailable,
          videoGen: unavailable,
          videoGenChannels: unavailable,
          uploadFrame: unavailable,
          uploadClip: unavailable,
          uploadAsset: unavailable,
        };
        return runAgentScript(api, args);
      }
      default:
        return { ok: false, message: `unsupported project editor method: ${method}` };
    }
  };
  return { info, execute };
}
