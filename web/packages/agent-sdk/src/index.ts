// @velocut/agent-sdk — the LLM editing agent.
//
// "AI edits the same way you do": the agent's tools call the SAME dispatch /
// document / evaluate surface that UI gestures and window.velocut use — one
// command language, one validation path, one undo history.
//
// The loop is a manual tool-use loop over the Anthropic Messages API
// (browser-direct via the official SDK). The transport is injectable so the
// loop is testable without network access.

import Anthropic from '@anthropic-ai/sdk';
import type { Command, Envelope, FrameGraph, TimeUs, VDocument } from '@velocut/protocol';
import { SYSTEM_PROMPT } from './protocol-prompt';

export { SYSTEM_PROMPT };

/** Result of an auto-caption run, surfaced back to the model. */
export interface CaptionResult {
  ok: boolean;
  trackId?: string;
  count?: number;
  message?: string;
}

/** Result of a TTS narration synthesis, surfaced back to the model. */
export interface SpeakResult {
  ok: boolean;
  clipId?: string;
  trackId?: string;
  durationUs?: number;
  atUs?: number;
  message?: string;
}

/** Result of a perception (observe) call: a text digest the model reads, plus
 *  zero or more images fed to its vision, plus structured data. The app layer
 *  (which owns the renderer + document) produces this; agent-sdk only relays it
 *  into the tool_result as text + image content blocks. */
export interface ObserveResult {
  ok: boolean;
  summary: string;
  images: { base64: string; mediaType: string }[];
  data?: unknown;
  message?: string;
}

/** Result of running an editing program (velocut_script): a JSON-serializable
 *  return value, captured console output, and an error+stack on failure. Kept
 *  JSON-only so the whole thing crosses an RPC boundary unchanged when the agent
 *  loop moves to a backend (the script runs wherever the runtime lives). */
export interface ScriptResult {
  ok: boolean;
  result?: unknown;
  logs?: string[];
  error?: string;
}

/** Result of a web research call (velocut_search): a cited answer the model
 *  reads, plus the sources behind it. JSON-only → RPC-clean. */
export interface SearchResult {
  ok: boolean;
  answer: string;
  sources: { title: string; url: string }[];
  message?: string;
}

/** What the agent needs from the editor — the Store (+ media) satisfies this.
 *  Every method is JSON-in/JSON-out and may be sync OR async: the in-process
 *  browser host returns synchronously; an RPC host (agent loop on a backend,
 *  runtime in the user's browser) returns promises. The loop awaits either way,
 *  so the SAME agent-sdk runs in-process today and over RPC unchanged. */
export interface AgentHost {
  dispatch(cmd: Command): Envelope | Promise<Envelope>;
  document(): VDocument | Promise<VDocument>;
  evaluate(timeUs: TimeUs): FrameGraph | Promise<FrameGraph>;
  /** Speech → caption track. Optional so the loop degrades gracefully when no
   *  transcriber is wired (the tool then reports it's unavailable). The host
   *  owns ASR + caption layout so agent-sdk stays free of the render layer. */
  caption?(opts: {
    assetId?: string;
    fontSize?: number;
    color?: string;
    /** Whisper language hint, e.g. 'chinese' | 'english'. Undefined = auto. */
    language?: string;
  }): Promise<CaptionResult>;
  /** Perception: render-and-see. The host renders the composite (or a clip /
   *  raw asset), measures it, and returns images + metrics. Params are opaque
   *  here — the app owns the observe schema. Optional so the loop degrades when
   *  no renderer is wired. */
  observe?(input: Record<string, unknown>): Promise<ObserveResult>;
  /** Generate spoken narration from text and lay it down as an audio clip.
   *  The engine knows the clip's exact duration, so sync is structural. Optional
   *  so the loop degrades when no TTS is wired. */
  speak?(opts: { text: string; atUs?: number; trackId?: string; language?: string }): Promise<SpeakResult>;
  /** Run an editing PROGRAM (JS) against the velocut API in one call — the
   *  general "write a script, run it once" primitive (velocut's analog of a
   *  shell loop). The host owns execution: it evals the code in the runtime
   *  realm (the browser today; an RPC stub to the browser when the loop runs on
   *  a backend) with a `velocut` API in scope, and returns JSON. agent-sdk only
   *  forwards the code string — it never evals anything itself, so the seam
   *  stays RPC-clean. Optional so the loop degrades when no runtime is wired. */
  runScript?(code: string): Promise<ScriptResult>;
  /** Web research: returns a cited answer + sources. Lets the agent verify facts
   *  (names, plot order, what's famous) before editing, instead of trusting
   *  training memory. The host owns the call (a proxied grounded search today),
   *  JSON in/out → RPC-clean. Optional so the loop degrades when no search wired. */
  search?(query: string): Promise<SearchResult>;
}

