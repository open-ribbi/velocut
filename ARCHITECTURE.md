# Velocut 架构

## 分层

```
┌──────────────────────────────────────────────────────────┐
│ App Shell  (TS + React, DI 容器)                          │
│   Canvas 自绘时间轴 / Inspector / AgentConsole            │
│   只做两件事:发 Command JSON,收文档快照渲染 UI           │
├──────────────────────────────────────────────────────────┤
│ Editing Core  (Rust → WASM;TS 参考实现同协议)             │
│   文档模型 · 命令校验/执行 · 快照式 undo/redo(200 步)     │
│   关键帧求值(linear/hold/bezier)→ FrameGraph             │
├────────────────────────┬─────────────────────────────────┤
│ 媒体管线                │ 渲染引擎                         │
│ mp4box demux           │ WebGPU(wgpu 语义,WGSL)          │
│ WebCodecs 硬解          │ external texture 直接消费         │
│ 帧 LRU + 关键帧寻址     │ VideoFrame,单 pipeline 合成      │
│                        │ 特效 = registry(schema 驱动 UI)  │
├────────────────────────┴─────────────────────────────────┤
│ 音频引擎:AudioBufferSource 调度混音,播放时 audio 为主时钟 │
├──────────────────────────────────────────────────────────┤
│ Agent(@velocut/agent-sdk):Claude tool-use 循环,工具 =     │
│   velocut_apply/get_document/evaluate → 同一 dispatch 链路 │
├──────────────────────────────────────────────────────────┤
│ 协同与落盘(@velocut/collab-sdk):Yjs 实体级 CRDT 镜像,     │
│   BroadcastChannel 多标签页实时;IndexedDB 文档 + OPFS 媒体 │
└──────────────────────────────────────────────────────────┘

## SDK 化(packages/)

- `@velocut/protocol` — 类型与命令协议(双引擎契约)
- `@velocut/core-ts` — TS 参考引擎(golden vectors 钉死)
- `@velocut/render-sdk` — Renderer(WebGPU) + MediaLibrary(+decode worker,
  懒字节区间读) + AudioEngine + Playback;无时间轴语义,只消费 FrameGraph
- `@velocut/agent-sdk` — LLM 剪辑 agent(浏览器直连 Anthropic API,可注入
  transport 供测试)
- `@velocut/collab-sdk` — CollabSession(Yjs/BC/IndexedDB) + OPFS 媒体库
```

## 核心决策与理由

**1. 协议先行,引擎双实现。**
Rust core 是 canonical 实现(编译到 WASM 进浏览器,同一 crate 可直接跑在服务端);TS 参考引擎实现同一协议,供 Node Agent / 服务端轻量使用,也是前端在 WASM 包缺失时的 fallback。两者由 `protocol/vectors` 的 golden vectors 钉死行为一致 —— 改引擎语义必须先改向量,两边同时过才算完成。这让"前后端通用、AI 可直接操作"不是口号而是被测试保护的契约。

**2. AI-native = 单一命令链路。**
UI 手势、应用内 Agent 控制台、`window.velocut`、服务端任务,全部汇入同一个 `engine.apply(json)`:同一套校验、同一份 undo 历史、同一个 revision 流。UI 拖拽期间只画本地 ghost,`pointerup` 才提交一条命令 —— 命令粒度 = 手势粒度 = undo 粒度,也正好是 LLM 的工具调用粒度。

**3. 引擎纯函数化:`evaluate(doc, t) → FrameGraph`。**
时间轴语义(轨道层序、变速映射、关键帧插值)全部在 core 内结清,渲染器拿到的是"这一帧画什么"的扁平清单。预览和未来的离线导出消费同一个 FrameGraph,保证所见即所得;混音器同理消费 `audio: AudioSlice[]`。

**4. 时间用整数微秒。**
浮点秒在 trim/split/变速链上会积累误差并破坏双引擎一致性;整数 µs 在 f64/JSON 安全范围内(±106 天),所有命令边界取整。

**5. WebGPU + WebCodecs,只支持 Chrome/Edge。**
`importExternalTexture(VideoFrame)` 让解码帧零拷贝进 shader;文字/图片栅格化成 VideoFrame 后复用同一 pipeline。解码采用标准预览策略:顺播前向喂帧,seek 时 flush 并从最近前置关键帧重启,LRU 持有少量已解码帧(VideoFrame 必须显式 close,显存敏感)。

**6. 特效是数据,不是代码分支。**
文档里只存 `{effect, params}`;前端 registry 提供 schema(Inspector 自动生成控件)和 uniform 打包。加一个特效 = registry 加一项 + shader 数学,协议与 core 不动。

**7. DI 容器装配服务。**
Engine(wasm/ts 运行时探测)、MediaLibrary、Renderer、Playback、Store 全部经容器注册/解析,测试与替换(如换 WebGL2 渲染器)只动装配处。

## 预留的扩展缝

- **CRDT 协作(已落地 v1)**:Y.Doc 以实体粒度(track/asset 各一条目)镜像文档,不同实体并发编辑自动合并,同实体 LWW;nextId 以 max() 合并防 id 撞车。后续演进:op-based undo、y-websocket 服务端 provider、clip 级粒度。
- **Worker 化**:decode/render 与主线程之间只传 `FrameGraph` JSON 与 VideoFrame(Transferable),搬进 Worker 不改接口;vite dev server 已配置 COOP/COEP,SharedArrayBuffer 可用。
- **导出**:离线循环 `evaluate(n/fps)` → 精确取帧(await 而非 best-effort)→ 同一 Renderer 离屏渲染 → VideoEncoder → mp4 mux(Rust 侧追加 muxer crate)。
- **转场**:FrameGraph 已是分层清单,转场 = 相邻两层 + 混合 shader 的一种特殊 layer 关系,协议上加 `transition` 字段即可。

## 已知取舍(v0.1)

- undo 为全量快照(实现简单、绝对正确);文档巨大时换 structural sharing 或 op 日志。
- 预览取帧 best-effort(最近可用帧),保流畅不保逐帧精确 —— 导出路径才要求精确。
- 文字渲染走 Canvas2D 栅格化,未做字形缓存与描边/阴影。
- 音频混音 v1:speed≠1 的 slice 静音(变速保调是导出路径特性);预览混音为 AudioBufferSource 调度,播放时 AudioContext 为主时钟。
