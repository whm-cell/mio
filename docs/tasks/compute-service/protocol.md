# 计算任务协议 v1 与 Worker 恢复边界

本协议约束 A/B 之间经 RabbitMQ 传输的视频转码命令/结果，以及只读视频媒体探测命令/结果。`transcode.request` 与 `transcode.result` 的 v1 身份、字段和行为保持兼容；`video.probe` 是独立的 v1 消息类型，不启动转码、不生成视频，也不携带供应商凭据或媒体字节。云端图片生成、查询和物化恢复已迁入 A，由 PostgreSQL 持久任务和 A 的专用恢复目录承接。[图片 HTTP 契约](../../apis/compute.md#post-apiv1computeimages) · [图片迁移变更](../onelink-image-generation/changes/image-generation-in-a/change.md)

本页是经本期协调审阅的 P3/P4 v1 实施边界；双方以它对齐，改变消息、身份、数据或副作用边界须重新核对。协议冻结不表示源码、云权限、消息或结果已经交付。需求和资源限制见[本期 PRD](prd.md)，服务边界见[设计](design.md)。共享包为 `@mio/compute-contracts`，源码入口为 `contracts/compute/src/index.ts`，构建生成 `dist/index.js` 与 `dist/index.d.ts`；A/B 不导入对方内部模块。

## 消息与身份

消息为 UTF-8 JSON，消费者在解析前拒绝超过 8192 字节的 body；`version` 必须为整数 `1`，未知版本、未知字段、无效 UUID、超限字符串和不符合当前类型的字段拒绝处理。所有 ID 为小写 UUID v4。`messageId` 在同一条消息重发时不变；不同事件使用不同 ID。仅消息本身不授予用户权限。

命令使用 `type: "transcode.request"`，字段如下：

```json
{
  "version": 1,
  "type": "transcode.request",
  "messageId": "<command-id>",
  "jobId": "<job-id>",
  "attemptId": "<attempt-id>",
  "attempt": 1,
  "profile": "mp4-h264-aac-720p24-v1",
  "input": {
    "assetId": "<asset-id>",
    "key": "mio/raw/<asset-id>/<raw-id>",
    "sizeBytes": 123,
    "etag": "<opaque-cos-etag>"
  }
}
```

A 从登录会话取得 owner，按 owner 查询已登记资产；HEAD 该 raw 键，核对大小与数据库，持久冻结 **raw 实际 ETag** 后才把它写入任务快照。不能把 staging 的 ETag 推断为 raw ETag。`sizeBytes` 为 1 至 1073741824；ETag 原样保留但限制长度和控制字符。B 只接受固定 profile 和上述严格键结构，使用条件 GET 校验 ETag，流式核对实际字节上限与声明大小；不能接收任意 URL、桶、命令、路径或来自用户的 owner。对媒体内容用 ffprobe 核对时长不超过 1800 秒，不能凭 MIME 或扩展名认定内容。

结果使用 `type: "transcode.result"`，公共字段为 `version`、`type`、`messageId`、`commandId`、`jobId`、`attemptId`、`attempt` 和 `state`；`commandId` 是对应命令的 messageId，`attempt` 为 1 至 3。`state` 为 `running`、`succeeded`、`failed` 或 `unknown`。running 不包含 output 或 errorCode；failed 与 unknown 必须带枚举 `errorCode` 且不含 output，不带上游错误栈、文件路径或秘密。可重试与否由 A 的固定错误分类决定，不能由 B 自授：

- failed：`INPUT_INVALID`、`INPUT_TOO_LARGE`、`INPUT_TOO_LONG`、`INPUT_CHANGED` 直接终止；`TRANSCODE_FAILED`、`EXECUTION_TIMEOUT`、`STORAGE_FAILURE`、`WORKER_INTERRUPTED`、`OUTPUT_INVALID` 在 attempt 小于 3 时由 A 创建下一 attempt，否则终止。
- unknown：`PROCESS_UNKNOWN`、`UPLOAD_UNKNOWN`、`OUTPUT_MISMATCH` 均保持待对账；journal 无法持久写入时不确认消息、停止消费并告警。上传是否成功未知时不能冒称 `STORAGE_FAILURE` 后自动重算。

succeeded 另含 `output: {key, sizeBytes, etag, sha256}`，键严格等于 `mio/derived/<jobId>/<attemptId>/result.mp4`，`sizeBytes` 为 1 至 1073741824，SHA-256 是小写 64 位十六进制。B 对输出及未知上传恢复的 GET 流式执行同一上限，再持久记录最终文件大小与 SHA-256；PUT 传内容校验及 SHA-256 元数据，完成后 HEAD 获取 derived 对象的实际 ETag。A 在登记前 HEAD 该对象，核对 key、实际长度、ETag 与 SHA-256 元数据，并从本地 job 事实取得 owner。HEAD 核对元数据不等同重新读取并计算全部对象字节。A 不以消息内的 owner 或 URL 决定资源归属。结果资产与 job 终态在同一 PG 事务发布；由既有媒体域作增量迁移，保留原数据。

## 只读视频媒体探测 `video.probe` v1

`video.probe` 仅对 A 已准备的私有 COS staging 媒体进行限时字节完整性校验和 ffprobe；不执行任何转码/写入 COS/供应商调用，不经消息传递媒体字节或供应商凭据。字段集严格封闭；身份为 `(jobId, outputIndex, attemptId, attempt)`，`outputIndex` 为 0–15，`attempt` 为 1–3。`source.stagingKey` 必须精确是 `mio/staging/video/<jobId>/<outputIndex>/<attemptId>.media`；不接收 URL、bucket、命令行或本机路径。`source.sizeBytes` 限为 1 至 1073741824；`etag` 为最长 256 且不含控制字符的原样值；`sha256` 为小写 64 位十六进制。

```json
{
  "version": 1,
  "type": "video.probe",
  "messageId": "<message-id>",
  "jobId": "<job-id>",
  "outputIndex": 0,
  "attemptId": "<attempt-id>",
  "attempt": 1,
  "source": {
    "stagingKey": "mio/staging/video/<job-id>/0/<attempt-id>.media",
    "sizeBytes": 12345,
    "etag": "<opaque-cos-etag>",
    "sha256": "<lowercase-64-hex-sha256>"
  }
}
```

B 使用本地已固定的私有 bucket，先 HEAD 完整 key 核对 size/ETag/可用的 SHA-256 元数据，再用条件 GET `If-Match: <etag>` 流式下载到 worker 受限临时目录（目录 0700，文件 0600）。过流逐块累计实际字节并计算 SHA-256，必须与消息 size/digest 完全相同才启动 ffprobe；失配、过大、超时或 worker 停机均不返回可消费媒体。COS 下载和 ffprobe 共用 300 秒本地 AbortSignal 上限，取消时销毁流/子进程并清除这个 UUID 推导的临时文件。ffprobe 只从固定本地文件路径运行，使用固定参数和已有文件格式 whitelist，不使用 shell。保留当前 1800 秒视频时长上限；JSON 输出限 64 KiB，错误输出限 256 KiB。

成功回执为 `type: "video.probe.result"`，必须原样回传 commandId、jobId、outputIndex、attemptId/attempt 和完整 source 身份；`media` 只包含 ffprobe 得出的 `container`/`videoCodec`/`width`/`height`/`durationSeconds`/`hasAudio`/`audioCodec`。尺寸使用已采用的 display rotation 规则，返回 1–65536 的安全整数；时长为有限正数且不大于 1800。源 sizeBytes 和 sha256 留在 `source` 中，作为实际流校验后的值。错误回执只使用 `SOURCE_INVALID`/`SOURCE_TOO_LARGE`/`SOURCE_CHANGED`/`PROBE_FAILED`/`EXECUTION_TIMEOUT`/`STORAGE_FAILURE`/`WORKER_INTERRUPTED`，不包含 COS 响应体、本机路径、stack 或凭据。回执可因 RabbitMQ 重投重复；A 按完整身份幂等并拒绝过时 attempt，B 不保存该读操作的跨重启 journal。

### `video.probe` 路由的同步要求

保持 `version: 1`，无需换新 exchange 或 queue，但分别要在 `mio.compute.commands.v1` 交换机绑定 `video.probe.v1` 到现有 `mio.compute.commands.v1` 持久队列，以及将 `video.probe.result.v1` 绑定至现有 `mio.compute.results.v1` 队列。这是加性的 v1 topology 绑定；这些 bindings 与 A 端命令发布/结果消费适配未同步部署前，不能发送 probe。使用 `mandatory` 发布时新 routing key 没有 binding 必须被退回并保留上游重试现场，不能回退使用 `transcode.v1` 假装为转码。

## 路由、回执与状态

所有路由在隔离 vhost 内建立，共使用四个持久 direct exchange 和四条持久 quorum 队列。[部署拓扑](../../../scripts/service/compute-broker-topology.ts)

| 路由         | 交换机                        | Routing key                | 队列                          |
| ------------ | ----------------------------- | -------------------------- | ----------------------------- |
| A 发转码命令 | `mio.compute.commands.v1`     | `transcode.v1`             | `mio.compute.commands.v1`     |
| A 发探测命令 | `mio.compute.commands.v1`     | `video.probe.v1`           | `mio.compute.commands.v1`     |
| 命令死信     | `mio.compute.commands.dlx.v1` | `transcode.dead.v1`        | `mio.compute.commands.dlq.v1` |
| B 发转码结果 | `mio.compute.results.v1`      | `transcode.result.v1`      | `mio.compute.results.v1`      |
| B 发探测结果 | `mio.compute.results.v1`      | `video.probe.result.v1`    | `mio.compute.results.v1`      |
| 结果死信     | `mio.compute.results.dlx.v1`  | `transcode.result.dead.v1` | `mio.compute.results.dlq.v1`  |

两侧的发布和消费使用独立连接。消息以 persistent、JSON content type、mandatory 与 publisher confirm 发布。B 的命令消费使用 `prefetch=1`。A 的结果消费使用 `prefetch=4`，关闭连接前排空在途结果处理及 COS HEAD 核验。旧图片消息若投到视频队列，按非法命令处理。

A 在一个 PostgreSQL 事务写入视频 job 与 outbox，落库后触发 `wakePoll()`，合并并发唤醒，每轮认领并发布最多 10 条命令。Broker 故障后的重试从 1 秒起指数退避，最多 30 秒。结果消费者成功注册且同一 Broker 完成当轮 outbox 检查和发布后恢复初始退避。相同 owner/requestId 和输入返回原 job，输入冲突返回 409。收到发布确认且消息未退回时才将 outbox 标为已送达。B 在 journal 中持久化结果事件后发布，并在完成对应结果的确认后 ACK 命令。A 验证结果并提交 inbox 去重、资产及状态后 ACK 结果。连接中断后按稳定 messageId 幂等重投。

视频任务状态为 accepted、queued、running、succeeded、failed。A 对 jobId、commandId、当前 attemptId 与 attempt 序号做一致核对，以数据库条件更新；running 不能覆盖终态，旧 attempt 的 running、failed 或 succeeded 均不回退或重试当前任务。unknown 不伪装失败或成功，保留待对账且不自动增加 attempt。终态后重复同事件无副作用。视频活动任务限制每用户最多 10、全局最多 500（`mio_compute_jobs` 的 `accepted`/`queued`/`running`），并发受理时以事务维持。

消息由独立 broker 身份隔离：A 可发布命令和消费结果，B 可消费命令和发布结果；限制 exchange/queue/vhost 权限，远程链路使用 TLS。发布者必须设置 AMQP `userId` 为自己的专用身份，消费者要求该属性存在且等于预期，禁止授予 `impersonator`；RabbitMQ 只在该属性存在时验证它与连接身份一致。消费者还须核验本地 attempt，不能信任正文的 worker 名；凭据泄露后的伪造不由字段格式单独解决。

quorum 的可靠死信转发不能沿用默认 at-most-once：源队列需显式配置 `dead-letter-strategy=at-least-once`、`overflow=reject-publish`、目标 DLX 和必要 feature flag，验证目标不可用时源队列保留待转发消息。把策略降为 at-most-once 或 drop-head 可能删除尚未确认的死信，恢复和运维不得静默降级。

## 历史图片链路

迁移前，A 经 outbox 将 `image.request`、`image.query`、`image.recover` 以 `image.v1` 路由到 `mio.compute.image.commands.v1`，B 独立消费并以 SQLite journal 记录执行和物化。旧图片队列、DLX/DLQ 与 B 额外的图片读取权限需要在切换时对账和显式退役。切换先暂停新提交并盘点旧 PG/outbox、队列消息、消费者、B journal 与尚未确认的图片上传，再按证据处理未排空的记录。历史任务数据与恢复原件继续保留。[图片生成切换步骤](../../local-environments.md#图片生成迁移与切换) · [历史验收记录](complete/report.md#image-io-concurrency)

## B 的持久 journal 与未知结果

首期单实例 B 将 SQLite journal 保存在独占持久卷 `/var/lib/mio-compute/journal.sqlite3`，使用 WAL 和 FULL 同步；该卷同时持有尚需恢复的输入、输出文件。启动须核对实例身份和现有 journal，缺失或损坏时停止消费并对账，不能自动当成新 worker。保留卷与数据库、WAL/SHM 的一致性；本地临时路径不得来自消息。SQLite 同步写的延迟、锁及损坏恢复须在目标环境验证。

B 每轮在 5 秒内建立消费和发布两条 AMQP 连接、通道及预取设置。收到停止信号时终止尚未完成的建立和重连等待。连接可用后，停机先停止接纳新命令，等待已接纳的 handler 和正在运行的 journal 对账完成。随后关闭 AMQP 连接，等待关闭回执最多 5 秒。

每个 attempt 在启动 FFmpeg 前持久写 launch intent，并且同一 attempt 最多 spawn 一次。A 最多创建三个 attempt；保守记账可能在 intent 已写但尚未证明 spawn 时消耗一次，不承诺恰好执行三次。`PROCESS_UNKNOWN` 时停止所有新计算 admission，包括新命令和重投，直到确认旧 FFmpeg 已终止，维持单实例并发 1。若 journal 已持久记录 PID，须核对同一宿主、boot 和进程命名空间，并确认该 PID 不存在；PID 仍存在或身份无法核对则继续 HOLD。若崩溃发生在 PID 落盘前，只能由可证明覆盖该进程的隔离运行时记录或人工核实；worker 或容器重启自身不能当作进程已结束的证明。确认后才能报告 interrupted，由 A 决定是否创建下一个 attempt。

每个视频 attempt 使用上述固定 derived 键。B 先持久化输出文件、长度和 SHA-256，再发带禁止覆盖头的 PUT；成功或结果未知后均 HEAD 同一键。上传结果未知且对象存在时 GET 同一键、流式重算 SHA-256 和长度再认领；不存在时仅用已持久输出重传同一键。同一进程中若 SDK PUT 因本地等待超时而仍未结束，对账须等待该请求真正结束，不能同时再次查询或写同一键；进程崩溃后只能按同键和摘要重新核验，不能声称旧请求已取消。对象内容不匹配、旧进程仍可能写入或本地输出丢失时保持 unknown，不无条件重新计算或更换键。unknown 事件持久并确认发布后可以 ACK 命令，但 journal 和必要本地文件必须保留；B 启动及有界定时对账可继续同一 attempt，解决后发布新的稳定事件，不能依赖已 ACK 消息再次投递。对账与命令重投共用 journal 排他控制，每次最多处理一个 attempt，定时扫描和失败退避须有界，不能并发对同一键恢复。

定期对账可持续较长时间，因此 B 开始对账前同步关闭新命令入场、排空已接纳的 handler，再关闭该次 consumer channel；不能让已投递的新命令在对账锁后等待而消耗其 ACK 期限。关门后迟到的投递不进入 Worker、不创建 attempt 或启动计算，也不 ACK；关闭该旧 channel 后由 broker 重排。旧 channel 的迟到回调不得在新 channel 上应答或误触发重连。publisher 使用独立连接及 channel；对账结束且进场条件满足后新建 consumer channel 并重新订阅。存在 `PROCESS_UNKNOWN` 或磁盘背压时继续暂停订阅，直到相应条件恢复。

结果终态与结果事件已持久化、发布确认且未退回后，可依据 journal 幂等清理本次 worker 本地文件，然后派发命令 ACK；无论进程在清理、ACK 派发或 journal 更新之间何时退出，重启和重投都能从持久终态重放结果或 ACK，清理也可重复。AMQP 消费者 ACK 没有服务端确认，派发与 broker 实际收到不能当作与 SQLite 原子提交；持久标记不能声称 broker 已收到。unknown 状态的必要文件仍须保留；登记的 COS 原件与成品不自动删除。

B 独占持久目录的初始总预算为 10 GiB，所在文件系统至少保留 2 GiB 空闲；计算入场前检查本目录已有占用和剩余空间，运行中持续检查。触及阈值停止新工作，按实际情况终止或等待在途执行，保留 journal 和仍需对账的文件；不能为了腾空间删除已登记 COS 资产或丢失 unknown 证据。这是本机初始护栏，须按实际负载验证，和 RabbitMQ 存储预算分开。

单次 attempt 从取得输入到生成并提交结果按 60 分钟总预算停止新工作；FFmpeg 的输入/编码 `-threads`、`-filter_threads` 与 `-filter_complex_threads` 参数固定为 2，并非进程总线程数或 CPU 硬上限。单次上传对账另有最多 60 分钟预算，SDK 的 60 秒连接或空闲超时不是整个 1 GiB 流传输的总期限。75 分钟 broker ACK 超时为恢复余量。若结果无法确认，保留 journal/outbox 并容许重投，不能把本地超时当作消息或 COS 副作用已取消。正常、超时、断线、重启、重复和异常来源须分别经真实入口验证。
