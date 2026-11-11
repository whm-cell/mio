# 计算任务 HTTP 契约

[API 导航](index.md)；消息与恢复见[计算协议](../tasks/compute-service/protocol.md)。仅认证、资产和计算配置均启用时注册。身份来自登录 Cookie，POST 要求允许的精确 Origin 和 JSON；GET 提供 Origin 时也须匹配。正文上限 8192 字节和 10 秒，拒绝额外字段，读取后复核会话。响应 no-store，错误为 `{error:{code,message,requestId}}`，不暴露内部对象键、存储凭据或数据库异常。

JobView 为 `{jobId,requestId,inputAssetId,status,attempt,resultAssetId,errorCode,createdAt,updatedAt}`；status 为 accepted、queued、running、succeeded 或 failed。`resultAssetId` 在成功前为 null，成功后可用本人[资产查询](assets.md)获取短期下载地址；errorCode 可为空，unknown 表示仍需对账而非终态。时长由 Worker 对实际媒体核验，最多 30 分钟。

## POST /api/v1/compute/jobs

身份：当前登录用户。

输入：`{requestId,assetId}`，两者均为小写 UUID v4；assetId 必须是本人已经登记的原始资产，不能指定对象键、URL、桶或其他用户。

成功：202 JobView；同一用户和 requestId 重试同一 assetId 返回 200 及原任务。服务核对真实 raw 对象长度与 ETag，事务性建立任务与待发布命令；受理不表示 Worker 已执行。

错误：400 BODY_INVALID/COMPUTE_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 ASSET_NOT_FOUND、409 REQUEST_CONFLICT/ASSET_SIZE_MISMATCH、429 COMPUTE_QUOTA_EXCEEDED、503 COMPUTE_STORAGE_UNAVAILABLE/COMPUTE_UNAVAILABLE；正文读取还可能返回 408 或 413。

副作用：受理时每用户最多 10 个、全局最多 500 个未结束任务；向持久 outbox 写入固定 profile 命令，发布确认与业务成功分别记录。

## GET /api/v1/compute/jobs/{id}

身份：任务所有者。

输入：服务端生成的任务 UUID，无查询参数。

成功：200 JobView；只能读取本人的任务。

错误：401 UNAUTHORIZED、403 ORIGIN_DENIED、404 JOB_NOT_FOUND/NOT_FOUND、503 COMPUTE_UNAVAILABLE。

副作用：只读取任务状态；重复或晚到的消息不使任务终态回退。
