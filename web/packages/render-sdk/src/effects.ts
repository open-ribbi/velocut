// effects.ts — the effect registry (a plugin point).
//
// An effect is one self-contained entry: its param SCHEMA (Inspector renders
// controls from it), a RESOLVE function (contributes to the renderer's grade
// uniforms), and an AI HINT (surfaced into the agent prompt). Adding an effect
// = one registerEffect(...) call — the Inspector, the renderer's
// resolveColorAdjust, and the agent's guidance all pick it up. The engine and
// protocol never change (effect params are opaque JSON on the clip).
//
// Two effect flavors:
//  - GRADE effects (resolve): fold into the single composite pass's fixed
//    grade uniforms — cheap, but limited to ResolvedGrade's existing knobs.
//  - PASS effects (pass: '<kind>'): the renderer runs a dedicated multi-pass
//    chain (ping-pong textures) for shader math the grade pass can't do —
//    blur today; glow / masks / chroma-key / LUT / displacement transitions
//    plug in the same way (add a kind + its WGSL passes in renderer.ts).

/** The renderer's grade uniforms — what every effect resolves into. */
export interface ResolvedGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  vibrance: number;
  vignette: number;
}

export interface EffectParamSchema {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface EffectSchema {
  name: string;
  label: string;
  params: EffectParamSchema[];
  /** Fold this effect's params into the running grade (mutates `grade`). */
  resolve?: (params: Record<string, unknown>, grade: ResolvedGrade) => void;
  /** Multi-pass render effect kind: 'blur'/'glow' (renderer-tuned, multi-stage)
   *  or 'shader' (a fragment body run by the generic compiled-pass path).
   *  Mutually exclusive with resolve(). */
  pass?: 'blur' | 'glow' | 'shader';
  /** For pass:'shader' — a built-in WGSL `userEffect` body (a curated preset).
   *  The freeform 'shader' effect omits this and takes its body from instance
   *  params.wgsl (AI-authored). */
  wgsl?: string;
  /** One-line guidance appended to the agent prompt (param ranges + intent). */
  aiHint?: string;
}

/** A multi-pass effect instance the renderer must run, in clip stack order. */
export interface PassEffect {
  kind: 'blur' | 'glow' | 'shader';
  /** Fragment `userEffect` body for kind 'shader' (built-in preset or AI). */
  wgsl?: string;
  /** Numeric params (wgsl stripped), defaults filled from the schema. */
  params: Record<string, number>;
}

// Cross-clip transitions. eval marks the incoming layer with {kind, progress,
// from:<outgoing layer>}; the renderer rasterizes BOTH clips and mixes them with
// the kind's WGSL — a dual-input pass where src(uv)=incoming, orig(uv)=outgoing,
// and `progress` (0→1) is injected. So a transition is genuinely BETWEEN two
// clips (both clips' pixels), not a one-sided entry animation.
export interface TransitionKind {
  kind: string;
  label: string;
  /** WGSL `userEffect` body: src=incoming, orig=outgoing, progress 0→1. */
  wgsl: string;
}

// Each wgsl is a GL-Transitions-style body: getFromColor(uv)=outgoing,
// getToColor(uv)=incoming, progress 0→1, ratio=W/H. Ported to WGSL from the
// gl-transitions standard library (the de-facto cross-app transition standard).
export const TRANSITIONS: TransitionKind[] = [
  { kind: 'dissolve', label: '溶解', wgsl: 'return mix(getFromColor(uv), getToColor(uv), progress);' },
  {
    kind: 'fadeBlack',
    label: '黑场',
    wgsl: `let f = getFromColor(uv); let t = getToColor(uv);
      if (progress < 0.5) { return vec4<f32>(f.rgb * (1.0 - progress * 2.0), f.a); }
      return vec4<f32>(t.rgb * (progress * 2.0 - 1.0), t.a);`,
  },
  {
    kind: 'wipeLeft',
    label: '擦除(向右)',
    wgsl: 'let e = smoothstep(uv.x - 0.03, uv.x + 0.03, progress); return mix(getFromColor(uv), getToColor(uv), e);',
  },
  {
    kind: 'wipeRight',
    label: '擦除(向左)',
    wgsl: 'let e = smoothstep((1.0 - uv.x) - 0.03, (1.0 - uv.x) + 0.03, progress); return mix(getFromColor(uv), getToColor(uv), e);',
  },
  {
    kind: 'wipeUp',
    label: '擦除(向上)',
    wgsl: 'let e = smoothstep((1.0 - uv.y) - 0.03, (1.0 - uv.y) + 0.03, progress); return mix(getFromColor(uv), getToColor(uv), e);',
  },
  {
    kind: 'circle',
    label: '圆形开幕',
    wgsl: `let d = distance(uv, vec2<f32>(0.5, 0.5)); let r = progress * 0.8;
      let e = 1.0 - smoothstep(r - 0.03, r + 0.03, d); return mix(getFromColor(uv), getToColor(uv), e);`,
  },
  {
    // Push slide: incoming pushes in from the right, outgoing slides out left.
    kind: 'slide',
    label: '滑动推移',
    wgsl: `let x = uv.x + progress;
      if (x < 1.0) { return getFromColor(vec2<f32>(x, uv.y)); }
      return getToColor(vec2<f32>(x - 1.0, uv.y));`,
  },
  {
    // Fake-3D horizontal card flip (outgoing squashes to a line, incoming opens).
    kind: 'flip',
    label: '翻转',
    wgsl: `if (progress < 0.5) {
        let s = 1.0 - progress * 2.0;
        let x = (uv.x - 0.5) / max(0.0001, s) + 0.5;
        if (x < 0.0 || x > 1.0) { return vec4<f32>(0.0); }
        let c = getFromColor(vec2<f32>(x, uv.y));
        return vec4<f32>(c.rgb * (0.55 + 0.45 * s), c.a);
      }
      let s2 = (progress - 0.5) * 2.0;
      let x2 = (uv.x - 0.5) / max(0.0001, s2) + 0.5;
      if (x2 < 0.0 || x2 > 1.0) { return vec4<f32>(0.0); }
      let c2 = getToColor(vec2<f32>(x2, uv.y));
      return vec4<f32>(c2.rgb * (0.55 + 0.45 * s2), c2.a);`,
  },
  {
    // crosswarp — both clips warp toward each other through the wipe seam.
    kind: 'crosswarp',
    label: '扭曲溶解',
    wgsl: `let x = smoothstep(0.0, 1.0, progress * 2.0 + uv.x - 1.0);
      return mix(getFromColor((uv - 0.5) * (1.0 - x) + 0.5), getToColor((uv - 0.5) * x + 0.5), x);`,
  },
  {
    // SimpleZoom — outgoing zooms out while incoming fades in.
    kind: 'zoom',
    label: '缩放',
    wgsl: `let sp = smoothstep(0.0, 1.0, progress);
      let z = (uv - 0.5) * (1.0 - sp) + 0.5;
      return mix(getFromColor(z), getToColor(uv), smoothstep(0.4, 1.0, progress));`,
  },
  {
    // pixelize — both clips dissolve through a growing-then-shrinking pixel grid.
    kind: 'pixelize',
    label: '像素化',
    wgsl: `let d = min(progress, 1.0 - progress);
      let dist = ceil(d * 50.0) / 50.0;
      let sq = 2.0 * dist / vec2<f32>(20.0, 20.0);
      var p = uv;
      if (dist > 0.0) { p = (floor(uv / sq) + 0.5) * sq; }
      return mix(getFromColor(p), getToColor(p), progress);`,
  },
  {
    // windowslice — incoming reveals through interleaved vertical slices.
    kind: 'windowslice',
    label: '百叶窗',
    wgsl: `let pr = smoothstep(-0.5, 0.0, uv.x - progress * 1.5);
      let s = step(pr, fract(12.0 * uv.x));
      return mix(getFromColor(uv), getToColor(uv), s);`,
  },
];

/** WGSL body for a transition kind (renderer compiles it as a dual-input pass). */
export function transitionWgsl(kind: string): string | undefined {
  return TRANSITIONS.find((t) => t.kind === kind)?.wgsl;
}

const num = (v: unknown, d: number) => (v == null ? d : Number(v));

export const EFFECT_REGISTRY: Record<string, EffectSchema> = {};

/** Register (or override) an effect. Inspector / renderer / agent all read it. */
export function registerEffect(schema: EffectSchema): void {
  EFFECT_REGISTRY[schema.name] = schema;
}

// ----- built-in effects --------------------------------------------------

registerEffect({
  name: 'brightnessContrast',
  label: '亮度 / 对比度 / 饱和度',
  params: [
    { key: 'brightness', label: '亮度', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'contrast', label: '对比度', min: 0, max: 2, step: 0.01, default: 1 },
    { key: 'saturation', label: '饱和度', min: 0, max: 2, step: 0.01, default: 1 },
  ],
  resolve: (p, g) => {
    g.brightness += num(p['brightness'], 0);
    g.contrast *= num(p['contrast'], 1);
    g.saturation *= num(p['saturation'], 1);
  },
  aiHint: 'brightness -1~1 / contrast 0~2 / saturation 0~2(0=黑白)— 基础亮度对比饱和',
});

// The comprehensive grade — mirrors 剪映's 调节 panel. One effect, ten
// composable knobs, all default to no-op so an empty grade is invisible.
registerEffect({
  name: 'colorGrade',
  label: '调色（色温 / 光影 / 暗角）',
  params: [
    { key: 'brightness', label: '亮度', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'contrast', label: '对比度', min: 0, max: 2, step: 0.01, default: 1 },
    { key: 'saturation', label: '饱和度', min: 0, max: 2, step: 0.01, default: 1 },
    { key: 'exposure', label: '光感', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'temperature', label: '色温', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'tint', label: '色调', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'highlights', label: '高光', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'shadows', label: '阴影', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'vibrance', label: '鲜艳度', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'vignette', label: '暗角', min: 0, max: 1, step: 0.01, default: 0 },
  ],
  resolve: (p, g) => {
    g.brightness += num(p['brightness'], 0);
    g.contrast *= num(p['contrast'], 1);
    g.saturation *= num(p['saturation'], 1);
    g.exposure += num(p['exposure'], 0);
    g.temperature += num(p['temperature'], 0);
    g.tint += num(p['tint'], 0);
    g.highlights += num(p['highlights'], 0);
    g.shadows += num(p['shadows'], 0);
    g.vibrance += num(p['vibrance'], 0);
    g.vignette = Math.min(1, g.vignette + num(p['vignette'], 0));
  },
  aiHint:
    '所有 params 可选默认无效果:brightness -1~1 / contrast 0~2 / saturation 0~2(0=黑白)/ ' +
    'exposure 光感 -1~1 / temperature 色温 -1~1(负=冷蓝,正=暖橙)/ tint 色调 -1~1 / ' +
    'highlights 高光 -1~1 / shadows 阴影 -1~1 / vibrance 鲜艳度 -1~1 / vignette 暗角 0~1。' +
    '示例:电影感冷调 {temperature:-0.25,contrast:1.2,saturation:0.92,shadows:-0.15,vignette:0.4};' +
    '暖阳复古 {temperature:0.3,exposure:0.1,saturation:1.1};黑白 {saturation:0};通透明亮 {exposure:0.15,contrast:1.1,vibrance:0.25}',
});

// A real multi-pass effect — needs taps the single grade pass can't do.
registerEffect({
  name: 'blur',
  label: '模糊',
  pass: 'blur',
  params: [{ key: 'radius', label: '强度', min: 0, max: 100, step: 1, default: 24 }],
  aiHint:
    'radius 0~100 像素高斯模糊(0=无,可分离两 pass)。用于背景虚化、柔焦、马赛克替代;' +
    '示例 {radius:30}。加在视频/图片 clip 上,可与调色叠加。',
});

// ----- curated shader presets (also few-shot exemplars for AI-authored ones) -

// Unsharp mask: add back the high-frequency (original − local average).
registerEffect({
  name: 'sharpen',
  label: '锐化',
  pass: 'shader',
  params: [{ key: 'amount', label: '强度', min: 0, max: 3, step: 0.05, default: 1 }],
  wgsl: `
    let avg = (src(uv + vec2(texel.x, 0.0)) + src(uv - vec2(texel.x, 0.0))
             + src(uv + vec2(0.0, texel.y)) + src(uv - vec2(0.0, texel.y))) * 0.25;
    let c = src(uv);
    return vec4(c.rgb + (c.rgb - avg.rgb) * amount, c.a);`,
  aiHint: 'amount 0~3 锐化(0=无)。范例同时演示邻域采样 src(uv±texel) 的写法',
});

// Chroma key: drop pixels near a key colour (default green screen) to transparent.
registerEffect({
  name: 'chromakey',
  label: '抠像（绿幕）',
  pass: 'shader',
  params: [
    { key: 'keyR', label: 'R', min: 0, max: 1, step: 0.01, default: 0 },
    { key: 'keyG', label: 'G', min: 0, max: 1, step: 0.01, default: 1 },
    { key: 'keyB', label: 'B', min: 0, max: 1, step: 0.01, default: 0 },
    { key: 'threshold', label: '阈值', min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: 'smoothness', label: '边缘', min: 0, max: 0.5, step: 0.01, default: 0.1 },
  ],
  wgsl: `
    let c = src(uv);
    let d = distance(c.rgb, vec3(keyR, keyG, keyB));
    let a = smoothstep(threshold, threshold + smoothness, d);
    return vec4(c.rgb, c.a * a);`,
  aiHint:
    'keyR/keyG/keyB 抠掉的颜色(默认绿 0/1/0)、threshold 0~1、smoothness 边缘。绿幕换背景:把前景 chromakey,下面垫背景轨',
});

// Dual-input bloom: blur the layer, add its bright-pass back onto the sharp
// original. A built-in worked example of the orig()+src() two-input path.
registerEffect({
  name: 'glow',
  label: '辉光 / 泛光',
  pass: 'glow',
  params: [
    { key: 'radius', label: '范围', min: 1, max: 100, step: 1, default: 16 },
    { key: 'intensity', label: '强度', min: 0, max: 3, step: 0.05, default: 1 },
    { key: 'threshold', label: '阈值', min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
  aiHint:
    'radius 范围 / intensity 强度 / threshold 阈值(只有亮于阈值的部分泛光)。梦幻柔光、霓虹、过曝氛围。示例 {radius:24,intensity:1.2,threshold:0.55}',
});

// The OPEN DOOR: AI writes the WGSL `userEffect` body itself.
registerEffect({
  name: 'shader',
  label: '自定义着色器',
  pass: 'shader',
  params: [], // numeric params are whatever the WGSL references; passed inline
  aiHint:
    'AI 自写像素效果。params.wgsl = 一段 WGSL,是函数体,必须 `return vec4<f32>(...)` 直通(非预乘)RGBA。' +
    '可用:uv(vec2 0~1)、src(uv)→当前(经前序效果后)该位置直通色、orig(uv)→该层原始直通色(双输入,做泛光/与原图混合)、' +
    'texel(=1/分辨率,邻域采样用 src(uv+texel*k))、以及 params 里其余数值键(按名直接用,如 params:{wgsl:"...", strength:2} 里的 strength)。' +
    '模板自动包 NaN→0+clamp+重新预乘,无需自己处理。示例反相:{wgsl:"let c=src(uv); return vec4(1.0-c.rgb, c.a);"};' +
    '示例 RGB 色差:{wgsl:"let r=src(uv+texel*4.0).r; let g=src(uv).g; let b=src(uv-texel*4.0).b; return vec4(r,g,b, src(uv).a);"}',
});

const numParam = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** Pull a clip's multi-pass effects (blur / shader) in stack order, with each
 *  effect's WGSL body + numeric params (schema defaults filled in). The renderer
 *  runs these as dedicated passes; resolveColorAdjust ignores them (no resolve). */
export function resolvePassEffects(
  effects: Array<{ effect: string; params: Record<string, unknown> }>,
): PassEffect[] {
  const out: PassEffect[] = [];
  for (const fx of effects) {
    const schema = EFFECT_REGISTRY[fx.effect];
    if (!schema?.pass) continue;
    const raw = fx.params ?? {};
    const wgsl = schema.wgsl ?? (typeof raw['wgsl'] === 'string' ? (raw['wgsl'] as string) : undefined);
    const params: Record<string, number> = {};
    // Instance-provided numbers (freeform shaders declare their own keys)…
    for (const [k, v] of Object.entries(raw)) {
      const n = numParam(v);
      if (k !== 'wgsl' && n !== undefined) params[k] = n;
    }
    // …then fill any schema params the instance didn't set.
    for (const p of schema.params) if (!(p.key in params)) params[p.key] = p.default;
    out.push({ kind: schema.pass, wgsl, params });
  }
  return out;
}

/** Resolve a clip's effect stack into the renderer's grade uniforms by running
 *  each registered effect's resolve(). Unknown effects are ignored. */
export function resolveColorAdjust(
  effects: Array<{ effect: string; params: Record<string, unknown> }>,
): ResolvedGrade {
  const g: ResolvedGrade = {
    brightness: 0,
    contrast: 1,
    saturation: 1,
    exposure: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
    vibrance: 0,
    vignette: 0,
  };
  for (const fx of effects) {
    EFFECT_REGISTRY[fx.effect]?.resolve?.(fx.params ?? {}, g);
  }
  return g;
}

/** Agent-prompt guidance for all registered effects (their aiHints). The editor
 *  appends this to the system prompt so adding an effect auto-documents it. */
export function effectPromptDoc(): string {
  const lines = Object.values(EFFECT_REGISTRY)
    .filter((e) => e.aiHint)
    .map((e) => `- addEffect ${e.name}(${e.label}):${e.aiHint}`);
  return [
    '## 调色 / 特效(addEffect 加在视频/图片 clip 上,setEffectParams 整组覆盖)',
    ...lines,
    '先 velocut_get_document 找到视频 clipId,再 addEffect。',
  ].join('\n');
}
