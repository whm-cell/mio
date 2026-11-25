# 通用媒体处理与资产派生设计

来源、范围与本期 M1–M6 开发单元安排见[PRD](prd.md#通用媒体处理与资产自动派生)。本设计原型参考依据为分支提交 `origin/A@7002715`，接入主干时执行去版本化重构，保留 `main@072c6d4` 既有音频私有 COS ACL 与 `playbackUrl`、音频 RabbitMQ 重投隔离以及既有单路视频转码（`/api/v1/compute/jobs`）已接受成果；当前为**设计候选**，尚未合入主干源码或接受，随 M1–M6 实施单元逐项验证与接受。

A 负责登录身份、任务受理、状态管理、私有 HLS 鉴权与资产登记；B 负责执行全部 FFmpeg/ffprobe。共享协议位于 `contracts/compute/`；既有单路视频转码（`/api/v1/compute/jobs`，[既有计算协议](protocol.md)）和独立音频检测保留原有字段、profile、队列与恢复语义。

## 操作与参数

所有时刻和长度均使用秒（有限数字）。输入为有序且不重复的 `{assetId}` 数组，参数仅通过 `inputIndex` 引用，最多 64 个资产。客户端不能传对象键、URL、本地路径、命令或滤镜。任务受理时固定采用语义化配置 `profile: "standard-media"`，冻结规范化 `operation`、输入快照、参数与执行资源预算；修改参数或输入必须新建任务，重试与恢复沿用原快照。

| 操作                    | 参数与保留行为                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| composition.render      | resolution=720p/1080p/4k，durationSeconds、tracks、items；每类六条 V/A/S，最多 256 项；图片/视频/音频/字幕、源偏移、0.5–4 倍速、增益、变换、隐藏与锁定；空隙黑底、多层叠加与原声/配音混合 |
| video.derivatives       | profile=ordinary/canvas；MP4 preview、poster、完整 HLS 包；普通一次输出整套，画布逐片及相同尺寸去重                                                                                       |
| video.trim              | startSeconds/endSeconds；实测源窗口、精确切点、最多 600 秒，保留音轨并按容器需要转 AAC                                                                                                    |
| video.mix               | 显式 clips 源窗口、seed、可选 bgmInputIndex/bgmVolume；确定性序列，无隐式保留原声                                                                                                         |
| video.narration_render  | videoInputIndex/narrationInputIndex、可选 BGM/cues/style；配音实测时长决定片长，末帧补齐、响度处理                                                                                        |
| media.export            | format=mp4/webm/gif/mp3、可选 height/fps；WebM 使用 VP9                                                                                                                                   |
| subtitle.burn           | cues 的 startSeconds/endSeconds/text、可选 style；独立中文 ASS、背景和描边                                                                                                                |
| video.reference_prepare | 空参数；按需压至 1080p、取前 15 秒，返回实际 compressed/trimmed                                                                                                                           |
| frames.extract          | mode=first_last/timestamps/interval/scene，相应 timestamps/intervalSeconds/threshold；maxFrames≤256、width≤1920                                                                           |
| scenes.detect           | 可选 threshold/minSceneSeconds；实测场景边界                                                                                                                                              |
| video.split             | 严格递增 boundaries，最多 255；copy 切段，切点受原媒体关键帧约束                                                                                                                          |
| media.probe             | 空参数；实测 duration、流、旋转、SAR、尺寸、编码、采样与帧率                                                                                                                              |
| audio.extract           | profile=original/asr、可选 wav/mp3/m4a；ASR 固定 16kHz 单声道 WAV                                                                                                                         |
| audio.waveform          | points≤4096；归一化、有界结果                                                                                                                                                             |
| audio.remux             | 两个输入（视频、音频）、可选 sourceDurationSeconds；按源长去除补长                                                                                                                        |
| audio.concat            | 有序输入、可选每输入字幕；拼接并按实测长度偏移字幕                                                                                                                                        |

时间线锁定只约束编辑，仍参与导出；隐藏轨过滤渲染。视觉轨由低至高叠加，同轨按开始时刻稳定排序；被遮挡不自动静音。音频混合保持原工程默认归一化语义。图片属于视觉轨。显式 manual 变换允许非等比尺寸和画布外裁剪。输出比例按输入实际显示比例处理，旋转及 SAR 必须核验。

混剪（`video.mix`）将旧实现中的随机源入点改为调用方提交并冻结的 clips 源窗口，`seed` 只决定可重放顺序，不宣称兼容 Python Random 的位级序列。修正普通 HLS 对小尺寸源实际放大与清单尺寸不一致的问题，统一以实际输出尺寸发布。模型生成、ASR 推理、TTS/供应商调用、网络采集、剪映工程编辑器与项目保存不迁入 B。

参考视频预处理（`video.reference_prepare`）在输入原视频已经符合 1080p 尺寸和 15 秒时长限制时，只执行探测并返回 `compressed=false`、`trimmed=false` 及空 outputs；调用方继续使用任务 `inputs` 中的原 ready 资产，不为无需处理的原件重新编码或复制发布。

## 受理、结果与发布

候选公共入口统一归属计算域，全部要求登录 Cookie 本人身份（写操作须满足精确允许 Origin、JSON 与会话复核）：

- 提交、列表与详情：`POST /api/v1/compute/media`、`GET /api/v1/compute/media`、`GET /api/v1/compute/media/{id}`
- 任务控制：`POST /api/v1/compute/media/{id}/cancel`、`POST /api/v1/compute/media/{id}/retry`、`POST /api/v1/compute/media/{id}/recover`
- 私有 HLS 鉴权入口：`GET /api/v1/compute/media/{id}/hls`、`GET /api/v1/compute/media/{id}/hls/{assetId}`

`POST /api/v1/compute/media` 正文为 `{requestId, operation, inputs, parameters}`，请求与内部命令 UTF-8 编码最多 256 KiB。A 核对本人 ready 原件或已登记派生资产，冻结真实 COS 长度、ETag、规范化参数与 `profile: "standard-media"`；B 条件 GET 并核验实际媒体。`(owner, requestId)` 与规范化输入幂等（同键异参返回 409）；`retry` 使用独立 `requestId` 幂等，修改参数或输入必须新建任务。

单个输入和单个输出均不超过 1 GiB，Worker 工作目录预算不超过 10 GiB 且所在文件系统空闲不低于 2 GiB；4K 渲染同样受此预算约束。画布 HLS（`video.derivatives` `profile="canvas"`）最多 720 秒 / 120 片，每片目标 6 秒且不超过 4 MiB；最多 720p/480p 两档，不放大且相同尺寸去重；逐片核验长度、时间和音轨，容差 0.35 秒。普通 HLS（`profile="ordinary"`）使用 FFmpeg 一次产生清单与全部分片。

B 为所有输出文件可靠上传后，最后提交含 SHA-256 的内部 manifest（最多 2 MiB / 4096 项）；结果消息仅携带 manifest 描述。对象键绑定 `jobId`/`attemptId`；A 验证 manifest 身份、对象长度/ETag/摘要及当前 attempt 后，在同一 PostgreSQL 事务中原子登记全部输出资产、结构化检测结果与 `succeeded` 状态。私有 HLS 作为受控资源包发布：主清单经 `GET /api/v1/compute/media/{id}/hls` 返回，子清单链接重写至 `GET /api/v1/compute/media/{id}/hls/{assetId}` 继续走本人鉴权入口，媒体分片链接重写为短期私有 COS 签名地址；只签 master 清单不构成播放闭环。

视频原件上传确认（`POST /api/v1/assets/{id}/complete`）登记 `ready` 与 `(asset, profile)` 唯一的 `ordinary` 派生意图在同一数据库事务内产生。后台沿持久 outbox 建立派生任务，配额不足或暂时故障时保留 `pending` 续跑；重复确认不会重复转码。原件始终可独立查询与下载，派生进度和结果随资产视图关联展示；派生排队、降级或失败绝不回滚原件 `ready`。未启用 compute 时明确显示 `disabled`；计算产物直接登记为 `ready`，不经过上传完成意图，也不递归触发二次派生。

## 私有 COS ACL、音频兼容与统一资产库边界

- **私有 COS ACL 与既有音频资产兼容**：Worker B 上传所有通用媒体产物（视频、抽帧图片、音频、HLS 主/子清单与分片）及内部 manifest 时，必须显式写入 `private` ACL，不得依赖存储桶默认权限。A 侧在 `AssetView` 上扩充可选 `derivatives` 字段时，必须完整保留 `main` 现有音频原件在[资产契约](../../apis/assets.md)中的 `uploadHeaders`（`x-cos-acl: private`）、完成确认时的私有 ACL 强制写入与校验，以及短期 inline `playbackUrl` 签发，严禁回退音频上传、完成、播放或音频检测 RabbitMQ 重投隔离行为。
- **内部附属派生不入生成历史**：视频原件上传 `complete` 同事务自动建立的 `ordinary` 派生物（preview MP4、poster、私有 HLS）及画布规格播放派生（`video.derivatives` `profile="canvas"`），均属于[统一资产库 PRD](../unified-asset-library/prd.md#3-生成历史)定义的内部附属派生物，**不产生生成历史、不自动进入我的资产**，且派生排队、降级或失败不影响原件 `ready` 与下载。
- **上层业务显式编辑/渲染结果入历史**：画布、漫剧等上层消费方显式发起并保存的裁剪（`video.trim`）、抽帧（`frames.extract`）、多轨渲染成片（`composition.render`）、字幕烧录（`subtitle.burn`）等独立产出，由对应业务确认链路按 `(businessTaskId, outputIndex)` 事务接入统一资产库生成历史与显式业务引用。
- **有效持有保护与物理 GC 关联清理**：未终结的通用媒体处理任务（`/api/v1/compute/media`）所冻结的输入资产、在途输出及受控关联附属派生对象，纳入[统一资产库 PRD](../unified-asset-library/prd.md#7-回收站与物理媒体清理)第 7 类有效持有保护；当原件满足全部 7 类持有归零并经受控物理 GC 清理时，按精确对象键一并清理关联的受控附属派生对象。

## 执行、取消与恢复

RabbitMQ 队列按计算域统一命名，不带代际版本号后缀：命令与控制分别路由至 `mio.compute.media.encode`、`mio.compute.media.probe`、`mio.compute.media.control`，结果路由至 `mio.compute.media.results`，并各自配备独立持久死信队列 `mio.compute.media.encode.dlq`、`mio.compute.media.probe.dlq`、`mio.compute.media.control.dlq` 与 `mio.compute.media.results.dlq`。沿用[RabbitMQ 集成契约](../../integrations/rabbitmq.md)的持久 direct exchange、quorum 队列、`dead-letter-strategy=at-least-once`、`overflow=reject-publish`、`delivery-limit=-1`、每队列 1 GiB 容量策略、发布/消费独立连接及 AMQP `userId` 强校验；具体交换机与路由键随 M1 在 `contracts/compute/` 与 `scripts/service/compute-broker-topology.ts` 统一冻结。

单个 Worker B 实例内，既有单路视频转码、独立音频检测与通用媒体处理共享统一的计数型资源槽（`total` / `encode` / `probe`，默认和最低部署硬上限为 `2/1/1`）：单路视频转码与编码类通用媒体操作占用 `encode` 槽，独立音频检测与探测类通用媒体操作占用 `probe` 槽，控制消息经独立通道消费不被计算通道满载阻塞。A 侧对既有单路视频转码（`/api/v1/compute/jobs`）与通用媒体处理（`/api/v1/compute/media`）共享活动任务准入锁与合计配额（每用户最多 10、全局最多 500），与图片生成独立配额隔离。动态并发上限、有界 prefetch 与占槽历史观测设计见[Worker 并发观测与动态上限 PRD](changes/worker-observability/change.md)。FFmpeg 输入、编码与滤镜线程参数固定为 2，不能当作容器 CPU 硬限制；单次 attempt 总执行预算为 60 分钟，独立音频检测保留 180 秒。独立产物须提供容器 CPU/内存/磁盘限制说明与启动能力自检。

所有文件系统、子进程、SQLite、COS、MQ 均经独立 adapter 接入；业务模块只生成内部类型化步骤。每步先持久化启动意图，再记录 PID/进程身份、退出码与输出摘要；切片/分片检查点仅在输入、`profile` 一致且摘要核验通过后复用。进度流式合并并保留有界诊断尾部，不累计整段长视频 stdout。

取消仲裁采用确定性先后裁决：A 先持久提交取消意图，再发送独立控制消息至 `mio.compute.media.control`。B 持久化取消标记：尚未开始的任务直接跳过；正在执行的任务执行 kill 并等待进程 reap 后报告 `cancelled`。若 `succeeded` 已在 A 侧提交，迟到的取消保持 `succeeded`；若取消已先提交，晚到的输出仅保留为内部对账材料，不登记为用户结果资产。取消或失败绝不自动删除原件或已登记资产。

确认进程已结束的中断（`WORKER_INTERRUPTED`）、执行超时（`EXECUTION_TIMEOUT`）和瞬时存储故障（`STORAGE_FAILURE`）允许建立新 attempt，自动与手动重试总计最多 3 次，全部沿用原冻结快照；输入错误、未分类执行失败、磁盘不足和取消不自动重跑。条件 GET 返回 412 保留为 `INPUT_CHANGED`；仅网络中断或 408/429/5xx 读取错误才归类为 `STORAGE_FAILURE`，存储权限错误不触发重试。已回收的信号中断保持 `WORKER_INTERRUPTED`，探测阶段不得将其改写为输入错误。`PROCESS_UNKNOWN`、`UPLOAD_UNKNOWN` 与摘要冲突进入 `reconciling`，`recover` 仅核对旧进程、原对象键与已保存本地输出，绝不新建 attempt。进程重启或本地超时不能证明旧副作用已结束，未知状态所需本地文件必须保留。结果事件先持久化、确认 publisher confirm 后标记确认、再执行命令 ACK，A 侧 inbox 幂等去重；步骤启动记录不能替代最终结果确认。

## 字体与独立产物

两款 Noto CJK OTF 字体及 OFL 许可随 `compute/fonts` 打包发布，使用 `fontkit` 获取精确字体度量，不依赖宿主机偶然安装的系统字体。Worker B 启动时核对 x264、VP9、AAC、MP3、所需滤镜及 `libass`/`fontkit`，缺少任一能力明确报告 `CAPABILITY_UNAVAILABLE`。A/B 独立产物在仓库外可独立运行，运行时严禁读取旧工程、测试文件或开发脚本。

PostgreSQL schema 与 Worker SQLite journal 仅采用增量升级，升级前完整保留既有持久事实；应用回退前必须先停止新任务准入，并对账在途新任务与未知副作用，严禁破坏性降级。共享协议、schema、拓扑、资源槽及插件装配由集成负责人唯一串行写入，各独立业务操作文件按单元独占。正式验收取证必须绑定干净 Git 候选，既有已接受计算与音频成果保持独立核对，不因本设计合入而改写既有接受结论。
