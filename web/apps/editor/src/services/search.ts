// services/search.ts — web research for the agent (velocut_search host side).
//
// Reuses evo-backend's proven approach: Gemini grounded search. One call returns
// a cited answer + source list — the model researches and summarizes, so the
// agent gets facts (character names, plot order, what's a famous scene) it can't
// get from training memory, without us building a crawler. The Google key is
// injected server-side by the /gemini-proxy (vite), so the browser never holds
// it — same pattern as MiniMax TTS.

import type { SearchResult } from '@velocut/agent-sdk';

const MODEL = 'gemini-2.5-flash';

interface GeminiPart {
  text?: string;
}
interface GeminiChunk {
  web?: { uri?: string; title?: string };
}

export async function searchWeb(query: string): Promise<SearchResult> {
  try {
    const r = await fetch(`/gemini-proxy/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        // google_search = web grounding; url_context lets it read URLs in the query.
        tools: [{ google_search: {} }, { url_context: {} }],
      }),
    });
    if (!r.ok) {
      return { ok: false, answer: '', sources: [], message: `search ${r.status}: ${(await r.text()).slice(0, 160)}` };
    }
    const d = await r.json();
    const c = d.candidates?.[0] ?? {};
    const answer: string = (c.content?.parts ?? [])
      .map((p: GeminiPart) => p.text ?? '')
      .join('')
      .trim();
    const chunks: GeminiChunk[] = c.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
      .filter((x) => x.web?.uri)
      .map((x) => ({ title: x.web!.title ?? '', url: x.web!.uri as string }))
      .slice(0, 10);
    if (!answer) return { ok: false, answer: '', sources, message: d.error?.message ?? 'Search returned no results' };
    return { ok: true, answer, sources };
  } catch (e) {
    return { ok: false, answer: '', sources: [], message: String(e instanceof Error ? e.message : e) };
  }
}
