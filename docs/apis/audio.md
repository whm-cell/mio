# 语音 HTTP 契约

[API 导航](index.md)。本轮范围见[音频 PRD](../tasks/onelink-audio-generation/prd.md)，凭据、模型和迁移见[供应商规范](../providers.md)。标准配音与声音复刻需要 providers、Asset 和计算服务。缺少执行依赖时 operation 模型列表为空、任务入口返回 AUDIO_UNAVAILABLE。

音频任务与作品记录使用 providers 数据库，样本读取与成品登记使用 Asset 数据库，两者可以分库。完整解码验证后先按固定 Asset ID 幂等登记成品，再在任务事务中发布作品记录和 ready 状态。暂时性检测、存储或发布失败保留供应商输出检查点，仅恢复检测与保存；确定性输出失败按[执行和恢复](#执行和恢复)结束任务并清除 PG 内输出。恢复不再次提交生成，也不在 providers 数据库创建或查询素材表。Asset 登记失败返回 AUDIO_STORAGE_UNAVAILABLE。检测失败保留具体检测错误码。

## 本域共同约定

完整启用认证与 providers 后注册。身份来自登录 Cookie 的 Authentication.identity，服务 Bearer 不替代用户。所有响应带 no-store、nosniff 和服务端请求 ID。错误为 {error:{code,message,requestId}}，不透传供应商原始响应、异常、Key 或数据库信息。

写入要求精确允许 Origin 和 application/json，读取正文后复核同一用户和会话。GET 若提供 Origin 也须允许。OPTIONS 无需登录但须允许 Origin，返回 204 和实际支持的方法。JSON 上限 160 KiB、期限 10 秒，拒绝额外字段。未知路径 404 NOT_FOUND、错误方法 405 METHOD_NOT_ALLOWED、错误媒体类型 415 JSON_REQUIRED。未登录 401 UNAUTHORIZED，Origin 缺失/不允许分别 403 ORIGIN_REQUIRED/ORIGIN_DENIED，正文/查询错误 400 BODY_INVALID/QUERY_INVALID。正文读取错误沿[请求原语](index.md#运行时公共能力)。

voiceRef 是本人配置下的稳定 UUID。上游同 ID 的不同来源仍是不同引用。来源是 system、voice_cloning、voice_generation。 声音列表和详情提供可空的 registrationModelRef。受控登记绑定某一型号时，客户端可用它与所选 TTS modelRef 筛选。资源归属不绑定 Key 指纹。轮换保留引用、收藏和历史元数据，当前可用性另行判断。generationAvailable 取当前音色及 TTS 路由资格，previewAssetId 仅引用已验证试听。未知语言、口音、性别、年龄为 null，tags 为空，不据音色 ID 推断。

## GET /api/v1/audio/models

身份：本人登录会话。

输入：无正文。省略查询参数时返回音色目录模型。也可仅传 operation=tts 或 operation=clone 获取对应执行模型及参数约束。operation 为其他值、重复键或与其他查询参数混用时返回 400 QUERY_INVALID。

成功：200 {items}。目录查询的 items 为 {modelRef,modelId,name,voice}，只返回当前目录中已实现并启用 audio.voices.list 的模型。voice 包含适配来源、版本、验证状态和当前 generationAvailable。operation 查询的 items 为 {modelRef,modelId,name,parameters,verification}，只返回本人发现、当前启用、已实现且已装配依赖的执行模型。verification 表示实际验证状态，parameters 提供 speed、volume、pitch 的 min/max/default，formats/defaultFormat，textMaxCodePoints/textMaxBytes 和 sampleMaxBytes/sampleMinSeconds/sampleMaxSeconds。无有效模型返回空数组，不从型号名称推断能力。

错误：共同错误。配置/存储不可用 503。不因没有可用项制造模型成员，缺少任务执行依赖时 operation 查询返回空数组，任务入口返回 503 AUDIO_UNAVAILABLE。

副作用：只读本地，不联网，不解密 Key，不调用供应商，不设置验证成功。

## POST /api/v1/audio/voices/refresh

身份：本人登录会话及允许 Origin。

输入：空对象 `{}`。旧客户端可携带字符串 `modelRef`，本地重读会忽略该字段。

成功：200 `{status:"connected"|"empty",source:"local",count:number}`。count 是本人本地数据库中 present 音色的数量。操作不依赖音色查询模型或供应商目录快照。

错误：共同错误。关闭或本地不可用为 503 VOICE_UNAVAILABLE。无配置或无本地音色返回 empty 和 count=0。

副作用：只读本机数据库，不解密 Key，不调用 OneLink `/minimax/v1/get_voice`，不修改目录快照或生成试听。前端随后重新读取当前筛选列表。

## GET /api/v1/audio/voices

身份：本人登录会话。

输入：可选 search（最多 100 Unicode 码点）、source（三种封闭来源）、favorite（true/false）、limit（1..100，默认 30）和 cursor。拒绝未知、重复查询键和非法游标。搜索将百分号、下划线、反斜线视为字面字符。

成功：200 `{catalog,total,items,nextCursor}`。total 为当前筛选条件下的完整匹配数，不受分页和 cursor 影响。catalog 为 {status,errorCode,succeededAt,current,stale}，按未筛选的本地 present 音色计算：有记录则 connected/current=true，否则 empty/current=false。errorCode=null、stale=false，succeededAt 为本地最新更新时间。items 提供共同音色字段及 favorite、available、createdAt。按不可变 created_at DESC/id DESC 分页，游标保留微秒。改变过滤条件须丢弃游标。分页表达当前集合，不是并发收藏变化的历史快照。无配置/无音色为 empty 和空列表。

错误：共同错误。503 VOICE_UNAVAILABLE。

副作用：只读本地。旧供应商查询错误或刷新租期不影响本地目录状态。系统音色 available/generationAvailable 由 present、本人配置、音色对应型号和当前 MiniMax TTS 路由资格判断。凭据轮换后，重新发现有效 TTS 模型即可恢复系统音色使用资格。账户私有音色仍保留凭据版本及归属校验。

## GET /api/v1/audio/voices/{voiceRef}

身份：本人登录会话，owner 与音色关联配置一致。

输入：UUID voiceRef。不接受查询参数。

成功：200 本人音色对象，包含来源、显示信息、收藏、当前可用性和可空的试听资产 ID。历史元数据不会因为目录移除而消失。

错误：共同错误。非法、不存在与越权引用统一 404 VOICE_NOT_FOUND。503 VOICE_UNAVAILABLE。

副作用：只读本地，无供应商查询。

## PATCH /api/v1/audio/voices/{voiceRef}

身份：本人登录会话及允许 Origin，owner 与引用关联配置一致。

输入：UUID voiceRef，JSON 仅 {favorite:boolean}。不接受查询参数。

成功：200 更新后的音色对象。显式设置收藏状态，重复相同设置不翻转。

错误：共同错误。非法、不存在与越权引用统一 404 VOICE_NOT_FOUND。503 VOICE_UNAVAILABLE。

副作用：仅更新本人音色收藏及更新时间，不修改排序时间、Asset、任务或上游资源。

## POST /api/v1/audio/jobs

身份：本人登录会话及允许 Origin。

输入：仅 {requestId,modelRef,voiceRef,text,mode:"standard",parameters?}，拒绝额外字段。requestId 为小写 UUIDv4，模型和音色为本人当前可用资源。parameters 仅接受 speed、volume、pitch、format，省略项采用模型声明默认。正文最多 10000 Unicode 码点和 80 KiB，取模型更严格限制，拒绝空白、非法代理项和控制字符。

成功：新任务返回 202，相同 owner/requestId 及相同输入语义复用并返回 200。省略参数和提供该任务冻结的默认值等价。统一任务视图为 {jobId,kind,status,errorCode,recordId,voiceRef,text,parameters,recoverable,cancelRequested,assetIds,outputs}。克隆另含 upstreamConfirmed，表示已持久化确切的上游创建事实。kind 为 tts/clone，status 为 queued/submitted/materializing/unknown/ready/failed/cancelled。outputs 仅在 ready 时提供 {index,assetId,durationMs,format}，时长来自完整解码。三个 ID 各自独立，不返回凭据、对象键或永久下载地址。

错误：共同错误。异输入 409 REQUEST_CONFLICT，超额 429 AUDIO_CONCURRENCY_LIMIT，模型、音色或参数资格不满足时沿具体错误。原回执查询先于模型、Key 等可变化检查。

副作用：持久保存幂等身份和冻结正文、模型、音色、参数。预检完成后原子保存提交意图，随即执行供应商请求。每用户最多两个 queued/submitted/materializing 任务，全局执行并发为二。已受理任务关闭页面后继续运行。

## POST /api/v1/audio/voices/clone

身份：本人登录会话及允许 Origin。

输入：仅 {requestId,modelRef,sampleAssetId,name,auditionText,sampleAuthorization:true}，拒绝额外字段。样本使用既有 Asset 上传，必须本人 ready，格式为 MP3/WAV/M4A，最多 20 MiB，完整解码实测 10–300 秒并取模型更严边界。后缀、MIME 与实际格式须一致。name 最多 100 码点，auditionText 最多 1000 码点且取模型文本预算。授权声明来自本轮用户，不能由模型生成。

成功：返回统一任务，新建 202、相同输入复用 200。供应商专用 multipart 只提交一次。供应商确认成功后保留确定音色 ID。试听验证、COS 和 Asset／音色／记录发布后进入 ready，稳定 voiceRef 可用于后续 TTS。供应商确认而试听缺失时，保留 upstreamConfirmed 和错误，任务结束为 failed。

错误：共同错误。未授权为 400 AUDIO_SAMPLE_AUTHORIZATION_REQUIRED，样本格式或时长无效为 400 AUDIO_SAMPLE_FORMAT_INVALID/AUDIO_SAMPLE_DURATION_INVALID，样本变化为 409 AUDIO_SAMPLE_CHANGED，供应商确认后缺少试听为 409 AUDIO_AUDITION_MISSING。上游被拒为 AUDIO_UPSTREAM_REJECTED，提交结果未知为 AUDIO_SUBMIT_UNKNOWN。

副作用：检测后条件读取本人样本并核对 SHA-256，确保同一已验证原件为私有，再向 OneLink 提交一次复刻请求。上传、检测或落库的暂时性失败只恢复后续步骤，不重复复刻供应商调用。

## GET /api/v1/audio/jobs/{jobId}

身份：本人登录会话。

输入：路径 UUID jobId。不接受查询参数或正文。

成功：200 返回 [POST /api/v1/audio/jobs](#post-apiv1audiojobs) 定义的统一任务视图。结果未知时保留 unknown，不显示虚构百分比。

错误：不存在与越权均 404 AUDIO_JOB_NOT_FOUND。其余见本域共同约定。

副作用：只读本人持久任务，不重新提交供应商调用。

## POST /api/v1/audio/jobs/{jobId}/recover

身份：本人登录会话及允许 Origin。

输入：路径 UUID jobId，正文必须为 {}。

成功：200 返回恢复后的统一任务视图。只恢复已有音频或供应商 URL 的上传、检测和发布。确定性失败或取消后的任务保持原终态及错误，不因输出已清理而重新解释为克隆缺试听。

错误：unknown 为 409 AUDIO_SUBMIT_UNKNOWN，已知克隆缺试听为 409 AUDIO_AUDITION_MISSING。其余见本域共同约定。下载过期保留原身份和错误。

副作用：不重新生成音频，不重发供应商 POST。只继续未完成的媒体验证、COS 和资产/记录发布。

## POST /api/v1/audio/jobs/{jobId}/cancel

身份：本人登录会话及允许 Origin。

输入：路径 UUID jobId，正文必须为 {}。

成功：200 返回统一任务视图。queued 包括样本预检，取消可结束为 cancelled。materializing 已停滞且无处理租约（lease_id 为空）、有错误码时，取消结束为 cancelled 并清除 PG 内输出字节或临时地址；此前已标 cancelRequested 的同类任务也可完成取消。仍有租约的 materializing、submitted 和 unknown 仅标 cancelRequested，不把租约到期视为已释放。其余已收到的结果仍可继续发布和恢复；ready、failed、cancelled 保持原终态。

错误：不存在与越权均 404 AUDIO_JOB_NOT_FOUND。其余见本域共同约定。

副作用：保存取消意图，或结束上述已停滞的本地后处理；不声称供应商已撤回，也不删除既有音色、COS 或 Asset。关闭页面不取消任务。停止回复另用会话 cancel。

## GET /api/v1/audio/records

身份：本人登录会话。

输入：可选 before（上页末 recordId）及 limit（默认 20，1–100）。拒绝未知或重复查询键。

成功：200 返回 {items,nextCursor}，按不可变 created_at/id 降序。nextCursor 为 null 表示本页末尾。

错误：参数无效为 400 QUERY_INVALID。其余见本域共同约定。

副作用：只读本人音频记录，不调用供应商。

## GET /api/v1/audio/records/{recordId}

身份：本人登录会话。

输入：路径 UUID recordId。不接受查询参数或正文。

成功：200 返回 {recordId,jobId,assetId,kind,text,parameters,voiceRef,voiceSnapshot,modelRef,durationMs,format,createdAt}，供正文与参数复用。

错误：不存在与越权均 404 AUDIO_RECORD_NOT_FOUND。其余见本域共同约定。

副作用：只读持久记录。本人通过 [Asset GET](assets.md#get-apiv1assetsid) 取得同一资产的五分钟 playbackUrl 及 downloadUrl。地址到期后按 assetId 重新获取。

### 执行和恢复

供应商截止 180 秒，处理租期 30 分钟。输出最多 100 MiB，实测最多 3600 秒。 上传样本随签发响应发送 private ACL 头。新成品和试听显式写入 private ACL。恢复时仅对任务生成的固定对象键，以及归属、内容、大小和 ETag 均匹配的同一文件补齐私有权限。成功发布后清除 PG 内的输出字节或临时地址。检查点短暂失败时可重试本地保存，提交意图始终对应一次供应商 POST。submitted 过期转 unknown，queued 和 materializing 可以收回过期租期并按原身份继续。关闭时等待准入、调度和执行收束，再关闭媒体与数据库连接。

materializing 中明确的 400 AUDIO_OUTPUT_INVALID、409 AUDIO_OUTPUT_MISMATCH 或 409 AUDIO_VOICE_CONFLICT 结束为 failed，保留原错误、上游确认事实及固定输出身份，清除 PG 内输出字节或临时地址。其他错误不按全部 400/409 一概终结；暂时性 503、提交结果未知及检查点丢确认仍沿原恢复边界。failed 不再占用任务并发名额，也不触发再次生成。清理 PG 输出不撤销供应商副作用，不删除已登记的音色或对象。

输入错误包括AUDIO_TEXT_INVALID、AUDIO_PARAMETERS_INVALID、AUDIO_FORMAT_INVALID、AUDIO_SAMPLE_INVALID、AUDIO_SAMPLE_FORMAT_INVALID、AUDIO_SAMPLE_DURATION_INVALID、AUDIO_SAMPLE_AUTHORIZATION_REQUIRED。样本变化为409 AUDIO_SAMPLE_CHANGED。供应商拒绝为AUDIO_UPSTREAM_REJECTED，提交不确定为AUDIO_SUBMIT_UNKNOWN。媒体/存储错误保持脱敏与recoverable事实，未验证不发布ready。隔离测试与真实供应商验收分别报告。

### 创作日志投递

音频任务 ready 且作品记录发布后，在 providers 库同一结果事务登记稳定 event_id、原 occurredAt 的创作日志 outbox；确认无可恢复输出／克隆检查点的 failed 才登记失败。unknown、保存中及可恢复检查点不产生失败消息。outbox 插入失败回滚结果／作品记录，本地恢复不再次生成。

插件在三类媒体及管理策略均可用时，将 outbox 注入媒体域 `receiveAudio(eventId,event)`；providers 与媒体使用独立池，跨域回调期间不持有 providers 事务或连接。每秒领取最多 20 条，以租约和 `SKIP LOCKED` 避免并发重复领取；失败至少间隔一分钟重试，保持原事件身份和时间。自原 occurredAt 满 7 天即停止投递并落 dead_lettered_at／脱敏告警；成功投递不重放。接收端在一个媒体库事务内登记回执和消息，超保留窗口或超硬性重试窗口仅记回执。回执固定保留 8 天，防止缩短后调长策略令已清理消息复活，无反向回收握手。

`pnpm providers:migrate --apply` 包含 outbox 的幂等增量迁移，保留原任务与作品。启动只读检查所需表和字段；部署先迁移再启动。关闭插件先等待 outbox 当前回调，再关闭媒体消费者、策略快照及 providers 连接池。列表与已读接口见[创作日志 HTTP](notifications.md#get-apiv1notifications)。
