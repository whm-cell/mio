# 对话 HTTP 契约

[API 领域导航](index.md)，配置/持久化及恢复责任见[本地对话服务](../conversations.md)。仅在显式配置对话数据库后注册；未启用时返回既有未知路径错误。

## 本域共同约定

每次操作使用账号 Cookie 经数据库解析，服务 Bearer 不能替代用户；猜测他人 ID 与不存在 ID 均返回 404。正文不允许自授 owner、密钥、DSH ID 或额外字段；modelRef 只在创建和一次绑定入口接受。POST/PUT 必须有认证允许的精确 Origin 和 application/json；GET 有 Origin 时也须匹配。OPTIONS 不要求登录，实际调用仍需登录。错误为 `{error:{code,message,requestId}}`，requestId 是服务端 HTTP 追踪标识，与客户端去重 ID 不混用；均禁止缓存、带 X-Content-Type-Options 与 X-Request-Id。

JSON 正文总上限 16 KiB，读取期限 10 秒；文本需非空。客户端 requestId 为 1–80 个字母/数字/下划线/连字符，随本地对话保留。通用错误：400 BODY_INVALID/QUERY_INVALID，401 UNAUTHORIZED，403 ORIGIN_DENIED/ORIGIN_REQUIRED，404 CONVERSATION_NOT_FOUND/REQUEST_NOT_FOUND/NOT_FOUND，405 METHOD_NOT_ALLOWED，408 BODY_TIMEOUT，413 BODY_TOO_LARGE，415 JSON_REQUIRED，503 CONVERSATION_UNAVAILABLE。源错误、路径、凭据、系统提示、推理、原始工具调用参数、目录探测内部结果、工具拒绝/异常详情与 trace 均不透传。

