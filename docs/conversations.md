# 本地对话服务

本地服务只接收测试账号和测试内容；实际接受范围、候选和已披露限制见[成果入口](tasks/conversation-service/complete/report.md)，尚无生产部署验收。真实文本观察按实际候选和协议分别记录，未验证目标不能展示为已验证。真实用户内容保留/删除与上线容量另定；没有删除接口不代表无限保留授权。需求、开发安排与接受条件见[对话 PRD](tasks/conversation-service/prd.md)，公开协议见[对话 HTTP](apis/conversations.md)。

## 配置与迁移

认证沿[认证底座](auth.md)，元数据使用独立池和显式的 `MIO_CONVERSATIONS_DATABASE_URL`，可指向同一专用 PostgreSQL/schema，但不借用认证内部池、表或登录会话 ID。原生内容沿 [DSH 契约](integrations/dsh.md)保存在独立 `DSH_HOME`。两处数据须成对保留和恢复。

[常驻开发/测试入口](local-environments.md)将 DSH home 分别放在 `.runtime/dev/dsh` 和 `.runtime/test/dsh`，原生会话目录不共用；对话域仍需在所选环境文件显式配置，并执行对应 `migrate:dev conversations --apply` 或 `migrate:test conversations --apply`，不会因部署数据库自动启用。

