# 消息中心 HTTP

配置与迁移见[公告配置](../notifications.md)。接口使用普通用户 Mio Cookie，由认证库实时核实主体，忽略 Bearer，不信任客户端 userId。所有响应含 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和 `X-Request-Id`，错误为 `{error:{code,message,requestId}}`。写入必须携带精确匹配认证允许列表的 Origin；JSON 写入读取完毕再次核实会话。允许来源的预检返回 204，携带具体方法、Content-Type 和凭据 CORS 响应头。

公告卡片仅含 `{id,title,body,publishedAt,isRead}`。只向登录用户返回已发布、已生效且启用的公告，顺序为 `publishedAt DESC, id DESC`；正文是纯文本，消费者应以文本显示。匿名、撤销或禁用用户返回 401 `UNAUTHORIZED`。共同错误包括 400 `QUERY_INVALID`／`BODY_INVALID`、403 `ORIGIN_REQUIRED`／`ORIGIN_DENIED`、404 `NOT_FOUND`／`ANNOUNCEMENT_NOT_FOUND`、405 `METHOD_NOT_ALLOWED`、408 `BODY_TIMEOUT`、413 `BODY_TOO_LARGE`、415 `JSON_REQUIRED`、503 `NOTIFICATIONS_UNAVAILABLE`。不返回数据库细节。

## GET /api/v1/announcements

身份：当前登录用户。

输入：`page` 默认 1，范围 1–1000000；`pageSize` 默认 10，范围 1–100，均为十进制正整数。不接受重复或额外查询参数。

成功：200 `{items:公告卡片[],page,pageSize,hasMore}`。非弹窗公告也在列表内；同一发布时间按 ID 倒序保持顺序。

错误：见共同约定。

副作用：只读查询公告与本人已读状态，不续期会话。

## GET /api/v1/announcements/latest-popup

身份：当前登录用户。

输入：无查询参数。

成功：200 `{announcement:公告卡片或null}`。只选择已发布、生效、启用且 `popup=true` 的最新一条；若本人已读该条，返回 null，即使仍有更早未读公告。最新元数据使用 4 秒缓存，同实例写入立即失效，其他实例按 TTL 收敛，未来生效时间会提前截断缓存期限。

错误：见共同约定。

副作用：不标记已读。缓存热且无活跃弹窗时公告域 0 条 SQL；缓存热且有弹窗时仅查一次 `(user_id,announcement_id)` 主键回执；认证查询另计。

## POST /api/v1/announcements/{id}/read

身份：当前登录用户，写入还要求允许的精确 Origin。

输入：UUID v4 公告 ID，JSON `{}`，不接受查询参数或额外正文键。

成功：200 `{ok:true}`；重复提交幂等。

错误：不存在、未发布、尚未生效或停用目标均为 404 `ANNOUNCEMENT_NOT_FOUND`；其余见共同约定。

副作用：只写当前认证用户的回执，跨退出、重登和服务重启保留。关闭弹窗、确认或打开详情由客户端调用同一接口；失败时客户端可关闭并提示下次可能再次提醒。

## GET /api/v1/notifications

身份：本人登录 Cookie，Origin、响应头与本页共同约定一致。仅在图片、视频、音频三条生产路径以及管理保留策略均可用时挂载创作日志入口，三类媒体一起开放。

输入：`type=creation_log` 必填；`page` 默认 1，范围 1–1000000；`pageSize` 默认 10，范围 1–100。下一页传上一页的 `nextCursor` 到 `cursor`，并递增 page；page 大于 1 时缺少游标返回 400 `CURSOR_REQUIRED`。不接受重复或额外参数，游标非法为 400 `QUERY_INVALID`。

成功：200 `{items,page,pageSize,hasMore,nextCursor}`。每项为 `{id,mediaType,jobId,eventKind,title,summary,occurredAt,isRead}`，`mediaType` 为 image／video／audio，`eventKind` 为 completed／partial／failed。标题和摘要是可公开给本人的纯文本，不含供应商原始响应、密钥或媒体正文。按原发生时间、UUID 倒序；不透明游标保留 PostgreSQL 微秒精度，游标对应记录被清理后仍可继续读取。只返回本人记录。

错误：管理策略快照不可用／过期时返回 503 `NOTIFICATIONS_UNAVAILABLE`；其余沿本页共同约定。

副作用：只读本人消息与已读状态。保留天数未设置时展示已有消息；设置后每次查询（包括旧游标续页）都按当前保留窗口过滤，恰满 `retentionDays × 24 小时` 即到期。延长后仅仍在库中的消息可重新展示，已清理的记录不回填。管理策略快照不可用／过期时返回 503 `NOTIFICATIONS_UNAVAILABLE`。

## PATCH /api/v1/notifications/{id}/read

身份：本人登录 Cookie，必须携带精确匹配允许列表的 Origin。JSON 读取完毕再次校验用户身份。

输入：UUID v4 ID、JSON `{}`，无查询参数或额外正文键。

成功：200 `{ok:true}`；重复提交保留首次已读时间。

错误：不存在、他人记录、已到期目标均为 404 `NOTIFICATION_NOT_FOUND`；其他错误沿本页共同约定。

副作用：只写当前用户的首次已读时间，跨重登和服务重启保存。

创作日志与固定 TTL 音频去重回执保存在媒体库 `MIO_ASSETS_DATABASE_URL`，显式迁移 `pnpm creation-logs:migrate` 默认预览，`--apply` 增量建表并保留已有记录；图片／视频迁移也包含同一结构。启动只读校验。后台每秒最多删除一批 100 条到期消息以及一批 100 条到期音频回执，使用 `LIMIT`、`FOR UPDATE SKIP LOCKED`，每批重新读取保留策略。音频回执自 recorded_at 起固定 8 天到期，不受无限保留或调长策略影响。U3 注销机制尚未接入本批代码，注销域实施时须将这些归属记录纳入其 24 小时清理。
