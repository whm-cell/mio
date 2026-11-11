# 计算任务协议 v1 与 Worker 恢复边界

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

结果直接引用 derived 对象的前提是：新私有桶未开启版本控制；B 的 derived PUT 在权限策略中强制 `x-cos-forbid-overwrite=true`；A/B 运行身份不能删除或绕过限制覆盖 derived。以上均须在新桶执行正反例，不得把 SDK 参数或策略文本当真云证据。前提不成立时停止真实结果接受，重新评估受保护的服务端复制；不静默放开权限。

## 路由、回执与状态

使用隔离 vhost、持久 direct exchange `mio.compute.commands.v1` 和 quorum queue `mio.compute.commands.v1`，routing key 为 `transcode.v1`；结果采用独立持久 direct exchange `mio.compute.results.v1`、quorum queue `mio.compute.results.v1`，routing key 为 `transcode.result.v1`。消息 persistent、JSON content type，B 消费 prefetch=1；两侧发布和消费使用分开的连接。命令和结果分别有持久 quorum 死信队列，P3 必须明确配置并验证可靠死信投递、不可路由及队列满时的行为，不依赖默认丢弃。

A 在一个 PG 事务写 job、当前 attempt 与待发布 outbox；同 owner/requestId 和同输入返回原 job，输入不同时 409。publisher confirm、mandatory return、断线未知和本地缓冲背压分别处理：确认不等于业务成功；未确认或退回的 outbox 不得标为已送达。B 在 journal 事务记录事件后发布结果，只有确认且未退回才 ACK 对应命令。A 在验证结果并提交 inbox 去重、资产及状态后 ACK 结果；连接中断后重投按稳定 messageId 幂等。

任务状态为 accepted、queued、running、succeeded、failed。A 对 jobId、commandId、当前 attemptId 与 attempt 序号做一致核对，以数据库条件更新；running 不能覆盖终态，旧 attempt 的 running、failed 或 succeeded 均不回退或重试当前任务。unknown 不伪装失败或成功，保留待对账且不自动增加 attempt。终态后重复同事件无副作用。每用户最多 10、全局最多 500 未结束任务，受理须在并发下事务性维持。

消息由独立 broker 身份隔离：A 可发布命令和消费结果，B 可消费命令和发布结果；限制 exchange/queue/vhost 权限，远程链路使用 TLS。发布者必须设置 AMQP `userId` 为自己的专用身份，消费者要求该属性存在且等于预期，禁止授予 `impersonator`；RabbitMQ 只在该属性存在时验证它与连接身份一致。消费者还须核验本地 attempt，不能信任正文的 worker 名；凭据泄露后的伪造不由字段格式单独解决。

quorum 的可靠死信转发不能沿用默认 at-most-once：源队列需显式配置 `dead-letter-strategy=at-least-once`、`overflow=reject-publish`、目标 DLX 和必要 feature flag，验证目标不可用时源队列保留待转发消息。把策略降为 at-most-once 或 drop-head 可能删除尚未确认的死信，恢复和运维不得静默降级。

## B 的持久 journal 与未知结果

首期单实例 B 将 SQLite journal 保存在独占持久卷 `/var/lib/mio-compute/journal.sqlite3`，使用 WAL 和 FULL 同步；该卷同时持有尚需恢复的输入、输出文件。启动须核对实例身份和现有 journal，缺失或损坏时停止消费并对账，不能自动当成新 worker。保留卷与数据库、WAL/SHM 的一致性；本地临时路径不得来自消息。SQLite 同步写的延迟、锁及损坏恢复须在目标环境验证。