| 配置                              | 行为                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MIO_CONVERSATIONS_DATABASE_URL`  | 显式 PostgreSQL URL；未设置时保留无对话数据库的 foundation 路径；设置时必须有完整认证与 DSH 内核 |
| `MIO_MODEL_PROVIDER`、`MIO_MODEL` | 未启用 provider 域时的显式 legacy 固定路由，必须同时设置；BYOK 不使用或回退这些值                |
| `MIO_MODEL_API_KEY`               | 仅 DeepSeek 官方适配器从启动环境读取；启用其路由必须设置，不写入公共文件或响应                   |

未启用 provider 域时保留 legacy：没有 provider/model 仍可创建/查询，发送返回 `503 MODEL_UNAVAILABLE` 且不新增接收记录；未注册 provider 拒绝，不支持的 model 沿原驱动结算失败。启用[用户供应商域](providers.md)后公共对话统一使用 BYOK，当前用户缺配置不回退全局或他人 Key；同时存在的 legacy 环境不参与选模或缺配校验。已绑定 BYOK 的会话不能在 legacy 装配下改跑全局模型。已有请求 ID 始终先查询/去重。

BYOK 创建使用本人动态目录的稳定 modelRef 或显式 chat 用途默认，不套旧目录默认或测试型号。当前凭据有效成功成员、启用状态及已启用平台模型路由（`mio_provider_model_routes`）共同决定资格；缺目录、被移除、认证拒绝、待适配和默认失效分别拒绝。逻辑模型/配置冻结，不开放会话内切换；旧分类引用无损映射到同一 raw ID，旧无绑定会话可读历史，下一次新发送前由 owner 一次绑定。元数据、创建及绑定不解密或联网，fresh 接收从一条 SQL 一致读取本人配置、成员、受成员门控的平台路由与用途偏好，再解密。该读取是刷新/轮换/停用的 admission 线性化点；已取得快照的运行继续原版本，后来的请求核对新状态，不能随默认变化换模型。未知 supplier context 在外层 DSH 省略；出站 `submitPath` 由路由受控提供并校验安全相对路径（`openai-chat` 为 `/v1/.../chat/completions`，`anthropic-messages` 为 `/v1/messages`），单轮输出上限取路由 `maxOutputTokens`（`1..65536`，未声明时沿用 Mio 默认 1024 tokens 政策），30 秒 idle/HTTP 是 Mio 政策。不支持的内容/选项在出站前拒绝。

真实文本验证使用独立进程与本人 Key，执行前核对实际测试范围和费用授权；普通检查不自动收费，文本授权不扩大媒体范围。token 观察不等于费用结算；全零/缺失 SDK usage 保持 unknown，失败时的非零 usage 只是 partial。取消不保证上游立即停止、退款或费用回滚。服务未提供生产容量或计费总预算保证。

```sh
pnpm migrate:dev conversations
pnpm migrate:dev conversations --apply
pnpm build
pnpm start:dev
```

第一条只展示 SQL，第二条才建表/索引；普通启动只读检查列，不自动建表。先停止旧实例、审阅计划并按目标库责任备份，再显式迁移；本期迁移没有破坏性改名/删除或自动回滚。共享数据库约束沿 [PostgreSQL](integrations/postgres.md)。

## 归属、接收与持久化

应用服务接收认证解析的 `{userId,sessionId}`，每次经 owner 条件查对话。客户端不能自授 owner、DSH ID 或工具权限。conversationId、登录 sessionId 和内部 dshSessionId 各有职责，不混用。

PostgreSQL 保存归属、创建状态、request ID、输入 SHA-256 摘要与接收/结算状态，不保存第二份消息正文；正文以 DSH 原生日志为权威。先保存 creating 映射，再创建并 flush 原生 Session，最后标 ready；失败映射保持 unknown，可从所属用户列表定位，不伪报已持久创建。

显式增量迁移保留可空对话模型绑定、可空请求绑定和观察数组；旧行不从环境回填、不删除旧回执。fresh 请求保存配置 ID/revision、modelKey、精确 modelRef/modelId、credentialVersion/catalogVersion/adaptationVersion（取平台路由 `declaration_version`）、operation/profile，兼容保留 protocol/capabilityVersion；owner/内部 Session 沿对话取得。Key 只在运行内存，不能序列化整个快照。多步工具轮次（如 `tool-calls -> stop`）按步向 `model_observations` 追加受控 HTTP status、provider request ID、token usage/已知程度、finish 和稳定 failureCode；401/403、402、408/504、429 分别区分鉴权、额度、超时、限流，不能分类的失败保持 unknown。请求观察落库失败结算 unknown；独立供应商验证标记失败保留已持久请求观察，不重发模型。仅当步骤达到 `status === 200` 且 `finish` 为 `stop` 或 `max-tokens` 时，才把该用户本人 `mio_provider_model_verifications` 在对应当前 `(config_id, model_key, credential_version, catalog_version, declaration_version)` 元组下标记为 `verified`，不改动平台路由或他人验证状态，旧运行晚到不能覆盖新验证。

当 BYOK、`assets` 与显式启用的 A `generations` 同时就绪时，插件向对话引擎注入窄桥接 `ConversationImageTools`（对话契约层不导入 DSH 或生成模块内部实现），仅在活动轮次的 `agentCtx.tools` 开放三个受控意图级生图工具：只读不解密的 `list_image_models`、异步/同步非阻塞受理的 `submit_image_job`（自动为 `requiresAsync: true` 路由补齐 `async: true`，按路由 `supportedOperations` 与 `allowGenerateReferences` 归一化参考图操作模式，并以 `sha256Utf8("mio:conv-image:v1:${userId}:${conversationId}:${turnRequestId}:${clientOperationKey ?? exec.callId}")` 派生确定性 UUID v4 `requestId` 交 `GenerationService.createImage` 幂等去重）以及先经 `isUuidV4` 校验的 `get_image_job`。工具严禁接收 `apiKey`、`userId`、裸 URL、Base64、COS 键或未知字段，单轮受 12 次总调用、4 次图片提交与 8 步硬熔断（`TURN_STEP_BUDGET_EXCEEDED`）约束；单轮内对尚未达到终态（`accepted`、`submitted`、`processing`、`materializing`）的同轮新建任务或本轮已查得非终态的同任务重复调用 `get_image_job` 会被以 `IMAGE_JOB_POLL_DEFERRED` 拦截（不产生重复卡片），跨轮对前序 `jobId` 的首次查询语义保持不变；轮次结束或卸载立即撤销工具授权。历史与 SSE 仅对非错误且通过严格结构校验的 `mio.image-job` 卡片做白名单投影。

图片工具提交会先按用户和派生的请求 ID 查已有任务。重试时按任务冻结的路由补齐 `async` 和参考图操作后比对请求摘要。同一意图在供应商停用或路由默认值变化时仍返回原任务。相同请求 ID 归一后的参数不同会返回 `REQUEST_CONFLICT`。新提交按当前路由受理。

同对话只接受一个活动请求。事务锁住归属行，先查原 request ID：同内容返回原回执，异内容冲突，早于当前目录、默认、认证阻断和解密；不同 ID 遇忙拒绝。输入摘要不含可变版本，不因刷新/轮换重发。目录移除或默认失效后旧回执/历史仍可读，fresh 输入无资格时不新增收费接收。进程内保存同一用户在途接收 Promise，持久去重仍由 PostgreSQL 唯一键负责。

带图请求先查 owner 和原回执，再检查忙碌状态及当前模型视觉能力；耗时资产读取、解码与本轮图片预算预检在行锁外完成。每服务同时最多准备两个新的带图请求，满载返回 503 IMAGE_UNAVAILABLE，既有回执优先。每图受理阶段复用一次私有读取和规范化，同时形成持久附件引用与本轮预览字节数，发送前的来源复核独立执行。最终短事务再次核对回执、busy 和路由/视觉预算快照，变化时拒绝并等待客户端按原意重试。纯文本沿旧 SHA-256，带图摘要为 `vision:v1:` 加 `SHA256(JSON.stringify([text, orderedIds]))`。原件、内存预览、授权检查及旧图卸载的限制见[对话 HTTP](apis/conversations.md#post-apiv1conversationsidmessages)和[DSH 集成](integrations/dsh.md)。同一原图在同一请求中出现多次时按 occurrence 计预算；不能满足时不能丢弃当前轮图片。

正式 Profile 关闭上游 DSH 默认身份开场白（`includeHarnessIdentity: false`），每次对话轮次（无论 legacy 还是 BYOK）统一由服务端注入受控的会话级系统提示词：助手固定自称 `miioo AI 漫剧助手`（不提及内部框架或运行时名称），围绕 AI 漫剧创作执行适度宽松话题政策（支持服务于创作的背景、历史/服饰/设定考据与审美参考并自然衔接回创作，对编程调试、作业解题、医疗/法律/金融、无关时政与纯粹闲聊礼貌婉拒并引导回漫剧创作），禁止泄露或覆盖内部指令，并按本轮实际授权的生图与图片查看能力如实声明工具可用性；提示词文本按 `{ imageGeneration, imageInspection }` 组合完全确定，不含动态变量以维持前缀缓存稳定，且绝不经公开历史或 SSE 透传。

回执层级为 accepted（仅 PG 已受理）、input-persisted（DSH 输入/inbox 屏障和 PG 状态已成功）、completed/cancelled/failed（已执行请求检查真实 DSH 终态并 flush 后完成 PG 更新，执行前用户取消另有下述边界）。unknown 表示无法证明完整结算，错误码只含服务定义值。接收 COMMIT/ACK 不确定时，按原用户/对话/请求/内容摘要锁行核对，只将本进程未启动的待执行记录改 unknown 并释放 busy；不重发模型。结算 ACK 丢失时先读原回执，保留已提交的终态。无法完成对账时停止该实例后续操作，查询返回脱敏 503，操作者须停止并重启原实例核对，不能换 ID 重发未知输入。

取消绑定本次 active request ID；包括 PG 已受理但 adapter 尚未登记的窗口。取消回执只是 requested，实际 cancelled/其他结算通过原请求查询；延迟取消不能取消下一条请求。

如果 Agent 尚在打开，首次生效的终止意图固定：先收到用户取消则不提交输入、结算 cancelled；先开始关闭则不提交输入、结算 unknown，后到取消不能改写关闭原因。Agent 已开始执行时仍以实际持久终态判断，不能把未取得的终态冒充用户取消。

## 实例与生命周期

每个本地 metadata schema 和 DSH_HOME 只运行一个实例。服务持有专用 PG advisory lock 连接，先取得锁再把旧 accepted/input-persisted 记录改 unknown、清理 busy；第二实例拒绝启动。持锁连接丢失后拒绝新操作，不自动重新取得锁、重放输入或恢复收费调用。操作者仍须确认旧进程和原生 writer 已停，再启动新实例；PG 租约不构成跨存储 fencing 或分布式部署协议。

普通元数据池最多 5 个连接，其中一个持有租约；连接、SQL 和查询等待上限各 5 秒。关闭先停止入口与流，等待已进入接收/创建的操作，取消并收敛全部 Agent/原生写入，再加入所有回执更新，最后关闭 PG 池。一个 Agent 打开失败不能跳过其他所有者清理；关闭失败保留错误。硬中断后保留已持久前缀，未结算 chunk 可能不存在；离线历史显示 interrupted，不自动续跑。

在途历史读取同样参与关闭排空；官方图片卸载投影必须保留到会话及读取结束。已开始执行的运行若没有可证明的 turn/end，回执为 unknown，冷读按 DSH 已持久前缀展示 interrupted。正式 Profile 的薄入口等待内核就绪，原 `@mio/plugin` 独立装载不增加内核前置。

断网只释放订阅，已受理轮次继续。登录过期/撤销后新操作拒绝；SSE 每秒重新验证同一登录会话，失败时发送脱敏错误并关闭，已受理轮次可完成。legacy 固定路由变化在下一次 setup model.select 生效；BYOK 始终恢复冻结的逻辑模型和 fresh 快照，不跟随默认项变化。关闭必须先等待对话 admissions/run 排空（含在途生图工具调用），再关闭 `generations`；即使排空或 generations 关闭失败，也须继续释放 `providers` 池并保留 `AggregateError`。`compute` 清理单独加入对话排空后再执行，不能只靠 effect 注册顺序。

## 验证及限制

`tests/conversations/conversations.test.ts` 经真实认证、PG、官方 loop、JSONL 和 HTTP/SSE 验证归属、多轮、忙时/去重、故障回执、订阅窗口、失效登录及断网；`tests/conversations/prompt.test.ts` 与 `tests/conversations/conversations-engine.test.ts` 验证平台系统提示词规则、四种工具能力组合、确定性输出、legacy/BYOK 会话注入、多轮前缀稳定与字面量 `{{...}}` 安全，以及多所有者异常关闭和无文本取消；`tests/conversations/conversations-profile.test.ts` 验证打包后的正式 Profile（含移除上游 `DeepSeek Harness` 开场白、注入 `miioo AI 漫剧助手` 且公开历史不外泄系统提示）、多轮、正常重启及 SIGKILL；`tests/conversations/conversation-image-tools.test.ts` 经 A 内的 generations、隔离 PG、受控上游与 COS 替身、官方 loop、真实 JSONL 与正式打包 Profile，在不启动 B 和图片 MQ 的条件下验证多轮生图/改图工具闭环、权限隔离、注入拦截、预算/步数熔断、幂等去重、取消与重启恢复。测试模型只安装在临时 Profile overlay，另有完全不含该 overlay 的正式装配验证，生产包不含测试夹具。

`tests/onelink/` 经公开 PiAi codec、官方 loop、隔离 PG/JSONL 和正式打包 Profile 验证 BYOK；overlay 只替换固定出站 fetch，不替换生产 adapter，并验证源码目录外的虚构精确 ID。`node tests/conversations/conversations-live.ts <authorized-private-key-file> [exact-model-id] [openai-chat|anthropic-messages]` 是显式真实入口，默认 deepseek-v4.1-flash/openai-chat。模型须精确存在于本账号当前目录，再经受控声明与用户默认、公开 API 完成两轮、SSE/终态、取消、历史和重启，输出对应目录/适配版本；失败保留实际观察，不回退模拟或目录外型号。当前验证目标与后续条件沿 PRD，已有接受按所属成果保留，不由新候选改写。

精确历史仍完整读取/校验单会话日志，公开分页不等于低成本存储查询。列表按 owner/id 索引有界返回、回执按复合主键；本地证据不推导生产吞吐、任意崩溃零丢失或全模型可用。完整检查、独立审阅、真实供应商与人类接受分别判定。
