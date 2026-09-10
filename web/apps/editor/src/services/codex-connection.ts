import type { createCodexHost } from './codex-host';

type Host = ReturnType<typeof createCodexHost>;
export interface CodexConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  sessionId?: string;
  message?: string;
}
const KEY = 'velocut.codexPairing';

/** Browser half of the loopback bridge. Commands execute once and in order.
 * On uncertain network outcomes stop; never re-run an editing command. */
export function createCodexConnection(host: Host) {
  let state: CodexConnectionState = { status: 'disconnected' };
  const listeners = new Set<() => void>();
  let controller: AbortController | null = null;
  let leave: (() => void) | null = null;
  const set = (next: CodexConnectionState) => { state = next; listeners.forEach((fn) => fn()); };
  const disconnect = () => {
    leave?.(); leave = null; controller?.abort(); controller = null;
    sessionStorage.removeItem(KEY); set({ status: 'disconnected' });
  };
  const connect = async (pairing: string) => {
    let value: string | null = pairing;
    try { value = new URLSearchParams(new URL(pairing).hash.slice(1)).get('velocut-codex'); } catch { /* a raw pairing value is also accepted */ }
    const match = /^(\d{1,5})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) { set({ ...state, status: controller ? state.status : 'error', message: 'Paste the connection URL returned by velocut_connect in Codex.' }); return; }
    disconnect();
    const abort = new AbortController(); controller = abort;
    const base = `http://127.0.0.1:${match[1]}`;
    set({ status: 'connecting' });
    sessionStorage.setItem(KEY, value!);
    let heartbeat = 0;
    const request = async (path: string, token: string, data?: unknown, method = data === undefined ? 'GET' : 'POST') => {
      const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: data === undefined ? undefined : JSON.stringify(data), signal: abort.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `bridge HTTP ${response.status}`);
      return result;
    };
    try {
      const { sessionId, sessionKey, protocol } = await request('/register', match[2], host.info());
      if (protocol !== 1 || typeof sessionId !== 'string' || typeof sessionKey !== 'string') throw new Error('unsupported Codex bridge');
      if (abort.signal.aborted) return;
      const path = `/sessions/${sessionId}`;
      leave = () => { clearInterval(heartbeat); void fetch(base + path, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionKey}` }, keepalive: true }).catch(() => {}); };
      heartbeat = window.setInterval(() => {
        void request(path + '/ping', sessionKey, host.info()).catch((e) => {
          if (!abort.signal.aborted) { set({ status: 'error', sessionId, message: `Codex disconnected: ${String(e)}. Reconnect before sending more edits.` }); abort.abort(); }
        });
      }, 10_000);
      set({ status: 'connected', sessionId });
      const executed = new Set<string>();
      while (!abort.signal.aborted) {
        const command = await request(path + '/next', sessionKey);
        if (command.idle) continue;
        if (typeof command.id !== 'string' || typeof command.method !== 'string' || executed.has(command.id)) throw new Error('invalid or repeated command; stopped without replay');
        executed.add(command.id);
        if (executed.size > 2000) executed.delete(executed.values().next().value!);
        let reply;
        try { reply = { id: command.id, result: await host.execute(command.method, command.args, sessionId, abort.signal) }; }
        catch (e) { reply = { id: command.id, error: e instanceof Error ? e.message : String(e) }; }
        // Failure here is uncertain: the edit may already be committed. Do not
        // retry either the command or a new editing program automatically.
        await request(path + '/result', sessionKey, reply);
        await request(path + '/ping', sessionKey, host.info());
      }
    } catch (e) {
      if (!abort.signal.aborted) set({ status: 'error', message: `Connection stopped: ${e instanceof Error ? e.message : String(e)}. Inspect the project before retrying an edit.` });
    } finally { clearInterval(heartbeat); if (controller === abort) { leave?.(); leave = null; abort.abort(); controller = null; } }
  };
  const initialize = () => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const paired = hash.get('velocut-codex');
    if (paired) { hash.delete('velocut-codex'); history.replaceState(history.state, '', location.pathname + location.search + (hash.size ? '#' + hash : '')); }
    const saved = paired ?? sessionStorage.getItem(KEY);
    if (saved) void connect(saved);
  };
  window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).has('velocut-codex')) initialize(); });
  window.addEventListener('pagehide', () => { leave?.(); controller?.abort(); });
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, connect, disconnect, initialize };
}
export type CodexConnection = ReturnType<typeof createCodexConnection>;
