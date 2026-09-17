# Security & Trust Model

Velocut is local-first: media, documents and history stay in browser storage
(OPFS / IndexedDB / localStorage). The local Studio CLI also hosts declarative
model configuration and executes configured media API calls.
Below are the boundaries you should understand before using the Agent features.

## Where the API key lives

- Your API key is entered in the Agent console's provider settings and **stored
  in plaintext in your browser's localStorage** (`velocut.llm`, together with the
  endpoint/model configuration). Requests go directly from the browser to the
  configured endpoint, through no intermediate server of Velocut's.
- This means: anything that can execute JS on that page (browser extensions, XSS,
  unsandboxed developer-console code) can read it. Use a rate-limited key, and clear
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
- Video-generation channel keys follow the LLM pattern, not the proxy pattern:
  they live in localStorage (`velocut.videogen`) and travel in the browser's own
  `Authorization` header. The dev-only `/videogen-proxy/<host>/…` Vite route is a
  pure CORS relay (channel APIs allowlist origins and reject localhost) — it
  injects nothing. In production the channel endpoint must allow CORS, the same
  contract as a configured LLM gateway.

## Declarative model configuration

The local Studio model host stores definitions and credentials separately from the
browser and Codex plugin cache, in `~/.velocut/models/config.json` (override with
`VELOCUT_MODEL_HOME`). This is a local plaintext file created with mode 0600 on
POSIX, not an OS keychain. Model list/export/preview operations never include tokens.
The dedicated `velocut_models` tool can edit model definitions and connection
metadata; it is not exposed to the CodeAct sandbox. Changing a connection endpoint
clears its existing token. Enter replacement tokens through Studio settings.

Definitions contain JSON Schema, HTTP paths and data mappings, not executable
scripts. The local API accepts same-origin JSON POSTs. Calls remain bound to the
configured HTTP(S) origin and do not follow redirects with credentials. Configuration
validation and request preview make no service requests. Paid generation is separate.
The generation sandbox still cannot change endpoints or retrieve credentials.

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
     `document`/`seek`/`motionClip`/`sceneClip`/`videoGen`/…), executed serially
     on the host via MessageChannel RPC; a 60s wall-clock timeout on sandbox
     compute (host RPC time excluded) guards against runaway scripts.
   - Paid/eGress-capable RPCs are further restricted on this path: `tts` is
     pinned to the browser-local backend (cloud TTS would POST attacker-
     controllable text from the host realm), and `videoGen` accepts only a
     **configured channel id + model + prompt** — endpoint and key resolve from
     host-side configuration, and reference-media URL options are rejected, so
     a prompt-injected program can neither point the host at an attacker
     endpoint nor make the provider fetch attacker URLs.

## Timeline generation jobs

The MCP host and sandbox expose `generation`, an allowlisted host service. It
accepts configured channel/model IDs, prompts and project reference IDs, never
endpoint overrides, keys or arbitrary reference URLs. Capturing a reference is
local; submission uploads that saved snapshot through the configured storage
provider. Prompts and references leave the browser when the user-authorized job
runs. The provider may charge credits even if local tracking is later stopped.

The job journal stores request metadata, a channel/credential fingerprint, task
receipts and downloaded-file references separately from undo history. Keys are
not stored in that journal or returned to the agent. Result URLs stay private to
the adapter; downloads go to the original project's storage. Browser lifecycle
locks coordinate same-project tabs. These locks do not coordinate separate
browser profiles or machines. Uncertain submissions are retained for inspection
and never automatically retried as a new paid request. The legacy MCP upload,
videoGen and speech methods remain disabled.

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
