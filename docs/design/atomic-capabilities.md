**Velocut 原子能力目录与执行契约（设计提案）**

日期：2026-09-15。对照基线：0.0.1 / `11ecf5b`。本文件是接口和实施边界梳理，不表示下述新接口已经实现。现有代码中的入口用原名标注；带命名空间的新名称是目标语义，不要求立刻改名或破坏现有客户端。此前的[能力调研](../research/capability-roadmap-2026-09-14.md)中，“口播剪辑”“自动短片”等建议应落在可组合脚本／Skill 层。

**实施进度（2026-09-15）**

已落地第一阶段：现有命令 schema 生成的能力目录、字段投影／分页／运行实例内快照、`ops`/`ref` 纯数据构造、时间线事务预检／提交／结果查询，以及 MCP/CodeAct 接入。实际接口见[使用说明](../integrations/atomic-api.md)。下文仍是完整目标目录，持久任务、字幕程序、外部 I/O 和完整场景事务统一等并未因此自动实现。

**一、划分原则**

原语只完成一个明确语义动作，输入输出可以被其他操作消费。它可以包含维持数据一致性所必需的内部步骤：例如分割片段必须同时正确处理源入点、局部关键帧和新 ID，复制场景子树必须重映射内部引用。没有必要拆成修改十几个内部字段的危险操作。

| 层级 | 责任 | 示例 | 是否由 Agent 决定组合 |
|---|---|---|---|
| L0 原语 | 查询、测量、单一语义修改、独立产物计算 | 读取片段、分割、设置音量、转写、渲染一帧 | 是 |
| L1 可展开组合 | 确定性的编辑便利操作，展开为普通操作计划 | 关闭指定空隙、生成指定阵列、按指定间隔分布、字幕实例化 | 是，可替换或展开 |
| L2 创作工作流 | 目标、判断标准、选择哪些素材及如何呈现 | 剪口播、找精彩片段、制作广告、挑选配乐 | 必须由 Agent／用户脚本／Skill 编排 |

“原语”与“事务原子性”是两件事：多个原语可以组成一个全成全败的事务。把几十个原语逐一变成 MCP 网络调用也不是目标；CodeAct 可以在一次脚本中生成操作计划，再一次提交。

**二、对象与副作用分类**

| 对象 | 含义与归属 |
|---|---|
| Resource / Artifact | 导入、生成或渲染得到的文件／数据产物；内容版本稳定，以项目内句柄访问 |
| Asset | 项目对素材的登记信息；登记素材不自动创建时间线片段 |
| Track / Clip | 时间线轨道与素材实例；多个 clip 可以引用同一个 asset |
| Effect / Keyframe / Transition | 时间线对象的效果、局部动画与转场 |
| Scene / SceneObject | SceneSpec 与有稳定 ID 的三维对象；材质目前主要内嵌在对象中 |
| Analysis / Transcript | 对素材版本的分析数据；源时间码独立于时间线摆放位置 |
| CaptionProgram（待建） | 文字、时间、样式及文字稿映射；显示实例与底层音视频编辑分开 |
| Job（待统一） | 异步计算或文件操作任务；不等同于文档事务 |
| Session / Selection / Reference | 播放、视角、临时选择及用户主动共享的引用快照 |

每个能力必须声明以下一种主类别，其他副作用也必须显式记录：

- **query**：读取快照，不改变文档、播放位置或选区。
- **observe**：计算／渲染证据，可以产生临时缓存；不改文档。图片通过图像内容或资源句柄返回。
- **command**：修改项目文档，参与事务和历史。
- **session**：修改预览、导航、选择等临时状态；不进入作品撤销历史。
- **job**：异步计算／I/O，返回任务与产物；不会默认将结果放入时间线。
- **history**：移动历史指针或读取历史；不放进普通编辑事务嵌套执行。

**三、现有原语盘点与目标目录**

状态：**已有**表示存在对应实现；**部分**表示有底层实现但语义／入口不完整；**缺失**表示本次检查的公开 API 中没有对应能力。SDK 可调用不等于所有 Agent 宿主均已开放。

