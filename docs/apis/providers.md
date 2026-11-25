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

revision 在配置/模型展示信息/偏好修改、刷新开始及结束递增（平台模型路由更新独立递增路由 `declarationVersion`）；客户端修改先读取最新值。

## GET /api/v1/providers/onelink

身份：当前登录用户。

输入：无查询参数。

成功：200 本人 ProviderView；未配置为 null，不返回明文/密文。

错误：见共同约定。

副作用：只读，不解密或联网。

## PUT /api/v1/providers/onelink/credential

身份：当前登录用户。

输入：`{apiKey,expectedRevision}`。初建 revision=0，否则为当前非负整数且小于 2147483647。Key 非空、最多 4096 字节，无空白、控制字符、`*` 或 `•`，且能由 Node `Headers` 构造 `Authorization: Bearer <apiKey>`。

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

成功：200 discovery；connected 表示当前用户 Key 的完整目录成功，空列表也是成功；`ids` 的数量就是本次最新目录数量。failed 携稳定脱敏 error：UPSTREAM_AUTH_REJECTED/RATE_LIMITED/UNAVAILABLE/TIMEOUT/CANCELLED/RESPONSE_INVALID/RESPONSE_TOO_LARGE/RESPONSE_OR_TRANSPORT_ERROR（各项均带 UPSTREAM_ 前缀）。模型 ID 和需持久化的元数据字符串含 NUL 或未配对 UTF-16 代理项时，整次尝试记为 UPSTREAM_RESPONSE_INVALID。失败不覆盖同凭据最近成功快照；认证失败额外阻止新调用。

错误：409 PROVIDER_CREDENTIAL_CHANGED 或 PROVIDER_REFRESH_SUPERSEDED 表示响应已失效、未发布；503 PROVIDER_CREDENTIAL_UNAVAILABLE 表示不能验证密文，最近尝试仍记录失败。

副作用：先分配持久刷新序号，解密本人当前 Key，固定 GET `/v1/models`；完整成功事务发布包含模型信息和数量的最新目录，其他结果只更新尝试/认证状态。不生成、不自动重试，晚到响应不能覆盖最新发起的尝试。

## GET /api/v1/providers/onelink/models

身份：当前登录用户。

输入：可选单个 category=chat/image/video/voice/music；只筛供应商/部署声明分类，null 分类不自动进入 chat。

成功：200 `{provider,items,defaults}`。`items` 是最近一次当前用户 Key 成功刷新得到的可见成员及符合当前凭据目录资格的平台补录型号（启用平台目录白名单总控时仅保留 `mio_provider_catalog_models` 中已登记且 `user_visible=true` 的型号；未导入、后台已删除或 `user_visible=false` 的型号不返回，直接调用或修改偏好返回 `409 MODEL_HIDDEN`）。items 含稳定 modelRef/modelKey、精确 modelId、`name`、`description`、`nameOverride`、`descriptionOverride`、可空 category/classificationSource、supplierMetadata、membership、credentialVersion/catalogVersion、firstSeenAt/lastSeenAt、legacyRef、discovered、`curated`、`callNotes`、adaptation、preferences、chat 的 enabled/isDefault/runnable/unavailableReason。`name` 使用用户覆盖，否则依次回退平台 `displayLabel` 与精确 modelId；历史不可解析项可为 null。`description` 使用用户覆盖，否则依次回退平台 `description`、供应商字符串描述或平台标签，均缺失为 null。两个 Override 字段为可空的实际用户覆盖，可区分回退；空字符串是实际覆盖。modelRef 为 `onelink:model:<UUID>`。discovered 只表示当前 `/v1/models` 成功成员，平台手动补录未发现型号 `discovered=false` 且 `curated=true`。

adaptation 为 null 或 `{operation,vendor,profile,implementation:'implemented',declarationVersion,sourceKind,source,sourceVersion,metadata,verification}`（`vendor` 为上游原厂标识，`profile` 为服务端已实现协议驱动名，`declarationVersion` 为当前生效平台路由声明版本），按 `平台原厂路由（mio_provider_model_routes） -> ADAPTER_PENDING` 单轨返回当前已存在成员的生效适配；`sourceKind` 只能是 `protocol-reference`（协议/文档依据）或 `runtime-observation`（对应模型和操作的实际运行观察），只影响已存在成员的适配与分类回退，绝不向用户目录注入未发现成员；catalog membership、旧快照和静态模型清单不能作为适配来源。`verification` 含每用户独立计算的 `status`（仅 `'unverified'` 或 `'verified'`，跨用户完全隔离）及 `at/evidence/testedTuple`。未命中有效路由或驱动未实现时返回 `ADAPTER_PENDING`。每个 preference 含 usage/enabled/isDefault/effectiveDefault。defaults 按用途返回目标、effective 和 unavailableReason；失效不会自动改目标。runnable 表示本地资格，不保证上游实时可用或解密成功。

chat `adaptation.metadata.inputModalities` 是部署声明的输入类型，缺省为纯文本；只有明确包含 `text` 和 `image` 才允许对话图片。可选图片预算及缺省值见[供应商规范](../providers.md)。现有 chat `verification.status` 不区分文本和视觉，文本成功不能作为视觉调用证据。

