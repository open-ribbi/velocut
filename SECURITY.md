# 安全与信任模型

Velocut 是 local-first 的纯浏览器应用:没有后端,你的素材、文档、历史全部
留在本机(OPFS / IndexedDB / localStorage)。下面是你在使用 Agent 功能前
应当知道的边界。

## API key 的存放

- Anthropic key 由你粘贴进 Agent 控制台,**明文存于本机浏览器 localStorage**
  (`velocut.anthropicApiKey`),请求直连 Anthropic,不经任何中间服务器。
- 这意味着:任何能在该页面执行 JS 的东西(浏览器扩展、XSS、下述脚本工具)
  都能读到它。建议使用限额 key,不用时可在控制台里清除。
- Gemini 搜索与 MiniMax TTS 的 key 走 Vite dev server 代理注入,浏览器
  永远不持有(见 README「可选能力与密钥约定」)。

## Agent 的两级执行权限

1. **命令级(默认)**:Agent 的一切剪辑经 `velocut_apply` 下发 JSON 命令,
   过 zod schema 校验,只能修改文档模型——改不了 DOM、发不了网络请求,
   且每一步都记入可回滚的编辑历史。
2. **脚本级(`velocut_script`)**:Agent 可以生成 JavaScript 并执行,但它
   **不在主页面 realm 运行**——而是在一个一次性的 `sandbox="allow-scripts"`
   iframe(null origin,srcdoc 内联 CSP `connect-src 'none'`)里跑。这个
   realm:
   - **读不到 localStorage**(opaque origin 无存储)→ Anthropic key 安全
   - **发不了任何网络请求**(fetch / XHR / WebSocket / sendBeacon / EventSource
     / 动态 import 均被 CSP 拦在浏览器层)→ 无法外泄
   - **碰不到父页 DOM / cookie / `window.velocut`**(跨源隔离)
   - 只能调用一张白名单 API(`apply`/`tts`/`observe`/`evaluate`/`document`/
     `seek`),经 MessageChannel RPC 回宿主串行执行;有 60s 墙钟超时防跑飞。

## 已知风险:注入链(已缓解)

`velocut_search` 会把不可信的网页内容注入模型上下文。理论攻击路径:恶意
网页内容 → 诱导模型生成恶意 `velocut_script` → 读取 localStorage 中的 key
或发起任意请求。**上面的沙箱已切断这条链**:脚本拿不到 key、连不上外网。
仍需注意:

- `motionClip`(过程式图形)因需宿主逐帧渲染,暂不在沙箱脚本内提供(调用返回
  明确错误);正迁移为声明式 spec 后恢复。宿主调试入口 `window.velocut.motionClip`
  不受沙箱约束,仅供本地调试,勿对不可信输入使用。
- key 仍以明文存于 localStorage:能读取页面主 realm 的东西(恶意浏览器扩展、
  页面自身 XSS)仍可拿到它。沙箱只隔离 Agent 脚本,不改变扩展的权限。

## 报告漏洞

发现安全问题请开 GitHub issue(不涉及可被远程利用的场景),或通过仓库
主页联系方式私下报告。这是个个人开源项目,没有赏金,但会认真修。