每个 attempt 在启动 FFmpeg 前持久写 launch intent，并且同一 attempt 最多 spawn 一次。A 最多创建三个 attempt；保守记账可能在 intent 已写但尚未证明 spawn 时消耗一次，不承诺恰好执行三次。`PROCESS_UNKNOWN` 时停止所有新计算 admission，包括新命令和重投，直到确认旧 FFmpeg 已终止，维持单实例并发 1。若 journal 已持久记录 PID，须核对同一宿主、boot 和进程命名空间，并确认该 PID 不存在；PID 仍存在或身份无法核对则继续 HOLD。若崩溃发生在 PID 落盘前，只能由可证明覆盖该进程的隔离运行时记录或人工核实；worker 或容器重启自身不能当作进程已结束的证明。确认后才能报告 interrupted，由 A 决定是否创建下一个 attempt。

每个 attempt 使用上述固定 derived 键。B 先持久化输出文件、长度和 SHA-256，再发带禁止覆盖头的 PUT；成功或结果未知后均 HEAD 同一键。上传结果未知且对象存在时 GET 同一键、流式重算 SHA-256 和长度再认领；不存在时仅用已持久输出重传同一键。同一进程中若 SDK PUT 因本地等待超时而仍未结束，对账须等待该请求真正结束，不能同时再次查询或写同一键；进程崩溃后只能按同键和摘要重新核验，不能声称旧请求已取消。对象内容不匹配、旧进程仍可能写入或本地输出丢失时保持 unknown，不无条件重新计算或更换键。unknown 事件持久并确认发布后可以 ACK 命令，但 journal 和必要本地文件必须保留；B 启动及有界定时对账可继续同一 attempt，解决后发布新的稳定事件，不能依赖已 ACK 消息再次投递。对账与命令重投共用 journal 排他控制，每次最多处理一个 attempt，定时扫描和失败退避须有界，不能并发对同一键恢复。

定期对账可持续较长时间，因此 B 开始对账前同步关闭新命令入场、排空已接纳的 handler，再关闭该次 consumer channel；不能让已投递的新命令在对账锁后等待而消耗其 ACK 期限。关门后迟到的投递不进入 Worker、不创建 attempt 或启动计算，也不 ACK；关闭该旧 channel 后由 broker 重排。旧 channel 的迟到回调不得在新 channel 上应答或误触发重连。publisher 使用独立连接及 channel；对账结束且进场条件满足后新建 consumer channel 并重新订阅。存在 `PROCESS_UNKNOWN` 或磁盘背压时继续暂停订阅，直到相应条件恢复。

结果终态与结果事件已持久化、发布确认且未退回后，可依据 journal 幂等清理本次 worker 本地文件，然后派发命令 ACK；无论进程在清理、ACK 派发或 journal 更新之间何时退出，重启和重投都能从持久终态重放结果或 ACK，清理也可重复。AMQP 消费者 ACK 没有服务端确认，派发与 broker 实际收到不能当作与 SQLite 原子提交；持久标记不能声称 broker 已收到。unknown 状态的必要文件仍须保留；登记的 COS 原件与成品不自动删除。

B 独占持久目录的初始总预算为 10 GiB，所在文件系统至少保留 2 GiB 空闲；计算入场前检查本目录已有占用和剩余空间，运行中持续检查。触及阈值停止新工作，按实际情况终止或等待在途执行，保留 journal 和仍需对账的文件；不能为了腾空间删除已登记 COS 资产或丢失 unknown 证据。这是本机初始护栏，须按实际负载验证，和 RabbitMQ 存储预算分开。

单次 attempt 从取得输入到生成并提交结果按 60 分钟总预算停止新工作；FFmpeg 的输入/编码 `-threads`、`-filter_threads` 与 `-filter_complex_threads` 参数固定为 2，并非进程总线程数或 CPU 硬上限。单次上传对账另有最多 60 分钟预算，SDK 的 60 秒连接或空闲超时不是整个 1 GiB 流传输的总期限。75 分钟 broker ACK 超时为恢复余量。若结果无法确认，保留 journal/outbox 并容许重投，不能把本地超时当作消息或 COS 副作用已取消。正常、超时、断线、重启、重复和异常来源须分别经真实入口验证。
