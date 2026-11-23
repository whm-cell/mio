# 多轮对话进阶与长会话治理 PRD

**状态**：待评审。本文在已接受的最小对话底座之上，统一规划 Mio 后端多轮对话的可靠性加固、长上下文治理、会话生命周期管理、漫剧业务上下文接入与深度交互进阶。本文当前只交付规划，不直接修改现行服务规范、数据库结构或运行时代码；各开发单元的实施授权、候选验证与业务接受按[协调协议](../../coordination.md#规划交付要求)与[当前任务的生命周期](../../coordination.md#当前任务的生命周期)分别记录，不因本规划落盘推导开发已就绪或实现已接受。[任务资料入口](../index.md)

## 1. 目标、定位与跨 PRD 边界

Mio 当前已具备用户归属、BYOK 动态准入、PostgreSQL 元数据与 DSH JSONL 双层持久化、SSE 实时流、协作式取消、受控图片输入/查看及意图级生图工具闭环。随着对话承载真实 AI 漫剧创作（单集剧本正文 P95 约 44 KB、最大约 170 KB，且伴随多轮人物设定推演与图片生成），需要在**不维护第二套 Agent 循环**的前提下，按需启用 `@deepseek-ai/dsh@0.2.2-rc.1` 已有模块化能力并补齐服务契约短板：

1. **多步副作用崩溃一致性、前缀缓存与可诊断错误**：消除多步工具轮次中间未刷盘窗口，开启受支持协议的前缀缓存控制以降低长多轮延迟与成本，并将上游细分失败原因脱敏透传给客户端。
2. **会话可读标题、活跃度排序与大文本输入**：补齐零额外模型费用的自动标题、重命名、软归档、按最近活跃时间分页，以及足以容纳整集剧本粘贴润色的单轮消息体量上限。
3. **长对话上下文不爆窗**：通过确定性 Token 水位计量、无模型工具输出裁剪与面向漫剧创作的受控自动摘要压缩，让几十轮至上百轮的创作对话可持续推进且保留完整原始历史供回看。
4. **漫剧工作区无缝接入**：在对话服务侧提供通用的“受控会话用途模板 + 每轮项目上下文静默注入”底座，直接解锁漫剧剧本工作区的多轮打磨需求。
5. **深度思考、进度反馈与分支重演**：支持可选推理强度（`reasoningEffort`）与工具/思考实时进度帧，支持从已结算历史轮次无损分叉（Fork / 重新生成）与空闲会话受控切模。

### 与既有 PRD 及规范的职责切分

- **[后端对话服务 PRD](../conversation-service/prd.md) 及 [已接受成果](../conversation-service/complete/report.md)**：保留原 D1/D2（`conversation-kernel`、`conversation-service`）及轻量变更（如 `conversation-platform-prompt`、`conversation-output-limit`、`conversation-vision-input`）的历史接受事实、既有请求回执与原生日志语义，不重开旧单元；本 PRD 新增单元全部归属 `docs/tasks/conversation-enhancement/prd.md` 独立核算与交付。
- **[万联 Agent 生成工具 PRD](../onelink-agent-tools/prd.md)**：继续遵守根级与非授权 Agent 单调拒绝守卫（[底座规格](../../foundation.md#结构决定)），单轮工具调用与生图提交预算保持有效，全局 `/api/v1/capabilities` 的 `tools` 继续保持为空。
- **[AI 漫剧工作流后端 PRD](../drama-workflow/prd.md)**：漫剧 D2（剧本工作区）需要“专属系统提示词 + 每轮注入当前剧本摘要与设定”。本 PRD 的单元 M4 在 `src/conversations/` 与 `src/dsh/` 内交付通用受控扩展点；漫剧模块仅作为上层消费者传入受控用途标识与项目快照，不跨模块导入 DSH 或改写对话存储。
- **前端边界**：本仓库只负责后端契约、存储与引擎适配，不设计前端界面组件。

## 2. 已确认的核心决策与不启用红线

以下四项核心边界由项目负责人于 2026-11-23 明确确认，作为本 PRD 全部开发单元的共同约束：

1. **失败重试与 BYOK 计费红线**：普通上游瞬时失败（`429`、`5xx`、网络或流式超时）默认不自动重发计费模型请求，M1 向前端返回细分脱敏错误码，由用户按需重试或经 M6 重新生成。M3 的受控例外限于上游明确返回 `CONTEXT_OVERFLOW`、且出错的这次正文尝试尚未通过 SSE 发布非空正文的情况，同一受理轮次可执行一次摘要及一次正文重发。首次正文失败、摘要、正文重发各自按实际出站向同一请求的 `model_observations` 追加观察，恢复路径合计最多三次出站。若这次尝试已发布非空正文，保留流上已推送的片段并直接以 `MODEL_CONTEXT_OVERFLOW` 结算，不追加摘要或重发。整轮自动摘要最多一次，未知结果保留原回执。
2. **单轮消息请求体积上限**：仅将 `POST /api/v1/conversations/:id/messages` 的 JSON 请求体上限从现行 `16 KiB` 放宽至 **`256 KiB`**（覆盖旧库单集剧本最大约 170 KB 的粘贴与润色场景）；其余对话创建、绑定、重命名、取消、分叉与压缩等控制接口继续保持 `16 KiB` 上限与 10 秒读取期限。
3. **对话删除语义**：统一采用**软归档**（`DELETE /api/v1/conversations/:id` 幂等写入 `archived_at`），归档后退出常规会话列表并拒绝新消息发送、模型切换与手动压缩，但完整保留底层 DSH JSONL 日志、请求回执审计及已生成的私有图片资产引用；物理清除与数据保留周期另立全局治理规范。
4. **深度思考（Reasoning）公开投影边界**：思考过程增量与状态**仅通过实时 SSE 事件流推送**供前端展示实时推理进度，不混入 `GET /api/v1/conversations/:id/history` 的正式助手消息正文；DSH 原生会话日志照常保留完整思考块，不破坏底层回放与未来按需扩展。

### 明确不启用的 DSH 能力（工程与安全红线）

依据 [DSH 集成契约](../../integrations/dsh.md#必须遵守的约束)、[源码护栏](../../engineering/source-guardrails.md) 与 `DESIGN-OVER-001`，以下已存在于依赖树中的上游包在本规划范围内明确禁止或排除：

- **宿主机与本地开发工具包**（`dsh-bash-*`、`dsh-pwsh-*`、`dsh-tool-fs*`、`dsh-tool-str-replace-editor`、`dsh-mcp-*`、`dsh-sdk-minimal`、`dsh-web-app`）：违背多用户后端隔离边界，根级与会话单调守卫继续全拒绝。
- **自由多智能体与重型自治编排包**（`dsh-subagent*`、`dsh-goal*`、`dsh-plan-mode`、`dsh-experimental-*`）：漫剧结构化节点已确定采用确定性代码编排（见 [漫剧 PRD](../drama-workflow/prd.md#已确认的决定)），现阶段引入子智能体或自治循环缺乏收益依据且放大计费失控风险。
- **默认单工作区假设的检索与跨会话引用包**（`dsh-session-query-sqlite`、`dsh-session-reference`）：上游实现面向单机单工作区，直接挂载存在跨用户数据串联风险，且根服务 A 受护栏限制禁止随意引入 SQLite 生产依赖；用户级会话列表与元数据过滤统一由带 `owner_id` 条件约束的 PostgreSQL 承接。

## 3. 现有基线与 DSH `0.2.2-rc.1` 接入接缝事实

各开发单元实施前须基于以下已核实的源码与固定 SDK（`0.2.2-rc.1`，基线参考提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）事实设计，不得假设未经验证的隐式行为：

| 接缝位置                                                                                                                                                        | 当前代码事实                                                                                                                                                                                                                                       | 对本 PRD 实施的直接约束                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **产物依赖声明**<br>[package.json](../../../package.json) · [cordis.patch.yml](../../../cordis.patch.yml)                                                       | 部分待启用包（如 `dsh-session-checkpoint-policy`、`dsh-token-meter`、`dsh-compaction*`、`dsh-session-title`、`dsh-repeat-tool-reminder`）目前仅存在于 `@deepseek-ai/dsh` 开发依赖传递树中，未列入生产 `dependencies`。                             | 任何被 `cordis.patch.yml`、`src/plugin.ts` 或 `src/dsh/` 实际引用的 `@deepseek-ai/dsh-*` 包，必须以精确固定版本 `0.2.2-rc.1` 显式写入根 `package.json` 的 `dependencies`，并通过打包后的 `pnpm test:smoke` 验证。 |
| **BYOK 调用准入**<br>[src/dsh/onelink.ts](../../../src/dsh/onelink.ts)                                                                                          | `OneLinkAdapter` 仅在 `agent/pre-step` 将 `ConversationRun` 绑定至当步 `AbortSignal`；直接调用 `stream()` 抛 `BINDING_REQUIRED`，且 `dispatch()` 强制要求 `options.purpose === undefined`，同时固定 `cacheRetention: 'none'`、`reasoning: false`。 | M1 开启缓存、M3 接入摘要压缩（`purpose: 'compaction'`）、M5 开启思考能力时，均须在 `OneLinkAdapter` 显式受控放开对应字段与辅助调用绑定，严禁退化为无 `ConversationRun` 归属的全局放行。                           |
| **上游压缩默认提示词**<br>`@deepseek-ai/dsh-compaction-basic`                                                                                                   | 上游 `dsh-compaction-basic` 内置摘要指令硬编码为面向“AI 编程助手”的代码任务总结，且内部直接调用 `ctx.llm.stream({ ..., purpose: 'compaction' })` 并强依赖正整数 `contextWindow`。                                                                  | M3 不直接照搬上游编程摘要提示词，应基于 `@deepseek-ai/dsh-compaction` 的公开 `CompactionEngine` 契约实现漫剧领域摘要器（或受控包装），并对未配置 `contextWindow` 的聊天路由明确降级为仅执行无模型工具输出裁剪。   |
| **系统提示词与历史投影**<br>[src/conversations/prompt.ts](../../../src/conversations/prompt.ts) · [src/dsh/conversations.ts](../../../src/dsh/conversations.ts) | `PERSONA_PREFIX_SECTION` 以 `order: 0, interpolate: false` 注册确定性文本；`history()` 仅投影 `source.kind === 'user'` 的用户消息、助手文本、`mio.image-job` 白名单卡片及轮次终态。                                                                | M4 新增用途模板须保持 `order: 0` 同会话确定性以维持前缀缓存；每轮动态项目上下文经内部 `source` 注入，确保公开 `history` 与 SSE 零泄露内部提示词和上下文块。                                                       |
| **存储与迁移边界**<br>[src/conversations/schema.ts](../../../src/conversations/schema.ts) · [src/conversations/store.ts](../../../src/conversations/store.ts)   | `mio_conversations` 当前仅有 `id, owner_id, dsh_session_id, created_at, state, active_request, model_binding`，无标题、活跃时间与归档列；启动只读检查列类型 OID。                                                                                  | M2/M4/M6 涉及的表结构扩展必须通过 `pnpm conversations:migrate --apply` 事务内增量执行并同步更新 `checkConversationSchema`，兼容既有行空值回退，不破坏已有请求摘要与幂等键。                                       |

## 4. 执行波次与开发单元总览

本 PRD 按可独立验证、写入冲突最小化的原则划分为 **6 个本期开发单元（M1–M6）** 与 **1 组条件触发候选（M7）**。单次实施按单元独立建档、验证和交付，不预建全部后续 `.work` 记录。

| 波次                         | 单元与稳定成果键（Result Key）                                                               | 核心交付结果                                                                                                                | 直接前置依赖                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **阶段一：底座加固与提速**   | **M1**：`conversation-step-reliability-and-cache`<br>步级检查点、前缀缓存与可诊断错误闭环    | 模型/工具每步持久化检查点、重复工具调用温和纠偏、受控协议前缀缓存、细分脱敏失败错误码                                       | 既有对话与万联底座                           |
| **阶段二：长对话与漫剧就绪** | **M2**：`conversation-lifecycle-and-titles`<br>会话标题、活跃排序、软归档与 256 KiB 消息扩容 | 首条消息零费用自动标题、手动重命名、按活跃倒序列表、软归档、单轮消息 256 KiB 上限                                           | 既有对话底座（可与 M1/M3 错峰或顺序推进）    |
| **阶段二：长对话与漫剧就绪** | **M3**：`conversation-context-compaction`<br>Token 水位计量、工具输出裁剪与漫剧自动摘要压缩  | 实时上下文水位暴露、无模型工具输出裁剪、漫剧专用自动/手动摘要压缩与 `CONTEXT_OVERFLOW` 单次压缩恢复、可选 JSONL `zstd` 压缩 | M1（细分错误分类与检查点基线）               |
| **阶段二：长对话与漫剧就绪** | **M4**：`conversation-purpose-and-context-injection`<br>会话用途模板与受控项目上下文注入     | 受控会话 `purpose` 系统提示词模板、每轮内部项目上下文快照静默注入（直接支撑漫剧 D2）                                        | M1（前缀缓存稳定基线）、M2（会话元数据扩展） |
| **阶段三：深度交互进阶**     | **M5**：`conversation-reasoning-and-progress-events`<br>可控深度思考与实时执行进度事件       | 路由 `reasoning` 能力声明、`reasoningEffort` 选择、SSE 实时思考增量与工具执行中状态帧                                       | M1（路由能力与 SSE 错误基线）                |
| **阶段三：深度交互进阶**     | **M6**：`conversation-fork-and-model-switch`<br>历史轮次分叉（Fork）与空闲会话受控切模       | 从已结算轮次无损派生新对话（支撑重问/重新生成/分支剧情）、空闲状态下合格聊天模型切换                                        | M2（标题/归档与会话元数据）                  |
| **条件触发候选**             | **M7**：交互式追问、动作卡、创作技能与评价反馈<br>（条件满足前不分配本期成果键）             | `ask_user_question`、`action-cards`、按需创作 `skill`、`message-feedback`                                                   | 前端交互卡片方案或漫剧 D2 采纳联动定稿后触发 |

## 5. 本期开发单元详细规划（M1–M6）

### 5.1 单元 M1：步级持久化检查点、前缀缓存与可诊断错误闭环

- **成果键**：`conversation-step-reliability-and-cache`
- **结果与范围**：
  - 消除多步工具轮次中间（模型请求前、生图/看图工具执行前、步间切换前）未刷盘导致的崩溃丢记录风险；
  - 对连续相同参数重复调用工具的循环行为注入温和纠偏提醒，并挂载工具协作超时保护；
  - 按平台聊天路由协议放开受控前缀缓存策略（`cacheRetention`），使现有稳定系统提示词与多轮历史前缀命中上游缓存；
  - 将请求结算时的笼统 `MODEL_FAILED` 细化为可指导用户行动的脱敏错误码。
  - **明确非目标**：不修改数据库表结构；不启用自动重发计费请求的 `dsh-llm-retry`。
- **C0 就绪条件与解决动作**：
  - **已确认决定**：不自动重发普通失败请求；保持根级单调拒绝守卫不变。
  - **C0 核对项**：核对 `@deepseek-ai/pi-ai@1.5.0` 在 `openai-chat` 与 `anthropic-messages` 下 `cacheRetention`（如 `'short'` / `'none'`）的实际线级字段行为：在 [router.ts](../../../src/providers/onelink/router.ts) 的聊天 `capabilityMetadata` 增加可选 `cacheRetention?: 'none' | 'short' | 'long'`（未声明时 `anthropic-messages` 默认 `'short'` 以激活断点缓存，`openai-chat` 保持自动前缀缓存无额外非法字段）；核对公开错误码枚举命名（`MODEL_AUTH_FAILED`、`MODEL_QUOTA_EXCEEDED`、`MODEL_RATE_LIMITED`、`MODEL_TIMEOUT`、`MODEL_CONTEXT_OVERFLOW`、`MODEL_UPSTREAM_ERROR` 及兜底 `MODEL_FAILED`）。无外部阻塞。
- **C1 实施要点与依赖顺序**：
  1. 在根 [package.json](../../../package.json) 显式添加 `0.2.2-rc.1` 的 `@deepseek-ai/dsh-session-checkpoint-policy`、`@deepseek-ai/dsh-repeat-tool-reminder` 与 `@deepseek-ai/dsh-tool-call-timeout-policy`，并在 [cordis.patch.yml](../../../cordis.patch.yml) / `mio-conversations` 装配挂载（`repeat-tool-reminder` 配置 `thresholds: [2, 4]`，不阻断合法不同参数的并发调用）。
  2. 扩展 [src/providers/contracts.ts](../../../src/providers/contracts.ts)、[src/providers/onelink/router.ts](../../../src/providers/onelink/router.ts) 与 [src/dsh/onelink.ts](../../../src/dsh/onelink.ts)：识别上游上下文超限状态/诊断并归类 `CONTEXT_OVERFLOW`，按路由配置传递 `cacheRetention`。
  3. 扩展 [src/conversations/contracts.ts](../../../src/conversations/contracts.ts)、[src/dsh/conversations.ts](../../../src/dsh/conversations.ts) 与 [src/conversations/service.ts](../../../src/conversations/service.ts)：从本轮最后一步有效 `ModelObservation.failureCode` 或引擎已知 `LlmError.code`（含 `TURN_STEP_BUDGET_EXCEEDED`）映射稳定公开回执错误码，同时兼容历史已落库 `MODEL_FAILED` 回执的读取。
  4. 进入 `verify` 前同步 [docs/conversations.md](../../conversations.md)、[docs/apis/conversations.md](../../apis/conversations.md)、[docs/providers.md](../../providers.md)、[docs/integrations/dsh.md](../../integrations/dsh.md) 与 [docs/integrations/onelink.md](../../integrations/onelink.md)。
- **验收与接受条件**：
  - 隔离测试中在第 1 步 `submit_image_job` 执行前及执行后、第 2 步模型响应前分别模拟中断/落盘失败：验证 `flush` 失败时工具函数 `0` 次执行，工具已执行但后续步骤中断时冷读历史完整保留第 1 步工具卡片；
  - 模拟模型连续同参重复调用工具，验证触发温和提醒并在下一步正常收敛，未误触硬步数熔断；
  - 协议替身核对 `anthropic-messages` 出站请求包含受控缓存控制标记且系统提示词前缀保持稳定，同时注入 401/402/429/504/上下文超限响应，验证 GET 回执与 SSE `state` 返回精确细分脱敏错误码且供应商调用次数为 `1`；
  - 通过完整静态检查、受影响回归与打包 Profile `pnpm test:smoke`，经质量与规范三方审阅及人类接受后交付。

### 5.2 单元 M2：会话标题、活跃排序、软归档与 256 KiB 消息扩容

- **成果键**：`conversation-lifecycle-and-titles`
- **结果与范围**：
  - 会话在首条有效人类消息落盘后自动生成可读标题（纯确定性本地截断，零模型调用、零费用），支持用户手动重命名固定标题（后续消息不再覆盖）；
  - 会话列表改为默认按最近活跃时间（`updated_at DESC, id DESC`）游标分页，返回 `title` 与 `updatedAt`；
  - 新增软归档接口隐藏不再使用的对话并阻止后续写入；
  - 将 `POST /api/v1/conversations/:id/messages` 正文上限放宽至 `256 KiB`。
  - **明确非目标**：不引入额外计费的 LLM 自动起标题调用；不执行物理删除或连带删除 COS 资产。
- **C0 就绪条件与解决动作**：
  - **已确认决定**：单轮消息上限 `256 KiB`；删除采用软归档。
  - **C0 核对项**：确定标题长度边界（如 `maxTitleBytes = 120`、`fallbackMaxWords = 12`、`fallbackMaxBytes = 96`，空白折叠并去除换行）及列表游标编码格式（支持复合游标并兼容无 `after` 首页查询，核对既有测试消费者）。无外部阻塞。
- **C1 实施要点与依赖顺序**：
  1. 在 [src/conversations/schema.ts](../../../src/conversations/schema.ts) 增加幂等增量迁移：`mio_conversations` 新增 `title text`、`title_pinned boolean NOT NULL DEFAULT false`、`updated_at timestamptz NOT NULL DEFAULT now()`、`archived_at timestamptz`（旧行 `updated_at` 默认回填 `created_at`），建立 `(owner_id, updated_at DESC, id DESC) WHERE archived_at IS NULL` 部分索引，同步更新 `checkConversationSchema`。
  2. 在根 `package.json` 与对话插件接入 `@deepseek-ai/dsh-session-title`（仅使用内置确定性首条消息回退与显式 `rename`，不挂 LLM 生成器），并在 PG 元数据同步保存最新 `title` 与 `title_pinned` 以实现零 JSONL I/O 的列表查询。
  3. 在 [src/conversations/http.ts](../../../src/conversations/http.ts)、[service.ts](../../../src/conversations/service.ts) 与 [store.ts](../../../src/conversations/store.ts) 新增 `PATCH /api/v1/conversations/:id`（校验非空且不超过 120 UTF-8 字节的 `title`）与 `DELETE /api/v1/conversations/:id`（忙时返回 `409 CONVERSATION_BUSY` 或先要求取消，空闲时幂等标记 `archived_at` 并返回 `200`）；已归档会话对列表隐藏，对其发送消息或修改返回 `409 CONVERSATION_ARCHIVED`（只读历史与原请求回执按 owner 仍可核对，或按规范统一返回只读视图）；将 `messages` 路由的 `readJsonBody` 与文本字节上限调整为 `256 * 1024`。
  4. 进入 `verify` 前同步 [docs/conversations.md](../../conversations.md)、[docs/apis/conversations.md](../../apis/conversations.md) 与 [docs/integrations/postgres.md](../../integrations/postgres.md)（若涉及迁移说明）。
- **验收与接受条件**：
  - 旧表数据经 `pnpm conversations:migrate --apply` 升级后旧会话可读、`updated_at` 有效；
  - 新会话首条消息自动产生截断标题，第 2 条消息不覆盖已手动 `PATCH` 的标题；多会话交替发消息后 `GET /api/v1/conversations` 严格按最近活跃倒序分页且无漏页/重页；
  - 归档会话退出列表、重复归档幂等、发新消息被 `409 CONVERSATION_ARCHIVED` 拒绝且无模型调用，其他用户操作返回 `404`；
  - 发送 `180 KiB` 剧本文本成功受理，超过 `256 KiB` 返回 `413 BODY_TOO_LARGE`。

### 5.3 单元 M3：Token 水位计量、工具输出裁剪与漫剧自动摘要压缩

- **成果键**：`conversation-context-compaction`
- **结果与范围**：
  - 挂载确定性 Token 计量服务，向客户端公开当前会话估算的上下文占用与路由窗口容量；
  - 挂载无模型工具输出裁剪器，在压力升高时优先裁减历史大体积工具文本（如历史 `list_image_models` 返回列表），保留头尾与完整原始日志；
  - 打通 `OneLinkAdapter` 受控 `purpose: 'compaction'` 绑定，实现面向 AI 漫剧创作的自动上下文摘要压缩、收到 `CONTEXT_OVERFLOW` 时的单次自动压缩重发，以及空闲会话显式手动压缩接口 `POST /api/v1/conversations/:id/compact`；
  - 新会话使用带校验和的 `zstd` 帧压缩，既有未压缩会话保留原目录、日志及续写格式。
  - **明确非目标**：不删除或篡改原始 JSONL 历史事件；不对未声明 `contextWindow` 的路由猜测窗口大小触发自动摘要；压缩绝不跨会话或借用全局 Key。
- **C0 就绪条件与解决动作**：
  - **依赖**：M1 的 `CONTEXT_OVERFLOW` 识别与步级检查点已经人工接受，候选为 `978d72073e63272fea07b7b1b8c5fa462385b49a`。[M1 成果](complete/report.md#conversation-step-reliability-and-cache)
  - **C0 核对项**：漫剧摘要结构化保留核心世界观与时代设定、已登场角色/场景/道具档案、分集剧情推进状态、已引用的用户或生成资产 UUID `assetId`/`jobId`、画风与镜头语言约束、当前待办创作意图。取 `headroom = min(1024, floor(W * 0.1))`，输入压力达到 `max(1, min(floor(W * 0.8), W - maxOutputTokens - headroom))` 时尝试压缩，保留最近约 20% 表面节点并遵守 `toolPairingBalanced` 工具配对边界。固定版本的官方日志服务在同一根目录切换格式时拒绝打开旧日志和创建新日志。双目录的隔离验证通过并已获人工接受，原 `sessions` 负责旧会话冷读和续写，新 `sessions-zstd` 负责新会话。
- **C1 实施要点与依赖顺序**：
  1. 在根 `package.json` 显式声明 `0.2.2-rc.1` 的 `@deepseek-ai/dsh-token-meter`、`@deepseek-ai/dsh-compaction`、`@deepseek-ai/dsh-compaction-tool-result-pruner`。装配挂载计量、裁剪服务及两套官方日志后端，并按同一会话 ID 路由，重复 ID、损坏或读取故障拒绝继续。
  2. 改造 [src/dsh/onelink.ts](../../../src/dsh/onelink.ts)：允许已绑定 `ConversationRun` 的活动轮次（或显式手动压缩请求）通过 `prepareCall` / `stream` 执行 `purpose === 'compaction'` 的同模型调用，强制复用同一 `userId`、冻结路由与 `apiKey`，拒绝携带外部工具调用，并将压缩步骤的观测追加进 `model_observations`（标记辅助用途以便区分正文步骤）。
  3. 在 `src/conversations/` 与 `src/dsh/` 实现基于 `CompactionEngine` 的漫剧压缩策略及 `POST /api/v1/conversations/:id/compact`。客户端传入幂等 `requestId`，成功受理后沿现有 202、GET 回执与 SSE 结算。忙时返回 `409 CONVERSATION_BUSY`，无可用 BYOK 窗口时返回 `409 CONVERSATION_COMPACTION_UNSUPPORTED`。在 SSE `snapshot` 和可取得估算的终态 `state` 附带脱敏 `contextUsage: { estimatedTokens, contextWindow, compacted }`，窗口无依据时为 `null`。保留 `history()` 的用户、助手及已有公开工具和状态投影，内部摘要只进入模型可见上下文。
  4. 进入 `verify` 前同步 [docs/conversations.md](../../conversations.md)、[docs/apis/conversations.md](../../apis/conversations.md)、[docs/integrations/dsh.md](../../integrations/dsh.md) 与 [docs/integrations/onelink.md](../../integrations/onelink.md)。
- **验收与接受条件**：
  - 隔离小窗口路由（如 `contextWindow = 8192`）连续多轮输入长剧本设定与工具调用：验证先触发零模型调用的工具结果裁剪，继续增长后触发漫剧摘要压缩，后续轮次模型入参包含压缩摘要与近期消息且仍能准确回答第 1 轮的角色设定与图片 `assetId`；
  - 模拟同一次模型尝试在发布非空正文前收到上游明确 `CONTEXT_OVERFLOW`，验证同轮一次摘要压缩和一次重发，`model_observations` 分别记录失败、摘要与重发。重发仍超限时立即以 `MODEL_CONTEXT_OVERFLOW` 终止。
  - 模拟该次尝试发布非空正文后才收到明确超限，验证 SSE 保留已推送片段、GET 和 SSE 返回 `MODEL_CONTEXT_OVERFLOW`，该次失败后没有摘要或重发。原生失败尝试留在日志中，公开历史沿正式消息投影。前序步骤已发布的正文及本次隐藏推理不改变该判定。
  - 验证 `GET /api/v1/conversations/:id/history` 翻页仍完整返回压缩前的全部原始用户/助手消息，不泄露内部压缩提示词；
  - 用正式双目录装配验证旧 `compression: 'none'` 会话重启冷读与原格式续写、新校验和 `zstd` 会话冷读续写和 ID 冲突拒绝。验证手动压缩的权限、去重、取消与无可压缩前缀的零次出站。在常驻 `mio_dev` 用有界最小窗口配置完成一次真实模型压缩闭环观察。

### 5.4 单元 M4：会话用途模板与受控项目上下文注入（对接漫剧 D2）

- **成果键**：`conversation-purpose-and-context-injection`
- **结果与范围**：
  - 支持在创建会话时指定受控业务用途 `purpose`（默认 `'general'`，新增 `'drama-script'` 剧本创作工作区用途），生成对应的确定性 `order: 0` 系统提示词前缀；
  - 在 `ConversationService` 层提供受控内部接口与可选关联绑定，使上层业务域（如漫剧工作区）可在每轮对话执行前按 owner 权限注入有界的结构化项目上下文快照（当前剧本摘要、已确认世界观与角色设定），驱动模型围绕最新项目状态多轮创作，而公开历史与 SSE 不把内部注入快照当作用户消息展示。
  - **明确非目标**：绝不向客户端 HTTP 开放自定义 System Prompt 字符串输入；不在对话数据库复制漫剧项目表或维护剧本修订版本。
- **C0 就绪条件与解决动作**：
  - **依赖**：M1、M2 已完成或数据结构对齐；与 [漫剧 PRD](../drama-workflow/prd.md#d2--剧本工作区) 对齐 `drama-script` 提示词职责（引导分场/对白/旁白打磨、输出易于用户采纳的清晰剧本结构，同时保持防指令泄露与能力诚实声明）。
  - **C0 核对项**：确定单轮注入项目上下文快照的字节上限（定为 `64 KiB` UTF-8 文本）与 DSH 注入方式（优先使用标记内部 `source` 的 `agent.inject(...)` 或非前缀动态上下文块，确保 `order: 0` 系统提示词前缀完全固定以维持 KV-Cache 命中）。
- **C1 实施要点与依赖顺序**：
  1. 扩展 [src/conversations/prompt.ts](../../../src/conversations/prompt.ts)：支持 `purpose: 'general' | 'drama-script'` 与工具能力矩阵组合，保持纯确定性无动态时间戳/ID 输出。
  2. 扩展 `mio_conversations`（可随 M2 迁移或独立增量列 `purpose text NOT NULL DEFAULT 'general'`）与 `POST /api/v1/conversations` 可选受控 `purpose` 字段；未知 `purpose` 返回 `400 BODY_INVALID`。
  3. 在 `ConversationService` 与 [src/dsh/conversations.ts](../../../src/dsh/conversations.ts) 增加按会话注册/解析的受控上下文注入钩子（核验同一 `actor.userId` 归属），在轮次 `followup` 前通过内部来源写入项目上下文快照，并严格确保 `history()` 与 SSE 过滤内部来源消息，同时将该内部上下文纳入 M3 `token-meter` 的压力估算。
  4. 进入 `verify` 前同步 [docs/conversations.md](../../conversations.md)、[docs/apis/conversations.md](../../apis/conversations.md) 与 [docs/integrations/dsh.md](../../integrations/dsh.md)。
- **验收与接受条件**：
  - 创建 `drama-script` 会话并连续两轮更新模拟的项目剧本设定快照：第 1 轮与第 2 轮模型入参均携带最新项目设定，且两轮的系统提示词首段前缀字节完全一致；
  - `GET /history` 与实时 SSE 仅返回真实用户输入与助手回复，不包含注入的内部项目设定原文；
  - 客户端尝试传入未知 `purpose` 或超限上下文被明确拒绝。

### 5.5 单元 M5：可控深度思考（Reasoning）与实时执行进度事件

- **成果键**：`conversation-reasoning-and-progress-events`
- **结果与范围**：
  - 平台聊天路由支持显式声明深度思考能力（支持开关与允许的 `reasoningEffort` 档位）；
  - 用户在创建会话或发送单轮消息时可传入受控 `reasoningEffort`（如 `'low' | 'medium' | 'high'`），不支持思考的路由显式传参时明确拒绝；
  - SSE 实时流新增瞬态思考事件（`reasoning` 增量）与工具执行进度事件（`tool-status`：`running` / `completed` / `failed` 脱敏状态），消除模型深度思考或执行工具期间的前端等待空白；公开 `GET /history` 保持原契约不混入思考文本。
  - **明确非目标**：不向不支持推理的模型伪造思考流；不在 SSE `tool-status` 中暴露工具原始入参、`list_image_models` 内部返回或未脱敏错误原因。
- **C0 就绪条件与解决动作**：
  - **依赖**：M1 已完成。
  - **C0 核对项**：确认 [router.ts](../../../src/providers/onelink/router.ts) 的 `capabilityMetadata.reasoning` 结构（如 `{ supported: boolean, efforts?: ('low' | 'medium' | 'high')[] }`）及对应流式空闲超时政策（对显式启用 `reasoning` 的路由允许声明最高 `120_000 ms` 的 `streamIdleTimeoutMs`，普通路由仍保持 `30_000 ms`）。
- **C1 实施要点与依赖顺序**：
  1. 扩展平台聊天路由结构校验、用户模型目录视图（暴露模型是否支持 `reasoning` 及可选档位）与 `ChatRuntimeSnapshot`。
  2. 在 [src/dsh/onelink.ts](../../../src/dsh/onelink.ts) 按路由快照设置 `model.reasoning` 与 `streamIdleTimeoutMs`，放行受控 `options.reasoningEffort`；在 [src/dsh/conversations.ts](../../../src/dsh/conversations.ts) 通过 `agent.model.select` / `AgentOptions` 传入已校验的 `reasoningEffort`。
  3. 在 `conversations.ts` 监听 `agent/assistant-stream` 的 `reasoning-delta` 以及受白名单授权工具的开始/结束事件，经单帧体积与缓冲边界保护推送 SSE `event: reasoning` 与 `event: tool-status`；确认 `history()` 不输出 `reasoning` 块。
  4. 进入 `verify` 前同步 [docs/conversations.md](../../conversations.md)、[docs/apis/conversations.md](../../apis/conversations.md)、[docs/providers.md](../../providers.md) 与 [docs/integrations/onelink.md](../../integrations/onelink.md)。
- **验收与接受条件**：
  - 对未声明 `reasoning` 的路由提交 `reasoningEffort` 返回 `409 MODEL_REASONING_UNSUPPORTED` 且零上游调用；
  - 对声明支持的路由提交 `reasoningEffort`，协议替身核对出站推理参数正确、SSE 依次收到 `reasoning` 增量、`tool-status` 进度与最终 `text`/`state` 帧，且 `GET /history` 仅保留正式助手文本与 `mio.image-job` 卡片；
  - `model_observations` 准确保存上游返回的 `reasoningTokens`。

### 5.6 单元 M6：历史轮次分叉（Fork）与空闲会话受控切模

- **成果键**：`conversation-fork-and-model-switch`
- **结果与范围**：
  - 新增 `POST /api/v1/conversations/:id/forks`，支持从本人会话的任意**已结算轮次边界**（指定目标 `turnEndSeq` 或省略以取最新已结算轮次）无损分叉出一条拥有独立 `conversationId` 与新 `dshSessionId` 的新会话，完整继承该点之前的上下文历史与用途配置，原会话日志零改动，直接支撑前端“编辑某轮重问”、“重新生成上一轮回复”与“多剧情支线探索”；
  - 放开空闲就绪会话的 `PUT /api/v1/conversations/:id/model` 受控切换当前绑定模型：新轮次按新模型执行并由 DSH 记录 `model/selection`，历史已结算请求回执仍保留当时的原模型快照。
  - **明确非目标**：不允许在正在运行的半截轮次中间截断分叉；不允许跨用户分叉他人会话；不改写历史回执中的 `model_binding`。
- **C0 就绪条件与解决动作**：
  - **依赖**：M2 已完成（新分叉会话需要继承或派生标题与活跃时间，且归档会话不可被改模）。
  - **C0 核对项**：确定“含未卸载历史图片的会话切换至纯文本模型”时的冲突规则（明确返回 `409 MODEL_MODALITY_UNSUPPORTED`，除非用户分叉到无图前缀或选择支持视觉的模型，绝不静默抹除历史图片上下文）。
- **C1 实施要点与依赖顺序**：
  1. 在 [src/dsh/kernel.ts](../../../src/dsh/kernel.ts) 与 [src/dsh/conversations.ts](../../../src/dsh/conversations.ts) 封装受控 `fork(sourceDshSessionId, targetDshSessionId, upToSeq, selection)`：读取源会话已持久事件前缀，校验 `upToSeq` 精确落在已闭合的 `turn/end` 边界（拒绝 `tool/call` 未闭合或运行中尾部），通过 `ctx.agents.create({ sessionId, seed, inheritedEventCount, meta: { isSeeded: true }, agentOptions })` 建立新会话并等待 `flush` 屏障后标 `ready`。
  2. 在 `mio_conversations` 增加可选溯源元数据（如 `forked_from_conversation_id uuid`、`forked_until_seq integer`）及 `requestId` 幂等保护（同一用户、源会话与 `requestId` 重试返回同一新会话，零重复文件创建）。
  3. 调整 [src/conversations/store.ts](../../../src/conversations/store.ts#L105-L108) 的 `bind` 为受控 `selectModel`：在会话 `state === 'ready'`、无 `active_request`、未归档且新 `modelRef` 满足当前 BYOK 资格与历史模态兼容性时，更新 `mio_conversations.model_binding`，并在下一轮 `resume` 时由 `agent.model.select` 生效。
  4. 进入 `verify` 前同步 [docs/conversations.md](../../conversations.md)、[docs/apis/conversations.md](../../apis/conversations.md) 与 [docs/integrations/dsh.md](../../integrations/dsh.md)。
- **验收与接受条件**：
  - 源会话跑完 3 轮后，从第 2 轮 `turn/end` 分叉出新会话：验证新会话 `GET /history` 仅含前 2 轮内容，在新会话发送第 3 轮能准确记忆前 2 轮上下文且不知晓源会话第 3 轮内容，源会话历史不受任何影响；相同 `requestId` 重试幂等返回原分叉会话；
  - 传入非 `turn/end` 序号、他人会话 ID 或忙碌状态下的非法切模请求均按精确错误码拒绝；
  - 空闲纯文本会话从模型 A 切换到模型 B 后，新消息按模型 B 出站并记录新观察，旧请求的 `model_binding` 仍保持模型 A；含图片历史的会话切向纯文本模型被 `409 MODEL_MODALITY_UNSUPPORTED` 拦截。

## 6. 条件触发候选单元（M7：待前端或漫剧工作区定稿后展开）

以下能力同样基于 `@deepseek-ai/dsh@0.2.2-rc.1` 现成公开包，符合 AI 漫剧创作助手的产品定位，但因其公开契约强依赖前端交互形态或漫剧工作区下游接口，遵循 `DESIGN-OVER-001` 与[同源阶段规划要求](../../coordination.md#规划交付要求)，本阶段仅登记边界与启动条件，不提前冻结 HTTP 字段：

| 候选子项与底层 DSH 包                                                                          | 目标用户价值                                                                                                   | 当前暂缓依据与重新展开 C0 的触发条件                                                            |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **M7a 结构化澄清追问**<br>`@deepseek-ai/dsh-user-questions` + `@deepseek-ai/dsh-tool-ask-user` | 用户给出模糊创作意图（如“写个古风逆袭漫剧”）时，模型发出单选/多选问题卡确认集数、画风、对白/旁白模式后再落笔。 | 需新增“会话等待用户答题”的挂起/超时状态与答题提交端点，强依赖前端问答卡片交互设计定稿后展开。   |
| **M7b 回答下方建议动作卡**<br>`@deepseek-ai/dsh-action-cards`                                  | 在剧本回复末尾提供“一键采纳为新剧本修订”或“提取本集角色主体”等可选动作卡，用户点击后才触发业务写入。           | 需等 [漫剧 PRD](../drama-workflow/prd.md) D2/D3 的采纳与主体提取接口定稿后对齐动作载荷 schema。 |
| **M7c 漫剧领域创作技能按需加载**<br>`@deepseek-ai/dsh-skill` + `@deepseek-ai/dsh-tool-skill`   | 将短剧爽点结构、分镜景别规范、Seedream/Kling/Vidu 提示词技巧拆为只读技能按需加载，避免塞满基础系统提示词。     | 待 M3/M4 上线并沉淀出经真实创作验证的高复用漫剧提示词手册后再拆分，避免空搭技能框架。           |
| **M7d 助手消息评价与反馈**<br>`@deepseek-ai/dsh-message-feedback`                              | 用户对某轮剧本或分镜回复点赞/点踩并附简短原因，落入会话日志供后续质量复盘，且绝不污染模型上下文。              | 待产品或运营明确需要收集对话质量反馈面板时展开。                                                |

## 7. 公共规范同步与验证总约束

1. **规范与代码同候选演进**：本 PRD 在评审期间不提前改写现行规范；M1–M6 各单元实施时，必须在进入各自 `C1_EVIDENCE_PENDING`（`verify`）之前，将本单元实际落地的 HTTP 字段、错误码、持久化结构、恢复边界与 DSH 包约束同步写入 [本地对话服务](../../conversations.md)、[对话 HTTP 契约](../../apis/conversations.md)、[供应商配置](../../providers.md)、[DSH 集成](../../integrations/dsh.md) 及 [OneLink 集成](../../integrations/onelink.md) 等受影响权威规范，并在 `norms-review` 中完成三方对账。
2. **源码护栏与依赖检查**：任何新增生产文件必须落入 `harness.config.json` 已分类范围并通过 `pnpm check:static`；所有框架包与 `@earendil-works/pi-ai` 导入严格限制在 `src/plugin.ts` 与 `src/dsh/` 内，纯业务层（`src/conversations/`、`src/providers/`）保持框架无关，并执行 `quality-review` 核查算法复杂度、未使用导出与已有基础原语（`@mio/foundation/*`）复用。
3. **分层验证与常驻环境纪律**：
   - **离线确定性回归**：并发、幂等、故障注入、跨存储异常、越权拦截、提示词前缀字节稳定性、工具预算与重启冷读全部通过 `tests/conversations/`、`tests/onelink/`、`tests/foundation/` 在隔离回归通道（`mio_regression_test` 随机 schema、临时 `DSH_HOME` 与受控协议替身）验证，严禁在自动化回归中读取 `mio_dev` 凭据或联网，交付前须取得覆盖 `pnpm check` 的有效结论与打包产物 `pnpm test:smoke` 通过证据。
   - **常驻 `mio_dev` 有界真实验证**：涉及真实供应商协议行为（如 M1 缓存标记兼容性、M3 真实模型摘要压缩、M5 真实推理模型 `reasoning-delta` 流式观察）时，按[常驻环境规范](../../local-environments.md#自动化回归与人工数据)在 `mio_dev` 使用既有加密凭据执行单次有界、最小规格调用并保留实际观察记录；确定性替身通过不冒充真实模型已验证，单项能力接受不外推整份 PRD 已完成。
