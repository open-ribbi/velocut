// services/engine.ts — engine abstraction + DI-selected implementation.
//
// ICoreEngine is the ONLY surface the app sees. Two adapters implement it:
//   WasmEngineAdapter — canonical Rust core compiled by wasm-pack
//   TsEngineAdapter   — TS reference engine (same golden vectors)
// createEngine() probes for the WASM bundle at /wasm/ (put there by
// `wasm-pack build crates/velocut-wasm --target web --release
//  --out-dir ../../web/apps/editor/public/wasm`) and falls back to TS.

import { TsEngine } from '@velocut/core-ts';
import type { Command, Envelope, FrameGraph, TimeUs, VDocument } from '@velocut/protocol';

export interface ICoreEngine {
  readonly kind: 'wasm' | 'ts';
  apply(cmd: Command): Envelope;
  undo(): Envelope;
  redo(): Envelope;
  canUndo(): boolean;
  canRedo(): boolean;
  document(): VDocument;
  load(doc: VDocument): Envelope;
  evaluate(timeUs: TimeUs): FrameGraph;
  durationUs(): TimeUs;
  revision(): number;
}

// ------------------------------------------------------------ TS adapter

export class TsEngineAdapter implements ICoreEngine {
  readonly kind = 'ts' as const;
  private engine: TsEngine;

  constructor(name: string, width: number, height: number, fpsNum: number, fpsDen: number) {
    this.engine = new TsEngine(name, width, height, fpsNum, fpsDen);
  }

  apply(cmd: Command): Envelope {
    return this.engine.apply(cmd);
  }
  undo(): Envelope {
    return this.engine.undo();
  }
  redo(): Envelope {
    return this.engine.redo();
  }
  canUndo(): boolean {
    return this.engine.canUndo();
  }
  canRedo(): boolean {
    return this.engine.canRedo();
  }
  document(): VDocument {
    return this.engine.document();
  }
  load(doc: VDocument): Envelope {
    return this.engine.load(doc);
  }
  evaluate(timeUs: TimeUs): FrameGraph {
    return this.engine.evaluate(timeUs);
  }
  durationUs(): TimeUs {
    return this.engine.durationUs();
  }
  revision(): number {
    return this.engine.revision();
  }
}

// ---------------------------------------------------------- WASM adapter

interface WasmEngineInstance {
  apply(json: string): string;
  undo(): string;
  redo(): string;
  can_undo(): boolean;
  can_redo(): boolean;
  document(): string;
  load(json: string): string;
  evaluate(timeUs: number): string;
  revision(): number;
  duration_us(): number;
}

interface WasmModule {
  default(init?: { module_or_path: string }): Promise<unknown>;
  WasmEngine: new (
    name: string,
    width: number,
    height: number,
    fpsNum: number,
    fpsDen: number,
  ) => WasmEngineInstance;
}

export class WasmEngineAdapter implements ICoreEngine {
  readonly kind = 'wasm' as const;
  constructor(private inner: WasmEngineInstance) {}

  apply(cmd: Command): Envelope {
    return JSON.parse(this.inner.apply(JSON.stringify(cmd)));
  }
  undo(): Envelope {
    return JSON.parse(this.inner.undo());
  }
  redo(): Envelope {
    return JSON.parse(this.inner.redo());
  }
  canUndo(): boolean {
    return this.inner.can_undo();
  }
  canRedo(): boolean {
    return this.inner.can_redo();
  }
  document(): VDocument {
    return JSON.parse(this.inner.document());
  }
  load(doc: VDocument): Envelope {
    return JSON.parse(this.inner.load(JSON.stringify(doc)));
  }
  evaluate(timeUs: TimeUs): FrameGraph {
    return JSON.parse(this.inner.evaluate(timeUs));
  }
  durationUs(): TimeUs {
    return this.inner.duration_us();
  }
  revision(): number {
    return this.inner.revision();
  }
}

// --------------------------------------------------------------- factory

export interface EngineInit {
  name: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

export async function createEngine(init: EngineInit): Promise<ICoreEngine> {
  try {
    // Served from public/wasm if the wasm core has been built. Vite dev
    // refuses module imports from /public, so fetch the glue JS and import
    // it as a blob; the .wasm path is passed explicitly since import.meta.url
    // inside a blob module can't resolve siblings.
    const resp = await fetch('/wasm/velocut_wasm.js');
    if (!resp.ok || !/javascript/.test(resp.headers.get('content-type') ?? '')) {
      throw new Error('wasm bundle not built');
    }
    const blobUrl = URL.createObjectURL(
      new Blob([await resp.text()], { type: 'text/javascript' }),
    );
    let mod: WasmModule;
    try {
      mod = (await import(/* @vite-ignore */ blobUrl)) as WasmModule;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    await mod.default({ module_or_path: '/wasm/velocut_wasm_bg.wasm' });
    const inner = new mod.WasmEngine(init.name, init.width, init.height, init.fpsNum, init.fpsDen);
    console.info('[velocut] engine: wasm (rust core)');
    return new WasmEngineAdapter(inner);
  } catch {
    console.info('[velocut] engine: ts reference (build the wasm core for the rust engine)');
    return new TsEngineAdapter(init.name, init.width, init.height, init.fpsNum, init.fpsDen);
  }
}
