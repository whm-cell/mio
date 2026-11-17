# DSH 对话内核接入

## 适用范围与接入事实

Mio 固定采用 `0.2.2-rc.1` 的官方公开 Agent、Agent Loop、LLM、Session、Session Projection、JSONL Persistence、Session Query 冷读接口，以及既有 System Prompt、Tools 和 Native Executor。[内核入口](../../src/dsh/kernel.ts)只管理公开 AgentHandle 和生命周期；模型请求、inbox、上下文与结算仍由官方 loop 负责。

[正式 Profile](../../cordis.patch.yml)逐项装配必要服务，不加载 SDK/Web 默认 Bundle、Shell、文件工具、MCP、自动重试或模拟模型。未启用 provider 域时保留显式 legacy deepseek-official；启用后由 Mio 注册固定 OneLink 文本路由，缺本人配置不回退。配置见[对话规范](../conversations.md)，无对话数据库保留 foundation 路径；sessions 只反映对话入口是否装配。

正式 Profile 使用 `@mio/plugin/profile` 薄入口以模块级依赖等待 `mioKernel`；独立 `@mio/plugin` 不新增该依赖。活动对话与冷读排空之前保留官方 `@deepseek-ai/dsh-compaction-image-offload` 投影及其恢复监听器，显式串行释放，不依赖同级 fiber 的卸载顺序。

[OneLink 包装](../../src/dsh/onelink.ts)只使用固定发布包 PiAiAdapter、公开 createProvider 和协议工厂，不复制 Agent/codec。公开 agent/pre-step 将同一可信 run 快照绑定到 turn AbortSignal；resolve/metadata/prepare 消费该冻结模型/目录/适配事实，prepare 捕获同一绑定，dispatch 核对原 signal、Session、model/provider 和 purpose。无 owner 的全局 listModels 返回空，不能返回各用户目录并集；无可信 signal 的 resolve/prepare 拒绝且不解密。Key 不入 Session。当前 Profile 只有官方 loop 发起 LLM；未来新增提前解析 metadata 或持有 turn signal 的辅助插件时须重新核对授权。

未知 context 在外层 metadata 省略；有来源声明时通过公开 `context.contextWindow` 传递同一快照。inner 0 是固定 SDK 1.5.0 的内部未知标记，SDK 必填 cost 的 0 也不是供应商价格。1024 是 Mio 输出政策，不是供应商最大能力。每请求的 createProvider 只包含已准入精确 ID，可编码未在 SDK 内置目录中的模型。保留官方 usage/finish、工具块和 replay；错误在进入 JSONL 前投影为固定安全诊断，取消 consumer return 也保存安全观察。根级与非授权 Agent 单调守卫保持默认全拒绝。

接入只用发布包，不依赖本机相邻源码。上游公开接口核对基线为提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；升级时重新核对本文时序。

## 必须遵守的约束

