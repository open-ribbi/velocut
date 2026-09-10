import { useState, useSyncExternalStore } from 'react';
import type { CodexConnection } from '../services/codex-connection';

export function CodexPanel({ connection }: { connection: CodexConnection }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState('');
  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
  return <div className="codex-connection">
    <button className={'codex-status ' + state.status} title={`Codex: ${state.status}`} onClick={() => setOpen(!open)}>Codex {state.status === 'connected' ? '●' : '○'}</button>
    {open && <div className="codex-popover">
      <strong>Connect to Codex</strong>
      <p>Install the Velocut plugin, ask Codex to connect, then open its connection link or paste it here.</p>
      <input aria-label="Codex connection URL" type="password" placeholder="Connection URL from velocut_connect" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button onClick={() => { void connection.connect(url); setUrl(''); }}>Connect</button>
      <button onClick={connection.disconnect}>Disconnect</button>
      {state.sessionId && <p>Session: <code>{state.sessionId}</code></p>}
      {state.message && <p role="status">{state.message}</p>}
      <p>Codex edits this project through its own model. No additional model API key is needed.</p>
    </div>}
  </div>;
}
