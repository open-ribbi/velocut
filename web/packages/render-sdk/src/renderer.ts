// services/renderer.ts — WebGPU compositor.
//
// One pipeline composites every layer kind:
//   video  → GPUExternalTexture via importExternalTexture(VideoFrame) — the
//            zero-copy path; the decoded frame never round-trips through CPU
//   image  → pre-wrapped as VideoFrame at import time (same binding)
//   text   → rasterized to an offscreen canvas, wrapped as VideoFrame,
//            cached per payload
//
// Per layer: a 2D affine (scale·rotate·translate → NDC) computed on CPU into
// a small uniform, color-adjust uniforms from the effect registry, one quad
// generated from vertex_index (no vertex buffers), standard alpha blending.

import type { FrameGraph, Layer, TextPayload } from '@velocut/protocol';
import type { MediaLibrary } from './media.ts';
import { resolveColorAdjust, resolvePassEffects, transitionWgsl, TRANSITIONS, type PassEffect } from './effects.ts';
import { computeInkRect, computeTextLayout, fontSpecOf, type InkRect, type TextLayout } from './textlayout.ts';

// Re-exported so consumers (and the SDK barrel) keep importing these from the
// renderer even though the layout math now lives in ./textlayout (shared with
// the main-thread editor across the worker boundary).
export type { InkRect, TextLayout, TextLine } from './textlayout.ts';

/** The active FontFaceSet — document.fonts on the main thread (the export
 *  Renderer), or the worker global's fonts when the Renderer runs inside the
 *  render worker (no `document` there). Custom fonts are registered into
 *  whichever set this thread owns. */
function fontSet(): FontFaceSet {
  return typeof document !== 'undefined'
    ? document.fonts
    : (self as unknown as { fonts: FontFaceSet }).fonts;
}

const SHADER = /* wgsl */ `
struct LayerUniform {
  col0: vec4<f32>,   // (a, b, 0, 0) — matrix column 0
  col1: vec4<f32>,   // (c, d, 0, 0) — matrix column 1
  col2: vec4<f32>,   // (tx, ty, 0, 0) — translation (NDC)
  misc: vec4<f32>,   // (opacity, brightness, contrast, saturation)
  grade: vec4<f32>,  // (temperature, tint, exposure, vibrance)
  tone: vec4<f32>,   // (highlights, shadows, vignette, _)
};
@group(0) @binding(0) var<uniform> u: LayerUniform;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_external;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // Two triangles covering a unit quad centered at origin.
  var corners = array<vec2<f32>, 6>(
    vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(-0.5, 0.5),
    vec2(-0.5,  0.5), vec2(0.5, -0.5), vec2( 0.5, 0.5),
  );
  let c = corners[vi];
  let x = u.col0.x * c.x + u.col1.x * c.y + u.col2.x;
  let y = u.col0.y * c.x + u.col1.y * c.y + u.col2.y;
  var out: VsOut;
  out.pos = vec4(x, y, 0.0, 1.0);
  out.uv = vec2(c.x + 0.5, c.y + 0.5); // model y is already texture-down (see packUniform)
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSampleBaseClampToEdge(tex, samp, in.uv);
  var rgb = color.rgb;

  // 1. exposure — photographic gain (stops). exp2(0) = 1 → no-op.
  rgb = rgb * exp2(u.grade.z);

  // 2. white balance — temperature warms R / cools B; tint shifts G↔magenta.
  rgb.r = rgb.r + u.grade.x * 0.12;
  rgb.b = rgb.b - u.grade.x * 0.12;
  rgb.g = rgb.g + u.grade.y * 0.12;

  // 3. contrast around mid-grey, then brightness.
  rgb = (rgb - vec3(0.5)) * u.misc.z + vec3(0.5) + vec3(u.misc.y);

  // 4. highlights / shadows — luma-masked lift so each touches only its band.
  let luma0 = dot(clamp(rgb, vec3(0.0), vec3(1.0)), vec3(0.2126, 0.7152, 0.0722));
  rgb = rgb + u.tone.x * smoothstep(0.5, 1.0, luma0) * 0.5;        // highlights
  rgb = rgb + u.tone.y * (1.0 - smoothstep(0.0, 0.5, luma0)) * 0.5; // shadows

  // 5. saturation + vibrance (vibrance boosts the less-saturated pixels more).
  let luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  let chroma = distance(rgb, vec3(luma));
  let vib = 1.0 + u.grade.w * (1.0 - clamp(chroma, 0.0, 1.0));
  rgb = mix(vec3(luma), rgb, u.misc.w * vib);

  // 6. vignette — radial darkening from the layer centre (uv 0..1).
  let vig = 1.0 - u.tone.z * smoothstep(0.35, 0.75, distance(in.uv, vec2(0.5)));
  rgb = rgb * vig;

  return vec4(clamp(rgb, vec3(0.0), vec3(1.0)), color.a * u.misc.x);
}
`;

