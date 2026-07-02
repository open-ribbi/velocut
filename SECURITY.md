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
2. **脚本级(`velocut_script`)**:Agent 可以生成 JavaScript 并在**主页面
   realm** 执行(当前实现为 `new Function`,尚未隔离进 sandboxed
   iframe/Worker——已在路线图上)。脚本拥有与页面同等的 DOM / 网络 /
   localStorage 权限。

## 已知风险:注入链

`velocut_search` 会把不可信的网页内容注入模型上下文。理论攻击路径:恶意
网页内容 → 诱导模型生成恶意 `velocut_script` → 读取 localStorage 中的
key 或发起任意请求。在脚本沙箱落地前,请理解并接受这个组合风险:

- 对不可信素材/话题使用搜索时保持警惕,留意聊天卡片里 Agent 生成的脚本内容
- 最保守的用法:不配置搜索 key(能力不接入,工具自然失效)

## 报告漏洞

发现安全问题请开 GitHub issue(不涉及可被远程利用的场景),或通过仓库
主页联系方式私下报告。这是个个人开源项目,没有赏金,但会认真修。
