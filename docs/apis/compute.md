# 计算任务 HTTP 契约

[API 导航](index.md)；消息与恢复见[计算协议](../tasks/compute-service/protocol.md)。重媒体接口在认证、资产和计算配置启用时注册；图片接口由独立生成配置启用，不依赖 B 或 RabbitMQ。身份来自登录 Cookie，POST 要求允许的精确 Origin 和 JSON；GET 提供 Origin 时也须匹配。正文上限 8192 字节和 10 秒，拒绝额外字段，读取后复核会话。响应 no-store，错误为 `{error:{code,message,requestId}}`，不暴露内部对象键、存储凭据或数据库异常。

JobView 为 `{jobId,requestId,inputAssetId,status,attempt,resultAssetId,errorCode,createdAt,updatedAt}`；status 为 accepted、queued、running、succeeded 或 failed。`resultAssetId` 在成功前为 null，成功后可用本人[资产查询](assets.md)获取短期下载地址；errorCode 可为空，unknown 表示仍需对账而非终态。时长由 Worker 对实际媒体核验，最多 30 分钟。

## POST /api/v1/compute/jobs

身份：当前登录用户。

输入：`{requestId,assetId}`，两者均为小写 UUID v4；assetId 必须是本人已经登记的原始资产，不能指定对象键、URL、桶或其他用户。

成功：202 JobView；同一用户和 requestId 重试同一 assetId 返回 200 及原任务。服务核对真实 raw 对象长度与 ETag，事务性建立任务与待发布命令；受理不表示 Worker 已执行。

错误：400 BODY_INVALID/COMPUTE_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 ASSET_NOT_FOUND、409 REQUEST_CONFLICT/ASSET_SIZE_MISMATCH、429 COMPUTE_QUOTA_EXCEEDED、503 COMPUTE_STORAGE_UNAVAILABLE/COMPUTE_UNAVAILABLE；正文读取还可能返回 408 或 413。

副作用：受理时独立统计活动视频任务（`accepted`、`queued`、`running`），限制每用户最多 10 个、全局最多 500 个未结束视频任务（与图片任务配额及事务锁分离）；向持久 outbox 写入固定 profile 命令并立即唤醒有界批量排空发布至 `mio.compute.commands.v1`（`transcode.v1`），发布确认与业务成功分别记录。

## GET /api/v1/compute/jobs/{id}

身份：任务所有者。

输入：服务端生成的任务 UUID，无查询参数。

成功：200 JobView；只能读取本人的任务。

错误：401 UNAUTHORIZED、403 ORIGIN_DENIED、404 JOB_NOT_FOUND/NOT_FOUND、503 COMPUTE_UNAVAILABLE。

副作用：只读取任务状态；重复或晚到的消息不使任务终态回退。

## POST /api/v1/compute/images

身份：当前登录用户；各图片切片与供应商路由的已接受范围分别以[图片能力成果](../tasks/onelink-image-generation/complete/report.md)和[供应商路由 PRD](../tasks/onelink-vendor-routing/prd.md) 所属成果入口为准，尚未记入已接受成果的真实模型闭环与上游 outpaint `geometry` 仍保持待接受或 pending。

输入：`{requestId,modelRef,parameters}`；requestId 是 UUID v4，modelRef 必须属于本人当前动态目录且命中已启用平台模型路由（`mio_provider_model_routes`），parameters 至少有 `prompt`。A 在受理时强制按路由的 `ImageRouteConfig` 校验参数，把完整路由作为必填 `route`（`profile` 为对应 `ImageDriver`）封入命令并持久化至 `mio_image_jobs.route_snapshot`，，与受理时的 provider 凭据密文快照、版本绑定一同存入内部执行记录；A 不向 B 发图片命令，缺失或损坏冻结路由时关闭执行，不回退静态规则表。`parameters.operation` 省略时为 `generate` 且须属于 `route.paramSpec.supportedOperations`；`size`、`aspect_ratio`、`n`（上限 `route.paramSpec.maxN`，协议最多 16 张）均按 `route.paramSpec` 白名单校验。`generate`（`allowGenerateReferences:true`）与 `edit` 在 `maxReferenceImages > 0` 时可使用本人 `imageAssetId` 或有序 `imageAssetIds` 数组；可选本人 `maskAssetId` 仅在 `allowMaskPng:true` 时开放且只接受 PNG；`outpaint` 因上游 `geometry` 协议尚未验证（`DESIGN-OVER-001`），仅在路由同时声明 `outpaint` 与 `allowOutpaintGeometry:true` 时可用。`allowWatermarkOverride:true` 时，A 按用户供应商配置中的 `defaultImageWatermark` 合成冻结 `route.effectiveWatermark`（未设时取 `requestDefaults.watermark`）；`allowWatermarkOverride:false` 时固定使用路由声明的水印默认值，请求 `parameters` 不直接接收 `watermark`。`parameters.async:true` 仅在 `route.paramSpec.async` 声明该操作时受理（`requiresAsync:true` 的异步模型必须显式传 `async:true`），任务有效期按 `maxAgeSeconds` 放宽至最高 24 小时（同步任务为 10 分钟）；任务先返回脱敏状态，后续由 A 的持久查询调度器 按声明的 `maxQueries`/`maxAgeSeconds` 有界推进，HTTP 状态不返回上游任务 ID。A 逐项按系统 `user_id` 查询 ready 图片资产（本人上传的 `original` `mio/raw/<assetId>/<uuid>` 或已落库图片输出 `derived` `mio/derived/<jobId>/images/<index>-<fileId>.<format>`）并冻结对象键、ETag/长度；A 在写持久提交意图与发起上游请求前，统一从私有 COS 以 `If-Match` 读取全部参考图/遮罩并核对真实文件签名，再按 `route.driver`（`openai-images`、`volcengine-ark-images`、`vidu-images`、`kling-images`）编码为对应原厂请求体，Asset ID、对象键、ETag 和用户凭据不会透传。这里的 `size` 与 `aspect_ratio` 是供应商生成参数，不是 W3/COS 对象容量策略。HTTP 正文上限 160000 字节，规范化受理输入同样受有界大小检查。

