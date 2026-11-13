# 用户万联 HTTP 契约

[API 导航](index.md)；持久化、迁移、部署适配和验证语义见[用户万联配置](../providers.md)，出站见[万联集成](../integrations/onelink.md)。仅在完整配置供应商域与认证后注册。

## 本域共同约定

身份来自登录 Cookie 的 Authentication.identity，服务 Bearer 不能替代用户。正文不得自授 owner、配置 ID、URL、header 或权限。写入要求精确允许 Origin 和 application/json；GET 提供 Origin 时也须匹配。OPTIONS 无需登录，需允许 Origin。JSON 最多 8192 字节、10 秒，拒绝额外字段/非法类型；读取正文后复核登录。

错误为 `{error:{code,message,requestId}}`，所有响应 no-store，带 X-Content-Type-Options 与 X-Request-Id，不透传源错误或凭据。通用状态：400 BODY_INVALID/QUERY_INVALID，401 UNAUTHORIZED，403 ORIGIN_DENIED/ORIGIN_REQUIRED，404 NOT_FOUND/PROVIDER_NOT_CONFIGURED，405 METHOD_NOT_ALLOWED，408 BODY_TIMEOUT，413 BODY_TOO_LARGE，415 JSON_REQUIRED，409 PROVIDER_REVISION_CONFLICT，503 PROVIDER_UNAVAILABLE。

ProviderView 保留 `id/type/enabled/hasKey/masked/credentialVersion/revision/defaultImageWatermark/defaultVideoWatermark`，并提供：

- `catalog={version,credentialVersion,succeededAt,current,stale}`：从未成功时前三项 null；轮换保留旧成功版本但 current=false；同凭据最近失败时 stale=true。
- `credentialAuthState=unchecked|valid|rejected`。
- `lastAttempt=null|{seq,credentialVersion,startedAt,finishedAt,status,error}`，status 为 running/connected/failed，进行中 finishedAt=null。
- `discovery=null|{credentialVersion,refreshSeq,checkedAt,status,scope:'models-only',ids,error}`：最近完成的本凭据尝试；失败 ids=[]，不能代替 catalog 判断成功快照，升级承接的旧成功通过 catalog 展示。

revision 在配置/模型展示信息/偏好/部署声明修改、刷新开始及结束递增；客户端修改先读取最新值。

## GET /api/v1/providers/onelink

身份：当前登录用户。

输入：无查询参数。

成功：200 本人 ProviderView；未配置为 null，不返回明文/密文。

错误：见共同约定。

副作用：只读，不解密或联网。

## PUT /api/v1/providers/onelink/credential

身份：当前登录用户。

输入：`{apiKey,expectedRevision}`。初建 revision=0，否则为当前非负整数且小于 2147483647。Key 非空、最多 4096 字节，无空白、控制字符、`*` 或 `•`。

成功：200 ProviderView；初建 enabled=true、水印 false。轮换递增凭据版本，清空本凭据尝试、auth=unchecked，旧目录和模型留历史，保留偏好/default 目标，须重新成功发现。

错误：400 PROVIDER_KEY_INVALID，409 PROVIDER_REVISION_CONFLICT。

副作用：事务替换当前 AEAD 密文，不联网，无历史 Key 查询/删除入口。

## PATCH /api/v1/providers/onelink

身份：当前登录用户。

输入：expectedRevision 和至少一个布尔值 `enabled/defaultImageWatermark/defaultVideoWatermark`。

成功：200 ProviderView。禁用保留目录和偏好，阻止新调用；显式只读目录测试仍允许。

错误：404 PROVIDER_NOT_CONFIGURED，409 PROVIDER_REVISION_CONFLICT。

副作用：事务修改配置/revision，不联网。

## POST /api/v1/providers/onelink/test

身份：当前登录用户。

输入：`{}`。

成功：200 discovery；connected 表示完整目录成功，空列表也是成功。failed 携稳定脱敏 error：UPSTREAM_AUTH_REJECTED/RATE_LIMITED/UNAVAILABLE/TIMEOUT/CANCELLED/RESPONSE_INVALID/RESPONSE_TOO_LARGE/RESPONSE_OR_TRANSPORT_ERROR（各项均带 UPSTREAM_ 前缀）。失败不覆盖同凭据最近成功快照；认证失败额外阻止新调用。

