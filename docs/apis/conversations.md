# 对话 HTTP 契约

[API 领域导航](index.md)，配置/持久化及恢复责任见[本地对话服务](../conversations.md)。仅在显式配置对话数据库后注册；未启用时返回既有未知路径错误。

## 本域共同约定

每次操作使用账号 Cookie 经数据库解析，服务 Bearer 不能替代用户。猜测他人 ID 与不存在 ID 均返回 404。正文不允许自授 owner、密钥、DSH ID 或额外字段，modelRef 只在创建和一次绑定入口接受。POST、PUT、PATCH、DELETE 必须有认证允许的精确 Origin，GET 有 Origin 时也须匹配。写入接口要求 `application/json`，DELETE 可以省略正文和 Content-Type。实际写入在读取正文前后各复核一次身份。OPTIONS 不要求登录。错误为 `{error:{code,message,requestId}}`，其中 requestId 是服务端 HTTP 追踪标识。所有响应禁止缓存，并带 X-Content-Type-Options 与 X-Request-Id。

消息入口的 JSON 正文和解码后的文本各自以 256 KiB 为上限，控制入口正文上限为 16 KiB。所有正文读取期限为 10 秒。客户端 requestId 为 1–80 个字母、数字、下划线或连字符，随本地对话保留。通用错误包括 400 BODY_INVALID/QUERY_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 CONVERSATION_NOT_FOUND/REQUEST_NOT_FOUND/NOT_FOUND、405 METHOD_NOT_ALLOWED、408 BODY_TIMEOUT、413 BODY_TOO_LARGE、415 JSON_REQUIRED 和 503 CONVERSATION_UNAVAILABLE。源错误、路径、凭据、系统提示、推理、原始工具调用参数、目录探测内部结果、工具拒绝或异常详情与 trace 均不透传。

