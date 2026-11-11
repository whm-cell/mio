# 用户资产 HTTP 契约

[API 导航](index.md)；存储与清理约束见 [COS 集成](../integrations/cos.md)。只在认证和完整资产配置启用后注册。

## 本域共同约定

身份只来自登录 Cookie；服务 Bearer 和请求体不能指定 owner、桶、对象键或目标 URL。POST 要求允许的精确 Origin 和 `application/json`；GET 提供 Origin 时也须匹配；OPTIONS 无需登录但须允许 Origin。JSON 上限 8192 字节、10 秒，拒绝额外字段，读取后复核会话。所有响应 no-store，错误为 `{error:{code,message,requestId}}`，不返回 COS 或数据库错误详情。常见错误为 400 BODY_INVALID/QUERY_INVALID/ASSET_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 NOT_FOUND/ASSET_NOT_FOUND、405 METHOD_NOT_ALLOWED、408 BODY_TIMEOUT、413 BODY_TOO_LARGE、415 JSON_REQUIRED 和 503 ASSET_UNAVAILABLE/ASSET_STORAGE_UNAVAILABLE。

AssetView 是 `{assetId,status,filename,contentType,size,createdAt,downloadUrl?}`；`status` 为 pending、finalizing、ready 或 expired，仅 ready 包含短期下载地址。文件名和 MIME 是用户描述，不证明文件类型或内容安全。地址是临时 bearer 凭证，必须避免日志、公开缓存和转交；COS 浏览器直传需配置指定 Origin 的 CORS。

## POST /api/v1/assets/uploads

身份：当前登录用户。

输入：`{filename,contentType,size}`；文件名非空且 UTF-8 不超过 255 字节，contentType 是不带参数的 MIME，size 是 1 至 1073741824 的整数。

成功：201 `{assetId,uploadUrl,expiresIn:300}`；调用方将对应长度的文件以 PUT 直传该 URL；签名绑定 Content-Length 和 Host。URL 到期后需新建上传，不可提供内部存储地址。

错误：见共同约定。

副作用：持久化本人待上传记录并生成临时对象键；只签名，不转发文件字节。

## POST /api/v1/assets/{id}/complete

身份：资产所有者。

输入：路径为服务端生成的 UUID，正文必须为 `{}`。

成功：200 AssetView；已登记时重复调用返回同一原件，下载 URL 可重新签发。

错误：404 ASSET_NOT_FOUND；409 ASSET_UPLOAD_NOT_FOUND/ASSET_SIZE_MISMATCH/ASSET_SOURCE_CHANGED/ASSET_BUSY/ASSET_EXPIRED/ASSET_FINALIZE_SUPERSEDED；其余见共同约定。冲突可在明确原因后重试，源内容改变后应新建资产。

副作用：HEAD 核验长度及 ETag，持久冻结源标识并抢占，按 ETag 条件复制到新的 raw 键，再条件登记；PG 与 COS 不是同一事务，失败可能留下未登记的复制残留。不会把 staging 直接作为已登记原件。

## GET /api/v1/assets/{id}

身份：资产所有者。

输入：路径为服务端生成的 UUID，无查询参数。

成功：200 AssetView；上传未完成且已过 24 小时显示 expired；ready 返回 5 分钟下载 URL。

错误：404 ASSET_NOT_FOUND；其余见共同约定。

副作用：读取本人元数据；ready 时在服务端签发下载地址，不读取或代理视频字节。