| 领域 | 目标原语／明确输入与输出 | 当前入口与状态 |
|---|---|---|
| 能力发现 | `capabilities.list/get`：命名空间／名称 → schema、限制、可用性、版本 | 部分：协议摘要、sceneAssets、效果注册表；缺统一目录 |
| 项目查询 | `project.get`：项目上下文 → 文档摘要、revision；`project.snapshot` → snapshotId | 已有 document 读取；缺显式快照句柄与字段投影 |
| 实体查询 | `asset/track/clip/scene.object.get/list`：ID、过滤、分页、字段 → 实体及版本 | 部分：读整份 document、sceneInspect；缺统一细粒度查询 |
| 关系查询 | `relations.get`：实体 ID → 使用者、父子、资产依赖、关联对象 | 部分：数据可遍历；缺统一依赖索引，音视频关联模型待建 |
| 文件输入 | `resource.import`：用户指定本地文件／文件句柄 → 项目资源句柄 | 部分：编辑器导入与 GLB MCP 导入；缺通用 MCP 媒体输入 |
| 媒体探测 | `media.probe`：资源句柄 → 时长、轨道、格式、尺寸、解码能力 | 已有 MediaLibrary 探测；缺统一 Agent 入口 |
| 素材登记 | `asset.register`：资源／经校验的元数据 → assetId | 已有 addAsset；当前 src 必须满足宿主限制 |
| 素材管理 | `asset.rename/relink/unregister`：ID、替换资源与策略 → 修改结果 | 缺统一命令；解除登记不等于删除原文件 |
| 轨道 | `track.create/remove/reorder/setMuted/setLocked` → trackId／变更 | 已有 addTrack/removeTrack/moveTrack/setTrackMuted/setTrackLocked |
| 轨道补充 | `track.rename`：ID、名称 → 变更 | 缺独立协议命令 |
| 片段创建 | `clip.create`：assetId、trackId、时间与源入点 → clipId | 已有 addClip；不会自动选择最佳落点 |
| 文本片段 | `textClip.create`：trackId、时间、TextPayload → clipId | 已有 addTextClip |
| 片段结构 | `clip.split/trim/move/remove`：ID、明确时间参数 → ID／变更 | 已有 splitClip/trimClip/moveClip/removeClip |
| 片段复制 | `clip.duplicate`：ID、目标轨道与位置 → 新 ID | 缺完整保留效果、关键帧、文本等的专用复制原语；不能只用 addClip 冒充完整复制 |
| 片段属性 | `clip.setTransform/setSpeed/setVolume`：ID、属性值 → 变更 | 已有 setTransform/setClipSpeed/setClipVolume；需补齐变速音频的执行一致性 |
| 文本属性 | `text.setContent/setStyle`：clipId、内容或样式 → 变更 | 部分：setText 写 TextPayload；需明确部分更新与替换语义 |
| 关键帧 | `keyframe.set/remove`：clipId、property、局部时间与值 → 变更 | 已有 setKeyframe/removeKeyframe；读取从文档获得 |
| 效果 | `effect.listDefinitions/add/remove/setParams` → 定义／effectId／变更 | 已有注册表及 addEffect/removeEffect/setEffectParams；缺一致的 Agent 发现方式 |
| 转场 | `transition.set/clear`：clipId、类型与时长／null → 变更 | 已有 setTransition；依赖片段边界与目标引擎支持 |
| 关联编辑 | `clip.link/unlink`：多个 ID、关系类型 → 关系 ID | 缺失；关联后仍须明确每次编辑影响范围 |
| 几何对象 | `scene.object.create/update/remove`：sceneId、对象数据 → objectId／变更 | 已有 SceneEdit add/update/remove |
| 层级与变换 | `scene.object.setParent/setTransform`：ID、局部／世界语义、值 → 变更 | 部分：update.parentId 与 transform；保世界变换的重父级需专项实现 |
| 三维外观 | `scene.object.setMaterial/setGeometry`：ID、参数 → 变更 | 部分：update.patch 支持内嵌材质和几何字段；不是独立共享材质库 |
| 灯光／角色 | `scene.light.setProperties`、`scene.character.setPose/setActions/setGaze` | 已有相应对象字段与 update；需通过类型目录发现，不另做大工具 |
| 镜头 | `scene.camera.set`、`scene.shot.create/update/remove` | 部分：scene patch 可整体改 camera/shots；镜头级稳定 ID 与 CRUD 待细化 |
| 三维复制 | `scene.object.duplicate`：根 ID、新 ID → 子树 ID 映射 | 已有 duplicate，正确维护子树引用属于该语义原语 |
| 模型读取 | `model.decode/probe`：资源 → 模型信息、动画／骨骼／材质描述 | 已有 GLB 底层加载；当前高层 sceneImportModel 同时登记和创建对象 |
| 动态图形 | `motion.create/update`：声明式 MotionSpec → 素材／变更 | 部分：SDK 与内置编辑器已有；当前 MCP 宿主禁用 motionClip 与相应 spec 写入 |
| 转写 | `analysis.transcribe`：素材版本、源区间、语言／模型 → Transcript 产物 | 部分：transcribeAsset/Transcriber 已有段级输出；缺持久词级数据与统一 MCP 入口 |
| 静音测量 | `analysis.measureSilence`：素材区间、阈值、最短长度 → 区间列表 | 已有 Observer 音频分析；它不是语义废话识别 |
| 镜头分析 | `analysis.detectCuts`：素材区间、检测参数 → 切点与指标 | 已有 Observer 镜头分析；不是“最佳镜头”选择 |
| 音频测量 | `analysis.measureAudio`：素材／合成范围 → RMS、峰值、能量曲线 | 已有基础指标；当前 loudnessDbfs 不是 LUFS，标准响度测量待补 |
| 视觉测量 | `analysis.measureFrame`：图像／帧 → 亮度、锐度等指标 | 已有帧指标；检测主体、分割、跟踪等待补 |
| 语音活动 | `analysis.detectSpeech`：素材区间／模型 → 语音区间及置信度 | 缺独立模型型 VAD API；不能把阈值静音分析直接当作同等能力 |
| 分析检索 | `analysis.get/query`：产物、源范围／关键词 → 结果与证据 | 缺统一产物仓库与源时间索引 |
| 字幕数据 | `caption.create/update/remove/style` → 字幕程序／段 ID | 部分：现用文本 clip 表达；缺字幕程序及词级源映射 |
| 字幕解析 | `subtitle.parse/serialize`：SRT/VTT 或字幕程序 → 数据／文件 | 缺统一接口；解析不自动落轨 |
| 音频处理 | `audio.trim/resample/timeStretch/normalize` 等各自具名的原语 | 部分：解码、混音、重采样已有；统一处理产物与预览／导出一致性待补 |
| 生成 | `speech.synthesize`、`image.generate`、`video.generate` | TTS、视频生成有底层接口；图片生成缺统一接口；MCP 当前禁用云生成与语音 |
| 观察 | `observe.frame/contactSheet/scene/audio` → 图片／指标／证据 | 已有 Observer、observeForAgent；直接 MCP 工具 schema 只列部分 mode |
| 时间线求值 | `timeline.evaluate`：明确时间 → FrameGraph | 已有 evaluate；应作为只读能力保留 |
| 文件渲染 | `render.video/audio/sceneModel`：冻结的输入快照和设置 → jobId／artifactId | 已有浏览器视频导出及 GLB 导出；缺统一音频单独导出与 Job API |
| 文件输出 | `artifact.write`：产物 ID、用户指定路径、覆盖策略 → 文件结果 | GLB MCP 有明确路径且禁止覆盖；其他产物待统一 |
| 项目归档 | `project.pack/unpack`：文档、资源清单与目标 → 产物／恢复结果 | 缺完整公共契约；OPFS 字符串不是可携带的素材文件 |
| 任务 | `jobs.get/list/cancel` → 生命周期与产物 | 缺跨导入、分析、生成、渲染的统一模型 |
| 会话 | `preview.get/set`、`director.get/set`、`selection.get/set` | 前两者已有；选择 Store 已有多选，尚未统一对 Agent 暴露 |
| 用户引用 | `references.get` → 用户明确共享的引用快照及当前状态 | 已有 velocut_references；不能等同于实时选区或自动发送聊天 |
| 历史 | `history.get/undo/redo/checkout` → 历史与当前 revision | Store 已有；MCP 只开放需 revision 的 undo/redo |