分类为 `chat` 的条目返回 `reasoning`。平台未开放推理时值为 `{supported: false}`，已开放时为 `{supported: true, efforts?}`，`efforts` 由管理员路由声明从 `low`、`medium`、`high` 中选择。省略 `efforts` 表示可展示上游产生的实时思考，客户端没有可选档位。有效路由可能在 `adaptation.metadata` 同时提供显式能力和 `streamIdleTimeoutMs`。[供应商规范](../providers.md#受控适配声明与实际验证)

图片候选另以 `image: {adaptation,parameters,enabled,runnable,unavailableReason}` 返回图片生效适配、生图参数边界和本地资格，`profile` 标识生效原厂驱动（`openai-images`、`volcengine-ark-images`、`vidu-images`、`kling-images`）；原有顶层 adaptation、protocol 和 runnable 保持 chat 含义。当存在有效且就绪（`asyncReady`）的 `image.generate` 生效路由时，`image.parameters` 直接由该路由规格在同一次只读查询内派生返回完整 `ImageParameterView`（含 `supportedOperations`、`requiresAsync`、`maxN`、`allowExplicitN`、`allowedSizes`、`defaultSize`、`allowCustomDimensions`、`allowedAspectRatios`、`maxReferenceImages`、`allowGenerateReferences`、`allowMaskPng`、`allowOutpaintGeometry`、`allowedQualities`、`allowedBackgrounds`、`allowedModerations`、`allowedOutputFormats`、`fixedOutputFormat`、`allowOutputCompression`、`allowWatermarkOverride`、`defaultWatermark`），便于 C 端界面按管理员配置的路由边界动态渲染生图选项；纯对话型号以及未适配或未就绪（`ADAPTER_PENDING`）的路由返回 `image.parameters = null`。图片 `adaptation.metadata.image` 由生效路由规格派生：`modes` 必须包含 `generate`，可声明 `edit`、`mask:{format:"png"}`、供应商参考图能力 `references:{maxImages}`（`1..16`）、`geometry:{unit:"pixels",edges:["left","top","right","bottom"]}` 和 `async:{operations,maxQueries,maxAgeSeconds}`；`outpaint` 必须同时声明 geometry，async operations 必须属于 modes，省略这些字段不推断能力。异步驱动（`vidu-images`、`kling-images`）仅在具备 generate async 规格与合法相对查询模板时 `runnable=true`，原样发送该成员的精确 modelId（`kling-images` 可按路由区分标准 `/kling/v1/images/generations` 与 Omni `/kling/v1/images/omni-image`）。`references.maxImages` 不是固定模型或图片容量策略。`parameters.async:true` 只有在当前生效路由显式声明 async capability 时受理。图片路由和本地资格不代表供应商已验证或实时可用；真实调用与远端 CI 仍分别记录。

语音的标准配音、复刻与目录模型由[音频 API](audio.md)按操作读取。普通模型目录中的 `category=voice` 可用于分类浏览。语音准入要求本人当前凭据实际发现且有精确语音声明。

错误：400 QUERY_INVALID；其余见共同约定。

副作用：一条 SQL 一致读取本人目录/配置/受成员门控的平台路由/本人验证与偏好，不解密、不联网，不返回用户目录并集或静态名单。

## PATCH /api/v1/providers/onelink/models

身份：当前登录用户。

输入：`{modelRef,expectedRevision,name?,description?,usage?,enabled?,isDefault?}`，至少一个展示字段或布尔偏好。展示字段接受字符串或 null，分别最多 100、500 个 Unicode 字符；null 清除覆盖，省略不变，空字符串保留为覆盖。JSON 解码后的字符串拒绝 NUL 和未配对的 UTF-16 代理项；原始正文沿共同 JSON 读取流程解码，不额外严格校验 UTF-8 字节。仅编辑展示字段无需 usage 或运行资格，但模型必须属于当前用户并已存在。修改偏好时新稳定引用须指定 usage；旧 `onelink:<category>:<rawId>` 可用其 category 表达旧用途，raw ID 无损解析。usage 仅接受五类业务用途，此 PATCH 的偏好修改当前仅支持 chat；没有偏好字段时不得单独提供 usage。

成功：200 ProviderView；同用途至多一个默认。设默认须当前有效成员、已实现适配和 enabled；原子清除同用途旧默认。禁用保留默认目标但使 effective=false，不选替代。

错误：400 MODEL_USAGE_REQUIRED；409 PROVIDER_DISABLED/PROVIDER_AUTH_REJECTED/MODEL_CATALOG_NOT_DISCOVERED/MODEL_NOT_FOUND/MODEL_REMOVED/MODEL_HIDDEN/LEGACY_MODEL_REF_INVALID/ADAPTER_PENDING/MODEL_USAGE_UNSUPPORTED/MODEL_DISABLED/PROVIDER_REVISION_CONFLICT。

副作用：配置行锁内核对 owner 和 revision，在同一事务修改本人展示信息及用途偏好，组合请求失败不保存任何部分；不联网。不能新增目录成员、选择协议、声明能力或伪造实测。部署适配入口见业务规范，无对应普通用户 HTTP 管理入口。
