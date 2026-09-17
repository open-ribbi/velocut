[English](README.md) · **简体中文**

# Velocut

**在浏览器里剪辑视频，与 AI 一起搭建场景、设计镜头。**

[![Release](https://img.shields.io/badge/release-v0.0.2-e6b774)](https://github.com/open-ribbi/velocut/releases/tag/v0.0.2)
[![CI](https://github.com/open-ribbi/velocut/actions/workflows/ci.yml/badge.svg)](https://github.com/open-ribbi/velocut/actions/workflows/ci.yml)
[![Distribution](https://github.com/open-ribbi/velocut/actions/workflows/distribution.yml/badge.svg)](https://github.com/open-ribbi/velocut/actions/workflows/distribution.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[下载 0.0.2](https://github.com/open-ribbi/velocut/releases/tag/v0.0.2)** · [连接 Codex](#连接-codex) · [使用 SDK](#使用-sdk) · [参与贡献](CONTRIBUTING.md)

Velocut 将多轨视频编辑器、可编辑的 3D 导演台和程序化项目运行时放在同一个工作区。你可以手动调整镜头，也可以让 Codex 搭建场景：两者共用编辑服务、项目文档和撤销历史。

由 [Ribbi](https://ribbi.ai) 构建。素材存储和渲染在浏览器中完成；AI 观察与可选云服务会向你选择的模型或提供方发送所需数据。

![Velocut 剪辑工作区：Sunroom 场景预览、时间线上的三个镜头、标题轨道和片段属性。](docs/media/editor.png)

*当前版本的真实界面。演示场景由可编辑几何体和家具组件搭建。*

## 启动 Studio

也可以直接从 npm 启动预构建编辑器：

```sh
npx @velocut/cli@0.0.2 studio
```

下载 **[便携 ZIP](https://github.com/open-ribbi/velocut/releases/download/v0.0.2/velocut-standalone.zip)** 或 **[TAR.GZ](https://github.com/open-ribbi/velocut/releases/download/v0.0.2/velocut-standalone.tar.gz)**，解压后在 `velocut-0.0.2` 目录中运行：

```sh
node start-studio.mjs
```

Studio 会在浏览器中打开，使用期间保持终端运行。便携包已经包含编辑器、场景素材和 Codex 插件 marketplace，无需克隆源码或执行 `npm install`。

- 需要 **Node.js 22.6+**，以及支持 **WebGPU / WebCodecs 的 Chrome 或 Edge**。完整编辑器暂不支持 Safari 和 Firefox。
- 项目保存在浏览器的 IndexedDB / OPFS 中。再次使用时，请保持相同的浏览器配置、主机名和端口。
- 手动编辑和 Codex 集成不需要额外填写模型 API Key。
- 发行版附有 [SHA-256 校验文件](https://github.com/open-ribbi/velocut/releases/download/v0.0.2/SHA256SUMS.txt)。八个 `@velocut` 包也可通过 npm 安装，版本均为 0.0.2。

## 连接 Codex

可直接通过 Git 插件市场安装 **0.0.2**：

1. 在 Codex 中选择「添加插件市场」，来源填写 `open-ribbi/velocut`，Git 引用填写 `v0.0.2`。
2. 稀疏路径可填写 `.agents/plugins` 和 `plugins/velocut`，每行一个。
3. 安装 **Velocut**，新建对话后让 Codex 打开 Velocut。
4. 插件通过 npm 启动固定版本的 MCP，首次连接时自动启动或复用同版本预构建 Studio，再打开配对链接。

需要 Node.js 22.6+ 和 npm，无需手动拉源码、构建或保持终端运行。便携发行包也可自动启动内置 Studio，无需 npm 下载。


可以这样开始：

> 搭建一个明亮的房间，放一张木桌、两把椅子和一个小雕塑。所有对象保持可编辑，再设计一个全景和一个特写镜头。

模型推理在 Codex 中进行。插件提供场景创建、对象编辑、GLB 导入、布局、镜头控制和视觉检查工具，不会在 Velocut 内再调用一层 LLM。其他 MCP 客户端也可使用同一套通用 MCP 服务。

[连接与排障指南 →](docs/integrations/codex-plugin.md)

## 在导演台搭建场景

创建基础几何体、可编辑网格，以及参数化桌子、椅子和楼梯；导入自包含 GLB 模型，调整材质与灯光，设置角色姿态和相机镜头。变换手柄、属性面板和程序化编辑都作用于同一份场景数据。

![Velocut 导演台：Sunroom 房间、对象层级、变换手柄和可编辑的桌子属性。](docs/media/director.png)


支持通过导演台、SDK 和 MCP 导出静态 GLB，详见[模型导出指南](docs/integrations/model-export.md)。Agent 还可批量复制、排列对象、调整预览倍速，以及读取从时间线多选引用的片段。

### 小窗也能操作

工作区适配 Codex 旁边的窄浏览器面板。底部导航按需打开素材／对象、属性、历史和助手面板；时间线可以折叠，为画布留出空间。素材支持点击插入，无需拖拽。

<p align="center">
  <img src="docs/media/compact.png" width="360" alt="440 像素宽窗口中的 Velocut 导演台：紧凑工具栏、场景画布和底部面板导航。">
</p>

### 看清每一次修改

分支历史记录操作归属。你可以检查修改、撤销操作，或回到之前的状态继续编辑。若项目已被其他操作改变，版本检查会拒绝过期的 AI 修改。

![历史面板在真实导演台旁显示通过 MCP 执行、归属于 Codex 的场景创建和修改记录。](docs/media/history.png)

*以上截图来自可复现的文档演示项目，通过真实 MCP 桥接操作。未使用生成式界面效果图，也未伪造聊天记录。*

## 当前能力

| 领域 | 功能 |
| --- | --- |
| 视频剪辑 | 多轨、分割／裁剪、吸附、变速、轨道控制和转场 |
| 视频生成 | 在时间线拉出生成区间，配置文生视频／首帧生成，恢复任务、预览并采用结果 |
| 标题与动效 | 可编辑文字、字幕、变换关键帧、特效和声明式动态图形 |
| 3D 导演台 | 几何体、参数化组件、GLB 模型、角色、材质、灯光、物理和镜头 |
| 音频 | 混音播放、音量关键帧，以及可选的转写和旁白服务 |
| AI 观察 | 渲染视图、抽帧、联系表、镜头分析和音频指标；具体工具取决于接入方式 |
| 导出 | WebCodecs 编码与 MP4 封装，可用编码器由浏览器决定 |
| 本地项目 | 独立项目存储、持久化历史，以及同源多标签页同步 |

内置 **Assistant** 是另一种可选接入方式，使用前需要配置兼容 Anthropic 协议的供应商。浏览器本地 Whisper / VITS 和云端生成服务分别需要对应依赖或凭据，它们不是手动编辑或 Codex 的前置条件。开发服务器的云端代理不包含在便携版中，详见[安全与数据流说明](SECURITY.md)。

### 配置模型与生成视频

打开工具栏的**模型设置**，导入 YAML／JSON 模型定义，或让 Codex 根据 API 文档配置模型，再填写自己的 **Base URL** 和 **API Token**。内置模板和自定义模型共用同一套声明式执行器，无需安装模型专属 npm 包或修改源码。语音与音乐结果可预览并保存到素材库。

在时间线选择**绘制生成区间**，拖出视频区间后选择模型、填写提示词并生成；窄窗口也可通过设置区间输入时间。任务运行时可以继续剪辑，重新打开原项目后可恢复已保存的任务，预览后显式采用结果。生成使用你选择的服务及其额度；首帧上传需要配置参考素材存储。详见[模型配置指南](docs/integrations/providers.md#configure-models-in-studio)。

## 使用 SDK

编辑器与各项集成在同一个 monorepo 中维护。八个模块提供独立安装包，SDK 包含 JavaScript 和 TypeScript 类型声明。GPU 渲染仍是浏览器能力，npm 包不代表提供无界面的 Node 渲染器。

| 包 | 用途 |
| --- | --- |
| [`@velocut/provider-sdk`](web/packages/provider-sdk) | 模型／通道契约、声明式 YAML／JSON 执行器与预设 |
| [`@velocut/protocol`](web/packages/protocol) | 文档类型、命令、校验与协议兼容 |
| [`@velocut/core-ts`](web/packages/core-ts) | 纯时间线编辑、求值和引擎历史 |
| [`@velocut/render-sdk`](web/packages/render-sdk) | WebGPU 合成、媒体 Worker、音频与导出，包含 Vite 辅助插件 |
| [`@velocut/scene-sdk`](web/packages/scene-sdk) | 场景描述、几何、模型、物理、镜头与素材 |
| [`@velocut/runtime`](web/packages/runtime) | 共用项目编辑、分支历史和宿主接口 |
| [`@velocut/mcp`](web/packages/mcp) | Codex 插件与其他客户端共用的 MCP 服务 |
| [`@velocut/cli`](web/packages/cli) | 预构建的本地 Studio 启动器 |

`.tgz` 文件见 [Release 0.0.2](https://github.com/open-ribbi/velocut/releases/tag/v0.0.2)。也可直接运行 `npm install @velocut/scene-sdk@0.0.2 @velocut/runtime@0.0.2` 安装 SDK，或使用压缩包离线安装。

[SDK 集成示例与发布流程 →](docs/integrations/npm-packages.md)

## 从源码开发

```sh
git clone https://github.com/open-ribbi/velocut.git
cd velocut/web
npm ci
npm run dev
```

开发命令会先构建 workspace SDK。无需 Rust 也可以使用 TypeScript 引擎；可选的 Rust 引擎是规范实现，与 TS 引擎共享行为测试向量。

<details>
<summary>构建可选的 Rust/WASM 引擎</summary>

在仓库根目录运行：

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build crates/velocut-wasm --target web --release \
  --out-dir ../../web/apps/editor/public/wasm
```

重启开发服务器后，可在状态栏查看当前引擎。便携版默认使用 TS 引擎；发行构建时设置 `VELOCUT_INCLUDE_WASM=1`，可包含刚刚构建的 WASM 产物。

</details>

```text
crates/                 Rust 引擎与 WASM 绑定
protocol/vectors/       共用行为测试
web/apps/editor/        Studio UI 与应用组装
web/packages/           SDK、运行时、MCP 和 CLI
plugins/velocut/   Codex 清单与导演台技能
web/scripts/            构建、打包、验证和文档截图
```

## 验证与贡献

```sh
# 在 web/ 中运行
npm test
npm run e2e
npm run build:release
npm -w @velocut/cli test
npm run pack:release
npm run test:distribution
```

Rust 引擎测试在仓库根目录运行 `cargo test`。请顺序执行构建与浏览器检查，重新构建 SDK 可能触发开发页面重载。

CI 检查双引擎、WASM 编译和编辑器操作；发行流程在仓库外安装压缩包，并在 macOS、Windows、Linux 上验证 CLI、MCP、Worker 与真实渲染。

[参与贡献](CONTRIBUTING.md) · [架构](ARCHITECTURE.md) · [命令协议](PROTOCOL.md) · [安全](SECURITY.md)

## 许可证

MIT © 2026 willbean。随包提供的第三方代码与场景素材保留各自的[许可证和署名要求](web/packages/scene-sdk/assets/LICENSES.md)。
