# 计算任务 HTTP 契约

[API 导航](index.md)；消息与恢复见[计算协议](../tasks/compute-service/protocol.md)。重媒体接口在认证、资产和计算配置启用时注册；图片接口由独立生成配置启用，不依赖 B 或 RabbitMQ。身份来自登录 Cookie，POST 要求允许的精确 Origin 和 JSON；GET 提供 Origin 时也须匹配。单路转码正文上限 8192 字节和 10 秒，拒绝额外字段，读取后复核会话。响应 no-store，错误为 `{error:{code,message,requestId}}`，不暴露内部对象键、存储凭据或数据库异常。

JobView 为 `{jobId,requestId,inputAssetId,status,attempt,resultAssetId,errorCode,createdAt,updatedAt}`；status 为 accepted、queued、running、succeeded 或 failed。`resultAssetId` 在成功前为 null，成功后可用本人[资产查询](assets.md)获取短期下载地址；errorCode 可为空，unknown 表示仍需对账而非终态。时长由 Worker 对实际媒体核验，最多 30 分钟。

## POST /api/v1/compute/jobs

身份：当前登录用户。

输入：`{requestId,assetId}`，两者均为小写 UUID v4；assetId 必须是本人已经登记的原始资产，不能指定对象键、URL、桶或其他用户。

成功：202 JobView；同一用户和 requestId 重试同一 assetId 返回 200 及原任务。服务核对真实 raw 对象长度与 ETag，事务性建立任务与待发布命令；受理不表示 Worker 已执行。

错误：400 BODY_INVALID/COMPUTE_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 ASSET_NOT_FOUND、409 REQUEST_CONFLICT/ASSET_SIZE_MISMATCH、429 COMPUTE_QUOTA_EXCEEDED、503 COMPUTE_STORAGE_UNAVAILABLE/COMPUTE_UNAVAILABLE；正文读取还可能返回 408 或 413。

副作用：视频任务在 `accepted`、`queued`、`running` 时占用名额。准入事务与通用媒体任务共享锁，合计每用户最多 10 个、全局最多 500 个活动任务，图片配额和锁单独计算。幂等命中仍返回原任务，同键冲突仍返回 409。新受理时向持久 outbox 写入固定 profile 命令并立即唤醒有界批量排空发布至 `mio.compute.commands.v1`（`transcode.v1`），发布确认与业务成功分别记录。

## GET /api/v1/compute/jobs/{id}

身份：任务所有者。

输入：服务端生成的任务 UUID，无查询参数。

成功：200 JobView；只能读取本人的任务。

错误：401 UNAUTHORIZED、403 ORIGIN_DENIED、404 JOB_NOT_FOUND/NOT_FOUND、503 COMPUTE_UNAVAILABLE。

副作用：只读取任务状态；重复或晚到的消息不使任务终态回退。

## 本域共同约定

单路转码、通用媒体和视频生成的 JSON 写入接受大小写不敏感的 `application/json` 媒体类型，可携带 `charset` 等类型参数。读取正文前验证登录会话，读取并解析后再次取得当前身份，再执行业务写入。

### 通用媒体处理

本组接口与单路转码共用认证、资产和计算开关及活动任务配额。所有请求以本人登录 Cookie 鉴权。POST 与 OPTIONS 要求允许的精确 Origin，POST 还须为 `application/json` 并在读取正文后复核会话。GET 提供 Origin 时也须匹配。只允许无查询参数的以下路径。

`requestId` 和资产 ID 为小写 UUID v4，`inputs` 为最多 64 个有序且不重复的 `{assetId}`。资产必须为本人已登记的 ready 原件或计算产物。受理核对真实对象长度，将真实 raw ETag、长度、对象键、操作及参数与 `profile: "standard-media"` 冻结在当前任务。请求和带内部快照的命令各限 256 KiB 且须为合法 UTF-8。两个大小检查均在任务和命令持久化前生效。每个输入和每个输出不超过 1 GiB。修改冻结请求须新建任务。