一个具体的入口差异：`observeForAgent` 支持 `audio`、`shots`；当前 `velocut_observe` 的 MCP schema 没列这两个 mode，而脚本中的 observe 可以透传到宿主。应修复能力声明与实现之间的差异，而不是重新开发一套分析器。

**四、原语输入输出的统一规则（目标契约）**

1. **上下文明确。** 传输层绑定明确的 `sessionId/projectId`；读取返回 revision 或 snapshotId。禁止默认选择“当前前台项目”。能力可用性取决于宿主、资源和所需服务，不能只列函数名。
2. **时间域明确。** 时间线整数微秒、素材源微秒、片段局部微秒必须区分；三维现有 API 的秒保留兼容，但新 schema 标明单位。区间使用 `[from,to)`；帧操作提供帧号与有理数帧率，统一舍入规则。
3. **坐标域明确。** 二维合成像素、归一化画面坐标、三维世界／父级局部米制坐标不能混用；旋转明确角度、顺序、轴和枢轴。缺少世界变换支持时直接返回 unsupported，不能静默按局部解释。
4. **更新语义明确。** `.set` 替换指定完整值，`.patch` 只更新声明的字段，`.clear` 显式移除可选字段；不要让 null、缺省与清空互相混淆。现有 setText、setTransform、SceneEdit.patch 的语义保持兼容，由适配层清楚声明。
5. **每个写入返回实际结果。** 返回 createdIds、updatedIds、removedIds、操作结果与 revision；split 明确给出 leftClipId/rightClipId。Agent 不预测 nextId，不靠对象名称当主键。
6. **每项分析有出处。** 返回输入素材 ID、内容哈希／版本、源时间范围、算法／模型与参数、结果及必要置信度。分析只给证据，不自动决定删除、选择镜头或配乐。
7. **失败可判断。** 错误包括 code、operationId/index、字段路径、message、是否可重试、outcome；outcome 区分未提交、已提交和无法确定。unknown 不能被当作“安全重试”。
8. **结果有预算。** 分页、字段投影、可请求的指标、输出大小上限；大数据返回项目资源句柄。图像使用图像内容块／受控资源，不把视频字节塞进文本上下文。

