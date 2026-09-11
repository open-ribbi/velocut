import { useEffect, useState } from 'react';
import type { Store } from '../state/store';
import { exportSceneModel } from '../services/scene';
import { Dialog } from './primitives/Dialog';
import { Icon } from './primitives/Icon';

export function SceneExportDialog({
  open,
  onClose,
  store,
  assetId,
  name,
  objectId,
  timeS,
}: {
  open: boolean;
  onClose: () => void;
  store: Store;
  assetId: string;
  name: string;
  objectId: string | null;
  timeS: number;
}) {
  const [scope, setScope] = useState('scene');
  const [environment, setEnvironment] = useState(true),
    [camera, setCamera] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]),
    [saved, setSaved] = useState('');
  useEffect(() => {
    if (open) {
      setScope(objectId ? 'selection' : 'scene');
      setError('');
      setWarnings([]);
      setSaved('');
    }
  }, [open]);
  const download = async () => {
    setBusy(true);
    setError('');
    setSaved('');
    setWarnings([]);
    try {
      const result = await exportSceneModel(store, {
        assetId,
        timeS,
        objectIds: scope === 'selection' && objectId ? [objectId] : undefined,
        includeEnvironment: environment,
        includeCamera: camera,
      });
      if (!result.ok) throw new Error(result.message);
      const filename =
        `${name}${scope === 'selection' ? `-${objectId}` : ''}`
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
          .slice(0, 150) + '.glb';
      const url = URL.createObjectURL(result.blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setWarnings(result.warnings);
      setSaved(filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="Export GLB"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-description">
        Static snapshot at {timeS.toFixed(2)}s. Keeps the current pose, geometry, materials and
        textures. Skinning and morphs are baked into static geometry; rigs, animation tracks and
        editing recipes are not included.
      </p>
      <label className="form-field">
        <span>Export</span>
        <select
          aria-label="GLB export scope"
          value={scope}
          disabled={busy}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="scene">Entire scene</option>
          <option value="selection" disabled={!objectId}>
            Selected object + children
          </option>
        </select>
      </label>
      {scope === 'scene' && (
        <>
          <label>
            <input
              type="checkbox"
              checked={environment}
              disabled={busy}
              onChange={(e) => setEnvironment(e.target.checked)}
            />{' '}
            Include environment geometry
          </label>
          <label>
            <input
              type="checkbox"
              checked={camera}
              disabled={busy}
              onChange={(e) => setCamera(e.target.checked)}
            />{' '}
            Include shot camera
          </label>
        </>
      )}
      {error && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">Download started: {saved}</p>}
      {warnings.length > 0 && (
        <ul className="dialog-description">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <button
        className="primary"
        disabled={busy || (scope === 'selection' && !objectId)}
        onClick={() => void download()}
      >
        <Icon name="download" />
        {busy ? 'Exporting…' : 'Download GLB'}
      </button>
    </Dialog>
  );
}