错误：409 PROVIDER_CREDENTIAL_CHANGED 或 PROVIDER_REFRESH_SUPERSEDED 表示响应已失效、未发布；503 PROVIDER_CREDENTIAL_UNAVAILABLE 表示不能验证密文，最近尝试仍记录失败。

副作用：先分配持久刷新序号，解密本人当前 Key，固定 GET 目录；完整成功事务发布新目录，其他结果只更新尝试/认证状态。不生成、不自动重试，晚到响应不能覆盖最新发起的尝试。

## GET /api/v1/providers/onelink/models

身份：当前登录用户。

输入：可选单个 category=chat/image/video/voice/music；只筛供应商/部署声明分类，null 分类不自动进入 chat。

成功：200 `{provider,items,defaults}`。items 含稳定 modelRef/modelKey、精确 modelId、`name`、`description`、`nameOverride`、`descriptionOverride`、可空 category/classificationSource、supplierMetadata、membership、credentialVersion/catalogVersion、firstSeenAt/lastSeenAt、legacyRef、discovered、adaptation、preferences、chat 的 enabled/isDefault/runnable/unavailableReason。`name` 使用用户覆盖，否则使用精确 modelId；历史不可解析项二者均可为 null。`description` 使用用户覆盖，否则使用供应商字符串描述，均缺失为 null。两个 Override 字段为可空的实际用户覆盖，可区分回退；空字符串是实际覆盖。modelRef 为 `onelink:model:<UUID>`。返回 current/removed/historical 实体，discovered 只表示当前成功成员。

adaptation 为 null 或 `{operation,profile,implementation:'implemented',declarationVersion,source,sourceVersion,metadata,verification}`；verification 含 status/at/evidence/testedTuple。未声明协议时 ADAPTER_PENDING。每个 preference 含 usage/enabled/isDefault/effectiveDefault。defaults 按用途返回目标、effective 和 unavailableReason；失效不会自动改目标。runnable 表示本地资格，不保证上游实时可用、费用或解密成功。

错误：400 QUERY_INVALID；其余见共同约定。

副作用：一条 SQL 一致读取本人目录/配置/声明/偏好，不解密、不联网，不返回用户目录并集或静态名单。

## PATCH /api/v1/providers/onelink/models

身份：当前登录用户。

输入：`{modelRef,expectedRevision,name?,description?,usage?,enabled?,isDefault?}`，至少一个展示字段或布尔偏好。展示字段接受字符串或 null，分别最多 100、500 个 Unicode 字符；null 清除覆盖，省略不变，空字符串保留为覆盖。JSON 解码后的字符串拒绝 NUL 和未配对的 UTF-16 代理项；原始正文沿共同 JSON 读取流程解码，不额外严格校验 UTF-8 字节。仅编辑展示字段无需 usage 或运行资格，但模型必须属于当前用户并已存在。修改偏好时新稳定引用须指定 usage；旧 `onelink:<category>:<rawId>` 可用其 category 表达旧用途，raw ID 无损解析。usage 仅接受五类业务用途，目前可运行适配只有 chat；没有偏好字段时不得单独提供 usage。

成功：200 ProviderView；同用途至多一个默认。设默认须当前有效成员、已实现适配和 enabled；原子清除同用途旧默认。禁用保留默认目标但使 effective=false，不选替代。

错误：400 MODEL_USAGE_REQUIRED；409 PROVIDER_DISABLED/PROVIDER_AUTH_REJECTED/MODEL_CATALOG_NOT_DISCOVERED/MODEL_NOT_FOUND/MODEL_REMOVED/LEGACY_MODEL_REF_INVALID/ADAPTER_PENDING/MODEL_USAGE_UNSUPPORTED/MODEL_DISABLED/PROVIDER_REVISION_CONFLICT。

副作用：配置行锁内核对 owner 和 revision，在同一事务修改本人展示信息及用途偏好，组合请求失败不保存任何部分；不联网。不能新增目录成员、选择协议、声明能力或伪造实测。部署适配入口见业务规范，无对应普通用户 HTTP 管理入口。