建议统一结果骨架：

```ts
// 目标类型，尚未实现；各操作的 data 仍须是具体、可发现的 schema。
type Result<T> =
  | { ok: true; data: T; revision?: number; snapshotId?: string; warnings?: Warning[] }
  | { ok: false; error: {
      code: string; message: string; operationId?: string; field?: string;
      retryable: boolean; outcome: 'not_committed' | 'committed' | 'unknown';
    } };
```

**五、事务与任务边界**

`transaction.validate/commit/status` 是执行协议，不是创作流程。建议采用客户端构造计划、服务端短事务提交，不开放跨多轮对话持锁的 begin/commit 会话。

| 行为 | 目标语义 |
|---|---|
| 计划 | JSON 原语序列；以绑定的文档快照为起点，逐项作用于候选文档；引用后续才创建的实体需拒绝 |
| 临时 ID | 用受 schema 约束的结果引用连接前序操作；不允许执行任意字符串表达式，也不提前占用全局 ID |
| 预检 | 克隆候选文档、校验操作／引用／重叠／锁定轨道、检查资源并编译受影响程序；不提交、不创建历史节点 |
| 提交 | 要求 expectedRevision；执行前和异步准备结束后重新检查；一次可见修改、一个历史节点 |
| 作用域 | 第一阶段限定一个项目文档，支持其中多个轨道；跨项目不承诺原子性 |
| 多类对象 | 后续将场景、字幕与时间线编辑汇入同一文档事务；不要把现有多个 sceneEdit/apply 调用误称为一个事务 |
| 失败 | 任一操作不合法则不发布候选文档；资源编译失败不能留下半条轨道 |
| 重试 | requestId + 项目 + 载荷哈希；相同 key 不允许提交不同内容；可查询已知结果。持久化记录与文档提交需要一致，否则崩溃后必须报告 unknown |
| 取消 | 提交前可停止准备；提交后不能靠取消回滚。明确返回提交结果，并让用户／Agent 决定是否 undo |
| 撤销 | 一个事务一个撤销节点；撤销前检查当前 revision，避免误撤销其他人的新操作 |

