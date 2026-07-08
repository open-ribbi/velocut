<!-- markdownlint-disable MD041 -->
[English](README.md) | **简体中文**

# Velocut

[![CI](https://github.com/open-ribbi/velocut/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen)

Rust + WASM + WebGPU 的 Web 视频剪辑引擎与编辑器。**协议先行、AI-native**:人通过 UI 剪辑、LLM 直接下发 JSON 命令剪辑,两者走同一条命令链路,映射到同一个 UI。

![Velocut 编辑器——多轨时间线(波形/关键帧/转场/变速)+ WebGPU 合成预览](docs/media/editor.png)

## 环境要求

- **Node ≥ 22.6**(`npm test` 依赖 `--experimental-strip-types`;仓库根有 `.nvmrc`)
- **浏览器:Chrome / Edge 113+**(WebGPU + WebCodecs;Safari/Firefox 暂不支持)
- 可选:Rust stable + wasm-pack(仅构建 canonical WASM 引擎时需要)

## 快速启动(零依赖,TS 引擎)

```bash
cd web
npm install
npm run dev
```

开箱即用:DI 容器检测到 WASM 包缺失时自动回退到 TS 参考引擎(右上角 badge 显示当前引擎)。

## 启用 Rust/WASM 引擎(canonical 实现)

```bash
# 一次性环境
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# 构建并放入前端 public 目录(或用 just build-wasm)
wasm-pack build crates/velocut-wasm --target web --release \
  --out-dir web/apps/editor/public/wasm

cd web && npm run dev   # badge 变为 "engine: Rust/WASM"
```

## Agent 快速上手

Velocut 的第一"用户"是 AI Agent:点右下角「⌘ Agent」气泡,在供应商设置面板
里完成配置(直接用你自己的 Anthropic API key 即可),就能用自然语言剪辑——
"把静音段都剪掉""给开头加个标题"。

![Agent 读取工程后用一个原子 batch 落好风格匹配的片尾字卡——走的是与 UI 完全相同的命令协议](docs/media/agent.png)

- **Key 只存在你本机浏览器的 localStorage,请求从浏览器直连所配置的端点,不经任何中间服务器**(信任模型详见 [SECURITY.md](SECURITY.md))
- Agent 能看(抽帧/拼图观察)、能听(响度与静音分析)、能切(镜头边界检测),所有编辑走与 UI 相同的命令协议,每一步都在聊天卡片和历史树里可见、可点击跳转、可回滚
- **中转/网关一等公民**:⚙ 供应商设置支持任意 Anthropic 协议兼容的 Base URL(LiteLLM、one-api、企业代理),`x-api-key` 或 `Authorization: Bearer` 两种鉴权,自定义模型 id,以及一键连接测试;端点需允许浏览器跨域(CORS)请求

### 可选能力与密钥约定(仅 dev server)

联网搜索(Gemini grounding)与 MiniMax 云 TTS 经 Vite dev server 代理注入密钥,浏览器永远不持有它们:

```bash
# 均为可选;文件已被 .gitignore,放在 web/apps/editor/ 下
echo "<你的 Google API key>"  > web/apps/editor/.google-key    # velocut_search
echo "<你的 MiniMax key>"     > web/apps/editor/.minimax-key   # 云 TTS(本地 TTS 无需 key)
```

注意:这两个代理只存在于 `npm run dev`;`vite build` 静态部署后搜索/云 TTS 不可用。

## 测试(双引擎共享 golden vectors)

```bash
cargo test                # Rust 引擎跑 protocol/vectors/*.json
cd web && npm test        # TS 引擎跑同一套向量 + 单元测试
cd web && npm run e2e     # Playwright 冒烟(启动/导入/编辑/持久化)
```

任何引擎行为变更必须以新增向量的方式落地,两边同时通过才算一致。向量之外,
套件还覆盖 agent tool-use 循环(注入 transport)、特效/动态图形注册表,以及
两条 Chromium 端到端旅程。CI(`.github/workflows/ci.yml`)对每个 PR 强制四个
job:Rust(fmt + clippy + 向量)、TS(向量 + 单测 + tsc)、wasm 编译冒烟、E2E。
贡献流程详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 目录结构

```
crates/
  velocut-core/      # canonical 引擎:模型/命令/求值/历史(纯 Rust,无 wasm 依赖)
  velocut-wasm/      # wasm-bindgen 绑定(string JSON ABI)
protocol/
  vectors/           # golden test vectors —— 双实现的行为契约
web/
  packages/protocol/ # TS 协议类型 + zod 校验(与 Rust serde 形状一一对应)
  packages/core-ts/  # TS 参考引擎(前端 fallback;Node 侧可直接跑)
  packages/render-sdk/ # WebGPU 合成 / WebCodecs 解码与导出 / worker / 观察(抽帧、镜头、响度)
  packages/agent-sdk/  # Anthropic 协议 tool-use 循环(transport 可注入)
  packages/collab-sdk/ # local-first 持久化 + 多 tab CRDT 同步(Yjs)
  apps/editor/       # Vite + React 编辑器(Canvas 时间轴 / 分支历史 / Agent 控制台)
```

## 当前能力

1. ✅ 多轨剪辑:切割 / 拖拽 / 吸附 / 变速 / trim / 轨道重排,分支式编辑历史(回到过去再编辑开新分支,人/AI 操作分色归因)
2. ✅ 关键帧动画(linear/hold/bezier)+ 特效注册表(调色等)+ 转场
3. ✅ 文字图层与字幕样式(栅格化 → 与视频同一 WebGPU 管线合成)
4. ✅ 音频:混音播放、音量关键帧(淡入淡出 / ducking)、TTS 旁白(本地 / MiniMax)、Whisper 自动字幕
5. ✅ Agent 感知:抽帧观察 / 镜头边界检测 / 响度与静音分析,结果以图片和 sparkline 呈现在聊天里
6. ✅ 声明式动态图形(motionClip):JSON spec 描述的关键帧图层,持久化、可从沙箱脚本生成
7. ✅ 导出:WebCodecs 编码 + mp4 封装(流式,不憋整段内存);低清代理预览后台转码
8. ✅ local-first:素材进 OPFS、文档与历史进 IndexedDB,多 tab 实时同步
9. ✅ 多项目管理:工具栏项目切换器,每个项目的文档/历史/素材/缓存完全隔离

操作:空格播放 / S 分割 / Delete 删除 / Cmd+Z 撤销 / Ctrl+滚轮缩放时间轴 / 拖 clip 边缘 trim / 右键轨道头与 clip 出菜单。

## 程序化入口

- DevTools / 外部脚本:`window.velocut.apply({type:'splitClip', clipId:'clip_2', atUs:1500000})`
- Node 侧引擎:`@velocut/core-ts`(workspace 内消费;独立发包在路线图上)

命令协议详见 [PROTOCOL.md](PROTOCOL.md),架构决策详见 [ARCHITECTURE.md](ARCHITECTURE.md),安全与信任模型详见 [SECURITY.md](SECURITY.md)。

## License

MIT © 2026 willbean
