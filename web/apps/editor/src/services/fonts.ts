// services/fonts.ts — font catalogue for the inspector's font picker.
//
// Built-in families (assumed installed on the OS) plus user-imported font
// files, which are registered with the renderer (FontFace) and persisted to
// OPFS so they survive reloads. The renderer rasterizes text with whatever
// family the payload names; caret/selection use the same metrics, so they
// never drift from a custom font.

import type { PreviewRenderer } from '@velocut/render-sdk';
import { saveFont, listFonts, loadFontData } from '@velocut/collab-sdk';

export interface FontOption {
  family: string;
  label: string;
  custom?: boolean;
}

const BUILTINS: FontOption[] = [
  { family: 'system-ui, sans-serif', label: 'System default' },
  { family: '"PingFang SC", sans-serif', label: 'PingFang' },
  { family: '"Hiragino Sans GB", sans-serif', label: 'Hiragino Sans' },
  { family: '"Songti SC", serif', label: 'Songti' },
  { family: '"STKaiti", "Kaiti SC", serif', label: 'Kaiti' },
  { family: 'Georgia, serif', label: 'Georgia' },
  { family: '"Courier New", monospace', label: 'Courier' },
];

export class FontLibrary {
  private customs: FontOption[] = [];
  private listeners = new Set<() => void>();

  constructor(private renderer: PreviewRenderer) {}

  /** Re-register every persisted font on startup. */
  async restore(): Promise<void> {
    const records = await listFonts();
    for (const r of records) {
      const data = await loadFontData(r.file);
      if (!data) continue;
      try {
        await this.renderer.registerFont(r.family, data);
        this.customs.push({ family: r.family, label: r.family, custom: true });
      } catch (e) {
        console.warn('[velocut] font restore failed:', r.family, e);
      }
    }
    this.emit();
  }

  /** Import a font file: register, persist, expose. Returns its family. */
  async import(file: File): Promise<string> {
    const family = file.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
    await this.renderer.registerFont(family, await file.arrayBuffer());
    await saveFont(family, file);
    if (!this.customs.some((f) => f.family === family)) {
      this.customs.push({ family, label: family, custom: true });
      this.emit();
    }
    return family;
  }

  options(): FontOption[] {
    return [...BUILTINS, ...this.customs];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