原语序列中的时间、ID 和属性默认针对“执行到该步骤时的候选状态”。如果 Agent 使用原始素材分析中的多个时间区间，应先规划区间映射／执行顺序，不能指望删除前段后所有旧坐标自动仍然正确。可展开的 gap/ripple 辅助器可以帮助做这种确定性计算，但必须明确轨道范围与影响对象。

文件导入、模型下载、云端计费、文件写出不是文档事务的一部分。推荐分解为：

```text
导入／生成产物 → 校验／探测 → 文档事务登记素材 → Agent 决定何时创建 clip
冻结文档快照 → 渲染产物 → Agent 决定写到哪里
```

分析／生成／渲染统一为有状态任务：queued → running → succeeded/failed；取消区分请求已收到和执行已停止。读取任务不消耗结果；产物保留规则明确。任务绑定不可变输入，文档随后变化不应悄悄改变正在导出的内容。

初期浏览器任务仍依赖页面和 Worker 存活；刷新后可恢复记录／重试，不代表能凭空恢复 WebGPU 上下文或编码器。需要关闭页面后继续运行的能力，应由可选本地进程或远端 Provider 执行并声明。

**六、保留哪些组合能力**

| 现有便利入口 | 拆解方向 |
|---|---|
| `sceneClip` | 准备可渲染场景资源 + asset.register + track.create（仅显式需要时）+ clip.create |
| `sceneImportModel` | 导入文件 + model.probe + 注册模型／素材 + 可选 scene.object.create |
| `sceneEdit` | 保留为场景事务入口；逐步适配统一事务协议 |
| `duplicateMany/array/layout/assembly` | 保留为确定性组合器；提供展开计划与生成 ID 映射，不替 Agent 决定构图 |
| `sceneArrange` | 对指定快照测量边界 + 生成明确的变换操作；与提交分开并检查测量所对应的版本 |
| `captionAsset/applyCaptions` | 分离转写、字幕程序、样式和落轨。当前 applyCaptions 分多次 dispatch，不能声称整条流水线已经原子提交 |
| 高层 TTS／视频生成后落轨 | 先返回音频／视频产物，插入位置、轨道、时长由 Agent 另行选择 |

这些入口保持兼容。新增 `expand/planOnly` 应返回普通计划，而不是另外维护一套只在大工具内部生效的业务逻辑。默认选择“最好片段”“最佳配乐”“自动决定风格”的工具不进入核心原语目录。

**七、MCP 与 CodeAct 的组织**

建议保留少量、职责稳定的入口，而不是把全部原语展开成上百个顶层工具：

| 入口类型（目标） | 职责 |
|---|---|
| capabilities | 列命名空间／检索能力；按需获取具体 schema、示例、限制与宿主支持情况 |
| query | 对明确快照读取实体、关系、任务、历史；支持字段投影和分页 |
| script | 在受控环境中使用带类型的 SDK 编排；可循环、计算、过滤、构造计划 |
| transaction | 预检、提交、查询提交结果；仅接受结构化文档操作 |
| jobs | 提交、查询、取消已发现的分析／生成／渲染能力 |
| observe | 返回实际图像／音频证据或结构化指标，供 Agent 验证结果 |
| session | 操作预览、导演台与选区等临时状态；与文档写入明确区分 |

现有离散 MCP 工具继续提供兼容调用。开始先做能力目录和 SDK 分层，再按使用情况收敛工具入口；不为“工具数量少”引入无 schema 的万能字符串接口。