同一 owner 和 `requestId` 的相同操作及有序输入与参数返回原任务，参数对象字段顺序不影响比较。同键异参返回 409 `REQUEST_CONFLICT`。重试使用独立请求身份，重复请求返回同一任务，输入沿用原快照。计算的 `accepted`、`queued`、`running`、`reconciling`、`cancel_requested` 合计占用每人 10、全局 500 个活动任务，与单路转码共用。

MediaJobView 含 `jobId`、`requestId`、`operation`、`profile`、`inputs`、`parameters`、`status`、`attempt`、`stage`、`progress`、`errorCode`、`cancelRequested`、`data`、`outputs`、`createdAt`、`updatedAt`。进度为 0 至 1，阶段和错误码可为空。`outputs` 在成功前为空，成功后按 manifest 顺序返回 `{assetId,name,role,contentType,sizeBytes}`；可下载产物通过本人[资产查询](assets.md)取得短期下载地址，支持的音频 MIME 同时签发播放地址。内部 HLS 清单与分片通过[私有 HLS](#私有-hls)消费。状态与产物来自同一数据库快照。私有对象键、ETag 和内部 manifest 描述保留在服务端。manifest 正文按 SHA-256 验证，每个文件核对 HEAD 中的长度、ETag、SHA-256 元数据，当前 attempt 仍匹配时同事务登记所有结果资产、结构化 `data` 和成功终态。

参数和返回信息见[操作设计](../tasks/compute-service/media-compute.md#操作与参数)。接口支持 `media.probe`、`video.reference_prepare`、`video.derivatives`、`video.trim`、`frames.extract`、`scenes.detect`、`video.split`、`media.export`、`audio.extract`、`audio.waveform`、`audio.remux`、`audio.concat`、`composition.render`、`video.mix`、`video.narration_render`、`subtitle.burn`。执行器根据媒体内容识别独立音视频容器，能够使用 MP4、MOV、Matroska、WebM、AVI、MPEG、常用音频及静态图像容器中的实际音视频流。输入须为单个冻结对象中的媒体，外部清单、播放列表及其他对象引用无法提交为媒体源。合规的参考视频只探测，返回 `data={compressed:false,trimmed:false}` 与空 `outputs`，继续使用原输入资产。

`media.probe` 的 `data.probe.width`、`height` 是应用源像素宽高比与旋转后的显示尺寸。`rotation` 报告归一化至 0–360 度的源旋转，`sampleAspectRatio` 报告源像素宽高比。编码尺寸 240×180、SAR 4:3、旋转 +90° 的源返回 `width=180`、`height=320`。显示时直接使用这对尺寸，无需重复变换。

当音轨长于画面流时，`frames.extract` 的 `first_last` 返回实际最后一帧。`audio.remux` 使用首个实际视频流的结束位置裁剪较长的新音轨，较短的新音轨自然结束。`sourceDurationSeconds` 可指定更短的输出窗口，超出画面末尾的请求返回任务错误 `INPUT_INVALID`。

`video.derivatives` 接受一个本人 ready 视频与 `parameters.profile` 为 `ordinary` 或 `canvas`。两档均交付私有 H.264 MP4 预览、JPEG 封面及 MPEG-TS HLS 播放包，`data.probe` 保留原件探测值。普通档以一次 FFmpeg HLS 打包步骤产生清单与全部分片，主清单使用已核对的实际编码尺寸。亚秒视频保留实测的分片时长，子清单的整数目标时长至少为 1 秒。画布档源视频最长 720 秒，按 6 秒目标独立编码，每档最多 120 片、每片不超过 4 MiB。720p/480p 沿显示方向等比适配，不放大，实际尺寸相同只保留一档。分片核对长度、时间、音轨和连续性，时间误差最多 0.35 秒。带源音轨的产物保留首条音轨为 AAC，音轨比画面短的区间补静音。画布音轨连续编码为 48 kHz AAC，各视频片按同一帧时钟复用完整音频包。末尾不足以容纳下一 AAC 帧时与前片合并，时间误差仍受 0.35 秒限制。普通档与通用探测的输入时长上限一致，为 3600 秒。

四种渲染操作各返回一份 `primary` H.264 MP4。输入引用一律为冻结 `inputs` 的零基下标，时间单位为秒。

| 操作                     | 参数及时间线                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composition.render`     | `resolution` 为 `720p`、`1080p` 或 `4k`，`durationSeconds` 最长 3600 秒，支持可选 `fps`（1–60，默认 30）。`tracks` 每类画面、音频、字幕各至多六轨，`items` 共至多 256 项。按照首个可见画面的实际显示比例选画布，短边使用所选规格。纯音频、字幕或空画面时间线用 16:9 黑底。 |
| `video.mix`              | 提交 `clips`（每项含 `inputIndex`、`startSeconds`、`durationSeconds`）和整数 `seed`，可选 `bgmInputIndex`、`bgmVolume`。源窗口冻结，种子决定重放顺序。1920×1080，保留源显示比例，合成时长由窗口长度之和决定，长背景音乐截断，短背景音乐补静音。仅显式 BGM 进入输出音轨。   |
| `video.narration_render` | 提交 `videoInputIndex`、`narrationInputIndex`，可选 `bgmInputIndex`、`bgmVolume`、`cues` 和 `style`。1920×1080，保留源显示比例。以首条配音音轨解码后的实测时长决定输出，短画面冻结真实末帧，长画面截断。配音经过响度处理，背景音乐限于口播窗口。                           |
| `subtitle.burn`          | 提交一个视频与 `cues`，可选 `style`。按源旋转和 SAR 规范化显示尺寸，原有音轨转 AAC。                                                                                                                                                                                       |

画面、音频和字幕轨通过 `kind` 与 `index` 标识，轨号为 0–5。各项使用 `track`、`startSeconds` 和 `durationSeconds`。图片放在画面轨并保持首帧。隐藏轨和隐藏项从导出过滤，锁定轨照常导出。画面和字幕各自从低轨号向高轨号叠加，同轨按开始时间稳定排序。画面未覆盖的区间呈现黑底。视频原声和显式音轨参与归一化混音，遮挡画面不关闭原声。可设 `muted` 与增益，原声保留相对画面的音轨起始位置。`sourceStartSeconds` 与 `speed`（0.5–4）决定源窗口，源窗口完全早于所引用流的首帧或超出其实际结束位置时返回 `INPUT_INVALID`。窗口起点早于首帧且包含首帧时，混剪保持前段为黑底，合成在首帧前继续显示下层画面或黑底，音轨保留前导静音。输出帧按同一全局帧时钟量化。`transform` 以画布中心为基准，支持 `contain`、`cover` 及 `manual`，`x`、`y` 为位移，`rotation` 为角度。显式 `manual` 宽高可以非等比，并允许画布边缘裁剪。4K 使用相同的单文件 1 GiB、工作目录 10 GiB 和空闲 2 GiB 预算。

字幕项提供文本与可选样式；`cues` 每项含 `startSeconds`、`endSeconds` 和 `text`。`font` 为 `sans` 或 `serif`，使用随 B 发布的 Noto CJK。字号 `fontSize`、边距 `margin` 和描边 `outline` 按 1080p 像素设置并随输出高度换算。`color`、`outlineColor`、`background` 为 `#RRGGBB` 或 `#RRGGBBAA`。`alignment` 为 `bottom`、`middle` 或 `top`。字幕烧录和带字幕的口播在 `data.subtitles` 返回原始提示文本和时间。媒体输入、参数与字幕均使用结构化字段。ASS 覆盖、FFmpeg 表达式和路径由 B 生成。

启用新增操作的 A 前，应将全部媒体编码消费者 B 更新至支持该操作的版本，完成字体和 libass 能力自检后再切换 A。B 缺少必需能力时按 `CAPABILITY_UNAVAILABLE` 报告通用媒体任务。

A 与 B 对同一 attempt 仲裁取消和成功。A 已提交成功时，取消返回原成功结果。取消先持久化时，后续已完成的结果结束为 `cancelled`，输出保留在内部对账中。B 收到取消后跳过未开始作业，运行中先终止并回收实际进程，再报告取消。已知回收中断、执行超时及瞬时存储失败可自动开启下一 attempt。人工重试需要 `failed` 状态，自动与人工合计最多三次。已取消及待对账的任务禁止新 attempt。

`PROCESS_UNKNOWN`、`UPLOAD_UNKNOWN`、`OUTPUT_MISMATCH` 或 A 核验摘要失败时保留原 attempt 与对象身份。`recover` 重新核对该次的子进程、旧键及已保留输出。仍无法证明安全时继续对账。B 在条件 GET 返回 412 时报告 `INPUT_CHANGED`，仅网络中断或 408、429、5xx 读取错误报告可重试的 `STORAGE_FAILURE`，存储权限拒绝保留为不可自动重试的失败。自动或人工取消、失败及恢复均保留原件和已登记资产。

常见错误为 400 `BODY_INVALID`、`QUERY_INVALID`、`MEDIA_INPUT_INVALID`、`MEDIA_OPERATION_UNAVAILABLE`，401 `UNAUTHORIZED`，403 `ORIGIN_DENIED`、`ORIGIN_REQUIRED`，404 `ASSET_NOT_FOUND`、`JOB_NOT_FOUND` 或无效路径 `NOT_FOUND`，409 `REQUEST_CONFLICT`、`ASSET_SIZE_MISMATCH`、`ASSET_SOURCE_CHANGED`、`MEDIA_RETRY_NOT_ALLOWED`、`MEDIA_RECOVER_NOT_ALLOWED`，429 `COMPUTE_QUOTA_EXCEEDED`，503 `COMPUTE_UNAVAILABLE` 或 `COMPUTE_STORAGE_UNAVAILABLE`。错误方法返回 405，JSON 介质不符返回 415，超时或正文过大返回 408 或 413。

## POST /api/v1/compute/media

身份：当前登录用户。

输入：`{requestId,operation,inputs,parameters}`，输入顺序、大小和身份要求见[通用媒体约定](#通用媒体处理)。

成功：首次受理 202，幂等重放 200，均返回 MediaJobView。

错误：见[通用媒体约定](#通用媒体处理)。

副作用：按本人 ready 资产和真实 raw 对象冻结输入，事务性建立任务及待发命令。

## GET /api/v1/compute/media

身份：当前登录用户。

输入：无查询参数。

成功：200 `{jobs:[MediaJobView]}`。按创建时间、ID 倒序，最多 100 条。

错误：见[通用媒体约定](#通用媒体处理)。

副作用：读取本人任务及同一快照的已登记产物。

## GET /api/v1/compute/media/{id}

身份：任务所有者。

输入：服务端生成的任务 UUID，无查询参数。

成功：200 MediaJobView。

错误：其他用户或不存在的任务返回 404 `JOB_NOT_FOUND`，其余见[通用媒体约定](#通用媒体处理)。

副作用：读取本人任务及同一快照的已登记产物。

## POST /api/v1/compute/media/{id}/cancel

身份：任务所有者。

输入：任务 UUID 和正文 `{}`。

成功：200 MediaJobView，可能先返回 `cancel_requested` 直至 B 回报。

错误：见[通用媒体约定](#通用媒体处理)。

副作用：同事务持久化取消意图与独立待发控制消息。已有终态时返回该状态。

## POST /api/v1/compute/media/{id}/retry

身份：任务所有者。

输入：任务 UUID 和正文 `{requestId}`，该请求 ID 是小写 UUID v4。

成功：200 MediaJobView。重复的重试请求返回同一任务。

错误：不允许重试时返回 409 `MEDIA_RETRY_NOT_ALLOWED`，其余见[通用媒体约定](#通用媒体处理)。

副作用：沿原快照建立新 attempt，自动与人工重试合计最多三次。

## POST /api/v1/compute/media/{id}/recover

身份：任务所有者。

输入：任务 UUID 和正文 `{}`。

成功：200 MediaJobView。旧结果尚待确认时保持当前对账状态。

错误：活动任务尚未进入对账或取消时返回 409 `MEDIA_RECOVER_NOT_ALLOWED`，其余见[通用媒体约定](#通用媒体处理)。

副作用：沿当前 attempt 持久化对账控制。A 若已保存待核验成功回报，会重新核对其 manifest。

### 私有 HLS

`GET /api/v1/compute/media/{id}/hls` 返回本人成功的 `video.derivatives` 主清单。`GET /api/v1/compute/media/{id}/hls/{assetId}` 返回该主清单所列的本人子清单。两条路由只接受任务和子清单 UUID，使用登录 Cookie 和本组 GET Origin 规则，返回 `application/vnd.apple.mpegurl` 与 `Cache-Control: private, no-store`。没有成功播放包、非本人任务或未列出的子清单返回 404 `MEDIA_HLS_NOT_FOUND`。

A 对主、子清单按登记 ETag 条件读取并核对长度及 SHA-256。主清单的变体引用改写成本组鉴权子路径。子清单只可引用同一任务和 attempt 已登记的本档 MPEG-TS 分片，所有引用通过后才重写成短期私有 COS inline GET。循环、外部引用、未知 URI 标签以及登记内容不符返回 409 `MEDIA_HLS_INVALID`。

每个分片的签名寿命为在子清单中累计的播放开始秒数向上取整后加 300 秒。普通档最多 3900 秒，画布档最多 1020 秒，并受临时 COS 凭据剩余寿命限制。连续 1× 播放可按同一子清单在不同时间取得分片。长时间暂停、延迟播放或过期后回放时可重新请求本人子清单取得新签名。签名不得公开或写入日志。

## POST /api/v1/compute/images

身份：当前登录用户；各图片切片与供应商路由的已接受范围分别以[图片能力成果](../tasks/onelink-image-generation/complete/report.md)和[供应商路由 PRD](../tasks/onelink-vendor-routing/prd.md) 所属成果入口为准，尚未记入已接受成果的真实模型闭环与上游 outpaint `geometry` 仍保持待接受或 pending。

输入：`{requestId,modelRef,parameters}`；requestId 是 UUID v4，modelRef 必须属于本人当前动态目录且命中已启用平台模型路由（`mio_provider_model_routes`），parameters 至少有 `prompt`。A 在受理时强制按路由的 `ImageRouteConfig` 校验参数，把完整路由作为必填 `route`（`profile` 为对应 `ImageDriver`）封入命令并持久化至 `mio_image_jobs.route_snapshot`，，与受理时的 provider 凭据密文快照、版本绑定一同存入内部执行记录；A 不向 B 发图片命令，缺失或损坏冻结路由时关闭执行，不回退静态规则表。`parameters.operation` 省略时为 `generate` 且须属于 `route.paramSpec.supportedOperations`；`size`、`aspect_ratio`、`n`（上限 `route.paramSpec.maxN`，协议最多 16 张）均按 `route.paramSpec` 白名单校验。`generate`（`allowGenerateReferences:true`）与 `edit` 在 `maxReferenceImages > 0` 时可使用本人 `imageAssetId` 或有序 `imageAssetIds` 数组；可选本人 `maskAssetId` 仅在 `allowMaskPng:true` 时开放且只接受 PNG；`outpaint` 因上游 `geometry` 协议尚未验证（`DESIGN-OVER-001`），仅在路由同时声明 `outpaint` 与 `allowOutpaintGeometry:true` 时可用。`allowWatermarkOverride:true` 时，A 按用户供应商配置中的 `defaultImageWatermark` 合成冻结 `route.effectiveWatermark`（未设时取 `requestDefaults.watermark`）；`allowWatermarkOverride:false` 时固定使用路由声明的水印默认值，请求 `parameters` 不直接接收 `watermark`。`parameters.async:true` 仅在 `route.paramSpec.async` 声明该操作时受理（`requiresAsync:true` 的异步模型必须显式传 `async:true`），任务有效期按 `maxAgeSeconds` 放宽至最高 24 小时（同步任务为 10 分钟）；任务先返回脱敏状态，后续由 A 的持久查询调度器 按声明的 `maxQueries`/`maxAgeSeconds` 有界推进，HTTP 状态不返回上游任务 ID。A 逐项按系统 `user_id` 查询 ready 图片资产（本人上传的 `original` `mio/raw/<assetId>/<uuid>` 或已落库图片输出 `derived` `mio/derived/<jobId>/images/<index>-<fileId>.<format>`）并冻结对象键、ETag/长度；A 在写持久提交意图与发起上游请求前，统一从私有 COS 以 `If-Match` 读取全部参考图/遮罩并核对真实文件签名，再按 `route.driver`（`openai-images`、`volcengine-ark-images`、`vidu-images`、`kling-images`）编码为对应原厂请求体，Asset ID、对象键、ETag 和用户凭据不会透传。这里的 `size` 与 `aspect_ratio` 是供应商生成参数，不是 W3/COS 对象容量策略。HTTP 正文上限 160000 字节，规范化受理输入同样受有界大小检查。

参考图和 PNG 蒙版每次出现的冻结长度各不得超过 16 MiB（16 × 1024² 字节），单任务合计不得超过 32 MiB，均含边界。同一资产同时作为参考图和蒙版时计两次。新 HTTP／工具准入在归属、对象快照与路由结构核对后、创建任务前以 413 `IMAGE_REFERENCE_LIMIT` 拒绝超限输入；已受理的同 requestId 请求仍先重放原任务。历史 `ready` 执行若超限，在读取任何参考对象、写提交意图或调用上游前进入 `rejected`，`errorCode=IMAGE_REFERENCE_LIMIT`，内部执行终结且不再重试。该预算只约束新准入和未提交任务，已提交查询、unknown 判定及已保存结果的恢复沿原身份继续。原始资产上传上限和原图字节、顺序不变；这些固定限制是单 A 的保守资源边界，不代表已测得生产容量。

`openai-images` 的 JSON `generate` 仅发送模型、提示词及驱动支持的生成选项。兼容网关使用的 `aspect_ratio` 由 JSON 生成按路由 `allowedAspectRatios` 发送。Multipart 编辑（含获路由授权的 `outpaint`）以 `size` 指定尺寸。新请求携带 `aspect_ratio` 时，在受理前返回 `IMAGE_INPUT_INVALID`。已受理且冻结该字段的历史任务按原路由校验和执行，multipart 继续省略该字段。编辑单图用 `image`，多图逐份使用 `image[]` 并保留提交顺序。可选 PNG 遮罩使用独立的 `mask` 字段。新导入的 OpenAI 路由不得为 `generate` 声明参考图能力。已保存的路由仍可用于纯文本生成和编辑。新 OpenAI 参考图 `generate` 请求返回 `IMAGE_OPERATION_UNSUPPORTED`，已冻结的同类任务在写提交意图与调用上游之前以 `IMAGE_INPUT_INVALID` 终止。其他驱动按各自声明支持参考图生成。

首次异步查询尽快执行；供应商仍在处理时，使用剩余查询次数和截止时间均匀安排后续查询。实际截止为路由异步时限与任务凭据有效期中较早者；超期、缺少截止或耗尽次数时停止查询并保留上游任务身份，不重新提交生成。

已知上游任务的查询使用该任务所属 `user_id` 当前保存且可解密的 OneLink Key，；停止新准入、目录变化或 Key 版本变化不改变既有任务和资产的归属。无可用 Key 时保留任务身份并报告 `IMAGE_CREDENTIAL_UNAVAILABLE`，恢复后可在原次数与期限内继续查询；供应商拒绝当前 Key 时如实报告，不能保证不同上游账户有权读取同一任务。图片任务终态完成落库后，按该用户当前 `(config_id, model_key, credential_version, catalog_version, declaration_version)` 元组将单用户验证记录更新为 `verified`，不影响其他用户或平台路由定义。

成功：202 返回图片任务视图；相同 owner/requestId 和输入返回同一任务，不重复生图。

错误：400 IMAGE_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED、404 ASSET_NOT_FOUND、409 REQUEST_CONFLICT/IMAGE_OPERATION_UNSUPPORTED 或供应商资格错误、413 IMAGE_REFERENCE_LIMIT、429 COMPUTE_QUOTA_EXCEEDED、503 IMAGE_UNAVAILABLE/COMPUTE_UNAVAILABLE；正文读取还可能返回 408 或 413。

副作用：受理仅占用独立的图片活动任务名额（每用户最多 32 个、全局最多 1000 个 `accepted` 或 `materializing` 状态任务，独立事务锁，不与视频转码名额互相挤占），在 PostgreSQL 短事务中建立图片任务和内部执行记录，立即唤醒 A 的后台执行器。单 A 通过数据库原子认领任务，网络请求期间不持长事务；网络并发上限 4，解码独立排队且并发 1。提交意图先持久化，再发送唯一一次生成 POST；提交结果不明进入 unknown，不自动重发。参考图与遮罩输入快照保存在图片任务命令中，COS `If-Match` 读取或签名校验失败均发生在持久提交意图 与调用上游之前（0 次上游 POST）。Volcengine Ark、Vidu、Kling 图片结果的 URL 路径走公网 HTTPS 限时有界下载，再核对实际图片格式并落入既有 COS/Asset 物化。OpenAI Images 已实现 `data[].b64_json` 路径。编辑接口文档也列出 `data[].url`，显式请求 Base64 时仅返回 URL 的目标路由行为仍待实证。详见 [OneLink 图片协议](../integrations/onelink.md#必须遵守的约束)。Mio 不记录费用、计费、余额或预算。

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

视频任务与图片任务分表持久化。视频提交和执行须显式设置 `MIO_VIDEO_GENERATIONS_ENABLED=true`，并具备生成、供应商、资产以及 B/RabbitMQ 计算配置；未装配的协议仍返回不可用。Veo 的受保护下载和内联结果尚未接入，因此保持 ADAPTER_PENDING。取消和手动恢复写入口尚未开放。

## GET /api/v1/compute/video-capabilities/{modelRef}

身份：当前登录用户。

输入：本人目录 modelRef；不接受查询参数。

成功：200 `{modelRef,capabilitiesVersion,available,unavailableReason,modes,cancellation}`。模式按当前目录、精确平台路由和已装配驱动的交集投影，包含分型号、分模式参数限制；例如 Vidu 比例仅在文生视频模式提供。旧的仅声明模式而缺少参数边界的路线保持不可用。目录或路由存在不代表已真实验证。

错误：400 VIDEO_INPUT_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED、503 VIDEO_UNAVAILABLE。不可用成员正常返回 available=false，不暴露他人配置。

副作用：只读能力，不访问供应商。

## POST /api/v1/compute/videos

身份：当前登录用户；要求允许的 Origin 和 JSON。

输入：`{requestId,modelRef,expectedCapabilitiesVersion,parameters}`。requestId 为 UUID v4；modelRef 必须属于本人当前目录。parameters 接受封闭模式、本人 ready Asset 引用及分型号参数，不接受任意 URL、对象键或上游任务 ID。提示词最多 5000 码点，正文 256 KiB，总媒体引用最多 16；路由可施加更小限制。首次准入核对归属、状态、媒体类型与实际对象长度，并在内部冻结实际 raw 对象键和 ETag。生成 POST 前再次核对这些条件，符合后才签发私有输入 URL，引用顺序沿用请求。缺少新对象快照的旧任务仍校验当前本人 ready 资产和实际对象。受支持的水印省略值采用本人供应商默认值并冻结。

成功：202 持久 VideoJobView。同 owner/requestId 和同输入返回 200 原任务；不同输入返回 409。accepted 仅表示受理。执行器在 POST 前持久化 submitting，收到上游任务 ID 后先写入持久 `MIO_GENERATIONS_DATA_DIR` 的私有回执，再更新数据库。数据库写入中断后，执行器凭同一目录内已持久化的原回执，在可用配额和剩余预算内自动恢复同一任务的查询。若回执尚未持久化且任务无法重新取得配额，数据库可用时可保留上游 ID 供对账，任务维持 unknown。无法确认上游身份时进入 unknown，生成 POST 至多一次。已知上游身份每 5 秒有界查询，最多 360 次或 30 分钟。回包任务身份冲突或所需身份无效时进入 unknown，错误码为 `VIDEO_QUERY_IDENTITY_INVALID`，结果不会物化。成功 URL 先持久化，再流式下载到恢复目录，以 Content-MD5 上传私有 staging。B 按实际 staging ETag 核验容器、视频流、尺寸、时长与声音。A 按探测绑定的 ETag 将同一对象在 COS 桶内条件复制到不可覆盖的私有 raw 键，核对长度、SHA-256 元数据、MIME 和已知复制 ETag，再在同一数据库事务登记本人 derived Asset 与输出。单输出最多 512 MiB，物化最多三次。复制回执丢失按原 raw 键对账，重用已核验的同一资产身份。

错误：400 `VIDEO_INPUT_INVALID`（包括媒体类型不符）或 `VIDEO_MODE_UNSUPPORTED`，401 `UNAUTHORIZED`，403 `ORIGIN_DENIED` 或 `ORIGIN_REQUIRED`，404 `ASSET_NOT_FOUND`（引用资产不存在、不属于本人或未就绪），409 `REQUEST_CONFLICT`、`VIDEO_CAPABILITIES_STALE` 或 `VIDEO_INPUT_CHANGED`（已登记的对象缺失、长度或可核对的 ETag 不符），429 `VIDEO_QUOTA_EXCEEDED`，503 `VIDEO_UNAVAILABLE`（包括 PostgreSQL 或 COS 调用故障）；读取正文可能返回 408 或 413。已受理任务在发送前复核失败时以 `rejected` / `VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE` 结束，生成 POST 为零。失败、未知和物化失败分别呈现，不能当作完成。

副作用：创建持久意图和执行密文快照，单次真实生成可能计费。DSH 视频工具在服务向数据库发出 COMMIT 之前观察到轮次取消时回滚受理。受理提交后，执行器独立推进同一任务。HTTP 正文及身份确认后，客户端断开时准入照常执行。活动任务限制每用户 5、全局 50；后台最多 4 个并发操作。普通自动化回归只连接隔离数据库和协议替身。

## GET /api/v1/compute/videos

身份：当前登录用户。

输入：可选 limit（默认20，1–100）和不透明 cursor；不接受 owner。

成功：200 本人任务 items 和 nextCursor，按 `(created_at,id)` 倒序 keyset 分页。

错误：400 VIDEO_INPUT_INVALID/VIDEO_CURSOR_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED、503 VIDEO_UNAVAILABLE。

副作用：只读任务，不推进供应商调用。

## GET /api/v1/compute/videos/{id}

身份：任务所有者。

输入：服务端任务 UUID，无查询参数。

成功：200 VideoJobView，包含有效参数、输入快照、状态、阶段和已登记输出元数据；assetId 可经本人资产接口取得短期下载地址。内部密文、签名输入 URL、上游任务 ID 和对象键不公开。恢复文件及未知任务保留供对账。

错误：401 UNAUTHORIZED、403 ORIGIN_DENIED、404 JOB_NOT_FOUND、503 VIDEO_UNAVAILABLE；未知和他人任务统一404。

副作用：只读状态，不重发生成。表由 generations 增量迁移创建，启动不自动迁移。

### 图片执行配置与切换

A 使用 `MIO_GENERATIONS_ENABLED=true` 和绝对持久目录 `MIO_GENERATIONS_DATA_DIR`；身份、媒体数据库、COS 及 provider master key 仍须配置。先迁移 assets，再显式执行 `pnpm generations:migrate --apply`（本地为 `pnpm migrate:dev generations --apply`）。历史任务及输出原表继续使用；没有 A 执行记录的旧 B 任务只读查询，不被 A 重新提交。内部密文、上游 ID、执行阶段和文件定位不进入公开视图。

切换沿[常驻环境](../local-environments.md#图片生成迁移与切换)先暂停新提交、排空并对账旧任务/outbox/MQ/B journal 和未确认上传，再停旧图片执行器、启动 A 并恢复接单。未对账 unknown、恢复数据缺失、存储权限不足阻止切换。A 接过新任务后先对账新任务，不能直接交旧 B 重跑。成功 COS/DB 对账后清理已确认临时图。进程在已完成提交后中断时，后台按确切完成检查点和 COS 输出补清；只处理全部完成且尝试键无歧义的文件，清理可幂等续接，失败项分页推进并后续回访。失败、部分完成与未知检查点保留；磁盘不足停止新任务准入，不自动删除恢复数据。

跨任务的 Worker 容量、占槽历史和动态调限统一收口至[管理后台 HTTP 契约](admin.md)的 `/api/v1/admin/compute/*` 纯 JSON 接口，由超级管理员通过独立前端 `mio-admin-web` 使用。本人任务接口和结果归属规则不变。
