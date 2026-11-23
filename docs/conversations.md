# 本地对话服务

本地服务只接收测试账号和测试内容。生产部署验收仍待完成。接受范围、候选和限制见[原对话成果](tasks/conversation-service/complete/report.md)及[多轮增强成果](tasks/conversation-enhancement/complete/report.md)，真实文本观察按实际候选和协议分别记录。真实用户内容保留、物理清除与上线容量另定。需求与开发安排见[对话 PRD](tasks/conversation-service/prd.md)和[对话增强 PRD](tasks/conversation-enhancement/prd.md)，公开协议见[对话 HTTP](apis/conversations.md)。

## 配置与迁移

认证沿[认证底座](auth.md)，元数据使用独立池和显式的 `MIO_CONVERSATIONS_DATABASE_URL`，可指向同一专用 PostgreSQL/schema，但不借用认证内部池、表或登录会话 ID。原生内容沿 [DSH 契约](integrations/dsh.md)保存在独立 `DSH_HOME`。两处数据须成对保留和恢复。

[常驻开发/测试入口](local-environments.md)将 DSH home 分别放在 `.runtime/dev/dsh` 和 `.runtime/test/dsh`，原生会话目录不共用；对话域仍需在所选环境文件显式配置，并执行对应 `migrate:dev conversations --apply` 或 `migrate:test conversations --apply`，不会因部署数据库自动启用。

