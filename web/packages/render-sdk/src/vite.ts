/** Vite's dependency optimizer relocates bundled code, which would change
 * import.meta.url and break sibling Worker URLs. Keep SDK modules intact in
 * development; normal production bundling still processes them. No Vite
 * runtime dependency is needed for this structurally-compatible plugin. */
export function velocutVite() {
  return {
    name: 'velocut-sdk-workers',
    config() {
      const headers = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      };
      return {
        optimizeDeps: { exclude: ['@velocut/render-sdk', '@velocut/scene-sdk', '@velocut/runtime'] },
        server: { headers },
        preview: { headers },
      };
    },
  };
}
