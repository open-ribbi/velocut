# Velocut

Rust + WASM + WebGPU 的 Web 视频剪辑引擎与编辑器。**协议先行、AI-native**:人通过 UI 剪辑、LLM 直接下发 JSON 命令剪辑,两者走同一条命令链路,映射到同一个 UI。

## 快速启动(零依赖,TS 引擎)

```bash
cd web
npm install
npm run dev        # Chrome/Edge 113+ 打开(WebGPU + WebCodecs)
```

开箱即用:DI 容器检测到 WASM 包缺失时自动回退到 TS 参考引擎(右上角 badge 显示当前引擎)。

## 启用 Rust/WASM 引擎(canonical 实现)

```bash
# 一次性环境
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# 构建并放入前端 public 目录
wasm-pack build crates/velocut-wasm --target web --release \
  --out-dir ../../web/apps/editor/public/wasm

cd web && npm run dev   # badge 变为 "engine: Rust/WASM"
```

## 测试(双引擎共享 golden vectors)

```bash
cargo test                # Rust 引擎跑 protocol/vectors/*.json
cd web && npm test        # TS 引擎跑同一套向量
```

任何引擎行为变更必须以新增向量的方式落地,两边同时通过才算一致。

## 目录结构

```
crates/
  velocut-core/      # canonical 引擎:模型/命令/求值/历史(纯 Rust,无 wasm 依赖)
  velocut-wasm/      # wasm-bindgen 绑定(string JSON ABI)
protocol/
  vectors/           # golden test vectors —— 双实现的行为契约
web/
  packages/protocol/ # TS 协议类型(与 Rust serde 形状一一对应)
  packages/core-ts/  # TS 参考引擎(Node Agent/服务端可直接用;前端 fallback)
  apps/editor/       # Vite + React 编辑器(WebGPU 渲染 / WebCodecs 解码 / Canvas 时间轴)
```

## 当前能力(按既定优先级)

1. ✅ 多轨剪辑基础:切割 / 拖拽 / 吸附 / 变速 / undo-redo(快照式,200 步)
2. ✅ 关键帧动画(linear/hold/bezier)+ schema 驱动的特效注册表(v0.1:亮度/对比度/饱和度)
3. ✅ 文字图层(栅格化 → 与视频同一 WebGPU 管线合成)
4. ⏭ 音频:数据已在 FrameGraph.audio(AudioSlice),AudioWorklet 混音是下一里程碑

操作:空格播放 / S 分割 / Delete 删除 / Cmd+Z 撤销 / Ctrl+滚轮缩放时间轴 / 拖 clip 边缘 trim。

## Agent 入口

- UI 内:右下角「⌘ Agent」控制台,粘贴命令 JSON 直接执行
- DevTools / 外部脚本:`window.velocut.apply({type:'splitClip', clipId:'clip_2', atUs:1500000})`
- 服务端 / Node Agent:`import { TsEngine } from '@velocut/core-ts'`,或在服务上跑同一个 Rust crate

命令协议详见 `PROTOCOL.md`,架构决策详见 `ARCHITECTURE.md`。
