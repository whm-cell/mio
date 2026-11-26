# 计算服务 RabbitMQ 部署

RabbitMQ 连接 A 和 B 的视频转码、独立音频检测、通用媒体处理及 Worker 控制协议。

开发和人工测试的常驻实例使用[环境入口](../../docs/local-environments.md)统一管理，公共权限和持久化边界见 [RabbitMQ 契约](../../docs/integrations/rabbitmq.md)。下列独立 Compose 和一次性 bootstrap 仍用于独占部署及隔离探针，不替代开发/测试环境，也不自动接管其数据。

该 Compose 配置用于独占的计算服务 broker，固定 RabbitMQ 4.4.0 management 镜像和摘要。启动前在受保护的位置准备仅当前用户可读的环境文件，提供 `RABBITMQ_DEFAULT_USER`、`RABBITMQ_DEFAULT_PASS`、`RABBITMQ_DEFAULT_VHOST`、`RABBITMQ_AMQP_PORT`、`RABBITMQ_MANAGEMENT_PORT`；不要将真实密码放入仓库或命令参数。Docker 管理员仍可读取容器环境，部署时应按宿主权限保护。首次启动会创建用户和 vhost；修改环境文件不会自动修改已有数据卷中的账号。

下面的 `RABBITMQ_ENV_FILE` 是环境文件路径，Compose 项目名应由部署者为该实例独占。测试时先选择两个空闲的随机本机端口并记录在私有环境文件中；配置只监听 127.0.0.1，重启时沿用这两个端口，端口占用时启动会失败。跨机器的 B 需要另行配置受限内网及 TLS，不能把本地测试映射当作部署方案。

```sh
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml up -d
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml port rabbitmq 5672
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml port rabbitmq 15672
```

在初始化拓扑或开始发布前，为专属 vhost 设置拒绝新发布的策略。以下每队列 1 GiB 消息体上限只是初始配置，须结合队列数量和真实消息负载调整。超过上限时 quorum 队列可能因在途发布短暂超额，发布方必须启用 publisher confirm 并处理 nack。部署显式设置 `delivery-limit=-1`，由应用负责有界执行和毒消息恢复。初始化时检查实际队列类型和生效策略。

```sh
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml exec -T rabbitmq sh -c 'rabbitmqctl set_operator_policy -p "$RABBITMQ_DEFAULT_VHOST" mio-capacity ".*" "{\"max-length-bytes\":1073741824,\"overflow\":\"reject-publish\"}" --apply-to queues'
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml exec -T rabbitmq sh -c 'rabbitmqctl set_policy -p "$RABBITMQ_DEFAULT_VHOST" mio-quorum-retain ".*" "{\"delivery-limit\":-1}" --apply-to quorum_queues'
```

本机测试可在共享协议包构建后使用一次性 bootstrap：

```sh
(
  umask 077
  mkdir -p .runtime/compute-environment
)
node scripts/service/prepare-compute-broker.ts "$RABBITMQ_ENV_FILE" .runtime/compute-environment/broker-p3
```

输出目录必须是 `.runtime` 下尚不存在的目录。准备和观测脚本按 Node dotenv 规则读取同一份环境文件。默认从 `RABBITMQ_MANAGEMENT_PORT` 推导 `http://127.0.0.1:<port>`，也兼容显式 `RABBITMQ_MANAGEMENT_URL`。管理地址须使用 HTTP 和 `127.0.0.1`，省略用户信息、路径、查询和片段。

准备脚本先验证 `stream_queue` feature flag 和原 vhost 中能匹配 quorum 队列的 1 GiB operator policy，发现同名当前拓扑资源时停止。脚本记录计划，将随机 A/B 凭据写入 0600 文件，再在业务 vhost 和两个独立测试 vhost 中建立共享拓扑，包括以下既有视频队列及音频、媒体和 Worker 队列。

