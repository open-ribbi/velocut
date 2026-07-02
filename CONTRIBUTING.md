# 向 Velocut 贡献

(English PRs and issues are welcome — the rules below are short, and the one
that matters is **№1: engine behavior changes ship with a golden vector**.)

## 环境

- Node ≥ 22.6(根目录 `.nvmrc`)、Rust stable;浏览器 Chrome/Edge 113+
- `cd web && npm install && npm run dev` 即可跑起来(无需 wasm 工具链,自动回退 TS 引擎)

## 规则一:引擎行为变更 = 新增 golden vector

Velocut 有两个引擎实现(canonical Rust + 参考 TS),行为一致性由
`protocol/vectors/*.json` 钉死,CI 对两侧同时强制。**任何改变命令语义的 PR
必须附带向量**,否则等于只改了一边而没人知道另一边坏了。

一个向量长这样(`protocol/vectors/03_trim_undo_redo.json`):

```jsonc
{
  "name": "一句话说清这条向量钉住的行为",
  "steps": [
    { "apply": { "type": "addAsset", "id": "a1", "kind": "video", "src": "mem://a1", "name": "A", "durationUs": 10000000 } },
    { "apply": { "type": "addTrack", "kind": "video" } },
    { "apply": { "type": "addClip", "trackId": "track_1", "assetId": "a1", "startUs": 1000000, "durationUs": 4000000, "sourceInUs": 500000 } },
    { "undo": true },
    { "redo": true }
  ],
  "expect": {
    "clips": [ { "id": "clip_2", "trackId": "track_1", "startUs": 1000000, "durationUs": 4000000, "sourceInUs": 500000 } ]
  }
}
```

要点:

- id 是引擎确定性铸造的(`<kind>_<nextId>` 单调递增),照着已有向量数 id
- 错误路径用 `applyErr`(断言错误 code),求值断言用 `eval`——各种写法在现有 5 个向量里都有样例
- 新文件放 `protocol/vectors/`,两侧测试自动发现(按目录遍历),不需要注册

跑法:

```bash
cargo test                # Rust 侧
cd web && npm test        # TS 侧(同一套 JSON)
cd web && npx tsc -b apps/editor   # 类型检查
```

## 改动落点速查

| 想改什么 | 动哪里 |
| --- | --- |
| 新命令 / 改命令语义 | `web/packages/protocol/src/schema.ts`(zod + SUMMARIES)→ `crates/velocut-core/src/command.rs` → `web/packages/core-ts/src/engine.ts` → 新向量 |
| 渲染 / 导出 / 解码 | `web/packages/render-sdk/src/`(worker 协议看 `media.worker.ts` 头注释) |
| Agent 工具与提示词 | `web/packages/agent-sdk/src/index.ts` + `protocol-prompt.ts` |
| 特效 / 转场 | `web/packages/render-sdk/src/effects.ts`(注册表,不用碰 agent-sdk) |
| 编辑器 UI | `web/apps/editor/src/ui/` |

改了 Rust 引擎记得重建 wasm(命令见 README),否则本地跑的还是旧引擎或 TS 引擎——右上角 badge 会告诉你真相。

## 风格

- 跟随周围代码的注释密度与命名;注释只写代码自身表达不了的约束
- 提交信息说清"为什么",不复述 diff