BYOK 选模、一次绑定和 fresh 输入另可返回 404 PROVIDER_NOT_CONFIGURED；409 PROVIDER_DISABLED/PROVIDER_AUTH_REJECTED/MODEL_CATALOG_NOT_DISCOVERED/MODEL_NOT_FOUND/MODEL_REMOVED/LEGACY_MODEL_REF_INVALID/ADAPTER_PENDING/MODEL_DISABLED/MODEL_DEFAULT_NOT_SET/MODEL_DEFAULT_INVALID；解密失败为 503 PROVIDER_CREDENTIAL_UNAVAILABLE。稳定引用来自本人[动态模型目录](providers.md#get-apiv1providersonelinkmodels)，兼容旧分类引用；当前目录不可用不回退其他模型或 Key。

## POST /api/v1/conversations

身份：当前登录用户，owner 由服务取得。

输入：`{modelRef?}`。modelRef 为准确目录引用、非空且最多 512 字节。BYOK 下省略时选择本人显式 chat 默认，不自动替代；legacy 只接受省略该值。

成功：201 `{id,createdAt,updatedAt,title:null,state:'ready',modelRef?}`。PG 映射和原生 Session 均达到本地创建屏障，初始 `updatedAt` 等于 `createdAt`。BYOK 返回冻结的 modelRef。

错误：BYOK 按共同约定的具体资格错误；legacy 的 503 MODEL_UNAVAILABLE 保留。503 CONVERSATION_UNKNOWN 表示跨存储未收口，所属列表可能已有 unknown 映射。缺模型/配置/资格不创建映射。

副作用：创建 PG 归属映射和 DSH 原生会话头，不调用模型或授权工具。

## GET /api/v1/conversations

身份：当前登录用户，只返回自己的对话。

输入：可选 `after` 接收上页原样返回的游标。省略时从首页开始。`limit` 默认 20，可取 1–100。

成功：200 `{items:[{id,createdAt,updatedAt,title,state,modelRef?}],nextAfter}`，仅包含未归档会话。首页按 `updated_at DESC, id DESC`，游标保存精确的数据库排序位置，客户端直接传回 `nextAfter`。继续使用旧 UUID 游标时，服务沿 UUID 升序分页并继续返回 UUID 游标，省略 `after` 后即使用活跃顺序。`nextAfter:null` 表示已到末页。`title:null` 表示尚无标题，legacy 或未绑定时省略 modelRef。

错误：见本域共同约定。

副作用：只读有界元数据，不打开模型。

## PATCH /api/v1/conversations/:id

身份：当前登录用户须拥有会话。

输入：`{title}`。原始标题最多 120 个 UTF-8 字节，须由有效的 Unicode 码点组成，清理控制字符并折叠空白后仍须非空。

成功：200 `{id,createdAt,updatedAt,title,state,modelRef?}`。

错误：正文含其他字段、标题无效或超长均返回 400 BODY_INVALID。归档后返回 409 CONVERSATION_ARCHIVED，归属不匹配返回 404。

副作用：在 DSH 日志和 PG 元数据保存并固定手工标题，保留原来的 `updatedAt`。

## DELETE /api/v1/conversations/:id

身份：当前登录用户须拥有会话。

输入：空正文，或 `application/json` 的空对象 `{}`。

成功：200 `{id,archivedAt}`，同一会话重复归档返回最初的时间。

错误：创建中或有活动请求时返回 409 CONVERSATION_BUSY。用户可以先取消活动请求并等待回执进入终态。

副作用：归档的会话退出列表，owner 仍能读取历史和旧回执，也能用相同 ID 与内容重取原接收回执。新消息、绑定、改名和取消返回 409 CONVERSATION_ARCHIVED。归档保留原生日志、回执和图片资产引用。

## GET /api/v1/conversations/:id/history

身份：当前登录用户与对话 owner。

输入：`afterSeq`（默认 -1，可原样复用空页/末页 cursor）、`limit`（默认 20、1–100）。

成功：200 `{items,nextAfterSeq,hasMore}`；items 为 `{seq,role:'user'|'assistant',text,interrupted?}`、`{seq,role:'tool',tool:'submit_image_job'|'get_image_job',job}`（`job` 为脱敏图片任务视图 `{jobId,status,requestedCount,errorCode,assetIds,outputs}`）或 `{seq,role:'status',status}`。带图的 user 项另有有序 `imageAssetIds`，无图时省略。状态白名单为 completed/cancelled/failed/interrupted/unknown。只展示已记录的文本、图片资产 ID、通过严格结构校验的 `mio.image-job` 工具结果卡片与终态（包括无文本取消及旧中断）；`tool/call` 原始参数、`list_image_models` 结果、工具失败/拒绝详情与瞬态 chunk 均不展示。live 读取先 flush，cold interrupted 可为只读合成，cursor 只随实际返回项推进。

原生日志证明轮次达到输出上限时，轮次末尾的 status 项为 completed，带 `truncation: {reason:'max-tokens', message:'已达输出上限'}`。同轮助手项按原顺序返回已保存正文。跨页时使用返回的 cursor 继续读到轮次末尾。

错误：损坏/不可读日志返回脱敏 503，不伪装空历史；其余见本域共同约定。

副作用：live 读取执行原生 flush；离线读取不启动 Agent 或模型，也不改写日志。底层仍可能完整读取/验证单会话日志。客户端断开或服务关闭会取消本次日志打开、读取和后续历史投影，并关闭本次读句柄；其他读者和已受理的模型轮次独立继续。

## POST /api/v1/conversations/:id/messages

身份：当前登录用户与对话 owner；受理后登录失效仍允许该轮结算。

输入：`{requestId,text,imageAssetIds?}`，普通输入经官方 followup；不开放 steer。`imageAssetIds` 最多 4 个互异小写 UUIDv4，顺序有意义，空数组等同省略，文本仍须非空。仅接受本人 ready 的 original 或 derived PNG/JPEG/WebP，源文件最多 10 MiB、16,777,216 像素且每边不超过 8192；仅显式声明 text 与 image 输入的 chat 路由可带图。

成功：202 原接收回执 `{conversationId,requestId,status,error?,truncation?}`。accepted/input-persisted/最终结算各表示不同屏障；同 ID 同内容返回原状态，不能据 HTTP 202 判断已输出或已持久完成。

错误：409 包括 CONVERSATION_BUSY、CONVERSATION_ARCHIVED、REQUEST_ID_CONFLICT、CONVERSATION_UNKNOWN、CONVERSATION_MODEL_REQUIRED、MODEL_MODALITY_UNSUPPORTED 和 MODEL_VISION_CHANGED。BYOK 资格与解密错误见本域共同约定。无权、未 ready、非图片或登记键不合法的资产为 404 ASSET_NOT_FOUND，登记大小无效或超过源上限为 400 ASSET_INPUT_INVALID，图片解码、格式或本次预算无效为 400 IMAGE_INPUT_INVALID，实际资产长度或源版本变化为 409 ASSET_SIZE_MISMATCH/ASSET_SOURCE_CHANGED，资产或图片处理不可用为脱敏 503。每服务同时最多准备两个新的带图请求，满载立即返回 503 IMAGE_UNAVAILABLE。已有同 ID 先比较摘要，匹配时返回原回执，不匹配时即使已归档也返回 REQUEST_ID_CONFLICT。fresh 输入看到已归档会在查询供应商或资产前被拒绝，行锁内的最终检查仍能拒绝预检过程中发生的归档。拒绝不新增 fresh 接收。摘要不含可变凭据、目录或适配版本。接收 ACK 或存储未知时按原 ID 查询。

副作用：PG 保存请求身份和输入摘要，DSH 保存内容并执行一个受控轮次；不同对话独立，同对话一个活动请求。根级与非授权会话工具仍全部拒绝；仅当 BYOK 与图片计算桥接均就绪时，该活动轮次可在单轮预算（最多 12 次工具调用、4 次图片提交、8 步模型调用）内通过 `list_image_models`、`submit_image_job`、`get_image_job` 访问当前用户本人的目录摘要与图片任务，轮次结束立即撤销授权。

视觉路由与资产桥可用时，活动轮次还可只读调用 `inspect_image_asset({assetId})` 检查本人 ready 图片，不依赖生图工具。图片请求按路由限制出现次数和 Base64 总字节数；服务可在内存生成有界预览，并为满足预算卸载本轮之前的旧图片。旧图占位提示可用同一资产 ID 重新检查；本轮图片不能静默卸载。原图、签名 URL 和对象键不写入 DSH 日志。

## POST /api/v1/conversations/:id/compact

身份：当前登录用户与对话 owner。

输入：`{"requestId":"compact-1"}`。同一会话的压缩和消息共用 requestId 命名空间。重放同一操作返回原回执。已归档会话仍可重放已受理压缩的回执。

成功：202 `{conversationId,requestId,status,error?}`。客户端用原请求 GET 回执或已连接的 SSE 观察结算。手动压缩没有新的人工输入，直接从 `accepted` 进入终态。当前无可压缩前缀时以 `completed` 结算，实际模型调用为零。

错误：新请求需要空闲且未归档的会话。已有活动请求、未知会话状态或归档分别返回 409 `CONVERSATION_BUSY`、`CONVERSATION_UNKNOWN` 或 `CONVERSATION_ARCHIVED`。复用消息请求的 ID 返回 409 `REQUEST_ID_CONFLICT`。无受支持的 BYOK 压缩路由或路由未声明正整数上下文窗口时返回 409 `CONVERSATION_COMPACTION_UNSUPPORTED`。已绑定路由的当前 BYOK 资格或凭据不可用时沿本域共同约定返回错误。接收未知时按原 requestId 查询。

副作用：摘要使用当前用户在此会话的同一模型，最多发起一次模型调用。该请求的内部摘要和实际用量记录分别保留于原生会话日志和 PG 回执审计。公开历史、标题和活跃时间沿既有会话语义。取消及重启恢复使用同一活动请求和回执。

## PUT /api/v1/conversations/:id/model

身份：当前登录用户与对话 owner。

输入：`{modelRef}`，准确的本人允许 chat 目录引用，最多 512 字节；不接收 mode、Key、配置 ID、URL 或 header。

成功：200 `{id,createdAt,updatedAt,title,state,modelRef}`。仅为旧无绑定会话设置一次。已经绑定相同值时返回原绑定，不重新验证当前 Key。归档会话拒绝绑定。

错误：409 包括 CONVERSATION_MODEL_LOCKED、CONVERSATION_BUSY、CONVERSATION_UNKNOWN 和 CONVERSATION_ARCHIVED。未绑定时还须满足共同约定的当前 BYOK 资格。

副作用：事务锁住 owner 对话、保存逻辑配置/模型绑定；不解密、不调用模型、不改写历史。BYOK 旧无绑定会话在下一次新发送前须显式调用；历史和已有回执始终可读。

## GET /api/v1/conversations/:id/requests/:requestId

身份：当前登录用户与对话 owner。

输入：原客户端 requestId。

成功：200 原回执，status 为 accepted/input-persisted/completed/cancelled/failed/unknown；error 只有服务定义脱敏码。

已结算为 `failed` 的请求可在 `error` 中返回以下固定值。它们描述原请求的执行结果，查询本身仍返回 HTTP 200。

| `error`                     | 含义                                       |
| --------------------------- | ------------------------------------------ |
| `MODEL_AUTH_FAILED`         | 模型凭据缺失、无效或权限被拒绝             |
| `MODEL_QUOTA_EXCEEDED`      | 上游明确拒绝本次额度或付款                 |
| `MODEL_RATE_LIMITED`        | 上游对本次调用限流                         |
| `MODEL_TIMEOUT`             | 模型请求或流式响应超时                     |
| `MODEL_CONTEXT_OVERFLOW`    | 模型协议或引擎确认输入超过上下文限制       |
| `MODEL_UPSTREAM_ERROR`      | 上游服务或模型调用传输失败                 |
| `TURN_STEP_BUDGET_EXCEEDED` | 继续执行将超过本轮模型步数上限             |
| `MODEL_FAILED`              | 其他未细分的明确失败，也是兼容的历史错误码 |

已取消或无法证明结算的请求沿实际状态返回。客户端可按原 requestId 查询，和 SSE `state` 或 `snapshot` 中的同一回执核对。普通模型错误不会自动重发。出错的模型尝试尚未发布非空正文且收到明确的上游上下文超限时，启用摘要的轮次最多执行一次摘要和一次正文重发，三次实际出站观察都归原请求。重发仍超限返回 `MODEL_CONTEXT_OVERFLOW`。

出错的模型尝试已通过 SSE 发布非空 `text` 时，之后确证的上下文超限直接结算为 `MODEL_CONTEXT_OVERFLOW`。流上已推送的片段保留，该次失败后无摘要或重发。前序步骤的正文及本次隐藏推理不影响这项判定。失败尝试保存在内部日志，重连按原请求回执和正式消息的历史投影恢复。服务不返回供应商响应原文或凭据。

输出截断的已结算回执为 completed，带 `truncation: {reason:'max-tokens', message:'已达输出上限'}`。该标记仅来自实际原生轮次终态及持久化确认，正文可从历史读取。普通结算及旧回执省略该字段。

错误：404 REQUEST_NOT_FOUND 不代表可以重发未知外部动作；数据库不可查时 503，其余见本域共同约定。

副作用：只读，不重新启动模型；重启后未完成接收保持 unknown。

## GET /api/v1/conversations/:id/events

身份：当前登录用户与对话 owner。首次鉴权最多等 5 秒；已验证的同一 userId/sessionId 共享每秒调度的 fresh 数据库身份复核，每次最多等 5 秒，不缓存成功身份。身份或会话变化、会话失效会关闭该组全部订阅；错误或超时同样整组关流，不同用户和会话分别复核。

输入：无正文；先用历史/原请求回执恢复，当前流没有可跨进程重放的 Last-Event-ID 协议。单 A HTTP 实例中 pending＋open 全局至多 256 条，其中首次鉴权尚未完成至多 64 条；已验证的每用户跨会话、跨对话合计至多 8 条。全局和未鉴权名额在首次异步鉴权前预留，用户名额在验证身份后、归属与快照读取前核对。超过相应边界返回 429 `SSE_LIMITED`；断开、失败与关闭释放名额，可再次建立订阅。

成功：200 text/event-stream。先发 snapshot `{conversationId,activeRequestId,receipt,contextUsage?}`（receipt 为最近回执或 null），再发 text `{requestId,text}`、tool `{requestId,tool:'submit_image_job'|'get_image_job',job}`（仅限非错误且通过严格结构校验的 `mio.image-job` 卡片）、state `{receipt,contextUsage?}` 或 error `{code}`；每个 data 对象也含 type。完成归属检查并安装 listener 后，在同一次数据库查询中读取活动请求和最近回执。交接期间事件有界缓冲，服务会省略快照已覆盖的同一请求状态。事件按 requestId 关联，重连可查持久历史和回执，瞬态事件仅在流上可见。

水位 `{estimatedTokens,contextWindow,compacted}` 在可估算时随 snapshot 与轮次或手动压缩的结算状态返回。BYOK snapshot 显示发起订阅时当前可用的绑定路由窗口；结算 state 显示本次已受理请求的冻结窗口。用 `contextWindow: null` 表示缺少适用的路由窗口，`compacted: true` 表示上下文含已持久化的压缩检查点。估算无法取得时省略该字段，回执照常返回。窗口只读取本地元数据，公开字段不含提示词、摘要、凭据或原始工具输出。

截断轮次完成后，state 中的回执带 `truncation`。如果该请求是订阅建立时的最近回执，snapshot 中也包含同一标记。已发送的 text 原样保留。

图片任务 `tool` 帧在对应原生日志记录通过持久化检查点后发布。连接中断或缺帧时，可以查询已持久历史和原回执，确认已有结果。

错误：响应前遵循本域错误体，限额为 429 `SSE_LIMITED`，初次鉴权错误或超时为 503 `AUTH_UNAVAILABLE`。建流后会话失效或身份变化发 `UNAUTHORIZED`，鉴权错误或超时发 `AUTH_UNAVAILABLE`，随后关闭；其他错误只发脱敏 error 并关闭或结束连接。单帧、排队基线事件或 socket 待写缓冲超过 64 KiB 时关闭该订阅，客户端补读历史/回执。

副作用：持有有界连接名额、临时 listener 和同会话共享的复核 timer；首次鉴权、归属或快照等待期间断开也立即释放名额及已安装 listener，最后订阅退出清理组 timer 和复核期限，迟到结果不重开流。断开不隐式取消已受理执行，建流本身不授予模型工具权限。

## POST /api/v1/conversations/:id/cancel

身份：当前登录用户与对话 owner。

输入：`{}`。

成功：202 `{requested,requestId}`；请求绑定当时活动 ID，覆盖受理至 adapter 登记窗口。requested 不表示已经终止或输出已持久，按原请求回执观察实际供应商结果与持久化状态；已结束时 requested=false。

错误：归档后返回 409 CONVERSATION_ARCHIVED，其余见本域共同约定。

副作用：请求官方协作式取消，不能撤销已发生动作或保证回收已发生的供应商调用；不会取消后续另一请求。