/** Progress events surfaced to the chat UI as the loop runs.
 *  text/tool are the non-streaming whole-block events (kept for the fallback
 *  transport); the *Start/*Delta/error events drive incremental streaming UI.
 *  All are plain JSON, so onEvent stays an RPC-clean loop→UI progress channel. */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      name: string;
      input: unknown;
      ok: boolean;
      detail: string;
      /** observe only: the SAME images & structured data the model received, so
       *  the chat UI can show the human what the agent looked at (base64 strings
       *  + plain JSON → onEvent stays RPC-clean). Absent for other tools. */
      images?: { base64: string; mediaType: string }[];
      data?: unknown;
    }
  | { kind: 'textStart' }
  | { kind: 'textDelta'; delta: string }
  | { kind: 'thinkingStart' }
  | { kind: 'thinkingDelta'; delta: string }
  | { kind: 'toolStart'; name: string; input: unknown }
  | { kind: 'error'; message: string };

/** The MessageStream returned by client.messages.stream() — derived from the
 *  SDK type (it isn't re-exported at the package root) so the loop depends only
 *  on its on('streamEvent')/finalMessage() surface, not an internal path. */
export type AgentMessageStream = ReturnType<InstanceType<typeof Anthropic>['messages']['stream']>;

export interface AgentTurnOptions {
  apiKey: string;
  model?: string;
  /** Prior conversation (user/assistant turns incl. tool blocks). */
  history: Anthropic.MessageParam[];
  userText: string;
  host: AgentHost;
  /** Extra guidance appended to the system prompt — e.g. the render-sdk effect
   *  registry's docs, so new effects are documented without touching agent-sdk. */
  systemExtra?: string;
  onEvent?: (e: AgentEvent) => void;
  /** Non-streaming transport (injectable for tests; defaults to the Anthropic SDK
   *  when no streaming transport is wired). */
  createMessage?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  /** Streaming transport (optional). When present, the loop streams: it relays
   *  text/thinking deltas to onEvent and awaits finalMessage() for the complete
   *  content fed back into the tool loop. Both the real-key path
   *  (client.messages.stream) and the dev path (an Anthropic client pointed at
   *  the /llm-proxy SSE) return this same MessageStream, so the loop is
   *  transport- and backend-agnostic (RPC-clean). Omit → falls back to
   *  createMessage. */
  createStream?: (params: Anthropic.MessageStreamParams) => AgentMessageStream;
  maxIterations?: number;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'velocut_apply',
    description:
      '对文档执行一条剪辑命令(或 type:"batch" 的原子批量)。返回引擎信封:成功时含 revision 和 events(新铸造的 id 在这里),失败时含错误码与原因。',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          description: 'Velocut 协议命令 JSON,如 {"type":"splitClip","clipId":"clip_1","atUs":1500000}',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'velocut_get_document',
    description: '读取完整工程文档(轨道、clip、素材、nextId、时长)。动手前先看一眼。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'velocut_evaluate',
    description: '求值某一时刻的合成清单 FrameGraph(分层画面 + 音频切片),用于理解该时刻画面上有什么。',
    input_schema: {
      type: 'object',
      properties: { timeUs: { type: 'number', description: '时间(微秒)' } },
      required: ['timeUs'],
    },
  },
  {
    name: 'velocut_observe',
    description:
      '看见并测量画面(render-and-see):返回真实渲染的合成帧图像 + 数值读数(亮度/对比/色温/锐度/鲜艳度、音频响度)。这是你的眼睛和耳朵——动手前先看,改完再看,凭实际画面决策,而不是只读结构。\n' +
      'mode:"frame" 看某一刻(返回 1 张图+数值);"contact" 缩略图网格(默认每个视频片段一格的分镜,或对 source.assetId 在整段时长上抽样——用于把长素材的场景映射成时间轴);"scan" 只返回数值时间线(逐窗的响度/亮度/疑似镜头切换分),无图,用于粗略找静音间隙、最响高光、镜头切点;"audio" 对 source.assetId 的原始音频在 [from,to] 区间做**细粒度**分析(~21ms),返回精确的静音**段** {startUs,endUs}(干净切点/对白缝,在段中点切不切断台词)和能量**峰/onset**(卡节拍/找高光起点),无图——先用 scan 粗定位、再用 audio 在窗口内精修切点。\n' +
      '"shots" 对视频 asset(source 传 {assetId} 或 {clipId},省略=首个视频)做整片**镜头切分**:返回镜头边界列表(每个 {index,startUs,endUs,keyUs},均为源时间)+ 帧差异曲线,无图。用于**按镜头推理**——把剪辑/插入对齐到真实切点(别切在镜头中间)、按镜头时长控节奏(对长镜头提速或裁剪)、定位「某个镜头」。比 scan 的粗「镜头切换分」精确得多;首次是一次前向解码(秒级)、结果按 asset 缓存,可反复引用。\n' +
      'source 省略=看用户所见的合成画面;{clipId} 单独看某片段;{assetId} 看素材原始内容(忽略时间轴)。\n' +
      'metricsOnly:true 只要数值不要图(便宜,用于"调一个参数→读一个数→再调"的优化回路)。先用 contact/scan 纵览,再用 frame 细看;能用数值判断就别出图。',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['frame', 'contact', 'scan', 'audio', 'shots'], description: '观察模式,默认 frame' },
        source: {
          type: 'object',
          description: '看什么;省略=合成画面',
          properties: {
            clipId: { type: 'string', description: '只看这个片段(合成里隔离出来)' },
            assetId: { type: 'string', description: '看素材原始内容,at/from/to 为源时间' },
          },
        },
        at: { type: 'number', description: 'frame:观察的时刻(微秒)。合成为时间轴时间,assetId 为源时间' },
        from: { type: 'number', description: 'contact/scan 区间起点(微秒)' },
        to: { type: 'number', description: 'contact/scan 区间终点(微秒)' },
        count: { type: 'number', description: 'contact 抽样格数(≤24)/ scan 窗数(≤120)' },
        resolution: { type: 'string', enum: ['thumb', 'preview', 'full'], description: '分辨率,默认 frame=preview、contact=thumb;full 仅在抠细节时用' },
        region: {
          type: 'object',
          description: 'frame:归一化裁剪 0~1,放大看局部(如盯人脸/字幕是否清晰)',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
        metricsOnly: { type: 'boolean', description: '只回数值不回图(优化回路)' },
      },
    },
  },
  {
    name: 'velocut_tts',
    description:
      '生成旁白配音:把一句解说文本合成语音,作为一条音频 clip 落到「旁白」轨。引擎知道这段音频的精确时长(返回 durationUs),所以音画同步是结构性的——你不需要手动对齐。\n' +
      'atUs 省略时自动接在旁白轨末尾(逐句调用即可顺次排好)。language 按文本语言传 "chinese"/"english"。首次运行会下载语音模型(数十秒)。返回 clipId / durationUs / atUs。\n' +
      '这是「创造」而非「裁剪」——做解说/速览视频时,先看素材(observe)+写文案,再逐句 velocut_tts 生成旁白,把镜头(裁剪原片的 clip)放到对应旁白时间,字幕用 addTextClip。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这一句旁白文本' },
        atUs: { type: 'number', description: '放置起点(微秒);省略=接在旁白轨末尾' },
        trackId: { type: 'string', description: '目标音频轨;省略=自动用/建「旁白」轨' },
        language: { type: 'string', description: '文本语言:"chinese" / "english"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'velocut_transcribe',
    description:
      '自动语音转字幕:识别某素材里的语音,生成一条「字幕」文字轨(底部居中,逐句一个文字 clip,均为可再编辑的普通文字)。assetId 省略时自动选第一个有音频的素材。首次运行会下载语音模型,可能耗时数十秒。返回生成的轨道 id 与字幕条数。',
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '素材 id;省略则自动选第一个含音频的素材' },
        fontSize: { type: 'number', description: '字号(像素),省略按画面高度自适应' },
        color: { type: 'string', description: '文字颜色 #RRGGBB,默认白色' },
        language: {
          type: 'string',
          description:
            "语音的语言,用于让识别输出对应语言(否则会自动检测,中文常被误转成英文)。中文音频传 'chinese',英文传 'english'。",
        },
      },
    },
  },
  {
    name: 'velocut_search',
    description:
      '联网查证(grounded web search):给一个问题,返回一段带来源的答案 + sources 列表。用来在动手前核实事实——人物/角色名、剧情顺序、谁是谁、哪个是名场面、专有名词、上映/版本信息等——而不是凭训练记忆瞎写(尤其做解说/速览时,旁白讲错事实很致命)。\n' +
      '做长剪短的规划阶段:observe 看懂画面 + velocut_search 核实剧情事实,两者结合再写文案。问题尽量具体(带作品名/版本/集数)。返回 {answer, sources}。',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查证的问题,尽量具体(含作品名/版本/集数等限定词)' } },
      required: ['query'],
    },
  },
  {
    name: 'velocut_script',
    description:
      '运行一段编辑程序(JavaScript)——在一次调用里批量完成多步剪辑,相当于「写个脚本跑一遍」。这是你做"几十个单元的批量任务"(如长剪短/混剪/批量改速/按节拍切)的主力:别用几十次单步工具调用,先用 velocut_get_document/velocut_observe 规划好,再用一段脚本一次铺完。\n' +
      '脚本里可 await 调用全局 velocut:\n' +
      '• velocut.apply(cmd) → 执行一条协议命令,返回引擎信封(成功含 revision 和 events;新铸造的 id 在 events 里)。\n' +
      '• await velocut.tts({text, atUs?, trackId?, language}) → 生成旁白音频 clip,返回 {ok, clipId, durationUs, atUs}。逐句调用,用返回的 durationUs 决定对应镜头/字幕的时长。\n' +
      '• await velocut.observe(input) → 看画面/读数值,返回 {ok, summary, data}(脚本里拿不到图,用 data 里的数值)。\n' +
      '• await velocut.motionClip({spec, atUs?, trackId?, name?}) → 用一份「声明式 spec」生成一段「动态图形」clip(标题卡/下三分之一条/动态字幕/信息图),自动落在「图形」视频轨。spec 是纯 JSON(不是代码),会被持久化——刷新/导出后照样重现。\n' +
      '  spec = {version:1, durationUs, fps?, width?, height?, background?(整帧填色), layers:[…]}。每个 layer 有可动画的变换:x,y,opacity(0..1),scale(1=100%),rotation(度),以及可选 in/out(秒,layer 的显示窗口)。任一变换值可以是常数,或一串关键帧 [{t(秒),v(值),ease?}](ease 用 GSAP 名:"none"/"power2.out"/"back.out"/"elastic.out"…,描述到达该帧那一段的缓动;第一帧前/最后帧后保持不变)。\n' +
      '  layer 类型:①{type:"text", text, size?, weight?, color?, align?("left"/"center"/"right"), baseline?, maxWidth?(自动测量折行,支持中文), lineHeight?, stroke?, strokeWidth?, shadow?:{color,blur?,x?,y?}} ②{type:"rect", w, h, radius?, fill?, stroke?, lineWidth?} ③{type:"ellipse", w, h, fill?, stroke?, lineWidth?} ④{type:"image", src(CORS URL), w?, h?}。变换以 (x,y) 为原点做 translate→rotate→scale,layer 自身坐标相对该原点(text 从原点起绘、rect/ellipse 从原点向右下铺 w×h)。坐标系=输出分辨率(默认整帧 w×h,常从 velocut.document() 读 doc.width/height)。返回 {ok, assetId, clipId, trackId, frameCount}。\n' +
      '  例:开场标题卡(淡入上移 0.5s、末尾淡出 0.4s):velocut.motionClip({atUs:0, spec:{version:1, durationUs:2_500_000, layers:[{type:"text", text:"全职猎人", size:96, weight:800, color:"#fff", align:"center", x:960, y:[{t:0,v:580},{t:0.5,v:540,ease:"power3.out"}], opacity:[{t:0,v:0},{t:0.5,v:1,ease:"power2.out"},{t:2.1,v:1},{t:2.5,v:0}], shadow:{color:"rgba(0,0,0,.6)",blur:24}}]}})。动态字幕跟旁白对齐:每句 tts 拿到 durationUs,就用同 atUs/durationUs 建一个 motionClip 字幕,入/出场用 opacity 关键帧。\n' +
      '• velocut.evaluate(timeUs) → 求值某刻合成清单;velocut.document() → 读完整文档。\n' +
      '支持循环/条件/用上一步返回值算下一步。典型(长剪短一次铺完):维护时间游标 T,for 每个单元 { const r = await velocut.tts({text, atUs:T, language:"chinese"}); velocut.apply(加镜头 startUs:T 时长 r.durationUs 源起点…); velocut.apply(加字幕条 同 T 同时长); T += r.durationUs; }。\n' +
      'return 一个 JSON 值作为结果(如 {units, totalUs});脚本里的 console.log 会回给你;抛错会回错误信息+栈,修了重跑。命令字段名以 velocut_get_document 看到的文档结构和命令一览为准。',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript 源码。顶层可直接用 await;用 return 返回一个 JSON 可序列化的结果。全局有 velocut(apply/tts/observe/motionClip/evaluate/document/seek)和 console。',
        },
      },
      required: ['code'],
    },
  },
];

