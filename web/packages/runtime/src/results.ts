export interface ObserveResult {
  ok: boolean;
  summary: string;
  images: { base64: string; mediaType: string }[];
  data?: unknown;
  message?: string;
}
export interface ScriptResult {
  ok: boolean;
  result?: unknown;
  logs?: string[];
  error?: string;
}
