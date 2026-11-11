# 本机计算 Worker

仓库内开发、人工测试优先使用[常驻环境](../docs/local-environments.md)的 `compute:init:dev/test` 与 `compute:start:dev/test`；初始化只做一次，启动在前台运行，使用该环境独立的 broker 身份和 journal。`start:dev/test` 启动主服务 A，不会同时启动 B。MQ 权限与部署边界见 [RabbitMQ 契约](../docs/integrations/rabbitmq.md)；下列原始入口仍用于独立部署产物。

本进程只接受计算协议 v1，通过受限 B 身份消费命令并发送结果。需要 Node 24、`ffmpeg`（含 libx264、AAC）和 `ffprobe`。先构建共享协议及 Worker，并准备由运行身份拥有、其他用户不可访问的独占持久目录。环境提供 `MIO_COMPUTE_DIRECTORY`、持久不变的 `MIO_COMPUTE_INSTANCE_ID`、B 专用 `RABBITMQ_URL` 和 `MIO_COMPUTE_BROKER_USER`、A 专用发送身份 `MIO_COMPUTE_EXPECTED_COMMAND_USER`，以及 `MIO_COS_BUCKET`、`MIO_COS_REGION`、`MIO_COS_SECRET_ID`、`MIO_COS_SECRET_KEY`。不要把凭据写入日志或仓库。非回环 RabbitMQ 连接须使用 TLS。

首次新建卷时显式运行 `node compute/dist/main.js init`，其后运行 `node compute/dist/main.js start`。已有卷丢失、损坏或实例身份不一致时，停止消费并调查；不要对已有卷重新初始化。journal、WAL、SHM 和未确认的输入/输出都须保留在一起。目录是单实例独占的；SQLite 的锁在进程退出后释放，各事件和状态独立提交。

已有 schema 3 的 journal 会在实例身份及完整性核对后，在 SQLite 事务内升级到 schema 4；升级中断时继续保留原卷并重新启动，不另建空库。终态结果已持久化且发布确认、未被退回后，本地文件可幂等清理；重投仍从 journal 应答，不重新计算。journal 的 `ack_dispatched` 只表示本地 ACK 调用返回，AMQP 没有该 ACK 的服务端回执；`cleaned` 记录本地文件清理，二者不能证明 broker 已收到 ACK。未知状态继续保留文件。

进程启动意图已提交而 PID 尚未持久化时，Worker 会发送 `PROCESS_UNKNOWN` 并停止新计算；重启不能证明旧进程结束。人工应先停止 Worker，核对同一宿主、启动周期和进程命名空间，并通过覆盖该运行环境的进程/隔离运行时记录，确认对应 FFmpeg 及其子进程均已终止。无法确认就保持 HOLD。**只有人工实际完成确认后**，以同一目录及实例身份运行 `node compute/dist/main.js resolve-no-pid <attempt-id> --confirmed-process-terminated '<确认依据>'`；它只接受无 PID 的 unknown 记录，保存依据并持久创建 interrupted 事件。再次启动后有界对账会发布该事件。该操作不会重新执行原 attempt。

上传结果未知时保留原输出和 journal；每次对账另有最多 60 分钟预算，查询同一对象键，存在时读取并重算内容摘要，不存在时只用已持久的原输出重传。连接或读写无进度的 60 秒超时与总预算不同。同一进程内若前次 PUT 尚未返回，后续同键对账等待其落定；本地超时不证明远端 PUT 已取消。未知对象内容不符或本地输出缺失时保持待对账，不删除 COS 资产或换键重算。