/** tool_result content: text for most tools, or text+image blocks for observe. */
type ToolContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

async function executeTool(
  host: AgentHost,
  name: string,
  input: unknown,
): Promise<{
  ok: boolean;
  content: ToolContent;
  summary: string;
  /** observe only — relayed verbatim into the tool event for the chat UI. */
  images?: { base64: string; mediaType: string }[];
  data?: unknown;
}> {
  const text = (ok: boolean, result: string) => ({ ok, content: result, summary: result });
  try {
    switch (name) {
      case 'velocut_apply': {
        const cmd = (input as { command: Command }).command;
        const resp = await host.dispatch(cmd);
        return text(resp.ok, JSON.stringify(resp));
      }
      case 'velocut_get_document':
        return text(true, JSON.stringify(await host.document()));
      case 'velocut_evaluate': {
        const t = Math.round((input as { timeUs: number }).timeUs);
        return text(true, JSON.stringify(await host.evaluate(t)));
      }
      case 'velocut_observe': {
        if (!host.observe) return text(false, '观察能力未接入(无渲染器)');
        const r = await host.observe((input ?? {}) as Record<string, unknown>);
        const digest = r.summary + (r.data ? '\n' + JSON.stringify(r.data) : '') + (r.message ? '\n' + r.message : '');
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [{ type: 'text', text: digest }];
        for (const img of r.images) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.base64 },
          });
        }
        // Relay the same images & data to the chat UI so the human sees exactly
        // what the agent saw (the model already got them in `blocks`).
        return { ok: r.ok, content: blocks, summary: r.summary, images: r.images, data: r.data };
      }
      case 'velocut_tts': {
        if (!host.speak) return text(false, 'TTS 能力未接入(无语音合成)');
        const r = await host.speak((input ?? {}) as { text: string; atUs?: number; trackId?: string; language?: string });
        return text(r.ok, JSON.stringify(r));
      }
      case 'velocut_transcribe': {
        if (!host.caption) return text(false, '转写能力未接入(无 transcriber)');
        const r = await host.caption(
          (input ?? {}) as { assetId?: string; fontSize?: number; color?: string; language?: string },
        );
        return text(r.ok, JSON.stringify(r));
      }
      case 'velocut_search': {
        if (!host.search) return text(false, '联网查证能力未接入(无搜索后端)');
        const r = await host.search((input as { query: string }).query);
        if (!r.ok) return text(false, r.message ?? '搜索失败');
        const src = r.sources.length ? '\n来源: ' + r.sources.map((s) => `${s.title || s.url}`).join('; ') : '';
        return { ok: true, content: r.answer + src, summary: r.answer.slice(0, 80) };
      }
      case 'velocut_script': {
        if (!host.runScript) return text(false, '脚本执行能力未接入(无运行时)');
        const r = await host.runScript((input as { code: string }).code);
        // JSON in/out: result + logs the model reads, error+stack on failure.
        const digest = JSON.stringify({ ok: r.ok, result: r.result, logs: r.logs, error: r.error });
        return { ok: r.ok, content: digest, summary: r.error ? `脚本出错: ${r.error.split('\n')[0]}` : '脚本执行完成' };
      }
      default:
        return text(false, `unknown tool: ${name}`);
    }
  } catch (e) {
    return text(false, String(e instanceof Error ? e.message : e));
  }
}