// Post-process passes operate on a regular texture_2d (the rasterized layer),
// not the external VideoFrame — a fullscreen triangle, sampling with taps the
// single composite pass can't. fsBlur is a separable 9-tap Gaussian (run once
// horizontal, once vertical); fsComposite blits the result back, premultiplied.
const POST_SHADER = /* wgsl */ `
struct PostU { param: vec4<f32> };   // blur: (stepU.x, stepU.y, _, _) per-tap uv offset
@group(0) @binding(0) var<uniform> pu: PostU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  let c = p[vi];
  var o: VOut;
  o.pos = vec4(c, 0.0, 1.0);
  o.uv = vec2((c.x + 1.0) * 0.5, (1.0 - c.y) * 0.5);
  return o;
}

@fragment
fn fsBlur(in: VOut) -> @location(0) vec4<f32> {
  let s = pu.param.xy;
  // Premultiplied-alpha Gaussian — summing premult rgba is linear, no fringing.
  var sum = textureSample(tex, samp, in.uv) * 0.2270270;
  sum += (textureSample(tex, samp, in.uv + s) + textureSample(tex, samp, in.uv - s)) * 0.1945946;
  sum += (textureSample(tex, samp, in.uv + s * 2.0) + textureSample(tex, samp, in.uv - s * 2.0)) * 0.1216216;
  sum += (textureSample(tex, samp, in.uv + s * 3.0) + textureSample(tex, samp, in.uv - s * 3.0)) * 0.0540541;
  sum += (textureSample(tex, samp, in.uv + s * 4.0) + textureSample(tex, samp, in.uv - s * 4.0)) * 0.0162162;
  return sum;
}

@fragment
fn fsComposite(in: VOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv); // already premultiplied; blend = src + dst*(1-a)
}
`;

const UNIFORM_SIZE = 96; // 6 × vec4<f32> (matrix 3 + misc + grade + tone)
const POST_UNIFORM_SIZE = 80; // texel vec4 + up to 16 params (array<vec4,4>)
const MAX_SHADER_PARAMS = 16;

// Built-in dual-input combine for 'glow': sharp original (orig) + blurred
// bright-pass (src) → additive bloom. A worked example of orig()+src() together.
const GLOW_COMBINE = `
  let base = orig(uv);
  let bloom = src(uv);
  let bright = max(bloom.rgb - vec3<f32>(threshold), vec3<f32>(0.0)) * intensity;
  return vec4<f32>(base.rgb + bright, base.a);`;
interface TextCacheEntry {
  frame: VideoFrame;
  width: number;
  height: number;
}