- 框架依赖限于插件入口和有界 `src/dsh/`；普通业务模块不得导入框架包或反向依赖插件。分类、类型检查与构建见[源码护栏](../engineering/source-guardrails.md)。
- 原生持久根是独立 `DSH_HOME` 的 `sessions`；不得借用账号登录 Session、认证表、`.work`、其他运行实例或共享业务数据。
- `@deepseek-ai/dsh-tools` 的 `checkGuards(exec)` 依次检查根级 `guards.global` 与 `guards.chainLayers(exec.agent)`。插件入口、内核和 `create`/`resume` 的 `setup` 在 Agent 发布前均注册[单调拒绝守卫](../../src/dsh/policy.ts)，无 Agent 的直接调用、未授权 Agent 及白名单外工具一律返回 `MIO_TOOL_DENIED`，后注册 `tools/pre-execute` allow 无法覆盖单调守卫。仅当 BYOK 与图片计算桥接均就绪时，活动对话轮次在模块私有 `WeakMap<Agent, ...>` 中临时登记该 `Agent`、仅向会话 `agentCtx.tools`（绝不向全局 `ctx.tools`）注册[三个意图级生图工具](../../src/dsh/image-tools.ts)（`list_image_models`、`submit_image_job`、`get_image_job`），并在 `agentCtx` 守卫执行单轮预算（`maxToolCallsPerTurn = 12`、`maxImageSubmitsPerTurn = 4`，超限返回 `MIO_TOOL_BUDGET_EXCEEDED` 且函数 0 次执行），配合 `agent/pre-step` 的单轮硬步数上限 `MAX_TURN_STEPS = 8`（超限抛 `LlmError(..., 'TURN_STEP_BUDGET_EXCEEDED')`）；轮次结束 `finally` 与 `agentCtx` fiber dispose 立即撤销授权。测试模型、计数工具只在 `tests/`，不得进入生产包或 Profile。
- 显式视觉路由和资产桥就绪时，本轮另登记只读 `inspect_image_asset`；它从可信轮次取 owner，复用同一总工具调用和步骤预算，独立于计算桥。图片仅以绑定资产与源摘要的 opaque ID 持久化，实际预览在内存编码；读取和发送均重新校验源身份。视觉能力撤回时先检查待处理输入和会话 surface，不让文本适配自动抹去图片。
- 预检先按 occurrence 检查张数，再逐个取得实际预览长度，以 Base64 总字节数判断是否需要旧图卸载；仅本轮开始前的 occurrence 可卸载。公开 `projectOffloadedImages` 在请求副本中生成含 assetId 和 `inspect_image_asset` 的占位，原日志和冻结输入不被改写。PiAi 发送前重新读取并核对摘要、尺寸、MIME 与预览指纹；有界并发和取消负责释放在途图片资源。
- 普通输入使用 followup，steer 不自动成为公共入口。Handle 持有者负责释放，完成释放后可在同一内核恢复，释放中重开明确拒绝；DSH ID 不等于登录会话 ID，使用者须先完成可信身份与资源归属检查。
- assistant-stream chunk 是瞬态展示；assistant/message 或 assistant/attempt 是结算记录，也仍不等于已落盘。whenIdle 只证明排空，需检查真实 turn/end.reason 才判断 completed、aborted、error 或 interrupted。
- sessions.flush 必须等待成功且返回 true；无 listener 或失败不能发布持久成功。PostgreSQL 和原生日志不是原子事务。
- 正常显式关闭先停新入口，再 mioKernel.close：cancel、whenIdle、flush、Handle.dispose。根卸载 fallback 只加入公开 Handle.dispose，其内置写句柄关闭负责排空；required injection 保留驱动和持久化服务到消费者清理后，不在 detach 后再次 flush。
- resume 的 setup 清空恢复的 next-step/next-turn inbox 并 flush，再允许新输入，防止旧未知请求在未来 followup 时执行。恢复及读取不是重新调用付费模型的授权。

## 历史、恢复与错误

mioKernel.history 是可信内部读取，不是公共 DTO。活动 Session 先 flush，再通过公开持久化 read handle 读取真实前缀，finally 关闭句柄，不补终态。离线日志用公开 readColdSessionLog 并经官方 Session 重放验证；只在内存补 interrupted，不改原件。synthetic seq 不得作为活动流的持久水位。

原生日志可恢复未完成的最后一行；完整格式/结构损坏拒绝读取，不变成空历史。强杀可能只留下用户输入和运行边界，没有未结算 chunk。可恢复前缀不代表任意崩溃零丢失；未知请求不自动重发，不承诺撤销已发生动作。

精确读取会读、验证完整单会话日志，I/O、时间与内存随内容量增长；公开分页只限制返回体。本地开发不据此承诺上线容量，尚无证据支持 FTS、缓存或第二份消息库。外部必须白名单投影文本、终态状态、脱敏错误以及经严格结构校验的 `mio.image-job`（仅限非错误的 `submit_image_job` / `get_image_job` 结果卡片），绝不透传系统提示、推理、`tool/call` 原始参数、`list_image_models` 内部输出、工具拒绝/异常详情、路径或 trace。

## 验证入口与变更影响

`tests/foundation/kernel.test.ts` 经测试模型 → 官方 loop → Session → 隔离真实 JSONL，观察实际第二轮入模上下文、flush、恢复、取消、根关闭、SIGKILL、损坏尾部和工具拒绝。`tests/foundation/plugin.test.ts` 保留无守卫原生执行正控制及 HTTP/卸载回归。`pnpm test:smoke` 使用打包产物和官方 Profile，内核就绪是基础路由注册的依赖；测试模型和工具不打包。`pnpm check` 同时验证适配目录及临近非法目录、类型/别名导入反例。

调整版本、装配、scope、持久根、flush/关闭顺序或恢复策略时，重验受影响路径和打包。模拟模型、真实存储、正式 Profile、真实供应商、公共 API、生产及远端门禁分别报告；内核验证不等于公共对话服务已接受。
