# 管理后台 HTTP 契约

[API 导航](index.md)；模型路由与平台目录白名单存储见[用户万联配置](../providers.md)，万联 SSO 配置与注册约束见[万联 OneLink SSO 契约](../integrations/onelink-sso.md)，计算任务与 Worker 遥测规则见[计算任务 HTTP](compute.md)与[Worker 并发观测与动态上限 PRD](../tasks/compute-service/changes/worker-observability/change.md)，中间件只读监控约束见[Redis 契约](../integrations/redis.md)与[RabbitMQ 契约](../integrations/rabbitmq.md)，需求与架构背景见[Web 管理后台 PRD](../tasks/web-admin-console/prd.md)与[万联第三方登录 PRD](../tasks/onelink-login/prd.md)。仅在完整配置认证、供应商域并显式设置 `MIO_ADMIN_ENABLED=true` 后注册。

## 本域共同约定

管理员身份独立于普通用户会话，仅由 HttpOnly Cookie `mio.admin_session`（`SameSite=Lax; Path=/api/v1/admin`，HTTPS Origin 下附加 `Secure`）提供；普通用户登录 Cookie 与 Foundation 服务 Bearer 均不能替代管理员会话。

所有写入请求（`POST`、`PUT`、`PATCH`、`DELETE`）必须携带允许列表内的精确 `Origin`（合并 `MIO_AUTH_ALLOWED_ORIGINS`、`MIO_AUTH_BASE_URL` 与可选 `MIO_ADMIN_ALLOWED_ORIGINS`）；携带正文的写入接口要求 `application/json`，常规接口上限 16384 字节，计算 Worker 动态调限写入上限 4096 字节，路由与模板写入上限 65536 字节，批量模型导入上限 262144 字节，读取期限均为 10 秒。`GET` 提供 `Origin` 时也须匹配。`OPTIONS` 预检无需登录但须匹配允许的 `Origin`。修改类入口在读取完请求体后重新核验管理员会话仍然有效。

计算 Worker 观测与调限接口（`/api/v1/admin/compute/*`）均为纯 JSON 管理接口，由独立管理前端 `mio-admin-web`（「计算 Worker」一级菜单）消费，本后端不托管任何静态前端页。只要配置 `MIO_COMPUTE_WORKER_INSTANCE_IDS`，A 即持续消费并落盘 Worker 遥测以防队列积压；启用 `MIO_ADMIN_ENABLED=true` 后经同一 `/api/v1/admin` 前缀开放查询与动态调限。启用管理后台但未配置计算 Worker 实例时，`/api/v1/admin/compute/*` 的 `OPTIONS` 仍返回合法 CORS 预检，其余请求先完成管理员会话鉴权（未登录严格返回 401 `ADMIN_UNAUTHORIZED`，不泄露配置状态），鉴权通过后返回 503 `COMPUTE_OPS_UNAVAILABLE`。Worker 观测跟踪最近一次观测和 A 接收时间，按 5 秒采样与轮询，超过 15 秒为过期，超过 60 秒为离线；`PUT /api/v1/admin/compute/workers/{id}/limits` 的审计操作人 `requestedBy` 记录当前管理员用户名 `admin.username`。

所有响应携带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 与 `X-Request-Id`，错误统一为 `{error:{code,message,requestId}}`，绝不返回密码哈希、会话令牌明文、API Key 明文/密文、OneLink SSO 加密密钥、监控连接密码、数据库栈或带签名的 COS URL。通用状态：400 `BODY_INVALID`/`QUERY_INVALID`/`ADMIN_INPUT_INVALID`/`ONELINK_SSO_NOT_CONFIGURED`/`WORKER_HARD_LIMIT_EXCEEDED`、401 `ADMIN_UNAUTHORIZED`/`ADMIN_INVALID_CREDENTIALS`/`ADMIN_PASSWORD_MISMATCH`、403 `ORIGIN_DENIED`/`ORIGIN_REQUIRED`、404 `NOT_FOUND`/`WORKER_NOT_FOUND`、405 `METHOD_NOT_ALLOWED`、408 `BODY_TIMEOUT`、409 `ADMIN_USERNAME_TAKEN`/`MODEL_ALREADY_EXISTS`/`TEMPLATE_KEY_TAKEN`/`SETTINGS_CONFLICT`/`ONELINK_REGISTER_IN_PROGRESS`/`WORKER_REVISION_CONFLICT`/`WORKER_NOT_OBSERVED`、413 `BODY_TOO_LARGE`、415 `JSON_REQUIRED`、503 `ADMIN_UNAVAILABLE`/`ONELINK_SSO_UNAVAILABLE`/`COMPUTE_OPS_UNAVAILABLE`。

