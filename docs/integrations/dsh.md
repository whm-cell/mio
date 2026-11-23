# DSH 对话内核接入

## 适用范围与接入事实

Mio 固定采用 `0.2.2-rc.1` 的官方公开 Agent、Agent Loop、LLM、Session、Session Projection、JSONL Persistence、Session Query 冷读接口，以及既有 System Prompt、Tools 和 Native Executor。[内核入口](../../src/dsh/kernel.ts)只管理公开 AgentHandle 和生命周期；模型请求、inbox、上下文与结算仍由官方 loop 负责。

[正式 Profile](../../cordis.patch.yml)逐项装配必要服务，不加载 SDK/Web 默认 Bundle、Shell、文件工具、MCP、自动重试或模拟模型，并在 `@deepseek-ai/dsh-system-prompt` 显式配置 `includeHarnessIdentity: false` 以移除上游 `DeepSeek Harness` 默认开场白。未启用 provider 域时保留显式 legacy deepseek-official；启用后由 Mio 注册固定 OneLink 文本路由，缺本人配置不回退。配置见[对话规范](../conversations.md)，无对话数据库保留 foundation 路径；sessions 只反映对话入口是否装配。

正式 Profile 使用 `@mio/plugin/profile` 薄入口以模块级依赖等待 `mioKernel`；独立 `@mio/plugin` 不新增该依赖。活动对话与冷读排空之前保留官方 `@deepseek-ai/dsh-compaction-image-offload` 投影及其恢复监听器，显式串行释放，不依赖同级 fiber 的卸载顺序。

`mio-conversations` 保留作用域内装配 `@deepseek-ai/dsh-session-checkpoint-policy`、`@deepseek-ai/dsh-repeat-tool-reminder` 和 `@deepseek-ai/dsh-tool-call-timeout-policy`。这三项策略随图片卸载、官方 TokenMeter 和 ToolResultPruner 保留到活动对话和读取排空。三项策略、计量、裁剪及 Mio 摘要策略所用的公开 CompactionEngine 都是正式产物的显式生产依赖，固定为 `0.2.2-rc.1`。根 Profile 的工具授权仍由单调拒绝守卫和活动轮次的白名单决定。

正式 Profile 将两套官方 JSONL 后端装配到隔离的 Cordis scope，并通过公开 SessionPersistence 接口逐个 ID 路由。既有会话继续在 `DSH_HOME/sessions` 冷读和写入原始 JSONL，新建会话在同一 `DSH_HOME` 下的兄弟目录 `sessions-zstd` 写入带校验和的 Zstandard 帧。Mio 保留两套原件各自的编码、写锁、写入顺序和关闭语义。两处均存在同一 ID，或任一根针对该 ID 返回损坏、格式不支持或 I/O 错误时，精确操作停止。只有官方的会话不存在错误允许检查结果落到单一根。内部持久化列表合并官方可发现的元数据并拒绝两处均可见的同 ID。用户会话列表仍经 PG 按归属和游标查询。

[OneLink 包装](../../src/dsh/onelink.ts)只使用固定发布包 PiAiAdapter、公开 createProvider 和协议工厂，不复制 Agent/codec。公开 agent/pre-step 将同一可信 run 快照绑定到 turn AbortSignal；resolve/metadata/prepare 消费该冻结模型/目录/适配事实，prepare 捕获同一绑定，dispatch 核对原 signal、Session、model/provider 和 purpose。无 owner 的全局 listModels 返回空，不能返回各用户目录并集；无可信 signal 的 resolve/prepare 拒绝且不解密。Key 不入 Session。当前 Profile 只有官方 loop 发起 LLM；未来新增提前解析 metadata 或持有 turn signal 的辅助插件时须重新核对授权。

未知 context 在外层 metadata 省略；有来源声明时通过公开 `context.contextWindow` 传递同一快照。inner 0 是固定 SDK 1.5.0 的内部未知标记，SDK 必填 cost 的 0 也不是供应商价格。1024 是 Mio 输出政策，不是供应商最大能力。每请求的 createProvider 只包含已准入精确 ID，可编码未在 SDK 内置目录中的模型。保留官方 usage/finish、工具块和 replay；错误在进入 JSONL 前投影为固定安全诊断，取消 consumer return 也保存安全观察。根级与非授权 Agent 单调守卫保持默认全拒绝。

接入只用发布包，不依赖本机相邻源码。上游公开接口核对基线为提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；升级时重新核对本文时序。

## 必须遵守的约束