参考图和 PNG 蒙版每次出现的冻结长度各不得超过 16 MiB（16 × 1024² 字节），单任务合计不得超过 32 MiB，均含边界。同一资产同时作为参考图和蒙版时计两次。新 HTTP／工具准入在归属、对象快照与路由结构核对后、创建任务前以 413 `IMAGE_REFERENCE_LIMIT` 拒绝超限输入；已受理的同 requestId 请求仍先重放原任务。历史 `ready` 执行若超限，在读取任何参考对象、写提交意图或调用上游前进入 `rejected`，`errorCode=IMAGE_REFERENCE_LIMIT`，内部执行终结且不再重试。该预算只约束新准入和未提交任务，已提交查询、unknown 判定及已保存结果的恢复沿原身份继续。原始资产上传上限和原图字节、顺序不变；这些固定限制是单 A 的保守资源边界，不代表已测得生产容量。

`openai-images` 的 JSON `generate` 仅发送模型、提示词及驱动支持的生成选项。兼容网关使用的 `aspect_ratio` 仅在路由 `allowedAspectRatios` 声明对应值时发送。参考图通过 multipart `edit` 提交。新导入的 OpenAI 路由不得为 `generate` 声明参考图能力。已保存的路由仍可用于纯文本生成和编辑。新 OpenAI 参考图 `generate` 请求返回 `IMAGE_OPERATION_UNSUPPORTED`，已冻结的同类任务在写提交意图与调用上游之前以 `IMAGE_INPUT_INVALID` 终止。其他驱动按各自声明支持参考图生成。

首次异步查询尽快执行；供应商仍在处理时，使用剩余查询次数和截止时间均匀安排后续查询。实际截止为路由异步时限与任务凭据有效期中较早者；超期、缺少截止或耗尽次数时停止查询并保留上游任务身份，不重新提交生成。

已知上游任务的查询使用该任务所属 `user_id` 当前保存且可解密的 OneLink Key，；停止新准入、目录变化或 Key 版本变化不改变既有任务和资产的归属。无可用 Key 时保留任务身份并报告 `IMAGE_CREDENTIAL_UNAVAILABLE`，恢复后可在原次数与期限内继续查询；供应商拒绝当前 Key 时如实报告，不能保证不同上游账户有权读取同一任务。图片任务终态完成落库后，按该用户当前 `(config_id, model_key, credential_version, catalog_version, declaration_version)` 元组将单用户验证记录更新为 `verified`，不影响其他用户或平台路由定义。

成功：202 返回图片任务视图；相同 owner/requestId 和输入返回同一任务，不重复生图。

错误：400 IMAGE_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 ASSET_NOT_FOUND、409 REQUEST_CONFLICT/IMAGE_OPERATION_UNSUPPORTED 或供应商资格错误、413 IMAGE_REFERENCE_LIMIT、429 COMPUTE_QUOTA_EXCEEDED、503 IMAGE_UNAVAILABLE/COMPUTE_UNAVAILABLE；正文读取还可能返回 408 或 413。

副作用：受理仅占用独立的图片活动任务名额（每用户最多 32 个、全局最多 1000 个 `accepted` 或 `materializing` 状态任务，独立事务锁，不与视频转码名额互相挤占），在 PostgreSQL 短事务中建立图片任务和内部执行记录，立即唤醒 A 的后台执行器。单 A 通过数据库原子认领任务，网络请求期间不持长事务；网络并发上限 4，解码独立排队且并发 1。提交意图先持久化，再发送唯一一次生成 POST；提交结果不明进入 unknown，不自动重发。参考图与遮罩输入快照保存在图片任务命令中，COS `If-Match` 读取或签名校验失败均发生在持久提交意图 与调用上游之前（0 次上游 POST）；四个原厂图片驱动（`openai-images`、`volcengine-ark-images`、`vidu-images`、`kling-images`）返回的 URL 结果统一按公网 HTTPS、限时有界下载及真实图片格式核对后进入既有 COS/Asset 物化，不依赖固定结果域名清单；Mio 不记录费用、计费、余额或预算。