/**
 * Run one user turn through the agent loop. Returns the new history
 * (caller keeps it for the next turn).
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<Anthropic.MessageParam[]> {
  const model = opts.model ?? 'claude-opus-4-8';
  // One default Anthropic client for the real-key path — built only when NO
  // transport is injected. Tests inject createMessage (non-streaming); the dev
  // app injects createStream (the proxy SSE). With nothing injected we have a
  // real key, so we stream by default.
  const client =
    !opts.createMessage && !opts.createStream
      ? new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true })
      : null;
  const createStream =
    opts.createStream ?? (client ? (p: Anthropic.MessageStreamParams) => client.messages.stream(p) : undefined);
  const createMessage =
    opts.createMessage ?? (client ? (p: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(p) : undefined);

  const messages: Anthropic.MessageParam[] = [...opts.history, { role: 'user', content: opts.userText }];
  const maxIterations = opts.maxIterations ?? 24;
  const system = opts.systemExtra ? `${SYSTEM_PROMPT}\n\n${opts.systemExtra}` : SYSTEM_PROMPT;

  for (let i = 0; i < maxIterations; i++) {
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      tools: TOOLS,
      messages,
    };

    let response: Anthropic.Message;
    if (createStream) {
      // Streaming: relay text/thinking deltas to the UI as they arrive; the SDK
      // accumulates the full message (thinking signatures + tool_use inputs are
      // assembled internally), so the response below is byte-identical to the
      // non-streaming path and the tool loop is unchanged.
      try {
        const stream = createStream(params);
        stream.on('streamEvent', (ev: Anthropic.MessageStreamEvent) => {
          if (ev.type === 'content_block_start') {
            if (ev.content_block.type === 'text') opts.onEvent?.({ kind: 'textStart' });
            else if (ev.content_block.type === 'thinking') opts.onEvent?.({ kind: 'thinkingStart' });
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') opts.onEvent?.({ kind: 'textDelta', delta: ev.delta.text });
            else if (ev.delta.type === 'thinking_delta')
              opts.onEvent?.({ kind: 'thinkingDelta', delta: ev.delta.thinking });
            // input_json_delta is intentionally not surfaced — the tool input is
            // only complete (and safe to execute) after finalMessage().
          }
        });
        response = await stream.finalMessage();
      } catch (e) {
        // A mid-stream upstream error / abort: report it and stop the turn.
        // Do NOT push a half-streamed assistant block into messages (it would
        // make the next request invalid).
        opts.onEvent?.({ kind: 'error', message: String(e instanceof Error ? e.message : e) });
        break;
      }
    } else if (createMessage) {
      response = await createMessage(params as Anthropic.MessageCreateParamsNonStreaming);
    } else {
      throw new Error('runAgentTurn: no transport (provide apiKey, createStream, or createMessage)');
    }

    // Echo the assistant turn back verbatim — thinking blocks (with
    // signatures) and tool_use blocks must be preserved.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        // Streaming already surfaced this text via textDelta; only the
        // non-streaming fallback needs the whole-block text event.
        if (!createStream) opts.onEvent?.({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        opts.onEvent?.({ kind: 'toolStart', name: block.name, input: block.input });
        const { ok, content, summary, images, data } = await executeTool(opts.host, block.name, block.input);
        opts.onEvent?.({ kind: 'tool', name: block.name, input: block.input, ok, detail: summary, images, data });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content,
          is_error: !ok || undefined,
        });
      }
    }

    if (response.stop_reason !== 'tool_use' || toolResults.length === 0) break;
    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}
