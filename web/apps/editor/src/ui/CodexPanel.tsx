import { Dialog } from './primitives/Dialog';
import { Icon } from './primitives/Icon';
import { useState, useSyncExternalStore } from 'react';
import type { CodexConnection } from '../services/codex-connection';

export function CodexPanel({ connection }: { connection: CodexConnection }) {
  const [open, setOpen] = useState(false),
    [url, setUrl] = useState('');
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot,
  );
  return (
    <div className="codex-connection">
      <button
        className={'codex-status ' + state.status}
        aria-label="Connect to Codex"
        title={`Codex: ${state.status}`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="link" size={15} />
        <span>Codex</span>
        <i className={`connection-dot ${state.status}`} />
      </button>
      <Dialog
        open={open}
        title="Connect to Codex"
        className="codex-popover"
        onClose={() => setOpen(false)}
      >
        <p>
          Install the Velocut plugin, ask Codex to connect, then open its connection link or paste
          it here.
        </p>
        <input
          aria-label="Codex connection URL"
          autoComplete="off"
          type="password"
          placeholder="Connection URL from velocut_connect"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="primary"
          disabled={!url.trim()}
          onClick={() => {
            void connection.connect(url);
            setUrl('');
          }}
        >
          Connect
        </button>
        <button onClick={connection.disconnect}>Disconnect</button>
        {state.sessionId && (
          <p>
            Session: <code>{state.sessionId}</code>
          </p>
        )}
        {state.message && <p role="status">{state.message}</p>}
        <p>
          Codex edits this project through its own model. No additional model API key is needed.
        </p>
      </Dialog>
    </div>
  );
}
