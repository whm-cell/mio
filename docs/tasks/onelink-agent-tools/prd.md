# 万联 Agent 生成工具 PRD

状态：O7 已采纳本期对话生图工具边界并进入 Unit 1（`onelink-conversation-image-tools`）实施；根级与未授权 Agent 工具默认全拒绝继续有效，视频、音频与素材库工具仍为后续独立条件切片，不随本期自动开启。后续轻量变化见[变更索引](changes/index.md)；各变化的新候选单独核验，不改判原成果。生命周期遵循[当前任务的生命周期](../../coordination.md#当前任务的生命周期)，返回[任务资料与成果](../index.md)。

## 1. 结果与非目标

官方 DSH Agent Loop 通过受控意图级业务工具调用已接受的 Mio 供应商目录与图片计算服务，返回脱敏 Mio 图片任务与私有资产引用；复用同一用户身份、任务幂等与副作用约束，不维护第二套 Agent Loop 或第二套生成准入逻辑。独立 HTTP 能力不隐含全局工具许可，Foundation `/api/v1/capabilities` 继续保持 `tools: []`。

### 1.1 O7 已采纳契约与本期开发单元

| 开发单元                       | 结果键                             | 本期范围与产物                                                                                                                                                                                                                                                                                   | 明确非目标                                                                                                                                                                     |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit 1：对话意图级生图工具闭环 | `onelink-conversation-image-tools` | 在 BYOK 与图片计算桥接均就绪的对话轮次中，向会话级 `agentCtx.tools` 注册 `list_image_models`、`submit_image_job`、`get_image_job`；升级根/Agent 单调守卫与双层预算互锁；落地 `mio.image-job` 历史与 SSE 白名单投影、插件卸载先排空对话再关 `compute`/`providers`、现行规范同步与真实隔离闭环测试 | 视频生成工具、音频（语音/音乐）生成工具、素材库工具、全局 `ctx.tools` 工具暴露、修改 `mio_provider_model_preferences` 仅 `chat` 默认规则、未经单独授权的外部真实付费供应商调用 |

O7 采纳结论冻结如下：

- **允许工具白名单与作用域**：仅开放 `list_image_models`（只读并发安全）、`submit_image_job`（互斥提交）、`get_image_job`（只读并发安全），且仅在 `providerConfig`、`computeConfig`、`assetConfig` 与 `imageEnabled` 均就绪的 BYOK 对话轮次注册到会话 `agentCtx.tools`；绝不注册到全局 `ctx.tools`。无关 Shell、文件、MCP、代码执行与动态插件管理工具继续禁止。
- **双层预算互锁与硬步数熔断**：会话 `agentCtx` 守卫执行单轮工具调用上限 `maxToolCallsPerTurn = 12` 与单轮图片提交上限 `maxImageSubmitsPerTurn = 4`（超限返回 `MIO_TOOL_BUDGET_EXCEEDED: ...`，工具函数执行 `0` 次）；`agent/pre-step` 执行单轮硬步数上限 `MAX_TURN_STEPS = 8`（第 9 步抛 `LlmError(..., 'TURN_STEP_BUDGET_EXCEEDED')` 熔断）；底层每用户 `32`／全局 `1000` 个活动图片任务配额（`accepted` / `materializing`，与视频转码 `10`／`500` 配额分离）由 `ComputeService` 继续强制执行。
- **参数与资源归属授权**：可信 `userId`、`conversationId` 与轮次 `requestId` 全部取自服务端已受理的 `ConversationRun` 绑定；工具严禁接收 `apiKey`、`userId`、`owner`、裸 `url`、`base64`、COS 对象键或任何未知字段。参考图 `imageAssetIds`、PNG 遮罩 `maskAssetId` 与任务 `jobId` 统一按系统 `userId` 校验归属。
- **用户意图、幂等去重与取消/恢复语义**：由用户显式发起的对话消息驱动官方 loop；`submit_image_job` 以 `sha256Utf8("mio:conv-image:v1:${userId}:${conversationId}:${turnRequestId}:${clientOperationKey ?? exec.callId}")` 派生合法小写 UUID v4 作为 `GenerationService.createImage` 的 `requestId`，受理后立即返回任务视图，不长阻塞对话锁等待上游渲染。同轮相同 `clientOperationKey`（或同 `callId`）重试复用同一 `jobId`（`0` 重复生图）；对话取消协作终止在途轮次与未派发工具，已受理图片任务保持既有状态机独立推进；重启冷读历史绝不重放工具。
- **公开历史与 SSE 审阅白名单**：仅当 `tool/result` 非错误且 `meta` 通过严格结构校验匹配 `{ kind: 'mio.image-job', tool: 'submit_image_job' | 'get_image_job', job }` 时，才投影为公开历史 `{ seq, role: 'tool', tool, job }` 与实时 SSE `event: tool` 帧；`tool/call` 原始参数、`list_image_models` 输出、拒绝/错误详情、系统提示与推理一律不透传。

## 2. 触发、直接依赖与 C0

触发后按[统一生命周期](../../coordination.md#当前任务的生命周期)推进。Unit 1 的 C0 前置决定与实施授权已齐备，直接复用以下已接受能力而无需新增外部依赖或数据库表：

- **可信身份与对话基线**：沿[认证底座](../../auth.md)、[DSH 契约](../../integrations/dsh.md)与[本地对话服务](../../conversations.md)，消费已接受的 `conversation-kernel`、`conversation-service` 及 `onelink-user-chat`（[对话成果](../conversation-service/complete/report.md)、[万联成果](../onelink-integration/complete/report.md)）。
- **单轨原厂路由与图片计算基线**：沿[供应商配置](../../providers.md)、[OneLinkAI 集成](../../integrations/onelink.md)与[计算任务 HTTP 契约](../../apis/compute.md)，消费已接受的 `onelink-db-vendor-routing`（[原厂路由成果](../onelink-vendor-routing/complete/report.md)）、私有资产与 Worker 队列 `private-user-assets`/`compute-jobs`/`compute-worker`（[计算成果](../compute-service/complete/report.md)）及图片生成/编辑/异步切片 `seedream-sync-slice`/`reference-outpaint-slice`/`async-image-slice`/`kling-async-image-slice`（[图片成果](../onelink-image-generation/complete/report.md)）。
- **图片工具边界**：`list_image_models` 只列出 `generate` 和 `edit`，`submit_image_job` 的声明和执行也只支持这两种操作。对话工具拒绝 `geometry`。图片 HTTP 接口按自身路由能力受理 `outpaint`。上游 `geometry` 真实协议与视频、音频和素材库工具由其他切片处理。

## 3. C1 实施要点

1. **单调守卫升级（`src/dsh/policy.ts`）**：`@deepseek-ai/dsh-tools` 的 `checkGuards(exec)` 依次核对根级 `guards.global` 与 `guards.chainLayers(exec.agent)`。根级与内核 `denyModelTools` 默认拒绝一切工具调用（返回 `MIO_TOOL_DENIED: ...`），仅当 `exec.agent` 存在于模块私有 `WeakMap<Agent, ...>` 活动轮次授权表、授权未撤销、信号未中止且 `exec.name` 命中三工具白名单时放行；同时由 `agentCtx` 守卫统计单轮 12 次总调用与 4 次提交预算，轮次 `finally` 与 fiber dispose 双重立即撤销授权。
2. **供应商只读目录摘要与路由检查（`src/providers/catalog.ts`、`src/providers/service.ts`）**：新增只读不解密的 `listImageModels`（单次 `store.state(userId)`、预建路由索引 $O(M+R+P)$、零联网零解密）返回当前用户 `runnable` 图片模型的 19 项路由能力摘要，以及复用同一资格校验的 `inspectImageRoute`；保持 `mio_provider_model_preferences` 仅允许 `chat` 默认不变。
3. **意图级生图工具与派生资产参考输入（`src/dsh/image-tools.ts`、`src/generations/image-routes.ts`、`src/generations/store.ts`、`src/generations/service.ts`）**：封闭工具参数 schema（`additionalProperties: false` 并显式拦截未知字段），异常统一脱敏为 `HarnessError`；`submit_image_job` 读取生效 `ImageRouteConfig`，在省略 `async` 且 `route.requiresAsync === true` 时自动补齐 `async: true`，在省略 `operation` 且携带参考图/遮罩时按路由 `supportedOperations` 与 `allowGenerateReferences` 归一化 `edit` 或 `generate`（兼容 OpenAI、Volcengine、Vidu、Kling 标准 `image` 与 Omni `image_list`），派生确定性小写 UUID v4 `requestId` 调用 `GenerationService.createImage`；在图片准入与协议校验中开放本人 `ready` 图片 `derived` 资产（`mio/derived/<jobId>/images/<index>-<fileId>.<format>`）作为后续轮次参考图/编辑输入（视频转码仍保持仅限 `original`）；`get_image_job` 先校验 `isUuidV4(jobId)` 防御 PG `22P02` 再调用 `GenerationService.getImage`；两者通过 `output.presentationMeta` 挂载 `mio.image-job`。
4. **对话引擎桥接、投影与卸载顺序（`src/conversations/contracts.ts`、`src/dsh/conversations.ts`、`src/plugin.ts`）**：`contracts.ts` 保持零 DSH/Compute 内部导入，扩展 `HistoryItem`、`ConversationEvent` 与窄桥接 `ConversationImageTools`；`conversations.ts` 在 `agent/pre-step` 实施 `MAX_TURN_STEPS = 8` 熔断，在 `history()` 与实时 `session/event` 对 `mio.image-job` 执行严格结构白名单投影（含 `outputs` 序号严格递增且与 `assetIds` 逐项一致），保留多步 `tool-calls -> stop` 的 `model_observations` 追加与终态文本 `recordVerification`；`plugin.ts` 在 `compute` 卸载 `ctx.effect` 中先等待 `conversations?.close()` 再关闭 `compute`（保留双方异常 `AggregateError`）。
5. **公共规范同步**：在进入 `verify` 前同步更新 `docs/foundation.md`、`docs/integrations/dsh.md`、`docs/integrations/onelink.md`、`docs/integrations/cos.md`、`docs/conversations.md`、`docs/apis/conversations.md`、`docs/apis/compute.md` 与 `docs/tasks/compute-service/protocol.md`，并纳入同一候选。

## 4. 验收与接受

Unit 1（`onelink-conversation-image-tools`）须同时满足以下验证与接受门槛：

- **隔离端到端闭环（`tests/conversations/conversation-image-tools.test.ts`）**经隔离 PostgreSQL、OneLink 和 COS 协议替身、官方 DSH Agent Loop、真实 JSONL 持久化以及正式打包的 A Profile 验证。只迁移 auth、assets、providers、conversations、generations，并在 Profile 就绪后核对视频表缺席。用例包括
  - 第 1 轮调用 `list_image_models` 发现模型并调用 `submit_image_job`（覆盖同步 Volcengine Seedream 与省略 `async` 自动补齐的异步 Kling 标准/Omni 路由），核对实时 SSE `event: tool` 帧与 `GET /history` 的 `role: 'tool'` 投影，且不透传 `list_image_models` 或原始 `tool/call`；
  - A 执行器完成后第 2 轮调用 `get_image_job` 取得输出 `assetId`，再调用 `submit_image_job` 完成携带 `imageAssetIds` 与 PNG `maskAssetId` 的编辑/参考图闭环，核对多步 `model_observations` 数组记录与最终聊天模型 `verified` 记录；
  - owner 在本用例建立已完成任务和输出资产，另一个 owner 的 `assetId`/`jobId` 调用被拒绝。核对唯一工具调用标识与实际错误码后验证脱敏。非法 UUID `jobId`（零 PG `22P02`）、未发现/禁用/待适配模型、未知或敏感参数均被拒绝且无越权副作用。Prompt 注入尝试调用无关工具（如 `counted_fixture`）及根 `ctx.tools.execute` 直接调用均被 `MIO_TOOL_DENIED` 阻断且工具函数执行 `0` 次。
  - 同轮第 5 次 `submit_image_job` 被 `MIO_TOOL_BUDGET_EXCEEDED` 拦截（仅创建 4 个任务，第 5 次 `0` 执行），单轮超过 8 步触发 `TURN_STEP_BUDGET_EXCEEDED` 熔断，相同 `clientOperationKey` 重试复用同一 `jobId`（`0` 重复生图），中途取消与正式打包 Profile 重启后冷读 `history` 正确投影 `role: 'tool'` 且不重放工具。
- **既有基线与工程护栏回归**：`tests/foundation/plugin.test.ts` 与 `tests/foundation/kernel.test.ts` 原断言 100% 保持通过；`pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm guard`、`pnpm build`、`pnpm test:smoke`、`pnpm work documents` 及受影响本地回归通过，形成覆盖 `pnpm check` 的有效结论。
- **审查与人类接受**：完成真实 `quality-review`、v2 `norms-review` 与独立只读审查，经 `deliver prepare` 交回人类审阅；确定性隔离闭环、正式 Profile、真实付费供应商观察与生产证据分别报告，取得真实人类接受前不宣称已接受或扩大到其他媒体工具。