- 视频命令队列 `mio.compute.commands.v1` 与对应死信队列 `mio.compute.commands.dlq.v1`
- 独立视频探测命令队列 `mio.compute.video.probe.commands.v1` 与对应死信队列 `mio.compute.video.probe.commands.dlq.v1`
- 视频结果队列 `mio.compute.results.v1` 与对应死信队列 `mio.compute.results.dlq.v1`

已有 vhost 应先执行[独立视频探测队列迁移](../../docs/integrations/rabbitmq.md#独立视频探测队列迁移)，再启用新发布者和 Worker。探测结果沿用视频结果队列。

交换机和 routing key 见[计算协议](../../docs/tasks/compute-service/protocol.md#路由回执与状态)。源队列配置 `dead-letter-strategy=at-least-once`，quorum 队列设置 `overflow=reject-publish` 和 `delivery-limit=-1`。初始化前可通过 `MIO_COMPUTE_WORKER_INSTANCE_IDS` 指定实例控制队列；指定多个 ID 时同时用 `MIO_COMPUTE_INSTANCE_ID` 选定本次生成 B 凭据对应的实例。部署者为其他实例单独发放各自精确 ACL。初始化完成前逐 quorum 队列核对 `mio-capacity` 及生效的 1 GiB 上限和 `reject-publish`，另核对音频结果 stream 的独立保留策略。出现策略冲突或网络请求结果未知时，查看输出目录的 `bootstrap-journal.jsonl` 和 broker 实际资源后再决定如何恢复。重试须保留已有业务队列和消息。

`runtime-a.env` 和 `runtime-b.env` 提供业务 vhost 的不同账户配置。`worker-test-a.env` 与 `worker-test-b.env` 指向 Worker 测试 vhost，`probe-a.env` 与 `probe-b.env` 指向环境探针 vhost。各文件提供 `RABBITMQ_URL`、`MIO_COMPUTE_BROKER_USER` 和对应的 `MIO_COMPUTE_EXPECTED_RESULT_USER` 或 `MIO_COMPUTE_EXPECTED_COMMAND_USER`。A 启用转码时还需设置 `MIO_COMPUTE_ENABLED=true`。A 仅写命令交换机、读指定结果队列；B 仅写结果交换机，读取共享命令队列和自身实例的控制队列。两者均无管理或 impersonator 标签，也没有 configure 权限。运行时不声明拓扑。消息发布方设置自身 `userId`，消费者核对预期身份。

云端图片生成及恢复在 A 执行。若旧部署仍有 `mio.compute.image.commands.v1`、图片 DLX/DLQ 或 B 的旧图片权限，依[图片生成切换步骤](../../docs/local-environments.md#图片生成迁移与切换)核对旧 PG/outbox、消息、消费者、B journal 与未确认上传，确认排空后显式退役图片资源并收缩权限。初始化不会自动退役旧拓扑，历史任务和恢复原件须保留。

配置将默认队列类型设为 quorum，并将消费者确认超时设为 75 分钟。初始化脚本显式声明并核验 quorum 队列。RabbitMQ 4.3 起该超时仅对支持该机制的 quorum 队列适用。异常退出、重新投递和终态恢复由应用负责。

资源初始预算为 1 CPU、1 GiB 内存、10 GiB 存储。Compose 实施 CPU 和内存限制，512 MiB 内存水位只触发发布流控；1 GB 可用磁盘告警只检查卷所在文件系统的剩余空间。命名卷、消息元数据、未确认消息和日志可能超出消息体上限，因此当前配置不强制 10 GiB 物理存储配额，须在目标宿主配置配额、监控及告警后再作为部署容量承诺。JSON 容器日志滚动上限为每个文件 10 MB、保留 3 个。

数据保存在 Compose 命名卷 `rabbitmq-data`；普通 `stop`/`start` 和 `restart` 保留数据与策略。确认不再需要数据前不要使用 `down -v`、删除卷或更换项目名。单节点 quorum 队列不提供多节点故障容错；镜像启动和静态配置通过也不能替代真实消息、恢复和负载验收。
