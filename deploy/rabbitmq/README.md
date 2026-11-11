# 计算服务 RabbitMQ 部署

开发和人工测试的常驻实例使用[环境入口](../../docs/local-environments.md)统一管理，公共权限和持久化边界见 [RabbitMQ 契约](../../docs/integrations/rabbitmq.md)。下列独立 Compose 和一次性 bootstrap 仍用于独占部署及隔离探针，不替代开发/测试环境，也不自动接管其数据。

该 Compose 配置用于独占的计算服务 broker，固定 RabbitMQ 4.4.0 management 镜像和摘要。启动前在受保护的位置准备仅当前用户可读的环境文件，提供 `RABBITMQ_DEFAULT_USER`、`RABBITMQ_DEFAULT_PASS`、`RABBITMQ_DEFAULT_VHOST`、`RABBITMQ_AMQP_PORT`、`RABBITMQ_MANAGEMENT_PORT`；不要将真实密码放入仓库或命令参数。Docker 管理员仍可读取容器环境，部署时应按宿主权限保护。首次启动会创建用户和 vhost；修改环境文件不会自动修改已有数据卷中的账号。

下面的 `RABBITMQ_ENV_FILE` 是环境文件路径，Compose 项目名应由部署者为该实例独占。测试时先选择两个空闲的随机本机端口并记录在私有环境文件中；配置只监听 127.0.0.1，重启时沿用这两个端口，端口占用时启动会失败。跨机器的 B 需要另行配置受限内网及 TLS，不能把本地测试映射当作部署方案。

```sh
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml up -d
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml port rabbitmq 5672
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml port rabbitmq 15672
```

在应用创建队列或开始发布前，为专属 vhost 设置拒绝新发布的策略。以下每队列 1 GiB 消息体上限只是初始配置，须结合队列数量和真实消息负载调整。超过上限时 quorum 队列可能因在途发布短暂超额；发布方必须启用 publisher confirm 并处理 nack。为了防止 quorum 队列默认在 20 次失败投递后丢弃消息，另设 `delivery-limit=-1`；应用必须有可观测的有界执行和毒消息恢复，避免无限重投。禁止由其他策略或队列参数削弱这些约束，实际队列类型和生效策略须在 P3 联调中检查。

```sh
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml exec -T rabbitmq sh -c 'rabbitmqctl set_operator_policy -p "$RABBITMQ_DEFAULT_VHOST" mio-capacity ".*" "{\"max-length-bytes\":1073741824,\"overflow\":\"reject-publish\"}" --apply-to queues'
docker compose --env-file "$RABBITMQ_ENV_FILE" -p mio-compute -f deploy/rabbitmq/compose.yaml exec -T rabbitmq sh -c 'rabbitmqctl set_policy -p "$RABBITMQ_DEFAULT_VHOST" mio-quorum-retain ".*" "{\"delivery-limit\":-1}" --apply-to quorum_queues'
```

本机测试可在共享协议包构建后使用一次性 bootstrap：

```sh
node scripts/service/prepare-compute-broker.ts "$RABBITMQ_ENV_FILE" .runtime/compute-environment/broker-p3
```

输出目录必须是 `.runtime` 下尚不存在的目录；脚本只连接 `127.0.0.1` 的管理接口，拒绝覆盖既有用户或固定拓扑。它先记录计划并将随机 A/B 凭据写入 0600 文件，再创建固定持久 direct exchange、quorum queue、各自的 direct DLX 和持久 quorum DLQ；来源队列指定 `dead-letter-strategy=at-least-once`、`overflow=reject-publish`、`delivery-limit=-1`，先核对 `stream_queue` feature flag 和原 vhost 的 1 GiB operator policy。脚本额外建立两个独立测试 vhost，不清空已有业务数据。网络请求结果未知时停止，先查看输出目录的 `bootstrap-journal.jsonl` 和 broker 实际资源，再决定如何恢复；不可删除或重建已有业务队列来重试。

`runtime-a.env` 和 `runtime-b.env` 是业务 vhost 的不同账户配置；`worker-test-a.env` 与 `worker-test-b.env` 指向独立测试 vhost。各文件提供 `RABBITMQ_URL`、`MIO_COMPUTE_BROKER_USER` 和对应的 `MIO_COMPUTE_EXPECTED_RESULT_USER` 或 `MIO_COMPUTE_EXPECTED_COMMAND_USER`；A 启用计算服务时还需单独设置 `MIO_COMPUTE_ENABLED=true`。两个账户均无管理或 impersonator 标签，也没有 configure 权限：A 仅发布命令、消费结果，B 仅消费命令、发布结果。运行时不声明拓扑。消息发布方设置自身 `userId`，消费者核对预期身份；确认收到不代表业务执行成功。

配置将默认队列类型设为 quorum，并将消费者确认超时设为 75 分钟。客户端仍须显式声明和核验 quorum 队列：RabbitMQ 4.3 起该超时不适用于 classic 队列。禁用投递次数限制不等于业务已实现最多三次实际执行；异常退出、重新投递和终态恢复仍由应用完成并验证。

资源初始预算为 1 CPU、1 GiB 内存、10 GiB 存储。Compose 实施 CPU 和内存限制，512 MiB 内存水位只触发发布流控；1 GB 可用磁盘告警只检查卷所在文件系统的剩余空间。命名卷、消息元数据、未确认消息和日志可能超出消息体上限，因此当前配置不强制 10 GiB 物理存储配额，须在目标宿主配置配额、监控及告警后再作为部署容量承诺。JSON 容器日志滚动上限为每个文件 10 MB、保留 3 个。

数据保存在 Compose 命名卷 `rabbitmq-data`；普通 `stop`/`start` 和 `restart` 保留数据与策略。确认不再需要数据前不要使用 `down -v`、删除卷或更换项目名。单节点 quorum 队列不提供多节点故障容错；镜像启动和静态配置通过也不能替代真实消息、恢复和负载验收。