- 框架依赖限于插件入口和有界 `src/dsh/`；普通业务模块不得导入框架包或反向依赖插件。分类、类型检查与构建见[源码护栏](../engineering/source-guardrails.md)。
- 原生持久根位于服务实例独立的 `DSH_HOME`，备份和恢复须保留 `sessions` 与 `sessions-zstd` 各自位置。不得借用账号登录 Session、认证表、`.work`、其他运行实例或共享业务数据。
- `@deepseek-ai/dsh-tools` 的 `checkGuards(exec)` 依次检查根级 `guards.global` 与 `guards.chainLayers(exec.agent)`。插件入口、内核和 `create`/`resume` 的 `setup` 在 Agent 发布前均注册[单调拒绝守卫](../../src/dsh/policy.ts)，无 Agent 的直接调用、未授权 Agent 及白名单外工具一律返回 `MIO_TOOL_DENIED`，后注册 `tools/pre-execute` allow 无法覆盖单调守卫。仅当 BYOK 与图片计算桥接均就绪时，活动对话轮次在模块私有 `WeakMap<Agent, ...>` 中临时登记该 `Agent`、仅向会话 `agentCtx.tools`（绝不向全局 `ctx.tools`）注册[三个意图级生图工具](../../src/dsh/image-tools.ts)（`list_image_models`、`submit_image_job`、`get_image_job`），并在 `agentCtx` 守卫执行单轮预算（`maxToolCallsPerTurn = 12`、`maxImageSubmitsPerTurn = 4`，超限返回 `MIO_TOOL_BUDGET_EXCEEDED` 且函数 0 次执行），配合 `agent/pre-step` 的单轮硬步数上限 `MAX_TURN_STEPS = 8`（超限抛 `LlmError(..., 'TURN_STEP_BUDGET_EXCEEDED')`）；同时单轮工具闭包对未完成（`accepted`/`submitted`/`processing`/`materializing`）的同轮新建任务或本轮已查非终态任务的重复 `get_image_job` 轮询以 `IMAGE_JOB_POLL_DEFERRED` 拦截（失败不产出 `mio.image-job` 卡片），跨轮对前序 `jobId` 的首次查询仍正常放行；轮次结束 `finally` 与 `agentCtx` fiber dispose 立即撤销授权。测试模型、计数工具只在 `tests/`，不得进入生产包或 Profile。
- 对话 `list_image_models` 只列出可由 `submit_image_job` 表达的 `generate` 和 `edit`。提交工具的参数声明与运行时均限这两种操作，额外的 `geometry` 参数会被拒绝。图片 HTTP 接口有独立的路由能力门控，可对获授权的路由受理 `outpaint`。[图片 HTTP 契约](../apis/compute.md)
- 显式视觉路由和资产桥就绪时，本轮另登记只读 `inspect_image_asset`；它从可信轮次取 owner，复用同一总工具调用和步骤预算，独立于计算桥。图片仅以绑定资产与源摘要的 opaque ID 持久化，实际预览在内存编码；读取和发送均重新校验源身份。视觉能力撤回时先检查待处理输入和会话 surface，不让文本适配自动抹去图片。
- 对话子插件 `mio-conversations` 显式注入 `systemPrompt`。[对话引擎](../../src/dsh/conversations.ts)在 legacy 和 BYOK 的活动轮次 `resume` 中，按会话用途和实际工具权限注册 `agentCtx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, interpolate: false, text })`。[对话系统提示词](../../src/conversations/prompt.ts)固定对外身份为 `miioo AI 漫剧助手`。用途和工具权限相同时，系统前缀字节保持稳定。`interpolate: false` 保留字面量 `{{...}}`，公开历史和 SSE 按既有白名单投影。
- `drama-script` 的项目快照由可信服务按 owner 解析，每轮最多传入 64 KiB UTF-8 JSON。引擎在官方 `agent/pre-step` 接纳该轮真实人类输入时通过 `mio-project-context` 内部来源更新[模型上下文槽](../../src/dsh/conversation-context.ts)。首次槽随官方 `enter` 批次追加，排在本轮真实用户输入之前。文字相同复用现有槽，变化时使用原生 `surfaceOp: replace` 更新同一位置，缺快照时最多写入一次简短失效标记。原生 JSONL 保留原始事件，冷启按其重建槽。公开历史、标题和输入回执仍识别真实人类输入，SSE 仅投影文本回复及既有白名单事件。项目快照按资料进入用户角色，独立于系统前缀。
- TokenMeter 计入待接纳或已落在 surface 的当前项目快照。M3 摘要输入跳过内部项目槽文本及其资产引用。若自动摘要替换的连续区段覆盖活动槽，同次请求会恢复冻结快照，并按扣除该槽后可实际回收的 token 判断摘要是否缩小上下文。人类输入与项目快照合计达到已声明的窗口时，保留正文尝试，跳过无法缩小该轮输入的摘要调用。
- 预检先按 occurrence 检查张数，再逐个取得实际预览长度，以 Base64 总字节数判断是否需要旧图卸载；仅本轮开始前的 occurrence 可卸载。公开 `projectOffloadedImages` 在请求副本中生成含 assetId 和 `inspect_image_asset` 的占位，原日志和冻结输入不被改写。PiAi 发送前重新读取并核对摘要、尺寸、MIME 与预览指纹；有界并发和取消负责释放在途图片资源。
- 普通输入使用 followup，steer 不自动成为公共入口。Handle 持有者负责释放，完成释放后可在同一内核恢复，释放中重开明确拒绝；DSH ID 不等于登录会话 ID，使用者须先完成可信身份与资源归属检查。
- 启用对话服务时，在其子插件装配同版本的官方 `@deepseek-ai/dsh-session-title`，使用本地确定性首条人类消息回退及显式 `rename`。配置的回退限制为 12 词、96 个 UTF-8 字节，手工标题上限 120 字节。该服务未注册标题生成 provider。PG 只接收已完成原生 flush 的人类消息时间和标题，用于会话列表。官方标题事件只存在于原生日志，公开历史和模型上下文依旧由既有投影产生。关闭时在对话写入排空后释放标题服务。
- assistant-stream chunk 是瞬态展示；assistant/message 或 assistant/attempt 是结算记录，也仍不等于已落盘。whenIdle 只证明排空，需检查真实 turn/end.reason 才判断 completed、aborted、error 或 interrupted。
- `sessions.flush` 必须等待成功且返回 true。Mio 为原生检查点策略接入严格 flush，在模型派发前、顶层工具函数执行前及步间确认已记录前缀。无持久化监听、返回 false 或抛错均阻止尚未进入的下游工作，同一轮余下检查点保持失败。有效图片卡片生成后补充 flush，成功再发 SSE 卡片，后续步等待其结果。PostgreSQL 和原生日志分别持久化，已受理图片任务可能早于工具结果落盘。
- 工具提醒使用 DSH 原生连续同参检测，阈值为 `2` 和 `4`。提醒仅进入模型上下文，异参调用继续沿原权限和预算检查。协作超时只作用于声明 `timeoutMs` 的工具。`inspect_image_asset` 为 60 秒，含准备队列等待，沿实际 AbortSignal 取消并等待工具收敛。`submit_image_job` 沿用提交前取消与现有存储期限，以便已受理的任务仍能返回句柄。
- 正常显式关闭先停新入口，再 mioKernel.close：cancel、whenIdle、flush、Handle.dispose。根卸载 fallback 只加入公开 Handle.dispose，其内置写句柄关闭负责排空；required injection 保留驱动和持久化服务到消费者清理后，不在 detach 后再次 flush。
- resume 的 setup 清空恢复的 next-step/next-turn inbox 并 flush，再允许新输入，防止旧未知请求在未来 followup 时执行。恢复及读取不是重新调用付费模型的授权。

