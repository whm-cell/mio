# 用户资产 HTTP 契约

[API 导航](index.md)；存储与清理约束见 [COS 集成](../integrations/cos.md)。只在认证和完整资产配置启用后注册。

旧 userId 关闭后停止签发新的读写地址，原签名仍受有效期及对象存续约束。注销清理释放所有逻辑持有，经共享 GC 确认独占零引用正式对象不存在；暂存加速过期并在原五分钟 PUT 窗口后复查。新账号与仍有独立合法持有的对象不被旧任务影响。状态与上线门禁见[认证规则](../auth.md#永久注销与清理)。

## 本域共同约定

身份只来自登录 Cookie；服务 Bearer 和请求体不能指定 owner、桶、对象键或目标 URL。POST 要求允许的精确 Origin 和 `application/json`；GET 提供 Origin 时也须匹配；OPTIONS 无需登录但须允许 Origin。JSON 上限 8192 字节、10 秒，拒绝额外字段，读取后复核会话。所有响应 no-store，错误为 `{error:{code,message,requestId}}`，不返回 COS 或数据库错误详情。常见错误为 400 BODY_INVALID/QUERY_INVALID/ASSET_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 NOT_FOUND/ASSET_NOT_FOUND、405 METHOD_NOT_ALLOWED、408 BODY_TIMEOUT、413 BODY_TOO_LARGE、415 JSON_REQUIRED 和 503 ASSET_UNAVAILABLE/ASSET_STORAGE_UNAVAILABLE。

AssetView 是 `{assetId,status,filename,contentType,size,createdAt,downloadUrl?,playbackUrl?,derivatives?}`。`status` 为 pending、finalizing、ready 或 expired。已登记的原件与可下载产物在 ready 时含短期下载地址，支持的音频 MIME 同时包含短期 inline 播放地址。计算任务的内部 HLS 清单与分片可按本人资产 ID 查询元数据，播放地址由[私有 HLS 接口](compute.md#私有-hls)签发。文件名和 MIME 是用户描述，不证明文件类型或内容安全。地址是临时 bearer 凭证，必须避免日志、公开缓存和转交；COS 浏览器直传需配置指定 Origin 的 CORS。若选定的 W3/P5 环境使用临时 COS 凭据，签名 URL 的实际有效期还受该凭据有效期限制；长期受限 Key 不需要额外会话配置。

原件视频在 ready 后返回 `derivatives={enabled,status,profiles}`。计算关闭时为 `{enabled:false,status:"disabled",profiles:[]}`。启用后有派生意图时为 `enabled`，早于此能力或关闭期间上传的原件为 `not_applicable`，其 `profiles` 为空且启动时不回填。

自动派生档位 `ordinary` 的每项含 `{profile,jobId,status,errorCode,outputs,playbackUrl?}`。`jobId`、`errorCode` 可为 null。`status` 为 `pending`、`scheduled`、`succeeded` 或 `failed`。调度成功前任务 ID 为空，处理成功后 `outputs` 含 `{assetId,name,role}`，并返回本人可访问的 HLS 主清单路径。画布档位通过[通用计算接口](compute.md#通用媒体处理)显式提交。封面、预览及 HLS 使用稳定的底层资产 ID，仅作为媒体展示的附属产物，均无独立生成历史或自动加入我的资产的记录。

[素材登记](materials.md#post-apiv1materialsgroupsidmaterials)复用本域的 ready 原件和已登记 derived 图片；不要求客户端重传已知 assetId。内部 `readMaterialSource` 使用独立 20 MiB 上限（视觉 `readVisionSource` 仍为 10 MiB，通用资产仍为 1 GiB），按 raw ETag 的 If-Match 读取并冻结 SHA-256/大小/键；`materialUrl` 重新核对归属、ready 与 raw HEAD 后签发 600 秒无 attachment 的供应商 GET。该 URL 不进入公开 AssetView、日志或永久文件身份；原上传 URL 不得覆盖 ready raw。

头像读取独立于通用下载签名：认证装配仅调用 `verifyAvatar`、`avatarUrl` 和 `normalizeAvatar`。静态头像核验本人 ready 元数据及实际 HEAD 大小、类型；签名只允许 JPEG/PNG/WebP，采用私有桶 300 秒 HTTPS inline URL，不落库。GIF 转换直接在主服务 A 执行，复用 `mio_assets` 保存不可变的静态 WebP，设置 private ACL；版本化确定性资产 ID 和对象键支持重试、并发恢复与重启复用，不新增表、队列或计算任务。完成登记再次核对原件快照仍为本人 ready。转换细节及前端接口见[头像转换](auth.md#post-apiv1meprofileavatarnormalize)，不改变通用 AssetView 的 attachment 下载语义。

## GET /api/v1/me/storage-usage

身份：当前登录用户。响应遵循本域 Cookie、Origin、no-store 和标准错误包装。

输入：无查询参数。

错误：资产服务未配置或计量／策略不可用时返回 `503 STORAGE_UNAVAILABLE`；其余沿本域共同约定。

副作用：严格只读，不执行数据库写入或行锁。

成功：200 `{quotaBytes,warningAvailableBytes,usedBytes,availableBytes,usageRatio,objectCount,status,reminderVersion,thresholdReminderPending,calculatedAt}`。大小单位为字节，默认配额 5 GiB、可用低于 1 GiB 提醒。`availableBytes=max(0,quotaBytes-usedBytes)`，`usageRatio=usedBytes/quotaBytes`，超额时可大于 1。可用空间为 0 时为 `full`，严格低于提醒阈值时为 `warning`，恰等于阈值仍为 `safe`。本期只计量和提醒，空间不足不禁用上传、生成、查看、下载或清理，不返回预留量、限写或降级字段。

GET 严格只读：按用户主键读取 `mio_storage_usage`，不写数据库、不加行锁、不扫描资产或跨表实时去重。新账号返回零用量而不建行，查询失败不返回假零。管理配额和阈值由装配层传入只读短快照，多实例遵循管理域至多 5 秒的快照有效期。查询同一快照中的媒体策略投影并核对配置版本及生效值；不一致时只读返回 `503 STORAGE_UNAVAILABLE`，不提前展示计量触发器尚未采用的新版本提醒。管理保存结果以管理库事务为准，已提交后的媒体投影同步失败记录日志并由现有后台恢复，不把已成功保存误报为失败。

媒体库中的 `mio_asset_holders(owner_id,asset_id,holder_type,holder_id)` 按实际持有位置保存可扩展引用，使用库内 `(owner_id,asset_id)` 外键约束归属。`mio_storage_objects` 按 `(owner_id,object_key)` 物化去重，用户汇总保存字节数、底层对象数、`waterline_epoch`、确认版本和计算时间。ready 上传及图片／视频／音频成品登记自动建立 `asset` 持有；头像、DSH 当前持久模型表面的非 offloaded 视觉输入／工具图片、本地非 deleted 素材的 `source_asset_id` 分别建立持有。内部 preview、poster、HLS 清单／分片、staging、未完成上传和仅供应商托管的对象不计。目录副本、作品和回收站可作为独立持有方复用对象，只计一次，最后一处有效持有释放才扣减。完整目录库与正式媒体物理 GC 不在本单元内实施。

资产及本地素材变更在媒体库同事务维护计量。跨认证／对话库通过装配层读取回调同步持有，不建立跨库外键或事务。头像提交后的同步失败不阻断读取、仅改昵称或清空头像；后台恢复已提交事实。DSH 读取复用当前持久模型表面，包含工具图片和分叉，不从历史文本猜测引用。周期对账按账号主键分页，每批至多 10 个账号；源读取失败保留已有持有。策略投影每秒独立刷新，不被某个账号的慢对账阻塞，关闭时等待两类在途工作。后台修复与扫描不进入 GET 路径。

资产持有变更或后台对账导致任一下降（`full → warning`、`full → safe`、`warning → safe`）时推进持久化 `waterline_epoch`。`reminderVersion=storage:v1:{status}:{configRevision}:{waterlineEpoch}`，由三者确定性生成。仅 warning/full 且当前版本未确认时 `thresholdReminderPending=true`，满额提醒优先。相同区域内刷新、清理或保存同值配置不重复提醒；实际配置变化或降级后再次升入提醒／满额时产生新版本。

存量环境先用 `pnpm storage:migrate` 预览，再显式执行 `pnpm storage:migrate --apply`；常驻环境可用 `pnpm migrate:dev storage --apply`。增量迁移保留资产和任务，分类既有内部媒体并回填 ready original/derived 及已存在的本地素材持有；重跑不恢复已释放的 `asset` 持有。新环境 `assets:migrate --apply` 同时建立计量底座，`materials:migrate --apply` 安装素材引用触发器。头像／当前对话持有由后台按权威源补齐。服务启动只核对结构，缺少迁移或计量触发器时拒绝装载，不自动迁移。

## POST /api/v1/me/storage-usage/reminders/ack

身份：当前登录用户；要求允许的精确 Origin 和 `application/json`。

输入：仅为 `{reminderVersion}`，无查询参数；读完正文后再次核对会话。

成功：204，无正文。按本人和版本幂等确认已展示；只允许匹配数据库当前区域、配置版本和 epoch 的版本写入确认。旧版本与重复回执均安全返回 204，不清除后续提醒，也不能替其他用户确认。条件更新同时核对媒体策略，并拒绝用较旧配置版本替换已保存的新确认；等待行锁的旧语句快照也受该行条件保护。

错误：沿本域规则，资产库或策略暂不可用返回 `503 STORAGE_UNAVAILABLE`。

副作用：按本人及当前版本幂等记录确认；旧版本或重复回执不改变当前确认。

## POST /api/v1/assets/uploads

身份：当前登录用户。

输入：`{filename,contentType,size}`；文件名非空且 UTF-8 不超过 255 字节，contentType 是不带参数的 MIME，size 是 1 至 1073741824 的整数。

成功：201 `{assetId,uploadUrl,expiresIn:300,uploadHeaders?}`。调用方以 PUT 直传对应长度的文件并发送 `uploadHeaders` 中的头。签名绑定 Content-Length 和 Host。MP3、WAV、M4A、FLAC 的受支持 MIME 另签入 `x-cos-acl: private`，通过 `uploadHeaders` 返回。丢弃或改变该头会导致签名验证失败。浏览器直传的 COS CORS 须允许调用方精确 Origin、PUT 和签发的请求头。地址到期后新建上传。

错误：见共同约定。

副作用：持久化本人待上传记录并生成临时对象键；只签名，不转发文件字节。

## POST /api/v1/assets/{id}/complete

身份：资产所有者。

输入：路径为服务端生成的 UUID，正文必须为 `{}`。

成功：200 AssetView；已登记时重复调用返回同一原件，下载 URL 可重新签发。

错误：404 ASSET_NOT_FOUND；409 ASSET_UPLOAD_NOT_FOUND/ASSET_SIZE_MISMATCH/ASSET_SOURCE_CHANGED/ASSET_BUSY/ASSET_EXPIRED/ASSET_FINALIZE_SUPERSEDED；其余见共同约定。冲突可在明确原因后重试，源内容改变后应新建资产。

副作用：HEAD 核验长度及 ETag，持久冻结源标识并抢占，再按 ETag 条件复制和登记新的 raw 键。音频完成时核对本人原 staging 键和对象身份，为原 staging 和新 raw 明确使用 private ACL。PG 和 COS 分别提交，失败可能留下未登记的复制残留。成功的原件使用新 raw 键。计算已启用时，视频原件的 ready 登记与唯一 `(assetId, ordinary)` 派生意图同事务提交。后台使用持久的同一请求 ID 受理派生，经计算 outbox 投递。配额不足或暂时故障时保持 `pending`，容量恢复后继续；重复完成或重启不会重复创建派生任务。排队、失败及取消均保留已登记的原件和下载。计算产物直接登记 ready，无第二次自动派生。

## GET /api/v1/assets/{id}

身份：资产所有者。

输入：路径为服务端生成的 UUID，无查询参数。

成功：200 AssetView；上传未完成且已过 24 小时显示 expired。可下载的 ready 资源返回 5 分钟下载 URL，支持的音频 MIME 定向签发同一资产的 5 分钟播放 URL。原件视频返回当前派生状态。

错误：404 ASSET_NOT_FOUND；其余见共同约定。

副作用：读取本人元数据；ready 时在服务端签发下载地址，不读取或代理视频字节。
