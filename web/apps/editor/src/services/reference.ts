// services/reference.ts — the "reference in agent chat" channel. Timeline
// clips and asset rows publish a document id (clip_N / asset_N — exactly the
// ids the agent's tools operate on) and the agent console, wherever it is
// docked, appends the token to its input. A one-slot sink is deliberate:
// there is exactly one console per app.

export interface AgentReference {
  /** Document id the token names (clip_N / asset_N). */
  id: string;
  /** Human name, appended for grounding (asset file name, clip label). */
  name?: string;
}

type Sink = (ref: AgentReference) => void;

let sink: Sink | null = null;

/** The agent console registers itself here (last mount wins). */
export function onAgentReference(fn: Sink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/** Publish a reference token toward the agent console. Returns false when no
 *  console is mounted (callers may then fall back to a clipboard copy). */
export function referenceToAgent(ref: AgentReference): boolean {
  if (!sink) return false;
  sink(ref);
  return true;
}

/** Token text as it lands in the input: the raw id, plus the human name in
 *  quotes when it adds grounding (the agent resolves ids via the document). */
export function referenceToken(ref: AgentReference): string {
  return ref.name ? `${ref.id} ("${ref.name}")` : ref.id;
}
