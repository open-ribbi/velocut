# Velocut 数据协议(AI-native)

一句话:**文档是 JSON,编辑是 JSON 命令,渲染输入是 JSON FrameGraph**。任何会改文档的东西 —— UI 手势、LLM 工具调用、服务端任务 —— 都只说这一种语言。

- 规范实现:`crates/velocut-core`(Rust)
- 参考实现:`web/packages/core-ts`(TypeScript,行为强一致)
- 一致性契约:`protocol/vectors/*.json`(双引擎必须同时通过)
- TS 类型定义:`web/packages/protocol/src/types.ts`

## 约定

- **协议版本:1**(`PROTOCOL_VERSION`,导出于 `@velocut/protocol`)。仅在命令集或错误契约发生破坏性变更时递增;持久化文档另有独立的 `formatVersion`(见 `migrate.ts`)
- 所有时间为 **整数微秒**(`TimeUs`),1 秒 = 1_000_000;边界校验(zod)拒绝小数——两引擎按整数寻址时间,小数会产生不同的取整结果
- JSON 字段一律 camelCase
- id 由引擎铸造(`clip_N` / `track_N` / `asset_N`),命令返回的 `events` 里带回新 id
- 同一视频/文字轨上的 clip **不允许重叠**(首尾相接允许)
- `asset.hasAudio` 缺省时按 `kind != image` 填充——命令路径与文档加载路径同一规则(向量 08 钉死)

## 信封(每条命令的返回)

```jsonc
// 成功
{ "ok": true, "revision": 42, "events": [{ "kind": "clipAdded", "clipId": "clip_3", "trackId": "track_1" }] }
// 失败(文档零副作用,包括 batch 中途失败)
{ "ok": false, "error": { "code": "overlap", "message": "clip would overlap clip_2" } }
```

错误码:`notFound` | `overlap` | `invalidArg` | `locked` | `parse` | `outOfRange`。

## 命令一览

| type | 关键字段 | 说明 |
|---|---|---|
| `addAsset` | kind, src, name, durationUs?, width?, height?, id? | 注册素材元数据 |
| `addTrack` | kind: video\|audio\|text, name?, index? | 新建轨道 |
| `removeTrack` | trackId | 删除轨道(含其 clips) |
| `addClip` | trackId, assetId, startUs, durationUs?, sourceInUs? | 素材上轨 |
| `addTextClip` | trackId, startUs, durationUs, text | 文字 clip |
| `removeClip` | clipId | 删除 clip |
| `moveClip` | clipId, startUs, trackId? | 移动(仅限**同 kind** 轨间,跨类拒绝 `invalidArg`) |
| `trimClip` | clipId, edge: in\|out, toUs | 裁剪;in 边同步推进 sourceIn |
| `splitClip` | clipId, atUs(时间轴坐标) | 一分为二;关键帧按分割点重定基 |
| `setClipSpeed` | clipId, speed | 变速;保持源素材区间,时长重算 |
| `setTransform` | clipId, transform | 整体写 x/y/scale/rotation/opacity |
| `setClipVolume` | clipId, volume | 0–2 |
| `setText` | clipId, text | 改文字内容/字号/颜色 |
| `setKeyframe` | clipId, property, keyframe | 同一 timeUs 即覆盖(相对 clip 起点) |
| `removeKeyframe` | clipId, property, timeUs | |
| `addEffect` / `setEffectParams` / `removeEffect` | clipId, effect/effectId, params | 特效是数据,registry 在前端 |
| `setTrackMuted` / `setTrackLocked` | trackId, muted/locked | locked 轨拒绝一切编辑 |
| `batch` | commands[] | **原子**:任意一条失败则全部回滚(含 id 计数器) |

关键帧 `easing`:`{"kind":"linear"}` | `{"kind":"hold"}` | `{"kind":"bezier","x1":…,"y1":…,"x2":…,"y2":…}`(CSS cubic-bezier 语义)。

## LLM 使用示例

**「把第一个镜头在 1.5s 处剪开,后半段加速到 2 倍」**

```json
{ "type": "batch", "commands": [
  { "type": "splitClip", "clipId": "clip_1", "atUs": 1500000 },
  { "type": "setClipSpeed", "clipId": "clip_2", "speed": 2.0 }
]}
```

(split 产生的新 clip id 可从上一条命令的 events 读取;batch 内可利用 id 铸造的确定性:下一个 id 总是 `clip_{nextId}`。)

**「开头加 2 秒标题,淡入」**

```json
{ "type": "batch", "commands": [
  { "type": "addTrack", "kind": "text", "name": "字幕", "index": 0 },
  { "type": "addTextClip", "trackId": "track_2", "startUs": 0, "durationUs": 2000000,
    "text": { "content": "新品上市", "fontSize": 96, "color": "#ffffff" } }
]}
```

然后对返回的 clipId 打透明度关键帧:

```json
{ "type": "setKeyframe", "clipId": "clip_5", "property": "opacity",
  "keyframe": { "timeUs": 0, "value": 0, "easing": { "kind": "linear" } } }
```

```json
{ "type": "setKeyframe", "clipId": "clip_5", "property": "opacity",
  "keyframe": { "timeUs": 500000, "value": 1, "easing": { "kind": "linear" } } }
```

**读状态**:`velocut.doc()` 拿完整文档;`velocut.evaluate(tUs)` 拿该时刻的 FrameGraph(分层合成清单 + 音频切片),用于"看懂当前画面"再决策。

## FrameGraph(求值输出,渲染器输入)

```jsonc
{
  "timeUs": 2000000, "width": 1280, "height": 720,
  "layers": [ // 按轨道序,底→顶
    { "clipId": "clip_1", "assetId": "asset_1", "sourceTimeUs": 3500000,
      "transform": { "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "opacity": 0.8 },
      "effects": [{ "id": "fx_1", "effect": "brightnessContrast", "params": { "brightness": 0.1 } }],
      "text": null }
  ],
  "audio": [ { "clipId": "clip_1", "assetId": "asset_1", "sourceTimeUs": 3500000, "speed": 1, "gain": 1 } ]
}
```

`sourceTimeUs` 已含 sourceIn 与变速映射;`transform` 已含关键帧求值结果。渲染器/混音器无须理解时间轴语义 —— 这是前后端、预览/导出共用同一引擎的关键。