永久注销属于认证独立终态，管理员会话与 `mio.admin_session` 仍隔离。全局认证策略和普通账号解禁均不能恢复已注销的旧 userId，不新增管理端“恢复注销”入口。全局设置写体仍仅 `{expectedRevision,auth}`，不以注销实现扩展该写体；审计不保存明文 smsBypassCode。注销任务监控与备份恢复走[认证运维规则](../auth.md#独立监控与灾备恢复)，不混入现有模型／Worker 运行期热配置。

## POST /api/v1/admin/auth/login

身份：匿名管理员登录入口。

输入：`{username,password}`；`username` 为 3 至 64 位 `[A-Za-z0-9_.-]` 字符串，`password` 为 8 至 128 位非空字符串，拒绝额外字段。

成功：200 `{admin:{id,username,isSuperAdmin,createdAt,updatedAt}}`，并签发 7 天有效期的 `mio.admin_session` Cookie（数据库仅存 `sha256Utf8` 令牌摘要）。

错误：账号不存在或密码不符统一返回 401 `ADMIN_INVALID_CREDENTIALS`；其余见共同约定。

副作用：创建一条管理员会话并顺带清理已过期会话。

## POST /api/v1/admin/auth/logout

身份：当前登录管理员（或携带待清除 Cookie）。

输入：`{}`。

成功：200 `{ok:true}`，并清除 `mio.admin_session` Cookie。

错误：见共同约定。

副作用：删除当前匹配的管理员会话记录。

## GET /api/v1/admin/auth/me

身份：当前登录管理员。

输入：无查询参数。

成功：200 `{admin:{id,username,isSuperAdmin,createdAt,updatedAt}}`。

错误：未登录或会话已过期/撤销返回 401 `ADMIN_UNAUTHORIZED`；其余见共同约定。

副作用：只读校验管理员会话，不续期或解密任何供应商凭据。

## PATCH /api/v1/admin/account

身份：当前登录管理员。

输入：`{username?,currentPassword?,newPassword?}`，至少提供 `username` 或 `newPassword` 之一。`username` 遵循 3 至 64 位 `[A-Za-z0-9_.-]`；提供 `newPassword`（8 至 128 位）时必须同时提供非空 `currentPassword`。

成功：200 `{admin:{id,username,isSuperAdmin,createdAt,updatedAt}}`。

错误：原密码不符为 401 `ADMIN_PASSWORD_MISMATCH`，新用户名已被占用为 409 `ADMIN_USERNAME_TAKEN`，缺少原密码或格式非法为 400 `ADMIN_INPUT_INVALID`；其余见共同约定。

副作用：在同一事务内更新用户名或密码哈希、写入管理员操作审计；修改密码成功后撤销该管理员除当前会话外的全部其他会话。

## GET /api/v1/admin/onelink/probe

身份：当前登录管理员。

输入：无查询参数。

成功：200 `{hasSavedKey,maskedHint,keyVersion,lastProbedAt,lastProbeStatus,lastProbeCount,lastProbeError,updatedBy,updatedAt}`；不返回明文或密文。

错误：见共同约定。

副作用：只读查询探测配置状态。

## DELETE /api/v1/admin/onelink/probe

身份：当前登录管理员。

输入：无正文。

成功：200 `{ok:true}`。

错误：见共同约定。

副作用：清除已保存的加密探测 Key，保留已入库记录并写入审计。

## POST /api/v1/admin/onelink/discover

身份：当前登录管理员。

输入：`{apiKey?,saveKey?}`。省略 `apiKey` 时使用已加密保存的常用探测 Key；提供 `apiKey` 时校验非空、最多 4096 字节且无空白/控制字符。`saveKey` 可选布尔值，默认 `false`。

成功：200 `{status,checkedAt,discoveredCount,newCount,existingCount,ignoredCount,totalCatalogCount,savedKey,error,candidates}`。`status='connected'` 时更新上游探测快照表 `mio_admin_catalog_models`，并对照平台模型主表 `mio_provider_catalog_models` 与忽略表 `mio_admin_ignored_models` 返回每项候选的 `importState`（`new | existing | ignored`），**不自动向平台模型主表写入未勾选的模型**；`saveKey=true` 时以 `MIO_PROVIDERS_MASTER_KEY` 和独立 AAD 加密保存该探测 Key，否则 `apiKey` 仅在当次请求内存使用后丢弃。

错误：未提供 `apiKey` 且未保存探测 Key 返回 400 `PROBE_KEY_REQUIRED`，Key 格式非法返回 400 `PROVIDER_KEY_INVALID`，主密钥不匹配无法解密已存探测 Key 返回 503 `PROBE_CREDENTIAL_UNAVAILABLE`；上游失败以 200 `{status:'failed',error:'UPSTREAM_...'}` 返回脱敏原因码。

副作用：单次受控请求 OneLink `GET /v1/models`，更新探测缓存与可选加密探测凭据状态，记录管理员审计。

## GET /api/v1/admin/onelink/candidates

身份：当前登录管理员。

输入：无查询参数。

成功：200 `{totalProbeModels,newCount,existingCount,ignoredCount,candidates}`，读取最近一次成功探测缓存的上游候选模型及其实时 `importState`。

错误：见共同约定。

副作用：只读查询，不联网。

## GET /api/v1/admin/onelink/sso

身份：当前登录管理员。

输入：无查询参数。

成功：200 `{config:{environment,enabled,clientName,clientId,expectedClientId,registrationStatus,registrationSource,lastRegisterCode,lastRegisterTraceId,lastRegisterMessage,lastRegisteredAt,revision,updatedBy,updatedAt},runtime:{configured,hasEncryptionKey,authorizeOrigin,registerOrigin,callbackUrl,tokenVerificationMode}}`。当 `mio_admin_onelink_sso_config` 尚无当前环境记录时，默认返回 `enabled:false`、`registrationStatus:'unregistered'`、`revision:0` 与空注册元数据；`runtime.tokenVerificationMode` 固定返回 `'payload_sub_unverified'`，`runtime` 仅报告配置就绪度与脱敏后的 origin/回调地址，绝不返回 `MIO_ONELINK_SSO_ENC_KEY`。

错误：见共同约定。

副作用：读取当前环境的万联 SSO 配置并同步刷新内存策略快照，不修改数据库且不联网。

## PATCH /api/v1/admin/onelink/sso

身份：当前登录管理员；读取请求体后重新核验管理员会话仍然有效。

输入：`{expectedRevision,enabled,expectedClientId?}`，严格拒绝额外字段。`expectedRevision` 为非负整数；`enabled` 为布尔值；`expectedClientId` 可省略、为 `null` 或 `1..128` 字符且不含空白/控制字符且不为 `routerClientId` 的字符串。

成功：200，返回结构与 `GET /api/v1/admin/onelink/sso` 相同；首次写入后 `revision` 为 `1`，后续每次更新递增 `1`。

错误：服务端未配齐 OneLink SSO 环境变量却尝试设置 `enabled:true` 返回 400 `ONELINK_SSO_NOT_CONFIGURED`，字段非法或传入 `routerClientId` 返回 400 `ADMIN_INPUT_INVALID`，`expectedRevision` 冲突返回 409 `SETTINGS_CONFLICT`；其余见共同约定。

副作用：在单事务内按乐观锁写入 `mio_admin_onelink_sso_config` 并记录 `action='onelink.sso.update'`、`target_id=<environment>` 的脱敏审计日志；事务提交后立即刷新内存只读策略快照，无需重启服务。

## POST /api/v1/admin/onelink/sso/register

身份：当前登录管理员；读取请求体后重新核验管理员会话仍然有效。

输入：`{}`，严格拒绝额外字段。

成功：200 `{outcome,upstreamCode,errorCode,traceId,config,runtime}`，其中 `outcome` 为 `'registered' | 'already_exists_trusted' | 'rejected' | 'failed'`。`200` 校验合法 `clientId` 后持久化为 `registrationStatus='registered'` 并保留既有 `enabled` 与 `expectedClientId`；`362` 不阻塞，保留既有配置与已有 `clientId`（无 `clientId` 时按 `expectedClientId ?? clientName` 标记为 `trusted_existing`）；`363`、`364` 及上游故障返回脱敏 `errorCode`（`ONELINK_CLIENT_NAME_INVALID`/`ONELINK_CLIENT_TEMPLATE_MISSING`/`ONELINK_REGISTER_UPSTREAM_FAILED`）与 `traceId`，不覆盖既有配置或登记状态。

错误：服务端未配置 OneLink SSO 返回 503 `ONELINK_SSO_UNAVAILABLE`，已有同进程注册请求在途返回 409 `ONELINK_REGISTER_IN_PROGRESS`；其余见共同约定。

副作用：单次受控向配置的万联注册地址发送 `POST {"clientName":"<clientName>"}`（10 秒超时、32 KiB 响应上限、拒绝重定向、零重试），按结果更新配置表、刷新内存策略快照并写入 `onelink.sso.register` 或脱敏的 `onelink.sso.register_failed`（仅含 `code` 与 `traceId`）审计日志。

## POST /api/v1/admin/models/import

身份：当前登录管理员。

输入：`{items,overwriteMetadata?}`，单批 1 至 500 项，每项支持 `{rawModelId,displayLabel?,vendorLabel?,category?,description?,supplierMetadata?,userVisible?,allowUndiscovered?,callNotes?}`。

成功：200 `{imported,updated,skipped}`。

错误：400 `ADMIN_INPUT_INVALID`；其余见共同约定。

副作用：将管理员勾选的模型写入平台模型主表 `mio_provider_catalog_models`（`origin_source='onelink-import'`），移除同 ID 的忽略标记，按需物化补录隐藏型号并写入审计。

## GET /api/v1/admin/models

身份：当前登录管理员。

输入：可选查询参数 `q`（关键词）、`category`（`chat|image|video|voice|music`）、`status`（`enabled|disabled|pending`）、`visibility`（`visible|hidden|curated`）。

成功：200 `{summary,items}`。以平台模型主表 `mio_provider_catalog_models` 为权威来源，合并探测命中标记、跨用户脱敏发现/实测统计、平台路由及可见性/补录策略，不暴露普通用户账号明细或私有凭据。每个模型的 `audioRoutes` 返回语音操作的 `operation`、`route`、`enabled`、`declarationVersion`、`verifiedUserCount` 和 `updatedAt`。`status` 筛选和路由汇总包含语音操作。语音实测人数按各操作的当前验证元组计算。

错误：400 `QUERY_INVALID`；其余见共同约定。

副作用：只读聚合查询，不解密、不联网。

## POST /api/v1/admin/models

身份：当前登录管理员。

输入：`{rawModelId,displayLabel?,vendorLabel?,category?,description?,userVisible?,allowUndiscovered?,callNotes?}`。

成功：201 `{model}`。

错误：ID 已存在返回 409 `MODEL_ALREADY_EXISTS`，输入非法返回 400 `ADMIN_INPUT_INVALID`；其余见共同约定。

副作用：在平台模型主表新建模型（`origin_source='admin-manual'`），按需向有效用户物化隐藏补录型号并写入审计。

## PATCH /api/v1/admin/models

身份：当前登录管理员。

输入：`{rawModelId,displayLabel?,vendorLabel?,category?,description?,userVisible?,allowUndiscovered?,callNotes?}`。

成功：200 `{model}`。

错误：目标不存在返回 404 `MODEL_NOT_FOUND`，输入非法返回 400 `ADMIN_INPUT_INVALID`；其余见共同约定。

副作用：更新平台模型主表元数据与可见性/补录开关并写入前后快照审计，即时作用于普通用户目录与调用门控。

## DELETE /api/v1/admin/models

身份：当前登录管理员。

输入：`{rawModelId,ignoreFutureImports?,summary?}`。

成功：200 `{ok:true,rawModelId,deletedRoutesCount}`。

错误：目标不存在返回 404 `MODEL_NOT_FOUND`；其余见共同约定。

副作用：级联删除该模型关联的平台路由（追加 `action='delete'` 修订快照），从 `mio_provider_catalog_models` 移除该模型（启用平台白名单时普通用户即时隐藏并阻断调用），可选写入 `mio_admin_ignored_models` 防止后续预览默认勾选，并记录删除审计。

## POST /api/v1/admin/routes

身份：当前登录管理员。

输入：`{routes,summary?}` 或单条 `{route,summary?}`；严格复用逻辑路由器 `validateRouteImportPayload` 校验（单批 1 至 500 条，上限 65536 字节），`summary` 可选最多 500 字符。

成功：200 `{total,inserted,updated,unchanged,revisions}`。

错误：路由规格不合法返回 400 `ROUTE_INVALID`；其余见共同约定。

副作用：在事务内确保模型在 `mio_provider_catalog_models` 登记、写入 `mio_provider_model_routes`（实质变更递增 `declaration_version` 使旧版用户验证自动回到 `unverified`），并追加修订快照。

## DELETE /api/v1/admin/routes

身份：当前登录管理员。

输入：`{rawModelId,operation,summary?}`，`operation` 可为 `chat`、`image.generate`、`audio.voices.list`、`audio.tts` 或 `audio.clone`。

成功：200 `{deleted:{id,rawModelId,operation,declarationVersion,action:'delete'}}`。

错误：目标路由不存在返回 404 `ROUTE_NOT_FOUND`；其余见共同约定。

副作用：删除指定操作的平台路由并写入 `action='delete'`、`after_route=null` 修订快照。

## POST /api/v1/admin/routes/rollback

身份：当前登录管理员。

输入：`{revisionId,summary?}`；`revisionId` 为目标历史修订 UUID。

成功：200 `{revisionId,rawModelId,operation,declarationVersion,unchanged}`。

错误：未知修订 ID 返回 404 `REVISION_NOT_FOUND`，指向 `delete` 空快照修订返回 400 `REVISION_NOT_RESTORABLE`；其余见共同约定。

副作用：读取目标历史修订的 `after_route` 重新经同一校验与版本递增事务发布为新版本，并写入 `action='rollback'` 修订记录。

## GET /api/v1/admin/templates

身份：当前登录管理员。

输入：无查询参数。

成功：200 `{drivers:{chat,image,audio},categories,items}`，返回服务端已实现的协议驱动枚举及数据库中按 `sortOrder` 排序的全部动态快捷配置模板（含 `routeTemplate` 与 `uiHints`）。

错误：见共同约定。

副作用：只读查询。

## POST /api/v1/admin/templates

身份：当前登录管理员。

输入：`{templateKey,label,description?,sortOrder?,routeTemplate,uiHints?}`；`templateKey` 为 2 至 64 位 `[a-z0-9][a-z0-9_-]*`，`routeTemplate` 经 `validateModelRouteEntry` 严格校验协议合法性。

成功：201 `{template}`。

错误：`templateKey` 冲突返回 409 `TEMPLATE_KEY_TAKEN`，协议规格非法返回 400 `ROUTE_INVALID`；其余见共同约定。

副作用：向 `mio_admin_route_templates` 新增动态模板并写入审计。

## PUT /api/v1/admin/templates

身份：当前登录管理员。

输入：`{id,templateKey,label,description?,sortOrder?,routeTemplate,uiHints?}`。

成功：200 `{template}`。

错误：模板不存在返回 404 `TEMPLATE_NOT_FOUND`，`templateKey` 冲突返回 409 `TEMPLATE_KEY_TAKEN`，协议规格非法返回 400 `ROUTE_INVALID`；其余见共同约定。

副作用：更新指定动态模板并写入前后快照审计。

## DELETE /api/v1/admin/templates

身份：当前登录管理员。

输入：`{id}`。

成功：200 `{ok:true}`。

错误：模板不存在返回 404 `TEMPLATE_NOT_FOUND`；其余见共同约定。

副作用：从 `mio_admin_route_templates` 删除指定模板并写入审计；已初始化库重跑迁移不会复活已删模板。

## GET /api/v1/admin/revisions

身份：当前登录管理员。

输入：可选查询参数 `rawModelId`、`limit`（1 至 100，默认 50）。

成功：200 `{routeRevisions,auditLogs}`，按时间倒序返回路由版本快照与模型/模板/账号/全局配置管理审计（全局配置审计仅保存脱敏后的 `smsBypassCodeMasked`，绝不含固定验证码明文）。

错误：400 `QUERY_INVALID`；其余见共同约定。

副作用：只读查询。

## GET /api/v1/admin/monitoring

身份：当前登录管理员。

输入：可选查询参数 `window`（`24h|7d|30d|all`，默认 `7d`）。

成功：200 `{window,generatedAt,providers,images,conversations,compute,rabbitmq,redis}`。除跨库脱敏聚合供应商凭据状态、图片生成三类失败桶、对话状态与计算 Outbox/Jobs 汇总外，并发返回由独立只读身份采集的 `rabbitmq`（Broker 版本、连接/通道、速率、节点内存/磁盘告警、各队列 Ready/Unacked/Consumers 与 DLQ 死信数）与 `redis`（PING RTT、时钟偏差、128 MiB 内存水位与 OOM 预警、`DBSIZE`、客户端连接、每秒 OPS 与 AOF 持久化状态）；未配置监控 URL 时对应项返回 `configured:false,status:'unconfigured'`。

错误：400 `QUERY_INVALID`；其余见共同约定。

副作用：执行有界只读聚合与隔离监控探针，不输出提示词、用户隐私、业务键值、API Key 或签名 URL。

## GET /api/v1/admin/settings/global

身份：当前登录管理员。

输入：无查询参数。

成功：200 `{settings:{auth:{emailPasswordEnabled,smsMode,smsBypassCode},revision,updatedBy,updatedAt},runtime:{envEmailPasswordDefault,smsProviderConfigured}}`。当 `mio_admin_global_settings` 尚无 `'auth'` 记录时，返回 `revision:0`、`emailPasswordEnabled:envEmailPasswordDefault`、`smsMode:'live'`、`smsBypassCode:null`、`updatedBy:null`、`updatedAt:null`。`runtime` 返回启动环境默认开关与当前进程是否配置腾讯短信供应商。

错误：见共同约定。

副作用：读取数据库中的全局认证配置并同步刷新服务内存策略快照，不修改数据库且不联网。

## PATCH /api/v1/admin/settings/global

身份：当前登录管理员；读取请求体后重新核验管理员会话仍然有效。

输入：`{expectedRevision,auth:{emailPasswordEnabled,smsMode,smsBypassCode}}`，严格拒绝额外字段。`expectedRevision` 为非负整数；`auth.emailPasswordEnabled` 为布尔值；`auth.smsMode` 为 `'live' | 'bypass' | 'disabled'`；当 `smsMode='bypass'` 时 `auth.smsBypassCode` 必须为 6 位数字字符串（`/^\d{6}$/`），其他模式下允许为 `null` 或 6 位数字字符串。

成功：200，返回结构与 `GET /api/v1/admin/settings/global` 相同；首次写入后 `revision` 为 `1`，后续每次成功更新递增 `1`。

错误：输入非法为 400 `ADMIN_INPUT_INVALID`；`expectedRevision` 与数据库当前版本不一致为 409 `SETTINGS_CONFLICT`；其余见共同约定。

副作用：在单事务内按乐观锁写入 `mio_admin_global_settings` 并记录 `action='settings.global.update'`、`target_id='auth'` 的审计日志（`summary`、`before_state` 与 `after_state` 均绝不写入 `smsBypassCode` 明文，仅以 `smsBypassCodeMasked` 保存前两位加 `****` 或 `null`）；事务提交后立即热更新内存认证策略快照，无需重启服务即可作用于下一次认证请求（详见[认证 HTTP 契约](auth.md)）。

## GET /api/v1/admin/compute/summary

身份：当前登录管理员。

输入：无查询参数。

成功：200 返回实例新鲜度计数、在线实例已采样的实际占用、生效与部署硬上限、待槽、HOLD、A 侧转码/媒体待发数和最近一小时每实例事件峰值。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`（未登录或普通用户 Cookie），403 `ORIGIN_DENIED`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## GET /api/v1/admin/compute/workers

身份：当前登录管理员。

输入：可选 `limit` 为 1–64，默认 32；可选 `offset` 为 0–64，默认 0。

成功：200 按实例 ID 返回分页，以 `MIO_COMPUTE_WORKER_INSTANCE_IDS` 配置实例为范围。无心跳的实例保留身份及未观测状态。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## GET /api/v1/admin/compute/workers/{id}

身份：当前登录管理员。

输入：部署清单中的实例 ID，无查询参数。

成功：200 返回最近 boot、心跳与接收时间、实际/生效/硬限、等待、HOLD、活动执行、排空和 desired 状态。过期快照不代表当前进程仍在或已经退出。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`，404 `NOT_FOUND`（路径非法或实例不在部署清单内），503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## GET /api/v1/admin/compute/executions

身份：当前登录管理员。

输入：可选 `instanceId`、`jobId`、`state` 及 `limit`。状态支持 `queued`、`active`、`released`、`cancelled`、`unknown`。默认 40，最多 100 条。

成功：200 返回最新优先的执行、协议、资源、归属、任务/attempt/inspection 身份与已知占槽时间。

独立视频探测使用 `protocol="video.probe.v1"`，包含视频生成任务 `jobId` 及探测 `attemptId`，`inspectionId` 为 null。资源为 `probe`，占用一个槽。时间线提供实际下载、探测与收尾阶段。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## GET /api/v1/admin/compute/executions/{id}

身份：当前登录管理员。

输入：执行 UUID，无查询参数。

成功：200 返回一条执行及至多 1000 条按同 boot sequence 排序的真实阶段/占槽事件。无法确认释放时保留未知，只有实际记录可建立结束时间。同实例同次启动的实际事件缺口若可能改变此前记录的等待状态，该状态也标为未知。缺口和排队事件可以乱序到达。业务结果仍由计算任务接口管理。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`，404 `NOT_FOUND`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## GET /api/v1/admin/compute/history

身份：当前登录管理员。

输入：可选 `instanceId`、`since`、`until`、`limit`。默认最近 1 小时与 720 点。起止使用 UTC ISO 8601 整秒或毫秒，最大 7 天、1000 点。

成功：200 返回范围内最新 N 点，按时间正序。单实例保留原始样本。汇总取各实例在该时刻之前 15 秒内的最新样本并求和，缺测区间与时钟差分别标记。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## GET /api/v1/admin/compute/limits

身份：当前登录管理员。

输入：可选 `instanceId`、`limit`。默认 40，最多 100 条。

成功：200 返回最新调限审计，含操作管理员用户名（`requestedBy`）、前后值、revision、派发后的实际结果和已知确认时间。

错误：400 `QUERY_INVALID`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或查询不可用）。

副作用：只读查询，无副作用。

## PUT /api/v1/admin/compute/workers/{id}/limits

身份：当前登录管理员；读取最多 4096 字节、10 秒的 JSON 后复核原管理员会话仍有效且为同一管理员，`requestedBy` 记录当前管理员用户名 `admin.username`。

输入：实例 ID 与 JSON `{expectedRevision,total,encode,probe}`，四项均为非负安全整数，无查询参数。各项上限由此实例部署硬限约束；零表示暂停相应新准入。

请求媒体类型为 `application/json`，按大小写不敏感比较并允许携带类型参数。

成功：202 保存修订并等待 Worker 回执。只有匹配的应用结果表示已生效。离线也可保存已观测过实例的修订并保留待生效。

错误：400 `BODY_INVALID`/`QUERY_INVALID`/`WORKER_HARD_LIMIT_EXCEEDED`，401 `ADMIN_UNAUTHORIZED`，403 `ORIGIN_DENIED`/`ORIGIN_REQUIRED`，404 `NOT_FOUND`/`WORKER_NOT_FOUND`，409 `WORKER_REVISION_CONFLICT`/`WORKER_NOT_OBSERVED`，408 `BODY_TIMEOUT`，413 `BODY_TOO_LARGE`，415 `JSON_REQUIRED`，503 `COMPUTE_OPS_UNAVAILABLE`（未配置 Worker 实例或写入不可用）。

副作用：事务写入不可变审计（`requested_by` 为当前 `admin.username`）、desired 配置和控制 outbox，并立即唤醒控制派发。B 取得后持久化校验结果，降限让占槽任务继续完成；上调或暂停只改变该实例的新准入。

## GET /api/v1/admin/announcements

身份：当前管理员，沿用 `mio.admin_session`；普通用户 Cookie 和部署 Bearer 均不授权。配置见[公告配置](../notifications.md)。

输入：`page` 默认 1、范围 1–1000000，`pageSize` 默认 10、范围 1–100，均为十进制正整数，拒绝重复和额外参数。

成功：200 `{items,page,pageSize,hasMore}`。每项含 `id,title,body,status,enabled,popup,effectiveAt,publishedAt,createdAt,updatedAt,isRead`；管理列表 `isRead` 固定为 false，不读取用户回执。按发布时间及 ID 倒序，空发布时间草稿在后。

错误：未登录 401 `ADMIN_UNAUTHORIZED`；启用公告域前已登录请求返回 503 `NOTIFICATIONS_UNAVAILABLE`；其余沿用共同约定。

副作用：只读查询，包括草稿、停用及未来公告，不续期会话。

## GET /api/v1/admin/announcements/{id}

身份：当前管理员。

输入：UUID v4 公告 ID，无查询参数。

成功：200 `{announcement:{id,title,body,status,enabled,popup,effectiveAt,publishedAt,createdAt,updatedAt}}`。

错误：404 `ANNOUNCEMENT_NOT_FOUND`；其余沿用管理和公告共同约定。

副作用：只读，不记录用户已读。

## POST /api/v1/admin/announcements

身份：当前管理员，必须有允许列表精确匹配的 Origin。

输入：JSON `{title,body,enabled?,popup?,effectiveAt?}`，标题非空且最多 200 个 Unicode 字符，纯文本正文非空且最多 16000 个字符；`enabled` 默认 true，`popup` 默认 false。`effectiveAt` 为带时区的 ISO 时间或 null（立即生效）；无查询参数，拒绝额外键。正文上限 64 KiB。

成功：201 `{announcement}`，结构同详情；始终创建草稿，`publishedAt=null`。

错误：400 `ANNOUNCEMENT_INPUT_INVALID`；其余沿用共同约定。审计或数据库暂不可用返回 503。

副作用：先向现有 `mio_admin_audit_logs` 独立提交 `announcement.create` 操作意图，再创建公告草稿；真实管理员 ID、用户名和新公告 ID 被保留。审计失败阻止公告写入；公告库失败时保留尝试审计，其摘要不表示变更成功。公告和审计没有跨库事务。所有公告写入结束即使同实例元数据缓存失效，旧在途查询不能重新填回旧值；其他实例按 4 秒 TTL 收敛。

## PATCH /api/v1/admin/announcements/{id}

身份：当前管理员，必须有允许的精确 Origin。

输入：至少一个 `{title?,body?,enabled?,popup?,effectiveAt?}`，各字段约束同创建；不得直接设置 status、发布时间或身份，无查询参数。

成功：200 `{announcement}`。发布后编辑沿用原发布时间；`enabled=false` 使公告从用户查询中移除。

错误：400 `ANNOUNCEMENT_INPUT_INVALID`、404 `ANNOUNCEMENT_NOT_FOUND`；其余沿用共同约定。

副作用：按公告行锁串行编辑，保留 `announcement.update` 操作意图审计，缓存行为及跨库失败语义同创建。

## POST /api/v1/admin/announcements/{id}/publish

身份：当前管理员，必须有允许的精确 Origin。

输入：JSON `{}`，无查询参数。

成功：200 `{announcement}`；状态变为 published，首次发布生成发布时间。已发布时重复发布保留原发布时间；未来生效或停用公告仍不向用户可见。

错误：404 `ANNOUNCEMENT_NOT_FOUND`；其余沿用共同约定。

副作用：公告域行锁更新并记录 `announcement.publish` 操作意图；缓存与审计边界同创建。

## POST /api/v1/admin/announcements/{id}/unpublish

身份：当前管理员，必须有允许的精确 Origin。

输入：JSON `{}`，无查询参数。

成功：200 `{announcement}`；状态变回 draft，发布时间清空，用户不可见。再次发布取得新的发布时间。

错误：404 `ANNOUNCEMENT_NOT_FOUND`；其余沿用共同约定。

副作用：保留内容及已读记录，记录 `announcement.unpublish` 操作意图；缓存与审计边界同创建。

## DELETE /api/v1/admin/announcements/{id}

身份：当前管理员，包含 DELETE 在内必须有允许列表精确匹配的 Origin。

输入：UUID v4 公告 ID，无正文及查询参数；独立管理前端先完成删除确认。

成功：200 `{ok:true}`。

错误：404 `ANNOUNCEMENT_NOT_FOUND`；其余沿用共同约定。

副作用：删除公告及同域全部回执，保留管理员域 `announcement.delete` 操作意图审计，不能恢复公告；缓存与跨库失败边界同创建。不新增账号注销机制。

## GET /api/v1/admin/settings/creation-logs

身份：独立管理员 Cookie 会话；普通用户 Cookie、服务 Bearer 均无权限。来源及响应头沿管理域共同约定。

输入：无查询参数或正文。

成功：200 `{revision,retentionDays}`。首次设置前为 `{revision:0,retentionDays:null}`；已有配置从管理库回读，重启保留。

错误：401 `ADMIN_UNAUTHORIZED`；503 `ADMIN_UNAVAILABLE`；其余沿管理域共同约定。

副作用：只读配置并刷新进程内只读快照，不改写配置或操作审计。

## PATCH /api/v1/admin/settings/creation-logs

身份：独立管理员 Cookie，必须携带精确匹配允许列表的 Origin。请求读取完毕再次校验管理员会话。

输入：JSON 体严格为 `{expectedRevision,retentionDays}`；`expectedRevision` 为非负整数，`retentionDays` 为安全正整数，不接受 null、零、负数、小数或字符串。`/settings/global` 仍只接收 `{expectedRevision,auth}`。

成功：200 `{revision,retentionDays}`，版本递增。

错误：版本冲突为 409 `SETTINGS_CONFLICT`，非法输入为 400 `ADMIN_INPUT_INVALID`；503 `ADMIN_UNAVAILABLE`；其余沿管理域共同约定。

副作用：管理库一个事务内完成配置版本检查、更新及 `settings.creation-logs.update` 审计；审计包含操作者和前后天数／版本，审计失败回滚配置。保存实例立即更新进程内只读快照，其他实例每秒刷新、快照最长有效 5 秒；刷新失败并过期后，创作日志读取／清理失败关闭，不退回无限保留。用户热路径不查询管理库。设置缩短或首次保存时，管理端应先提示超期旧消息会被清理。更改仅影响创作消息和已读状态，作品、生成历史和公告沿各自规则。

## GET /api/v1/admin/settings/storage

身份：独立管理员 Cookie 会话；普通用户 Cookie、服务 Bearer 均不授权。来源及响应头沿管理域共同约定。

输入：无查询参数或正文。

成功：200 `{revision,quotaBytes,warningAvailableBytes}`。首次配置前为 `{revision:0,quotaBytes:5368709120,warningAvailableBytes:1073741824}`（5 GiB 配额、1 GiB 提醒阈值）；已有配置从管理库回读，重启保留。

错误：401 `ADMIN_UNAUTHORIZED`；503 `ADMIN_UNAVAILABLE`；其余沿管理域共同约定。

副作用：只读配置并刷新进程内只读快照，不写配置或审计。缺配置才使用默认值，已有但格式损坏的配置失败关闭，不自动覆盖。

## PATCH /api/v1/admin/settings/storage

身份：独立管理员 Cookie，必须携带精确匹配允许列表的 Origin。请求读取完毕再次校验管理员会话。

输入：JSON `{expectedRevision,quotaBytes?,warningAvailableBytes?}`，至少提交一个配置字段，拒绝额外字段及查询参数。`expectedRevision` 为 0–2147483647 的整数；字节值须为安全正整数，不接受 null、小数、字符串或超出安全整数的值。省略字段保留当前值，管理库事务内合并后必须满足 `0 < warningAvailableBytes < quotaBytes`。可同时调整两项。前端按 GiB 展示，服务端以字节保存；`/settings/global` 仍只接收认证配置。

成功：200，结构同 GET。生效值有变化时版本加一（首次变更为 1）；合并后与当前值相同则返回当前版本，不递增、不写配置或变更审计。首次保存与默认值相同也保留版本 0。旧版本即使提交相同值也返回 409。

错误：400 `ADMIN_INPUT_INVALID`；409 `SETTINGS_CONFLICT`；503 `ADMIN_UNAVAILABLE`；其余沿管理域共同约定。

副作用：复用 `mio_admin_global_settings` 的 `storage` 记录，在同一个管理库事务内按版本、行锁完成合并校验、配置写入和 `settings.storage.update` 审计（`target_id='storage'`，记录管理员 ID／用户名与前后值／版本）。首次写入竞争通过主键冲突返回 409；审计失败回滚配置。只修改全局策略，不逐账号更新。

服务内同步 `getStoragePolicy(): StorageSettings` 返回不可变快照，供用户用量热路径直接读取，单次读取不查询管理库。保存实例在事务成功完成后立即刷新，并从完成时刻重新计算最长 5 秒有效期，避免锁等待消耗刚保存配置的有效期。其他实例每秒后台刷新，查询取得的快照仍从查询开始时计时；慢查询和失败均不延长旧快照寿命，过期返回 503 `STORAGE_POLICY_UNAVAILABLE`。旧在途查询不能覆盖本机刚保存的新版本，卸载时停止轮询并等待在途刷新结束。此处短快照用于满足[个人中心 U6](../tasks/personal-center/prd.md#u6-存储用量与提醒)的同步读和跨实例收敛要求，不新增 Redis 缓存或通用配置框架。

配额只用于计量和提醒，实际用量可超过配额；此配置不拦截上传、生成、查看、下载或清理，不新增空间预留、限写或降级字段。