| 配置                              | 行为                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MIO_CONVERSATIONS_DATABASE_URL`  | 显式 PostgreSQL URL；未设置时保留无对话数据库的 foundation 路径；设置时必须有完整认证与 DSH 内核 |
| `MIO_MODEL_PROVIDER`、`MIO_MODEL` | 未启用 provider 域时的显式 legacy 固定路由，必须同时设置；BYOK 不使用或回退这些值                |
| `MIO_MODEL_API_KEY`               | 仅 DeepSeek 官方适配器从启动环境读取；启用其路由必须设置，不写入公共文件或响应                   |

未启用 provider 域时保留 legacy：没有 provider/model 仍可创建/查询，发送返回 `503 MODEL_UNAVAILABLE` 且不新增接收记录；未注册 provider 拒绝，不支持的 model 沿原驱动结算失败。启用[用户供应商域](providers.md)后公共对话统一使用 BYOK，当前用户缺配置不回退全局或他人 Key；同时存在的 legacy 环境不参与选模或缺配校验。已绑定 BYOK 的会话不能在 legacy 装配下改跑全局模型。已有请求 ID 始终先查询/去重。

BYOK 创建使用本人动态目录的稳定 modelRef 或显式 chat 用途默认，不套旧目录默认或测试型号。当前凭据有效成功成员、启用状态及已启用平台模型路由（`mio_provider_model_routes`）共同决定资格；缺目录、被移除、认证拒绝、待适配和默认失效分别拒绝。逻辑模型/配置冻结，不开放会话内切换；旧分类引用无损映射到同一 raw ID，旧无绑定会话可读历史，下一次新发送前由 owner 一次绑定。元数据、创建及绑定不解密或联网，fresh 接收从一条 SQL 一致读取本人配置、成员、受成员门控的平台路由与用途偏好，再解密。该读取是刷新/轮换/停用的 admission 线性化点；已取得快照的运行继续原版本，后来的请求核对新状态，不能随默认变化换模型。未知 supplier context 在外层 DSH 省略；出站 `submitPath` 由路由受控提供并校验安全相对路径（`openai-chat` 为 `/v1/.../chat/completions`，`anthropic-messages` 为 `/v1/messages`），单轮输出上限取路由 `maxOutputTokens`（`1..65536`，未声明时沿用 Mio 默认 1024 tokens 政策）。HTTP 响应等待与流空闲默认 30 秒，显式支持推理的路由可声明到 120 秒。不支持的内容或选项在出站前拒绝。

平台聊天路由的 `cacheRetention` 随本轮适配快照冻结。Anthropic Messages 默认发送短期缓存标记，OpenAI Chat Completions 由上游处理自动前缀缓存。系统提示词的能力组合与历史前缀保持一致时，实际缓存读写仍取决于供应商与本轮输入，按实际返回用量观察。[供应商配置](providers.md#受控适配声明与实际验证)

真实文本验证使用独立进程与本人 Key，执行前核对实际测试范围和费用授权；普通检查不自动收费，文本授权不扩大媒体范围。token 观察沿用固定 DSH 的计数口径。`inputTokens` 为未计入缓存读写的输入，缓存读写分别记为 `cacheReadTokens` 和 `cacheWriteTokens`。可取得的 `totalTokens` 和供应商明确返回的 `reasoningTokens` 原样保存，包含明确报告的零。观察层不重算计数，`outputTokens` 继续使用原汇总口径。一次正常调用如果只报告缓存用量，也记为 `reported`。失败或取消且仅观察到思考用量时，保存该数字，省略未知输入及输出计数，记为 `partial`。其他失败或取消时，已有非零计数记为 `partial`，全零或缺失记为 `unknown`。取消不保证上游立即停止、退款或费用回滚。服务未提供生产容量或计费总预算保证。

```sh
pnpm migrate:dev conversations
pnpm migrate:dev conversations --apply
pnpm build
pnpm start:dev
```

第一条只展示 SQL，第二条才执行迁移。新版本启动前需显式执行新迁移，启动只读检查列。先停止旧实例、审阅计划并按目标库责任备份。输出截断迁移新增可空 `truncation_reason`，现有回执继续按原状态和错误码读取。生命周期增量为旧行用 `created_at` 回填 `updated_at`，标题初始为空且未固定，旧会话继续可读。用途增量列为 `purpose text NOT NULL DEFAULT 'general'`，已有会话按通用用途继续使用。两种列表顺序均保留独立的归属索引。共享数据库约束见[PostgreSQL](integrations/postgres.md)。

## 会话用途与项目上下文

创建时固定为通用 `general` 或剧本创作 `drama-script`。用途与已授权的工具能力决定固定系统提示词。剧本创作模板引导分场、对白与旁白打磨。相同用途和工具能力下，项目设定更新不会改变本轮系统提示词前缀的字节。

可信服务端业务模块可在同一 Cordis 作用域提供 `mioConversationProjectContext` 读取器。它接收 `{ownerId, conversationId, signal}`，按这两个标识从业务域自己的关联中读取最新设定，返回 `{ownerId, conversationId, snapshot}` 或表示未关联的 `null`。对话服务核对返回的两个标识。读取器在接收事务持有当前会话行锁时执行，只查询业务域自身的数据，须按有界范围读取并响应退出信号。关联和剧本修订存于业务域。

剧本用途的每个新请求在通过归属、原回执去重和接收检查后读取快照。快照接受可选的 `scriptSummary` 字符串、`worldbuilding` 字符串和 `characters` 字符串数组。编码后的快照 JSON 最多 64 KiB UTF-8，包含转义和结构字符。读取器未装配或返回未关联时正常执行剧本用途。读取失败、归属不符、格式无效或超限时拒绝接收，原 requestId 可以重试。已受理请求的回执重放不重新读取项目。

有效快照参与本轮的模型上下文预算。对话 PostgreSQL 元数据和回执不存项目快照。DSH 私有原生日志可能保留内部输入，访问随会话日志保护。公开历史、实时事件和自动标题只投影原有允许来源，助手正文按模型实际输出传递。[DSH 集成](integrations/dsh.md)

## 深度思考与实时工具进度

创建会话时，可以从当前聊天路由列出的档位中选取 `reasoningEffort` 作为缺省值。显式选定值保存到新增可空列 `mio_conversations.reasoning_effort`，旧行为空。对话列表、创建及元数据响应返回已设置的缺省值。发送消息可为该轮覆盖。两处都省略时，沿用所选驱动的默认请求行为。

接收新消息时，在归属行锁内用当前路由快照验证生效档位。缺少支持声明或明确档位时返回 `409 MODEL_REASONING_UNSUPPORTED`，发生在受理和模型派发前。已受理的请求使用冻结的路由、能力、超时和档位完成本轮。同一 requestId 与相同客户端输入首先返回原回执。显式单轮覆盖计入摘要，使用 `reasoning:v1:` 加 `SHA256(JSON.stringify([text, orderedIds, reasoningEffort]))`。省略单轮档位的文本与视觉摘要沿用原算法，既有请求可按原输入重放查询。请求 `model_binding` 仅在有生效档位时保存 `reasoningEffort` 作为内部审计字段。

公开 SSE 的 `reasoning` 承载声明支持推理的路由实际发出的思考增量。轮次执行已授权工具时，`tool-status` 只投影工具名与脱敏的开始或完成状态。SSE 订阅、快照交接和背压仍使用有界资源；重连用原回执和正式历史恢复。原生 DSH 日志按私有会话规则保留思考块。公开历史保留正式助手正文、有效图片任务卡片和原有状态投影。[对话 HTTP](apis/conversations.md#get-apiv1conversationsidevents)

## 归属、接收与持久化

应用服务接收认证解析的 `{userId,sessionId}`，每次经 owner 条件查对话。客户端不能自授 owner、DSH ID 或工具权限。conversationId、登录 sessionId 和内部 dshSessionId 各有职责，不混用。

PostgreSQL 保存归属、创建状态、request ID、请求摘要与接收/结算状态，正文以 DSH 原生日志为权威。消息使用内容摘要，手动压缩在同一 request ID 命名空间使用独立操作标记。先保存 creating 映射，再创建并 flush 原生 Session，最后标 ready；失败映射保持 unknown，可从所属用户列表定位，不伪报已持久创建。

模型出站前、顶层工具执行前及进入下一步之前，必须确认相应原生日志前缀已落盘。有效图片任务结果先补充 flush，再向 SSE 发布卡片，下一步等待这个检查点。检查点失败后阻止该轮尚未开始的工具或模型派发，按未知结算。冷读可以恢复已落盘的卡片和文本。生图提交和 DSH 日志分属不同持久层，任务已受理但结果尚未形成或落盘时，卡片可能缺失。恢复沿原对话和请求身份查询，服务不重放输入、工具或计费调用。[DSH 集成](integrations/dsh.md#必须遵守的约束)

显式增量迁移保留可空对话模型绑定、可空请求绑定和观察数组；旧行不从环境回填、不删除旧回执。fresh 请求保存配置 ID/revision、modelKey、精确 modelRef/modelId、credentialVersion/catalogVersion/adaptationVersion（取平台路由 `declaration_version`）、operation/profile，兼容保留 protocol/capabilityVersion；owner/内部 Session 沿对话取得。Key 只在运行内存，不能序列化整个快照。多步工具轮次（如 `tool-calls -> stop`）按步向 `model_observations` 追加受控 HTTP status、provider request ID、token usage/已知程度、finish 和稳定 failureCode。模型错误结算取本轮最后一步已持久观察的有效分类，或官方轮次终态中的已知错误码，使用公开脱敏码。无法细分的明确失败沿用 `MODEL_FAILED`，历史回执继续按原错误码读取。观察落库失败结算 unknown。普通上游故障不会自动重发计费模型请求。[对话回执](apis/conversations.md#get-apiv1conversationsidrequestsrequestid)

仅当正文调用达到 `status === 200` 且 `finish` 为 `stop` 或 `max-tokens` 时，才把该用户本人 `mio_provider_model_verifications` 在对应当前 `(config_id, model_key, credential_version, catalog_version, declaration_version)` 元组下标记为 `verified`，不改动平台路由或他人验证状态，旧运行晚到不能覆盖新验证。独立供应商验证标记失败保留已持久请求观察。

当 BYOK、`assets` 与显式启用的 A `generations` 同时就绪时，插件向对话引擎注入窄桥接 `ConversationImageTools`（对话契约层不导入 DSH 或生成模块内部实现），仅在活动轮次的 `agentCtx.tools` 开放三个受控意图级生图工具：只读不解密的 `list_image_models`、异步/同步非阻塞受理的 `submit_image_job`（自动为 `requiresAsync: true` 路由补齐 `async: true`，按路由 `supportedOperations` 与 `allowGenerateReferences` 归一化参考图操作模式，并以 `sha256Utf8("mio:conv-image:v1:${userId}:${conversationId}:${turnRequestId}:${clientOperationKey ?? exec.callId}")` 派生确定性 UUID v4 `requestId` 交 `GenerationService.createImage` 幂等去重）以及先经 `isUuidV4` 校验的 `get_image_job`。工具严禁接收 `apiKey`、`userId`、裸 URL、Base64、COS 键或未知字段，单轮受 12 次总调用、4 次图片提交与 8 步硬熔断（`TURN_STEP_BUDGET_EXCEEDED`）约束；单轮内对尚未达到终态（`accepted`、`submitted`、`processing`、`materializing`）的同轮新建任务或本轮已查得非终态的同任务重复调用 `get_image_job` 会被以 `IMAGE_JOB_POLL_DEFERRED` 拦截（不产生重复卡片），跨轮对前序 `jobId` 的首次查询语义保持不变；轮次结束或卸载立即撤销工具授权。历史与 SSE 仅对非错误且通过严格结构校验的 `mio.image-job` 卡片做白名单投影。

DSH 在连续两次、四次调用同一工具且参数相同时分别向模型提醒和加强提醒，异参调用仍按原工具授权与预算执行。启用图片查看时，`inspect_image_asset` 使用 60 秒协作期限，包含图像准备队列等待，并通过原有取消信号等待工具收敛。图片任务提交沿用提交前取消及现有存储和上游期限，避免在受理已提交后丢失任务句柄。[DSH 集成](integrations/dsh.md#必须遵守的约束)

图片工具提交会先按用户和派生的请求 ID 查已有任务。重试时按任务冻结的路由补齐 `async` 和参考图操作后比对请求摘要。同一意图在供应商停用或路由默认值变化时仍返回原任务。相同请求 ID 归一后的参数不同会返回 `REQUEST_CONFLICT`。新提交按当前路由受理。

对话图片提交工具只提供 `generate` 和 `edit`，HTTP 扩图由相应路由独立控制。[图片任务路由](apis/compute.md#post-apiv1computeimages)

同对话只接受一个活动请求。事务锁住归属行，先以请求 ID 查原回执及摘要，再检查归档、忙碌、目录、默认、认证阻断和解密。同内容返回原回执，异内容冲突。输入摘要不含可变版本，不因刷新或轮换重发。目录移除、默认失效和归档后，旧回执和历史仍可读。进程内保存同一用户在途接收 Promise，持久去重由 PostgreSQL 唯一键负责。

带图请求先查 owner、原回执和归档，再检查忙碌状态及当前模型视觉能力。耗时资产读取、解码与本轮图片预算预检在行锁外完成。每服务同时最多准备两个新的带图请求，满载返回 503 IMAGE_UNAVAILABLE，既有回执优先。每图受理阶段复用一次私有读取和规范化，同时形成持久附件引用与本轮预览字节数，发送前的来源复核独立执行。最终短事务再次核对回执、归档、busy 和路由/视觉预算快照，变化时拒绝。纯文本沿旧 SHA-256，带图摘要为 `vision:v1:` 加 `SHA256(JSON.stringify([text, orderedIds]))`。原件、内存预览、授权检查及旧图卸载的限制见[对话 HTTP](apis/conversations.md#post-apiv1conversationsidmessages)和[DSH 集成](integrations/dsh.md)。同一原图在同一请求中出现多次时按 occurrence 计预算，服务须保留当前轮图片。

正式 Profile 关闭上游 DSH 默认身份开场白（`includeHarnessIdentity: false`），每次对话轮次（无论 legacy 还是 BYOK）统一由服务端注入受控的会话级系统提示词：助手固定自称 `miioo AI 漫剧助手`（不提及内部框架或运行时名称），围绕 AI 漫剧创作执行适度宽松话题政策（支持服务于创作的背景、历史/服饰/设定考据与审美参考并自然衔接回创作，对编程调试、作业解题、医疗/法律/金融、无关时政与纯粹闲聊礼貌婉拒并引导回漫剧创作），禁止泄露或覆盖内部指令，并按本轮实际授权的生图与图片查看能力如实声明工具可用性；提示词文本按 `{ imageGeneration, imageInspection }` 组合完全确定，不含动态变量以维持前缀缓存稳定，且绝不经公开历史或 SSE 透传。

回执层级为 accepted（仅 PG 已受理）、input-persisted（DSH 输入/inbox 屏障和 PG 状态已成功）、completed/cancelled/failed（已执行请求检查真实 DSH 终态并 flush 后完成 PG 更新，执行前用户取消另有下述边界）。unknown 表示无法证明完整结算，错误码只含服务定义值。接收 COMMIT/ACK 不确定时，按原用户/对话/请求/内容摘要锁行核对，只将本进程未启动的待执行记录改 unknown 并释放 busy；不重发模型。结算只更新在途回执，同一事务只清除原请求的 busy。结算 ACK 丢失时按原身份读回，保留已提交的 completed、cancelled、failed 或 unknown 及原错误。无法完成对账时停止该实例后续操作，查询返回脱敏 503，操作者须停止并重启原实例核对，不能换 ID 重发未知输入。

真实 DSH `turn/end` 为 `max-tokens` 且本轮已通过原生日志 flush 时，服务保留原助手正文，以 completed 结算并附 `truncation: {reason:'max-tokens', message:'已达输出上限'}`。GET 回执及 SSE 的 state 和 snapshot 使用同一持久标记。热读和冷读历史从已持久的原生轮次末尾返回同一标记，正文项保持原文。旧回执保留 PG 原值，旧原生日志能证明输出截断时历史仍可展示该状态。供应商单步观察、取消、网络错误或进程中断均不能为回执提供截断依据。服务不因此续写或重发模型。

取消绑定本次 active request ID；包括 PG 已受理但 adapter 尚未登记的窗口。取消回执只是 requested，实际 cancelled/其他结算通过原请求查询；延迟取消不能取消下一条请求。

如果 Agent 尚在打开，首次生效的终止意图固定：先收到用户取消则不提交输入、结算 cancelled；先开始关闭则不提交输入、结算 unknown，后到取消不能改写关闭原因。Agent 已开始执行时仍以实际持久终态判断，不能把未取得的终态冒充用户取消。

## 上下文计量与压缩

确定性计量根据模型可见上下文估算 token。SSE 首帧与结算帧公开估算值、已知路由窗口及是否存在内部摘要检查点。BYOK 首帧读取 owner 的当前适用路由声明，结算帧采用本次请求受理时冻结的窗口。窗口缺少依据时为 `null`。估算从本地原生状态取得，窗口查询只读取元数据。关闭或断开流时取消当前原生读取。活跃订阅共享同一次结算估算，回执按既有持久化屏障发布。

工具结果先在本轮模型投影内裁剪，保留原生结果及公开历史。高水位摘要复用本轮同一 owner、冻结 BYOK 路由及凭据，保留近期上下文和工具配对，以漫剧世界观、角色、场景、道具、分集进度、画风、镜头语言、待办与资产标识接续。未声明窗口的路由只能做无模型裁剪。摘要不携带工具或二进制附件，成功持久化摘要检查点后才使用压缩表面。公开历史仍从原始事件投影。

摘要使用同一路由窗口内可容纳的前缀。单条原始历史已超过摘要输入预算且没有可用前缀时，服务保留原始记录和本次实际结算，跳过该次摘要。也不会把一条不可容纳的历史拆为多次计费摘要。

同一轮自动摘要最多一次。在出错的模型尝试发布非空正文前收到上游明确超限时，可执行一次摘要和一次正文重发。按实际出站向原请求分别追加首次正文失败、标有 `purpose: 'compaction'` 的摘要，以及正文重发观察。重发仍超限时以 `MODEL_CONTEXT_OVERFLOW` 结算。

若报错的模型尝试已通过 SSE 发布非空正文，保留流上已推送的片段并直接以 `MODEL_CONTEXT_OVERFLOW` 结算，无后续摘要或正文重发。是否发布过正文只取决于该次尝试的公开 text，前序步骤和思考增量不参与判定。原生日志保留失败尝试，公开历史沿既有规则投影正式助手消息。普通上游错误、未知结果或压缩检查点未确认时保留实际回执。

手动压缩沿同一 PG 接收、占用、取消、恢复及回执流程。fresh 请求需要空闲、未归档的 owner 会话及当前有窗口的 BYOK 路由。空范围可直接完成；已受理记录沿原 ID 读取。手动压缩使用自身请求的观察数组，标题和活跃时间由真实人类输入继续维护。[手动压缩 API](apis/conversations.md#post-apiv1conversationsidcompact)

原 `DSH_HOME/sessions` 中的未压缩会话在原目录冷读和续写；新会话在并列 `DSH_HOME/sessions-zstd` 使用带校验和的 zstd 帧。备份、恢复和归档保留完整两套原生目录及 PG 映射。重复会话 ID 或无法安全读取任一匹配日志时拒绝继续。[DSH 存储约定](integrations/dsh.md)

## 标题、活跃度与归档

官方 DSH 标题逻辑使用首条已持久化的真实人类消息，折叠空白并截取最多 12 个词和 96 个 UTF-8 字节。确定性截断不调用模型。创建时的标题为 null。原生持久化确认后，在 PG 将候选写入尚未设置且未固定的标题字段，并以真实人类消息事件时间推进 `updated_at`。inbox 已持久的接收回执仍在原屏障发布。读取、重放和手工改名均沿用原活跃度。

PG 活跃投影首写失败时，已受理的模型轮次继续，服务在结算释放活动请求前用同一已落盘人类消息的时间与标题补写一次。持续失败或进程提前退出时，列表显示 PG 当前值，回执按原有轮次结算和恢复规则处理。同 ID 重放仍读原回执，后续仍未归档时，下一条真实人类输入可从原生日志补投影未固定的首标题，并按新输入时间推进活跃度。

手工改名固定标题。PG 归属行锁内先保存官方规范化后的原生标题，再写 PG 的 `title` 和 `title_pinned`。原生和 PG 写入有各自的持久化边界。遇到故障时，未归档会话可重试同一改名以同步 PG，历史和旧回执保持可读。后续真实人类输入仍推进活跃度，已固定的标题保持原值。

归档在同一归属行锁下核对创建和活动请求状态，原子写入 `archived_at`。它隐藏常规列表项并阻止新消息和变更，保留原生历史、审计回执与资产引用。重复归档读回首次时间，同摘要重放读回原回执。常规列表按归属、活跃时间和 UUID 使用有界索引读取，旧 UUID 游标兼容到客户端重新从首页请求。

## 实例与生命周期

每个本地 metadata schema 和 DSH_HOME 只运行一个实例。服务持有专用 PG advisory lock 连接，先取得锁再把旧 accepted/input-persisted 记录改 unknown、清理 busy；第二实例拒绝启动。持锁连接丢失后拒绝新操作，不自动重新取得锁、重放输入或恢复收费调用。操作者仍须确认旧进程和原生 writer 已停，再启动新实例；PG 租约不构成跨存储 fencing 或分布式部署协议。

普通元数据池最多 5 个连接，其中一个持有租约；连接、SQL 和查询等待上限各 5 秒。关闭先停止入口与流，等待已进入接收/创建的操作，取消并收敛全部 Agent/原生写入，再加入所有回执更新，最后关闭 PG 池。一个 Agent 打开失败不能跳过其他所有者清理；关闭失败保留错误。硬中断后保留已持久前缀，未结算 chunk 可能不存在；离线历史显示 interrupted，不自动续跑。

在途历史读取同样参与关闭排空；官方图片卸载投影必须保留到会话及读取结束。已开始执行的运行若没有可证明的 turn/end，回执为 unknown，冷读按 DSH 已持久前缀展示 interrupted。正式 Profile 的薄入口等待内核就绪，原 `@mio/plugin` 独立装载不增加内核前置。

断网只释放订阅，已受理轮次继续。登录过期/撤销后新操作拒绝；SSE 每秒重新验证同一登录会话，失败时发送脱敏错误并关闭，已受理轮次可完成。legacy 固定路由变化在下一次 setup model.select 生效；BYOK 始终恢复冻结的逻辑模型和 fresh 快照，不跟随默认项变化。关闭必须先等待对话 admissions/run 排空（含在途生图工具调用），再关闭 `generations`；即使排空或 generations 关闭失败，也须继续释放 `providers` 池并保留 `AggregateError`。`compute` 清理单独加入对话排空后再执行，不能只靠 effect 注册顺序。

## 验证及限制

`tests/conversations/conversations.test.ts` 经真实认证、PG、官方 loop、JSONL 和 HTTP/SSE 验证归属、多轮、忙时/去重、故障回执、订阅窗口、失效登录及断网；`tests/conversations/prompt.test.ts` 与 `tests/conversations/conversations-engine.test.ts` 验证平台系统提示词规则、四种工具能力组合、确定性输出、legacy/BYOK 会话注入、多轮前缀稳定与字面量 `{{...}}` 安全，以及多所有者异常关闭和无文本取消；`tests/conversations/conversations-profile.test.ts` 验证打包后的正式 Profile（含移除上游 `DeepSeek Harness` 开场白、注入 `miioo AI 漫剧助手` 且公开历史不外泄系统提示）、多轮、正常重启及 SIGKILL；`tests/conversations/conversation-image-tools.test.ts` 经 A 内的 generations、隔离 PG、受控上游与 COS 替身、官方 loop、真实 JSONL 与正式打包 Profile，在不启动 B 和图片 MQ 的条件下验证多轮生图/改图工具闭环、权限隔离、注入拦截、预算/步数熔断、幂等去重、取消与重启恢复。测试模型只安装在临时 Profile overlay，另有完全不含该 overlay 的正式装配验证，生产包不含测试夹具。

`tests/onelink/` 经公开 PiAi codec、官方 loop、隔离 PG/JSONL 和正式打包 Profile 验证 BYOK；overlay 只替换固定出站 fetch，不替换生产 adapter，并验证源码目录外的虚构精确 ID。`node tests/conversations/conversations-live.ts <authorized-private-key-file> [exact-model-id] [openai-chat|anthropic-messages]` 是显式真实入口，默认 deepseek-v4.1-flash/openai-chat。模型须精确存在于本账号当前目录，再经受控声明与用户默认、公开 API 完成两轮、SSE/终态、取消、历史和重启，输出对应目录/适配版本；失败保留实际观察，不回退模拟或目录外型号。当前验证目标与后续条件沿 PRD，已有接受按所属成果保留，不由新候选改写。

精确历史仍完整读取和校验单会话日志，公开分页限制返回体。回执按复合主键读取。生产吞吐、崩溃丢失上限和各模型可用性须分别验证。完整检查、独立审阅、真实供应商与人类接受分别判定。