export class Renderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private layout!: GPUBindGroupLayout;
  private uniformBuffers: GPUBuffer[] = [];
  // Reused per-layer uniform staging — queue.writeBuffer copies synchronously, so
  // one scratch array is safe across all layers in a frame (avoids a Float32Array
  // allocation per layer per frame in the composite hot path).
  private uniScratch = new Float32Array(24);
  private canvas!: HTMLCanvasElement | OffscreenCanvas;
  private format!: GPUTextureFormat;
  // Multi-pass effect plumbing (blur, …): a fullscreen pipeline that samples a
  // texture_2d, plus two ping-pong intermediate textures sized to the canvas.
  private blurPipeline!: GPURenderPipeline;
  private compositePipeline!: GPURenderPipeline;
  private postLayout!: GPUBindGroupLayout;
  private postBuffers: GPUBuffer[] = [];
  private fxTex: GPUTexture[] = []; // [A, B] ping-pong
  private fxW = 0;
  private fxH = 0;
  // Compiled pipelines for shader-pass effects (built-in presets AND AI-authored
  // WGSL), cached by source. null = compilation failed → the pass is skipped.
  private shaderPipelines = new Map<string, GPURenderPipeline | null>();
  /** Bumped on every init(). All GPU resources (pipelines, buffers, textures)
   *  belong to the device of one generation; a re-init (e.g. React StrictMode
   *  mounts the preview twice) acquires a NEW device, so async pipeline compiles
   *  in flight from the old generation must NOT commit into the cache — their
   *  pipelines belong to the discarded device and would fail setPipeline with a
   *  cross-device error. */
  private deviceGen = 0;
  /** De-dupes concurrent/repeat init() for the same canvas (StrictMode). */
  private initPromise: Promise<void> | null = null;
  private initCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  /** The preserved original-layer view bound at binding 3 (orig()) for the
   *  effect chain currently being rendered. Set per renderEffectLayer call. */
  private origView: GPUTextureView | null = null;
  private textCache = new Map<string, TextCacheEntry>();
  /** Composite width of the frame currently being rendered — full-width text
   *  bars size their background to this. Set at the top of render(). */
  private composeW = 0;
  /** Families we've already kicked off a load for (avoid re-requesting). */
  private fontRequested = new Set<string>();
  /** Bumped when a font finishes loading — lets the paused playback loop
   *  know a repaint is worthwhile (the text was rastered with a fallback). */
  version = 0;
  ready = false;
  /** Notified on every version bump. When the Renderer runs inside the render
   *  worker, async invalidations (a font or shader-effect finishing compile
   *  while the transport is PAUSED) produce no further render messages — so the
   *  worker hooks this to push a repaint to the main thread. The export Renderer
   *  leaves it unset (it drives every frame explicitly). */
  onInvalidate: (() => void) | null = null;

  /** Bump the repaint version and fire onInvalidate (font load, shader compile). */
  private bump() {
    this.version++;
    this.onInvalidate?.();
  }

  /** Register a custom font from file bytes so canvas2d can rasterize it. */
  async registerFont(family: string, data: ArrayBuffer): Promise<void> {
    const face = new FontFace(family, data);
    await face.load();
    fontSet().add(face);
    this.fontRequested.add(family);
    this.invalidateTextCache();
    this.bump();
  }

  private invalidateTextCache() {
    for (const e of this.textCache.values()) e.frame.close();
    this.textCache.clear();
  }

  /** If the payload's font isn't ready yet, kick off a load and repaint when
   *  it lands. Returns whether the font is ready NOW (else fallback rasters). */
  private ensureFont(text: TextPayload): boolean {
    const fontSize = text.fontSize ?? 64;
    const fontFamily = text.fontFamily ?? 'system-ui, sans-serif';
    const spec = `${fontSize}px ${fontFamily}`;
    const fonts = fontSet();
    if (fonts.check(spec)) return true;
    const key = `${fontFamily}@${fontSize}`;
    if (!this.fontRequested.has(key)) {
      this.fontRequested.add(key);
      fonts.load(spec).then(
        () => {
          this.invalidateTextCache();
          this.bump();
        },
        () => {},
      );
    }
    return false;
  }

  /** Idempotent against duplicate/concurrent calls for the SAME canvas — React
   *  StrictMode mounts the preview twice (mount → cleanup → mount) on this one
   *  singleton, so two init()s would otherwise race on the device/pipelines and
   *  tear them across two GPUDevices (cross-device setPipeline errors → black
   *  transitions). A genuinely new canvas re-initializes. */
  init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    if (this.initPromise && this.initCanvas === canvas) return this.initPromise;
    this.initCanvas = canvas;
    this.initPromise = this.initDevice(canvas);
    return this.initPromise;
  }

  private async initDevice(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU unavailable — please use Chrome/Edge 113+');
    }
    // Drop every GPU resource cached against a prior device — a re-init acquires
    // a new one, and mixing resources across devices is a hard error. Bumping the
    // generation also invalidates any async pipeline compile still in flight.
    this.deviceGen++;
    this.shaderPipelines.clear();
    this.uniformBuffers = [];
    this.postBuffers = [];
    this.fxTex = [];
    this.fxW = 0;
    this.fxH = 0;

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No GPU adapter found');
    this.device = await adapter.requestDevice();
    this.device.addEventListener('uncapturederror', (e) => {
      console.error('[velocut][GPU]', (e as GPUUncapturedErrorEvent).error.message);
    });
    this.canvas = canvas;

    this.context = canvas.getContext('webgpu') as unknown as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.format = format;
    this.context.configure({ device: this.device, format, alphaMode: 'opaque' });

    const module = this.device.createShaderModule({ code: SHADER });
    this.layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      ],
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Post-process pipelines (multi-pass effects). Both sample a texture_2d.
    const postModule = this.device.createShaderModule({ code: POST_SHADER });
    this.postLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // current
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // orig (dual-input)
      ],
    });
    const postPipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
    // Blur writes opaquely into the next ping-pong texture (no blend).
    this.blurPipeline = this.device.createRenderPipeline({
      layout: postPipelineLayout,
      vertex: { module: postModule, entryPoint: 'vsFull' },
      fragment: { module: postModule, entryPoint: 'fsBlur', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    // Composite blends the (premultiplied) result over the canvas.
    this.compositePipeline = this.device.createRenderPipeline({
      layout: postPipelineLayout,
      vertex: { module: postModule, entryPoint: 'vsFull' },
      fragment: {
        module: postModule,
        entryPoint: 'fsComposite',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.ready = true;

    // Warm the built-in transition shaders so scrubbing to a transition never
    // catches a not-yet-compiled pipeline (which would briefly hard-cut).
    for (const t of TRANSITIONS) this.shaderPipeline(t.wgsl, ['progress']);
  }

  private uniformBuffer(i: number): GPUBuffer {
    while (this.uniformBuffers.length <= i) {
      this.uniformBuffers.push(
        this.device.createBuffer({
          size: UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    return this.uniformBuffers[i];
  }

  /** Pool of small uniform buffers for post passes — each pass needs its own
   *  (writeBuffer can't differ per-pass within one submit). */
  private postBuffer(i: number): GPUBuffer {
    while (this.postBuffers.length <= i) {
      this.postBuffers.push(
        this.device.createBuffer({
          size: POST_UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    return this.postBuffers[i];
  }

  /** Four canvas-sized textures for effect passes, (re)allocated on resize:
   *  [A, B] ping-pong + [C] the preserved original layer (the dual-input
   *  `orig()` source — glow/bloom, blend-with-original, etc.) + [D, E] parking
   *  slots the transition path uses to hold each side's effected result (so the
   *  mix samples clean copies, never a live chain working texture). COPY_DST/SRC
   *  so rasterized layers can be copied between them. */
  private fxTextures(): GPUTexture[] {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.fxTex.length === 5 && this.fxW === w && this.fxH === h) return this.fxTex;
    this.fxTex.forEach((t) => t.destroy());
    this.fxTex = [0, 1, 2, 3, 4].map(() =>
      this.device.createTexture({
        size: { width: w, height: h },
        format: this.format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      }),
    );
    this.fxW = w;
    this.fxH = h;
    return this.fxTex;
  }

  /** Wrap an effect's WGSL `userEffect` body into a complete fullscreen module.
   *  Provides: uv, src(uv) (straight-alpha sample, neighbour-capable), texel,
   *  and each param as a named `let`. The output is NaN-guarded, clamped, and
   *  re-premultiplied for the pass pipeline — the author works in plain RGBA. */
  private buildPassShader(body: string, paramKeys: string[]): string {
    const comp = ['x', 'y', 'z', 'w'];
    const lets = paramKeys
      .slice(0, MAX_SHADER_PARAMS)
      .map((k, i) => `  let ${k} = u.p[${Math.floor(i / 4)}].${comp[i % 4]};`)
      .join('\n');
    return /* wgsl */ `
struct PU { texel: vec4<f32>, p: array<vec4<f32>, 4> };
@group(0) @binding(0) var<uniform> u: PU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var tex0: texture_2d<f32>;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> VOut {
  var pp = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  let c = pp[vi];
  var o: VOut; o.pos = vec4(c, 0.0, 1.0); o.uv = vec2((c.x + 1.0) * 0.5, (1.0 - c.y) * 0.5); return o;
}
fn unpremul(c: vec4<f32>) -> vec4<f32> {
  // Guard near-transparent pixels: dividing tiny rgb by tiny alpha explodes into
  // out-of-gamut values (clamped later to garish primaries). A ~0-alpha pixel
  // carries no color, so treat it as fully transparent.
  if (c.a < 1.0e-3) { return vec4<f32>(0.0); }
  return vec4<f32>(c.rgb / c.a, c.a);
}
// textureSampleLevel (explicit LOD 0) — NOT textureSample — because transition
// bodies call these inside conditionals (if (x<1.0) { getFromColor(...) }), and
// WGSL forbids the derivative-taking textureSample under non-uniform control
// flow. We have no mipmaps, so level 0 is exact and equivalent.
fn src(p: vec2<f32>) -> vec4<f32> { return unpremul(textureSampleLevel(tex, samp, p, 0.0)); }   // current (prior passes)
fn orig(p: vec2<f32>) -> vec4<f32> { return unpremul(textureSampleLevel(tex0, samp, p, 0.0)); } // original layer
// Transition aliases (GL Transitions standard names). NB: WGSL reserves the
// word \`from\`, so we expose getFromColor/getToColor — not from()/to().
fn getToColor(p: vec2<f32>) -> vec4<f32> { return src(p); }   // incoming clip
fn getFromColor(p: vec2<f32>) -> vec4<f32> { return orig(p); } // outgoing clip
fn userEffect(uv: vec2<f32>) -> vec4<f32> {
  let texel = u.texel.xy;
  let ratio = u.texel.y / max(u.texel.x, 1e-8); // width/height (GL Transitions)
${lets}
${body}
}
@fragment fn fsUser(in: VOut) -> @location(0) vec4<f32> {
  var c = userEffect(in.uv);
  c = select(vec4<f32>(0.0), c, c == c);          // NaN → 0
  c = clamp(c, vec4<f32>(0.0), vec4<f32>(1.0));
  return vec4<f32>(c.rgb * c.a, c.a);             // re-premultiply
}`;
  }

  /** Compiled (once, cached) shader-pass pipeline, or null while compiling /
   *  if the WGSL is invalid. Compilation is ASYNC and the pipeline is only
   *  cached once it validates — so an unvalidated or broken AI-authored shader
   *  is simply SKIPPED (the layer renders without it) rather than poisoning the
   *  frame's command buffer or blocking the render thread on driver compile. */
  private shaderPipeline(body: string, paramKeys: string[]): GPURenderPipeline | null {
    const key = `${paramKeys.join(',')}\n${body}`;
    const cached = this.shaderPipelines.get(key);
    if (cached !== undefined) return cached; // pipeline, or null (pending/invalid)
    this.shaderPipelines.set(key, null); // pending → skip until it compiles
    const gen = this.deviceGen; // pin the device this pipeline is built against
    const module = this.device.createShaderModule({ code: this.buildPassShader(body, paramKeys) });
    this.device
      .createRenderPipelineAsync({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
        vertex: { module, entryPoint: 'vsFull' },
        fragment: { module, entryPoint: 'fsUser', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      })
      .then(
        (pipeline) => {
          if (gen !== this.deviceGen) return; // device re-acquired meanwhile — pipeline is stale
          this.shaderPipelines.set(key, pipeline);
          this.bump(); // a fresh effect compiled — repaint even if paused
        },
        (err) => console.warn('[velocut] shader effect invalid, skipping:', String(err?.message ?? err)),
      );
    return null;
  }

  /** Run one compiled shader pass: srcView → dstView with texel + packed params. */
  private shaderPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    srcView: GPUTextureView,
    dstView: GPUTextureView,
    postIdx: number,
    paramKeys: string[],
    params: Record<string, number>,
  ): void {
    const data = new Float32Array(20); // texel(4) + 16 params
    data[0] = 1 / this.canvas.width;
    data[1] = 1 / this.canvas.height;
    paramKeys.slice(0, MAX_SHADER_PARAMS).forEach((k, i) => (data[4 + i] = params[k] ?? 0));
    const buf = this.postBuffer(postIdx);
    this.device.queue.writeBuffer(buf, 0, data);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dstView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.postBindGroup(srcView, postIdx, buf));
    pass.draw(3);
    pass.end();
  }

  // ------------------------------------------------------------- text

  // An OffscreenCanvas measuring context (not document.createElement) so the
  // renderer measures the same in the worker as on the main thread.
  private measureCtx: OffscreenCanvasRenderingContext2D | null = null;

  /** Exact glyph layout of a text payload, in source (frame) pixels — the
   *  shared {@link computeTextLayout} so the rasterizer here and the editor's
   *  caret/selection (which runs the same math on the main thread) can't drift. */
  textLayout(text: TextPayload): TextLayout {
    this.measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')!;
    return computeTextLayout(text, this.measureCtx);
  }

  /** Raster size a text payload renders at (hit-testing convenience). */
  measureText(text: TextPayload): { width: number; height: number } {
    const l = this.textLayout(text);
    return { width: l.frameW, height: l.frameH };
  }

  /** Visible (ink) bounds within the raster frame — selection chrome only;
   *  hit-testing and caret math stay on the padded frame. */
  textInkRect(text: TextPayload): InkRect {
    this.measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')!;
    return computeInkRect(text, this.measureCtx);
  }

  private textFrame(text: TextPayload): TextCacheEntry {
    const full = !!text.backgroundFullWidth;
    // Full-width bars depend on the composite width, so it's part of the key.
    const key = (full ? this.composeW + '|' : '') + JSON.stringify(text);
    const hit = this.textCache.get(key);
    if (hit) return hit;

    // Kick off a load if the font isn't ready; the fallback raster below is
    // cached, then dropped + repainted when ensureFont's load resolves.
    this.ensureFont(text);
    const fontSize = text.fontSize ?? 64;
    const layout = this.textLayout(text);
    // Full-width subtitle bar: widen the raster to the composite width and
    // center the glyphs within it, so the background band spans the whole frame
    // edge-to-edge (covers burned-in subtitles a text-hugging pill can't).
    const width = full ? Math.max(layout.frameW, this.composeW || layout.frameW) : layout.frameW;
    const height = layout.frameH;
    const xShift = (width - layout.frameW) / 2;
    const c = new OffscreenCanvas(width, height);
    const ctx2 = c.getContext('2d')!;
    ctx2.font = fontSpecOf(text);
    ctx2.textBaseline = 'top';
    ctx2.textAlign = 'left';

    // 1. Background: one full-width band (subtitle bar) or per-line pills.
    if (text.backgroundColor) {
      const padX = fontSize * 0.3;
      const padY = fontSize * 0.08;
      const r = fontSize * 0.14;
      ctx2.save();
      ctx2.globalAlpha = text.backgroundOpacity ?? 1;
      ctx2.fillStyle = text.backgroundColor;
      if (full) {
        // A single band spanning the whole raster width, covering every line.
        const top = layout.lines[0].top - padY;
        const last = layout.lines[layout.lines.length - 1];
        const bottom = last.top + layout.lineHeight - fontSize * 0.05 + padY;
        ctx2.fillRect(0, top, width, bottom - top);
      } else {
        for (const line of layout.lines) {
          const x = line.left - padX;
          const y = line.top - padY;
          const w = line.width + 2 * padX;
          const h = layout.lineHeight - fontSize * 0.05 + 2 * padY;
          ctx2.beginPath();
          ctx2.roundRect(x, y, w, h, r);
          ctx2.fill();
        }
      }
      ctx2.restore();
    }
    // Glyphs are laid out for the text-width frame; shift them to stay centered
    // inside a widened full-width raster (the background band is already absolute).
    if (xShift) ctx2.translate(xShift, 0);

    const strokeW = text.strokeColor ? Math.max(0, text.strokeWidth ?? 0) : 0;
    // Draw each line at its measured left edge — identical geometry to the
    // caret/selection math in the editor.
    for (const line of layout.lines) {
      // 2. Shadow pass: cast from the outline if stroked, else from the fill.
      if (text.shadowColor) {
        ctx2.save();
        ctx2.shadowColor = text.shadowColor;
        ctx2.shadowBlur = text.shadowBlur ?? 0;
        ctx2.shadowOffsetX = text.shadowX ?? 0;
        ctx2.shadowOffsetY = text.shadowY ?? 0;
        if (strokeW > 0) {
          ctx2.lineWidth = strokeW * 2;
          ctx2.strokeStyle = text.strokeColor as string;
          ctx2.lineJoin = 'round';
          ctx2.strokeText(line.text, line.left, line.top);
        } else {
          ctx2.fillStyle = text.color ?? '#ffffff';
          ctx2.fillText(line.text, line.left, line.top);
        }
        ctx2.restore();
      }
      // 3. Outline.
      if (strokeW > 0) {
        ctx2.lineWidth = strokeW * 2;
        ctx2.strokeStyle = text.strokeColor as string;
        ctx2.lineJoin = 'round';
        ctx2.strokeText(line.text, line.left, line.top);
      }
      // 4. Fill on top.
      ctx2.fillStyle = text.color ?? '#ffffff';
      ctx2.fillText(line.text, line.left, line.top);
    }

    const frame = new VideoFrame(c, { timestamp: 0 });
    const entry = { frame, width, height };
    // Cap cache; text payloads change rarely.
    if (this.textCache.size > 32) {
      const first = this.textCache.keys().next().value as string;
      this.textCache.get(first)?.frame.close();
      this.textCache.delete(first);
    }
    this.textCache.set(key, entry);
    return entry;
  }

  // ------------------------------------------------------------ render

  /**
   * Composite one FrameGraph onto the canvas. `frameFor` lets the export path
   * supply frame-exact decoded frames (keyed by clipId); preview omits it and
   * uses the realtime media path.
   */
  render(fg: FrameGraph, media: MediaLibrary, frameFor?: (clipId: string) => VideoFrame | null): void {
    if (!this.ready) return;
    this.composeW = fg.width;
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();

    // Layers composite back-to-front. Plain layers (no pass effects) batch into
    // a single direct pass — the original fast path. A layer WITH pass effects
    // breaks the batch: it rasters into an offscreen texture, runs its pass
    // chain, and composites the result; then batching resumes. `cleared` tracks
    // whether the canvas has been written yet so the first pass clears it.
    let drawIndex = 0;
    let postIndex = 0;
    let cleared = false;
    let batch: { layer: Layer; source: NonNullable<ReturnType<Renderer['layerSource']>> }[] = [];

    const flushBatch = () => {
      if (!batch.length) return;
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: cleared ? 'load' : 'clear', storeOp: 'store' },
        ],
      });
      cleared = true;
      pass.setPipeline(this.pipeline);
      for (const { layer, source } of batch) drawIndex = this.drawLayer(pass, layer, source, fg, drawIndex);
      pass.end();
      batch = [];
    };

    for (const layer of fg.layers) {
      const source = this.layerSource(layer, media, frameFor);
      if (layer.transition) {
        // Render even if the INCOMING frame isn't decoded yet (source null) —
        // the transition still has its outgoing side to show, so it shouldn't
        // black out while the incoming clip's decoder catches up.
        flushBatch(); // composite everything below the transition first
        const r = this.renderTransitionLayer(encoder, view, layer, source, fg, media, frameFor, drawIndex, postIndex, !cleared);
        drawIndex = r.drawIndex;
        postIndex += r.postUsed;
        cleared = true;
        continue;
      }
      if (!source) continue;
      const pfx = resolvePassEffects(layer.effects as never);
      if (pfx.length === 0) {
        batch.push({ layer, source });
        continue;
      }
      flushBatch(); // everything below this layer must already be on the canvas
      const r = this.renderEffectLayer(encoder, view, layer, source, fg, pfx, drawIndex, postIndex, !cleared);
      drawIndex = r.drawIndex;
      postIndex += r.postUsed;
      cleared = true;
    }
    flushBatch();

    if (!cleared) {
      // Nothing drawable — still clear the canvas to black.
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /** Draw one layer's quad into an open pass with the main composite pipeline.
   *  Returns the next free uniform-buffer index. */
  private drawLayer(
    pass: GPURenderPassEncoder,
    layer: Layer,
    source: { frame: VideoFrame; width: number; height: number },
    fg: FrameGraph,
    drawIndex: number,
  ): number {
    const buf = this.uniformBuffer(drawIndex);
    this.device.queue.writeBuffer(buf, 0, this.packUniform(layer, source.width, source.height, fg));
    let external: GPUExternalTexture;
    try {
      external = this.device.importExternalTexture({ source: source.frame });
    } catch {
      return drawIndex; // frame closed by cache eviction mid-flight
    }
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: external },
        ],
      }),
    );
    pass.draw(6);
    return drawIndex + 1;
  }

  /** Raster a layer and run its multi-pass effect chain, leaving the result in
   *  one of the ping-pong textures (returned). Does NOT composite — the caller
   *  decides where the result goes (canvas, or a transition mix input). Uses
   *  `ta`/`tb` as ping-pong (raster lands in `ta`) and `tc` as the preserved
   *  dual-input `orig()` source. Sets this.origView for the chain; the caller
   *  resets it once it's done consuming the result. */
  private effectChainResult(
    encoder: GPUCommandEncoder,
    layer: Layer,
    source: { frame: VideoFrame; width: number; height: number },
    fg: FrameGraph,
    pfx: PassEffect[],
    ta: GPUTexture,
    tb: GPUTexture,
    tc: GPUTexture,
    drawIndex: number,
    postIndex: number,
  ): { resultView: GPUTextureView; resultTex: GPUTexture; drawIndex: number; postUsed: number } {
    const viewA = ta.createView();
    const viewB = tb.createView();
    const viewC = tc.createView();

    // Raster the transformed/graded layer onto a transparent texture (ta) — the
    // main pipeline's over-blend onto a cleared target yields premultiplied
    // alpha — then copy it into tc as the preserved `orig()` source.
    const rp = encoder.beginRenderPass({
      colorAttachments: [{ view: viewA, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    rp.setPipeline(this.pipeline);
    drawIndex = this.drawLayer(rp, layer, source, fg, drawIndex);
    rp.end();
    encoder.copyTextureToTexture({ texture: ta }, { texture: tc }, { width: this.canvas.width, height: this.canvas.height });
    this.origView = viewC;

    // Effect chain, ping-ponging ta↔tb (tc stays the untouched original).
    const pp = { sView: viewA, dView: viewB, sTex: ta, dTex: tb, pi: postIndex };
    const swap = () => {
      [pp.sView, pp.dView] = [pp.dView, pp.sView];
      [pp.sTex, pp.dTex] = [pp.dTex, pp.sTex];
    };
    // N dense small Gaussians ≈ one wide alias-free Gaussian (fixed 9-tap kernel
    // undersamples past ~2px/tap). Advances the ping-pong in place.
    const blur = (radius: number) => {
      const iterations = Math.min(16, Math.max(1, Math.ceil(radius / 8)));
      const step = radius / iterations / 4;
      for (let it = 0; it < iterations; it++) {
        this.postPass(encoder, this.blurPipeline, pp.sView, pp.dView, pp.pi++, [step / this.canvas.width, 0]);
        swap();
        this.postPass(encoder, this.blurPipeline, pp.sView, pp.dView, pp.pi++, [0, step / this.canvas.height]);
        swap();
      }
    };

    for (const fx of pfx) {
      if (fx.kind === 'blur') {
        const radius = Math.max(0, Number(fx.params['radius'] ?? 0));
        if (radius > 0) blur(radius);
      } else if (fx.kind === 'glow') {
        // Dual-input: blur the current image, then add its bright-pass back onto
        // the SHARP original (orig()) for a bloom halo.
        blur(Math.max(1, Number(fx.params['radius'] ?? 12)));
        const pipeline = this.shaderPipeline(GLOW_COMBINE, ['intensity', 'threshold']);
        if (pipeline) {
          this.shaderPass(encoder, pipeline, pp.sView, pp.dView, pp.pi++, ['intensity', 'threshold'], fx.params);
          swap();
        }
      } else if (fx.kind === 'shader') {
        if (!fx.wgsl) continue;
        const keys = Object.keys(fx.params).sort();
        const pipeline = this.shaderPipeline(fx.wgsl, keys);
        if (!pipeline) continue; // compile failed/pending → skip this effect, keep the layer
        this.shaderPass(encoder, pipeline, pp.sView, pp.dView, pp.pi++, keys, fx.params);
        swap();
      }
    }
    return { resultView: pp.sView, resultTex: pp.sTex, drawIndex, postUsed: pp.pi - postIndex };
  }

  /** Render a layer that has multi-pass effects: raster → effect chain → composite.
   *  The rasterized layer lands premultiplied on a transparent texture, so the
   *  blur and the final composite stay in premultiplied-alpha space. */
  private renderEffectLayer(
    encoder: GPUCommandEncoder,
    canvasView: GPUTextureView,
    layer: Layer,
    source: { frame: VideoFrame; width: number; height: number },
    fg: FrameGraph,
    pfx: PassEffect[],
    drawIndex: number,
    postIndex: number,
    clearCanvas: boolean,
  ): { drawIndex: number; postUsed: number } {
    const [texA, texB, texC] = this.fxTextures();
    const r = this.effectChainResult(encoder, layer, source, fg, pfx, texA, texB, texC, drawIndex, postIndex);

    // Composite the (premultiplied) result over the canvas.
    const cp = encoder.beginRenderPass({
      colorAttachments: [
        { view: canvasView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: clearCanvas ? 'clear' : 'load', storeOp: 'store' },
      ],
    });
    cp.setPipeline(this.compositePipeline);
    cp.setBindGroup(0, this.postBindGroup(r.resultView, postIndex + r.postUsed));
    cp.draw(3);
    cp.end();
    this.origView = null;
    return { drawIndex: r.drawIndex, postUsed: r.postUsed };
  }

  /** Composite a cross-clip transition: rasterize the outgoing (`from`) and
   *  incoming layers to textures, then mix them with the kind's dual-input
   *  shader (src=incoming, orig=outgoing, progress) and composite onto canvas.
   *  Falls back to a hard cut (incoming only) if the kind/shader isn't ready. */
  private renderTransitionLayer(
    encoder: GPUCommandEncoder,
    canvasView: GPUTextureView,
    toLayer: Layer,
    toSource: { frame: VideoFrame; width: number; height: number } | null,
    fg: FrameGraph,
    media: MediaLibrary,
    frameFor: ((clipId: string) => VideoFrame | null) | undefined,
    drawIndex: number,
    postIndex: number,
    clearCanvas: boolean,
  ): { drawIndex: number; postUsed: number } {
    const tr = toLayer.transition!;
    const [texA, texB, texC, texD, texE] = this.fxTextures();
    const viewC = texC.createView();
    const viewD = texD.createView();
    const viewE = texE.createView();
    let pi = postIndex;

    // Decode the outgoing (`from`) frame. Same-asset transitions route through a
    // SEPARATE decoder (frameForFrom) so they don't thrash the one realtime
    // decoder serving the incoming side; missing frame → transparent.
    const from = tr.from;
    let fromSource: { frame: VideoFrame; width: number; height: number } | null = null;
    if (from.text) {
      const tf = this.textFrame(from.text);
      fromSource = { frame: tf.frame, width: tf.width, height: tf.height };
    } else if (from.assetId) {
      const conflicting = from.assetId === toLayer.assetId;
      const frame = frameFor ? frameFor(from.clipId) : media.frameForFrom(from.assetId, from.sourceTimeUs, conflicting);
      if (frame) {
        const size = media.assetSize(from.assetId);
        fromSource = { frame, width: size?.width ?? frame.displayWidth, height: size?.height ?? frame.displayHeight };
      }
    }

    // Render each side WITH its own pass effects (blur/glow/shader) — so a clip's
    // look during a transition matches its look outside one — into its parking
    // texture (from→texD, to→texE). Parking via a copy means the mix samples
    // settled textures, never a chain's live ping-pong working texture. A/B/C are
    // the shared chain scratch, reused sequentially by the two sides.
    const renderSide = (
      layer: Layer,
      source: { frame: VideoFrame; width: number; height: number } | null,
      parkView: GPUTextureView,
      parkTex: GPUTexture,
    ) => {
      const pfx = source ? resolvePassEffects((layer.effects ?? []) as never) : [];
      if (source && pfx.length) {
        const r = this.effectChainResult(encoder, layer, source, fg, pfx, texA, texB, texC, drawIndex, pi);
        drawIndex = r.drawIndex;
        pi += r.postUsed;
        this.origView = null;
        encoder.copyTextureToTexture({ texture: r.resultTex }, { texture: parkTex }, { width: this.canvas.width, height: this.canvas.height });
      } else {
        const rp = encoder.beginRenderPass({
          colorAttachments: [{ view: parkView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        });
        rp.setPipeline(this.pipeline);
        if (source) drawIndex = this.drawLayer(rp, layer, source, fg, drawIndex);
        rp.end();
      }
    };
    renderSide(from, fromSource, viewD, texD);
    renderSide(toLayer, toSource, viewE, texE);

    // Mix: to(uv)=incoming (texE), from(uv)=outgoing (texD), progress. A custom
    // AI-authored wgsl overrides the built-in kind shader. texC is free after the
    // chains (it only held each side's transient orig()), so the mix writes there.
    const wgsl = tr.wgsl || transitionWgsl(tr.kind);
    // A custom (AI-authored) wgsl that FAILS to compile yields a null pipeline →
    // hard-cut fallback below (we never judge a *compiled* shader's output as
    // "good" or "bad" — that's the author's creative call, not ours).
    const pipeline = wgsl ? this.shaderPipeline(wgsl, ['progress']) : null;
    // Fallback while the shader compiles (async, first use of a kind): show the
    // clip the transition is CLOSER to — outgoing in the first half, incoming in
    // the second — so an un-ready frame reads as "not transitioned yet" rather
    // than flashing the next clip.
    let resultView = tr.progress < 0.5 ? viewD : viewE;
    if (pipeline) {
      this.origView = viewD;
      this.shaderPass(encoder, pipeline, viewE, viewC, pi++, ['progress'], { progress: tr.progress });
      this.origView = null;
      resultView = viewC;
    }

    // Composite the mixed result over the canvas.
    const cp = encoder.beginRenderPass({
      colorAttachments: [
        { view: canvasView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: clearCanvas ? 'clear' : 'load', storeOp: 'store' },
      ],
    });
    cp.setPipeline(this.compositePipeline);
    cp.setBindGroup(0, this.postBindGroup(resultView, pi));
    cp.draw(3);
    cp.end();
    return { drawIndex, postUsed: pi - postIndex };
  }

  /** One fullscreen post pass sampling `srcView` into `dstView` with `param`. */
  private postPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    srcView: GPUTextureView,
    dstView: GPUTextureView,
    postIdx: number,
    param: [number, number],
  ): void {
    const buf = this.postBuffer(postIdx);
    this.device.queue.writeBuffer(buf, 0, new Float32Array([param[0], param[1], 0, 0]));
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dstView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.postBindGroup(srcView, postIdx, buf));
    pass.draw(3);
    pass.end();
  }

  private postBindGroup(srcView: GPUTextureView, postIdx: number, buf?: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.postLayout,
      entries: [
        { binding: 0, resource: { buffer: buf ?? this.postBuffer(postIdx) } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: srcView },
        { binding: 3, resource: this.origView ?? srcView }, // orig() second input
      ],
    });
  }

  private layerSource(
    layer: Layer,
    media: MediaLibrary,
    frameFor?: (clipId: string) => VideoFrame | null,
  ): { frame: VideoFrame; width: number; height: number } | null {
    if (layer.text) {
      // Live in-place editing overrides the rendered text without touching
      // the document (one undo entry on commit, not one per keystroke).
      const override = this.textOverrides.get(layer.clipId);
      const t = this.textFrame(override ?? layer.text);
      return { frame: t.frame, width: t.width, height: t.height };
    }
    if (layer.assetId) {
      const frame = frameFor ? frameFor(layer.clipId) : media.frameFor(layer.assetId, layer.sourceTimeUs);
      if (!frame) return null;
      const size = media.assetSize(layer.assetId);
      return { frame, width: size?.width ?? frame.displayWidth, height: size?.height ?? frame.displayHeight };
    }
    return null;
  }

  /** Ghost transform overrides for in-flight gestures: the document only
   *  changes on pointerup (command granularity = gesture granularity), but
   *  the preview must follow the pointer live. */
  private overrides = new Map<string, Partial<Layer['transform']>>();
  /** Live text overrides for in-place editing — see layerSource. */
  private textOverrides = new Map<string, TextPayload>();

  setOverride(clipId: string, transform: Partial<Layer['transform']> | null) {
    if (transform) this.overrides.set(clipId, transform);
    else this.overrides.delete(clipId);
  }

  setTextOverride(clipId: string, text: TextPayload | null) {
    if (text) this.textOverrides.set(clipId, text);
    else this.textOverrides.delete(clipId);
  }

  private packUniform(layer: Layer, srcW: number, srcH: number, fg: FrameGraph): Float32Array<ArrayBuffer> {
    const override = this.overrides.get(layer.clipId);
    const t = override ? { ...layer.transform, ...override } : layer.transform;
    // Pixel-space size of the quad.
    const w = srcW * t.scaleX;
    const h = srcH * t.scaleY;
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Affine in pixel space (centered at canvas center + offset), then → NDC.
    // NDC scale: x' = px / (W/2), y' = -py / (H/2) (y down in our px space).
    const halfW = fg.width / 2;
    const halfH = fg.height / 2;
    const a = (w * cos) / halfW;
    const b = (-w * sin) / halfH;
    const c = (-h * sin) / halfW;
    const d = (-h * cos) / halfH;
    const tx = t.x / halfW;
    const ty = -t.y / halfH;
    const g = resolveColorAdjust(layer.effects as never);
    const u = this.uniScratch;
    u[0] = a; u[1] = b; u[2] = 0; u[3] = 0;
    u[4] = c; u[5] = d; u[6] = 0; u[7] = 0;
    u[8] = tx; u[9] = ty; u[10] = 0; u[11] = 0;
    u[12] = t.opacity; u[13] = g.brightness; u[14] = g.contrast; u[15] = g.saturation;
    u[16] = g.temperature; u[17] = g.tint; u[18] = g.exposure; u[19] = g.vibrance;
    u[20] = g.highlights; u[21] = g.shadows; u[22] = g.vignette; u[23] = 0;
    return u;
  }

  resize(width: number, height: number) {
    if (!this.canvas) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** Resolve once all submitted GPU work has completed — the export path
   *  awaits this before snapshotting the canvas into a VideoFrame. */
  workDone(): Promise<undefined> {
    return this.device.queue.onSubmittedWorkDone();
  }

  dispose() {
    for (const e of this.textCache.values()) e.frame.close();
    this.textCache.clear();
    this.uniformBuffers.forEach((b) => b.destroy());
    this.uniformBuffers = [];
    this.postBuffers.forEach((b) => b.destroy());
    this.postBuffers = [];
    this.fxTex.forEach((t) => t.destroy());
    this.fxTex = [];
  }
}
