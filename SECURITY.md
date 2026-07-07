# Security & Trust Model

Velocut is a local-first, browser-only app: there is no backend, and your media,
documents, and history all stay on your machine (OPFS / IndexedDB / localStorage).
Below are the boundaries you should understand before using the Agent features.

## Where the API key lives

- Your API key is entered in the Agent console's provider settings and **stored
  in plaintext in your browser's localStorage** (`velocut.llm`, together with the
  endpoint/model configuration). Requests go directly from the browser to the
  configured endpoint, through no intermediate server of Velocut's.
- This means: anything that can execute JS on that page (browser extensions, XSS,
  the script tool described below) can read it. Use a rate-limited key, and clear
  it from the console when not in use.
- **Configuring a relay/gateway base URL is a trust decision.** The default
  endpoint is the official Anthropic API. If you point the base URL at a
  third-party Anthropic-protocol-compatible gateway (LiteLLM, one-api, a
  corporate proxy), your key, your prompts, and the observation frames the agent
  looks at are sent to THAT service instead. Only configure endpoints you trust.
  Browser-direct calls also require the endpoint to allow cross-origin (CORS)
  requests; the settings panel's "Test connection" verifies URL, auth, CORS and
  the model id in one round trip.
- The Gemini search and MiniMax TTS keys are injected via the Vite dev server
  proxy; the browser never holds them (see README "Optional capabilities and key
  conventions").

## The Agent's two levels of execution privilege

1. **Command level (default)**: everything the Agent edits goes through
   `velocut_apply` as JSON commands, validated against the zod schema. It can only
   modify the document model — it cannot touch the DOM or make network requests,
   and every step is recorded in the undoable edit history.
2. **Script level (`velocut_script`)**: the Agent can generate and execute
   JavaScript, but it does **not run in the main page's realm** — it runs in a
   one-shot `sandbox="allow-scripts"` iframe (null origin, with an inline CSP
   `connect-src 'none'` in the srcdoc). This realm:
   - **Cannot read localStorage** (an opaque origin has no storage) → the
     Anthropic key is safe
   - **Cannot make any network request** (fetch / XHR / WebSocket / sendBeacon /
     EventSource / dynamic import are all blocked at the browser level by the
     CSP) → no exfiltration
   - **Cannot touch the parent page's DOM / cookies / `window.velocut`**
     (cross-origin isolation)
   - Can only call a whitelisted API (`apply`/`tts`/`observe`/`evaluate`/
     `document`/`seek`), executed serially on the host via MessageChannel RPC;
     a 60s wall-clock timeout guards against runaway scripts.

## Known risk: the injection chain (mitigated)

`velocut_search` injects untrusted web content into the model's context. The
theoretical attack path: malicious web content → lures the model into generating
a malicious `velocut_script` → reads the key from localStorage or makes arbitrary
requests. **The sandbox above severs this chain**: the script cannot get the key
and cannot reach the outside network. Still worth noting:

- `motionClip` now accepts a declarative JSON spec (no longer a draw closure), so
  it can be safely created from sandboxed scripts — the spec crosses the boundary
  as pure data, and the host renders it with a fixed interpreter, never eval'ing
  anything. Image `src` values in the spec are fetched by the host via GET (the
  fetch only retrieves the image, the response is never sent out, and the sandbox
  has no secrets to smuggle into the URL — not an exfiltration surface).
- The key is still stored in plaintext in localStorage: anything that can read
  the page's main realm (a malicious browser extension, XSS in the page itself)
  can still obtain it. The sandbox only isolates Agent scripts; it does not
  change what extensions are allowed to do.

## Reporting vulnerabilities

If you find a security issue, please open a GitHub issue (for scenarios that are
not remotely exploitable), or report it privately via the contact information on
the repository homepage. This is a personal open-source project — there is no
bounty, but reports will be taken seriously and fixed.