BYOK 选模、一次绑定和 fresh 输入另可返回 404 PROVIDER_NOT_CONFIGURED；409 PROVIDER_DISABLED/PROVIDER_AUTH_REJECTED/MODEL_CATALOG_NOT_DISCOVERED/MODEL_NOT_FOUND/MODEL_REMOVED/LEGACY_MODEL_REF_INVALID/ADAPTER_PENDING/MODEL_DISABLED/MODEL_DEFAULT_NOT_SET/MODEL_DEFAULT_INVALID；解密失败为 503 PROVIDER_CREDENTIAL_UNAVAILABLE。稳定引用来自本人[动态模型目录](providers.md#get-apiv1providersonelinkmodels)，兼容旧分类引用；当前目录不可用不回退其他模型或 Key。

## POST /api/v1/conversations

身份：当前登录用户，owner 由服务取得。

输入：`{modelRef?}`。modelRef 为准确目录引用、非空且最多 512 字节。BYOK 下省略时选择本人显式 chat 默认，不自动替代；legacy 只接受省略该值。

成功：201 `{id,createdAt,state:'ready',modelRef?}`；PG 映射和原生 Session 均达到本地创建屏障，BYOK 返回冻结的 modelRef。

错误：BYOK 按共同约定的具体资格错误；legacy 的 503 MODEL_UNAVAILABLE 保留。503 CONVERSATION_UNKNOWN 表示跨存储未收口，所属列表可能已有 unknown 映射。缺模型/配置/资格不创建映射。

副作用：创建 PG 归属映射和 DSH 原生会话头，不调用模型或授权工具。

## GET /api/v1/conversations

身份：当前登录用户，只返回自己的对话。

输入：可选 `after`（上页 UUID cursor）、`limit`（默认 20、1–100）。

成功：200 `{items:[{id,createdAt,state,modelRef?}],nextAfter}`，按 UUID 升序；未绑定/legacy 项省略 modelRef，nextAfter 为 null 表示本页末尾。

错误：见本域共同约定。

副作用：只读有界元数据，不打开模型。

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

错误：409 CONVERSATION_BUSY/REQUEST_ID_CONFLICT/CONVERSATION_UNKNOWN/CONVERSATION_MODEL_REQUIRED/MODEL_MODALITY_UNSUPPORTED/MODEL_VISION_CHANGED，以及共同约定的 BYOK 资格/解密错误；无权、未 ready、非图片或登记键不合法的资产为 404 ASSET_NOT_FOUND，登记大小无效或超过源上限为 400 ASSET_INPUT_INVALID，图片解码/格式或本次预算无效为 400 IMAGE_INPUT_INVALID，实际资产长度或源版本变化为 409 ASSET_SIZE_MISMATCH/ASSET_SOURCE_CHANGED，资产或图片处理不可用为脱敏 503。每服务同时最多准备两个新的带图请求，满载立即返回 503 IMAGE_UNAVAILABLE，不排入图片准备等待队列，不读取本次原图、不新增 fresh 接收；同 ID 既有回执优先返回。拒绝时不新增 fresh 接收。已有同 ID 原回执早于当前目录、启停、默认、解密和资产检查；摘要不含可变化的凭据/目录/适配版本。接收 ACK/存储未知不重发，按原 ID 查询。

副作用：PG 保存请求身份和输入摘要，DSH 保存内容并执行一个受控轮次；不同对话独立，同对话一个活动请求。根级与非授权会话工具仍全部拒绝；仅当 BYOK 与图片计算桥接均就绪时，该活动轮次可在单轮预算（最多 12 次工具调用、4 次图片提交、8 步模型调用）内通过 `list_image_models`、`submit_image_job`、`get_image_job` 访问当前用户本人的目录摘要与图片任务，轮次结束立即撤销授权。

视觉路由与资产桥可用时，活动轮次还可只读调用 `inspect_image_asset({assetId})` 检查本人 ready 图片，不依赖生图工具。图片请求按路由限制出现次数和 Base64 总字节数；服务可在内存生成有界预览，并为满足预算卸载本轮之前的旧图片。旧图占位提示可用同一资产 ID 重新检查；本轮图片不能静默卸载。原图、签名 URL 和对象键不写入 DSH 日志。

## PUT /api/v1/conversations/:id/model

身份：当前登录用户与对话 owner。

输入：`{modelRef}`，准确的本人允许 chat 目录引用，最多 512 字节；不接收 mode、Key、配置 ID、URL 或 header。

成功：200 `{id,createdAt,state,modelRef}`。仅为旧无绑定会话设置一次；已经绑定相同值返回原绑定，不重新验证当前 Key，不允许换模型。

错误：409 CONVERSATION_MODEL_LOCKED/CONVERSATION_BUSY/CONVERSATION_UNKNOWN；未绑定时还须满足共同约定的当前 BYOK 资格。

副作用：事务锁住 owner 对话、保存逻辑配置/模型绑定；不解密、不调用模型、不改写历史。BYOK 旧无绑定会话在下一次新发送前须显式调用；历史和已有回执始终可读。

## GET /api/v1/conversations/:id/requests/:requestId

身份：当前登录用户与对话 owner。

输入：原客户端 requestId。

成功：200 原回执，status 为 accepted/input-persisted/completed/cancelled/failed/unknown；error 只有服务定义脱敏码。

输出截断的已结算回执为 completed，带 `truncation: {reason:'max-tokens', message:'已达输出上限'}`。该标记仅来自实际原生轮次终态及持久化确认，正文可从历史读取。普通结算及旧回执省略该字段。

错误：404 REQUEST_NOT_FOUND 不代表可以重发未知外部动作；数据库不可查时 503，其余见本域共同约定。

副作用：只读，不重新启动模型；重启后未完成接收保持 unknown。

## GET /api/v1/conversations/:id/events

身份：当前登录用户与对话 owner。首次鉴权最多等 5 秒；已验证的同一 userId/sessionId 共享每秒调度的 fresh 数据库身份复核，每次最多等 5 秒，不缓存成功身份。身份或会话变化、会话失效会关闭该组全部订阅；错误或超时同样整组关流，不同用户和会话分别复核。

输入：无正文；先用历史/原请求回执恢复，当前流没有可跨进程重放的 Last-Event-ID 协议。单 A HTTP 实例中 pending＋open 全局至多 256 条，其中首次鉴权尚未完成至多 64 条；已验证的每用户跨会话、跨对话合计至多 8 条。全局和未鉴权名额在首次异步鉴权前预留，用户名额在验证身份后、归属与快照读取前核对。超过相应边界返回 429 `SSE_LIMITED`；断开、失败与关闭释放名额，可再次建立订阅。

成功：200 text/event-stream。先发 snapshot `{conversationId,activeRequestId,receipt}`（receipt 为最近回执或 null），再发 text `{requestId,text}`、tool `{requestId,tool:'submit_image_job'|'get_image_job',job}`（仅限非错误且通过严格结构校验的 `mio.image-job` 卡片）、state `{receipt}` 或 error `{code}`；每个 data 对象也含 type。完成归属检查并安装 listener 后，在同一次数据库查询中读取活动请求和最近回执。交接期间事件有界缓冲，服务会省略快照已覆盖的同一请求状态。事件按 requestId 关联，重连可查持久历史和回执，瞬态事件仅在流上可见。

截断轮次完成后，state 中的回执带 `truncation`。如果该请求是订阅建立时的最近回执，snapshot 中也包含同一标记。已发送的 text 原样保留。

错误：响应前遵循本域错误体，限额为 429 `SSE_LIMITED`，初次鉴权错误或超时为 503 `AUTH_UNAVAILABLE`。建流后会话失效或身份变化发 `UNAUTHORIZED`，鉴权错误或超时发 `AUTH_UNAVAILABLE`，随后关闭；其他错误只发脱敏 error 并关闭或结束连接。单帧、排队基线事件或 socket 待写缓冲超过 64 KiB 时关闭该订阅，客户端补读历史/回执。

副作用：持有有界连接名额、临时 listener 和同会话共享的复核 timer；首次鉴权、归属或快照等待期间断开也立即释放名额及已安装 listener，最后订阅退出清理组 timer 和复核期限，迟到结果不重开流。断开不隐式取消已受理执行，建流本身不授予模型工具权限。

## POST /api/v1/conversations/:id/cancel

身份：当前登录用户与对话 owner。

输入：`{}`。

成功：202 `{requested,requestId}`；请求绑定当时活动 ID，覆盖受理至 adapter 登记窗口。requested 不表示已经终止或输出已持久，按原请求回执观察实际供应商结果与持久化状态；已结束时 requested=false。

错误：见本域共同约定。

副作用：请求官方协作式取消，不能撤销已发生动作或保证回收已发生的供应商调用；不会取消后续另一请求。