参考图或遮罩的实际字节签名与冻结 MIME 不符时，任务进入 `rejected`，`errorCode` 为 `IMAGE_INPUT_INVALID`。条件读取错误沿用执行器在提交前的现有重试。

停用或轮换 A 的图片 Key 只阻止新图片准入；已受理任务和已登记输出按系统 `user_id` 保留，资源查询和恢复不因 Key 变化失效。任务中的 provider/model/upstream 身份用于恢复，Key 版本只记录提交上下文；撤销配置不删除或重绑既有 COS 资产，也不改变未知结果。

## GET /api/v1/compute/images/{jobId}

身份：任务所有者。

输入：图片任务 UUID，无查询参数。

成功：200 返回 `{jobId,status,requestedCount,errorCode,assetIds,outputs}`；outputs 的每项为 `{index,assetId}`，index 是 `0..15`（单任务最多 16 张输出）的原始输出序号，即使前项缺失也不重排。A 为每次图片物化生成 `index-fileId.format` 的唯一 COS 键，成功后由 A 绑定 owner 资产，重试不会覆盖已登记键；已登记的 assetIds 通过[资产接口](assets.md)获取下载地址。`completed` 要求输出数等于请求数；上游返回较少或能明确判定部分输出无效时为 `partial`。`materializing` 表示已返回的图片正在有界落库，失败耗尽为 `materialization_failed`，仍可见已登记的部分资产；A 使用 sharp 异步完整解码校验原图，不调整原始字节、格式、尺寸或顺序。URL 结果在上游任务身份核验后按原索引逐张流入耐久暂存，单张最多 128 MiB，不整批转为 Base64 驻留；同步 JSON/Base64 回包继续使用独立的有界正文读取。收到的图片先可靠落盘并同步，再登记 PG 文件定位与摘要；COS 或入库失败时从该检查点继续，不能重新生成。此类原件可能长期保留，当前没有主动放弃入口。`unknown` 表示提交结果不明，不自动重发。

错误：401 UNAUTHORIZED、403 ORIGIN_DENIED、404 JOB_NOT_FOUND/NOT_FOUND、503 COMPUTE_UNAVAILABLE。

副作用：只读取本人任务和已登记输出。

## POST /api/v1/compute/images/{jobId}/recover

身份：任务所有者。

输入：图片任务 UUID 和空 JSON。`materialization_failed` 从已保存图片恢复物化；已知上游任务 ID 的异步失败或未知状态仅在原次数、绝对期限内恢复查询；没有上游 ID 的 unknown 不重发生图。重复请求在恢复进行中复用同一任务。

成功：202 返回当前图片任务视图，表示恢复受理；旧恢复结果不会覆盖新一轮状态。

错误：400 IMAGE_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 JOB_NOT_FOUND/NOT_FOUND、409 RESULT_CONFLICT、429 COMPUTE_QUOTA_EXCEEDED、503 IMAGE_UNAVAILABLE/COMPUTE_UNAVAILABLE。

副作用：重新核验独立的图片活动任务名额（每用户 32／全局 1000 个 `accepted` 或 `materializing` 任务，不与视频共享），立即唤醒 A 的持久执行器恢复已保存结果，不再次提交生图；未知提交不能通过此入口重发。

### 图片执行配置与切换

A 使用 `MIO_GENERATIONS_ENABLED=true` 和绝对持久目录 `MIO_GENERATIONS_DATA_DIR`；身份、媒体数据库、COS 及 provider master key 仍须配置。先迁移 assets，再显式执行 `pnpm generations:migrate --apply`（本地为 `pnpm migrate:dev generations --apply`）。历史任务及输出原表继续使用；没有 A 执行记录的旧 B 任务只读查询，不被 A 重新提交。内部密文、上游 ID、执行阶段和文件定位不进入公开视图。

切换沿[常驻环境](../local-environments.md#图片生成迁移与切换)先暂停新提交、排空并对账旧任务/outbox/MQ/B journal 和未确认上传，再停旧图片执行器、启动 A 并恢复接单。未对账 unknown、恢复数据缺失、存储权限不足阻止切换。A 接过新任务后先对账新任务，不能直接交旧 B 重跑。成功 COS/DB 对账后清理已确认临时图。进程在已完成提交后中断时，后台按确切完成检查点和 COS 输出补清；只处理全部完成且尝试键无歧义的文件，清理可幂等续接，失败项分页推进并后续回访。失败、部分完成与未知检查点保留；磁盘不足停止新任务准入，不自动删除恢复数据。