能力目录的单一来源应是协议 schema、场景操作 schema、效果注册表和具体服务声明。由它们生成 TypeScript 类型、JSON Schema、示例和文档。宿主再报告 `available/unsupported/requires_configuration`、执行位置、事务资格、输入输出上限和 schemaVersion。方法存在但被宿主禁用时，必须被目录如实反映。

CodeAct 中建议使用清楚的命名区分副作用：`query.*` 读数据，`ops.*` 仅构造命令，`tx.*` 才提交；`jobs.*` 开始计算，`session.*` 改临时 UI。避免一个同名方法有时构造计划、有时立即执行。

**八、Agent 自组装示例（伪代码，不是当前可运行 API）**

目标：删除指定 clip 中时间线 2–4 秒这段内容，并只关闭该轨道上的空隙。由 Agent 决定要删除的区间；分析器只提供候选区间。

```js
const read = await v.query.projectSnapshot();
if (!read.ok) return read;
const snapshot = read.data;
const later = [];
for await (const page of v.query.clipPages({
  snapshotId: snapshot.id, trackId,
  startAtOrAfterUs: 4_000_000, orderBy: 'startUs'
})) {
  if (!page.ok) return page;
  later.push(...page.data.items);
}

const operations = [
  { id: 'start', op: 'clip.split', args: { clipId, atUs: 2_000_000 } },
  { id: 'end', op: 'clip.split', args: {
    clipId: v.ref('start', 'rightClipId'), atUs: 4_000_000
  } },
  { id: 'remove', op: 'clip.remove', args: {
    clipId: v.ref('end', 'leftClipId')
  } },
  { id: 'close', op: 'clip.move', args: {
    clipId: v.ref('end', 'rightClipId'), startUs: 2_000_000
  } },
  ...later.map(c => ({
    id: `move-${c.id}`, op: 'clip.move',
    args: { clipId: c.id, startUs: c.startUs - 2_000_000 }
  }))
];
const plan = { expectedRevision: snapshot.revision, operations };
const checked = await v.tx.validate(plan);
if (!checked.ok) return checked;
return await v.tx.commit({ ...plan, requestId });
```

示例前提：目标 clip 的起点早于 2 秒、终点晚于 4 秒；later 是已取完分页的同轨后续片段，按时间升序排列；所有需同步的轨道由 Agent 显式决定是否加入。`v.ref` 只产生类型安全的数据引用，不执行代码。第一次 split 的新 ID 不由 Agent 猜测。删停顿、拼主题片段或制作短视频都可以在这些原语上构造不同计划。

**九、实施顺序与完成标准**

1. **目录与契约。** 整理现有 schema、修正 MCP/脚本声明差异、细粒度查询、统一时间域和错误结果。先标记不可用，不虚报功能。
2. **可靠组合。** 事务结果引用、预检、提交结果查询；完善 clip.duplicate、素材登记／输入拆分。新增协议行为同时更新 Rust/TS 和共用测试向量。
3. **可消费的分析与任务。** 将已有段级转写、音频／镜头分析作为独立结果暴露；再扩展词级数据。补 jobs、渲染产物、文件输出，不自动落轨。
4. **字幕和关联模型。** 增加源词映射、字幕程序、音视频关联及其原语；然后提供可展开的确定性辅助器。
5. **示例而非大工具。** 用数个公开脚本／Skill 验证组合性：去指定停顿、批量替换样式、复制并排列三维对象、渲染选定片段。脚本可读、可改，不成为唯一入口。

完成标准：新组合不需要新增专用大工具；每个动作能独立调用、得到精确结果；计划可预检且失败不产生部分文档修改；重连后能查询已知执行结果；分析不会擅自剪辑；导入不会擅自落轨；所有自动编辑都能追溯到明确输入与版本。

代码依据：[协议 schema](../../web/packages/protocol/src/schema.ts)、[时间线引擎](../../web/packages/core-ts/src/engine.ts)、[场景操作](../../web/packages/scene-sdk/src/authoring.ts)、[宿主](../../web/packages/runtime/src/host.ts)、[观察接口](../../web/packages/runtime/src/observe.ts)、[字幕实现](../../web/packages/render-sdk/src/transcribe.ts)、[MCP 工具](../../web/packages/mcp/src/server.mjs)。