空闲会话改名通过同一受控 resume 保存官方标题，清理持久 inbox 中的未执行输入。公开历史项目和已有回执沿各自原边界读取。

## 历史、恢复与错误

mioKernel.history 是可信内部读取，不是公共 DTO。活动 Session 先 flush，再通过公开持久化 read handle 读取真实前缀，finally 关闭句柄，不补终态。离线日志用公开 readColdSessionLog 并经官方 Session 重放验证；只在内存补 interrupted，不改原件。synthetic seq 不得作为活动流的持久水位。历史请求断开及服务关闭将取消信号传到本次公开持久化 open/read；读句柄始终在 finally 关闭，后续投影分段让出事件循环检查取消。活动 Session 的 flush 和官方同步重放仍按原生调用边界完成后检查取消。

官方后端可恢复未完成的末尾 JSONL 行或 Zstandard 帧；完整格式、校验和或结构损坏拒绝精确读取。强杀可能只留下用户输入和运行边界，没有未结算 chunk。可恢复前缀不代表任意崩溃零丢失；未知请求不自动重发，不承诺撤销已发生动作。

精确读取会读、验证完整单会话日志，I/O、时间与内存随内容量增长；公开分页只限制返回体。本地开发不据此承诺上线容量，尚无证据支持 FTS、缓存或第二份消息库。外部必须白名单投影文本、终态状态、脱敏错误以及经严格结构校验的 `mio.image-job`（仅限非错误的 `submit_image_job` / `get_image_job` 结果卡片），绝不透传系统提示、推理、`tool/call` 原始参数、`list_image_models` 内部输出、工具拒绝/异常详情、路径或 trace。

## 验证入口与变更影响

`tests/foundation/kernel.test.ts` 经测试模型 → 官方 loop → Session → 隔离真实 JSONL，观察实际第二轮入模上下文、flush、恢复、取消、根关闭、SIGKILL、损坏尾部和工具拒绝。`tests/foundation/plugin.test.ts` 保留无守卫原生执行正控制及 HTTP/卸载回归。`pnpm test:smoke` 使用打包产物和官方 Profile，内核就绪是基础路由注册的依赖；测试模型和工具不打包。`pnpm check` 同时验证适配目录及临近非法目录、类型/别名导入反例。

`tests/conversations/m3-storage.test.ts` 验证双根冷读续写、新帧校验和、根卸载和同 ID 拒绝。`tests/conversations/vision-profile.test.ts` 通过已打包 Profile 验证旧日志冷读续写，并解码新日志检查图片卸载与数据泄露。

调整版本、装配、scope、持久根、flush/关闭顺序或恢复策略时，重验受影响路径和打包。模拟模型、真实存储、正式 Profile、真实供应商、公共 API、生产及远端门禁分别报告；内核验证不等于公共对话服务已接受。
