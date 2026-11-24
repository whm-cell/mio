# RabbitMQ 集成契约

返回[集成入口](index.md)。计算服务使用固定 RabbitMQ 4.4.0 management 镜像及摘要，客户端为锁定的 amqplib；A 的适配入口是 [RabbitMQ 集成](../../src/integrations/rabbitmq.ts)，B 是 [Worker 适配器](../../compute/src/adapters/rabbitmq.ts)。业务消息和幂等/恢复约束见[计算协议](../tasks/compute-service/protocol.md)，本页不将消息确认等同于计算成功。

## 环境与持久化

本机开发、人工测试分别部署独立 broker，容器、卷、固定节点名、端口、vhost 和账号由[常驻环境](../local-environments.md)维护，使用同一份 [Compose](../../deploy/local/compose.yaml)。端口只映射回环地址。单个 broker 的 vhost 提供逻辑资源隔离，不能隔离重启、内存或磁盘告警；两套环境的日常操作不得接管历史独立部署。

`rabbitmq-data` 挂载 `/var/lib/rabbitmq`，使用 `unless-stopped`。命名卷、原配置秘密和节点名成套保留；删除卷、换项目名或丢失密码不能当作恢复手段。单节点 quorum 仍是单点，持久化不等于高可用或备份。

## 拓扑与权限

命令/结果队列名称来自[共享协议](../../contracts/compute/src/index.ts)，环境隔离由 broker/vhost 完成。队列、交换机、绑定和权限定义统一在[部署拓扑](../../scripts/service/compute-broker-topology.ts)，同时供常驻环境、隔离回归和现场探针初始化使用；运行时不声明拓扑。

拓扑采用持久 direct exchange、quorum queue 和各自持久 DLQ，保留 at-least-once 死信、reject-publish、禁用隐式投递次数上限及每队列 1 GiB 消息体 operator policy。命令交换机 `mio.compute.commands.v1` 将 `transcode.v1` 路由至重媒体命令队列 `mio.compute.commands.v1`（死信交换机 `mio.compute.commands.dlx.v1` / 死信队列 `mio.compute.commands.dlq.v1` / `transcode.dead.v1`）。云端图片生成、查询和物化恢复在 A 的 PG/持久目录中执行，不使用 MQ；旧 `mio.compute.image.commands.v1`、DLQ/DLX 和旧 B 权限只供切换前排空对账，初始化不自动删除或改写它们；结果采用 `mio.compute.results.v1`（`transcode.result.v1` 及对应 DLX/DLQ `transcode.result.dead.v1`），A 结果消费通道使用 `prefetch=4` 并在关闭时排空全部在途结果处理后再释放连接。A 建链到通道初始化共用 5 秒启动期限，消费注册受连接取消控制；停机最多等待 5 秒排空，届期通过底层 TCP/TLS 取消终止传输，未完成结果不提前确认。B 每轮重连注销该轮停机订阅，继续响应进程停机。消费确认超时、资源预算与容器日志限制沿[部署说明](../../deploy/rabbitmq/README.md)，不得因本地隔离改弱保护。发布方必须使用自身 `userId`、持久消息、mandatory 和 publisher confirm；消费者核对预期发送身份。队列容量拒绝和未知结果不得冒充成功。

A 仅写命令交换机 `mio.compute.commands.v1`，读取视频结果、音频结果 stream、媒体结果及 Worker 遥测队列。B 仅写结果交换机 `mio.compute.results.v1`，读取视频、音频、媒体命令与所属实例控制队列。两者独立密码、无管理标签、无 configure 权限；管理密码只用于部署入口，不传给 A/B。[管理后台 RabbitMQ 只读监控](../../src/integrations/rabbitmq-monitor.ts)可选通过 `MIO_ADMIN_RABBITMQ_MONITOR_URL` 使用独立 `mio-<env>-monitor` 账号（`tags="monitoring"`，对 `mio-<env>` 的 `configure/write/read` 均为 `^$`，无权收发消息或修改拓扑）只读采集 Management HTTP 概览、节点告警与队列/死信积压指标。Worker 启动只接收 B 的 MQ 和本环境 COS 配置，不能继承 A 的数据库、认证秘密或管理配置。

通用媒体的 encode、probe、control 待发命令分别认领并保留各自退避。收到某一路由的确定 publisher NACK 或 mandatory return 时释放当前租约，在该路由按原消息 ID 重投，其他路由继续排空。确认结果不明或连接关闭时重建连接。每轮每路最多认领 10 条，确认和释放必须匹配当前租约。详见[通用媒体协议](../tasks/compute-service/protocol.md#通用媒体处理与-worker-观测协议)。

音频检测使用独立的 `mio.compute.audio.commands.v1` quorum 队列（`audio.inspect.v1` 路由），沿用命令交换机及 1 GiB 容量策略。无效命令经 `audio.inspect.dead.v1` 进入专用 `mio.compute.audio.commands.dlq.v1`。B 在结果获发布确认后 ACK 原命令。读对象期间中断或结果确认失败会留下原命令供重投。

音频结果经 `audio.inspect.result.v1` 路由进入持久的 `mio.compute.audio.results.v1` stream。每个 A 实例先从 `next` 注册自己的消费游标，再提交请求，按命令、检测和业务任务三个 ID 关联结果。断线和停机会结束本实例的在途等待，下一次业务恢复可重新检查同一对象。结果只含检测证据和关联 ID。stream 以 64 MiB 和 1 小时为保留配置，按 8 MiB 分段回收，至少保留最新非空段。其精确匹配的 operator policy 优先于现有 quorum 容量策略。[RabbitMQ Streams](https://www.rabbitmq.com/docs/streams)

通用媒体通过同一对 direct exchange 使用 `media.encode`、`media.probe`、`media.control`、`media.result`，对应 `mio.compute.media.{encode,probe,control,results}`。每条源队列有一条同名前缀的 `.dlq`。Worker 通过 `worker.telemetry` 结果路由传送遥测与调限结果，对应 `mio.compute.worker.telemetry` 及其 `.dlq`。实例控制路由 `worker.limits.command.<instanceId>` 绑定 `mio.compute.worker.control.<instanceId>`，死信进入 `mio.compute.worker.control-dlq.<instanceId>`。这些新增 quorum 队列沿用每队列 1 GiB、`reject-publish` 及 `delivery-limit=-1`，源队列通过既有 DLX 启用 `at-least-once` 死信。

## 初始化与验证

`broker:init:dev/test` 只读核对 vhost、A/B 用户、权限、容量和音频保留策略，再补齐可声明的计算拓扑。缺少预置项时报告 `LOCAL_BROKER_PREPROVISION_REQUIRED`，集中列出该次检查发现的缺项和已完成的声明。已有 vhost 时可补交换机，队列和绑定还须有匹配的容量策略，音频结果 stream 及其绑定也须有音频保留策略。报告就绪前先验证真实 AMQP 登录，再重读预置项，发现缺项或冲突时报告实际观察。

预检发现已有权限、队列、交换机或策略不匹配时，在声明前报告 `LOCAL_BROKER_CONFLICT`，保留现场与消息。声明期间独立保存的配置仍由管理者保管，重新读取时若发现变化则以当次观察报告。请求结果未知时停止并核对实际资源，按同一配置恢复后重跑。旧图片资源及双命令队列 B 权限按[图片切换步骤](../local-environments.md#图片生成迁移与切换)排空对账后由运维显式退役或调整。

### 预置本地 Broker

启动 `infra:up:dev/test` 后，用选定环境的回环管理端和对应管理员登录。开发读取私有 `.env`，人工测试读取 `.env.test`。管理端口取 `MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT`，管理员为 `mio-dev-admin` 或 `mio-test-admin`，密码取 `MIO_LOCAL_RABBITMQ_PASSWORD`。在管理界面直接输入密码，保留私有配置。

下面的 `<env>` 取 `dev` 或 `test`。按 vhost、策略、用户、授权的顺序预置缺项。旧卷缺少 vhost 时，先核对实际卷与身份，再恢复所选环境的同名 vhost。正常空卷的 vhost 已由 [Compose](../../deploy/local/compose.yaml) 创建。

若由另一位管理员恢复 vhost，在该 vhost 的权限页为运行初始化的 `mio-<env>-admin` 恢复 Compose 默认权限，Configure、Write 和 Read 均填 `.*`。RabbitMQ 会给创建者授予权限，初始化仍使用选定文件里的项目管理员。A/B 按下表单独授予受限权限。

| 项目                     | 预置值                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vhost                    | `mio-<env>`                                                                                                                                                                                                                                    |
| operator policy          | vhost 内命名 `mio-capacity`，Pattern `.*`，Priority `0`，Apply to `queues`（Queues）。Definition 为 `{"max-length-bytes":1073741824,"overflow":"reject-publish"}`。                                                                            |
| 音频结果 operator policy | 命名 `mio-audio-result-retention`，Pattern `^mio\.compute\.audio\.results\.v1$`，Priority `1`，Apply to `streams`。Definition 为 `{"max-length-bytes":67108864}`。                                                                             |
| A 用户                   | `mio-<env>-a`，无 tags，使用所选文件的 `MIO_LOCAL_RABBITMQ_A_PASSWORD` 和 RabbitMQ 默认 SHA-256 密码哈希。                                                                                                                                     |
| B 用户                   | `mio-<env>-b`，无 tags，使用所选文件的 `MIO_LOCAL_RABBITMQ_B_PASSWORD` 和 RabbitMQ 默认 SHA-256 密码哈希。                                                                                                                                     |
| A 权限                   | 对 `mio-<env>`，Configure `^$`，Write `^mio\.compute\.commands\.v1$`，Read 精确匹配 `mio.compute.results.v1`、`mio.compute.audio.results.v1`、`mio.compute.media.results`、`mio.compute.worker.telemetry`。                                    |
| B 权限                   | 对 `mio-<env>`，Configure `^$`，Write `^mio\.compute\.results\.v1$`，Read 精确匹配 `mio.compute.commands.v1`、`mio.compute.audio.commands.v1`、`mio.compute.media.{encode,probe,control}` 及本实例 `mio.compute.worker.control.<instanceId>`。 |

升级已有拓扑时，部署者保留原 vhost、用户、密码、标签、音频 stream 和保留策略，只在原角色上预置表中新增的精确 Read 范围，再重跑 `pnpm broker:init:dev` 或 `pnpm broker:init:test`。实例 ID 默认取本环境原有 `MIO_LOCAL_COMPUTE_INSTANCE_ID`；显式 `MIO_COMPUTE_WORKER_INSTANCE_IDS` 为至多 64 个唯一 ID 的逗号列表，须包含该 ID。每个 ID 最多 96 个 ASCII 字符，以字母或数字开头，后续允许字母、数字、点、下划线和连字符。每个 B 账号只获得自身实例控制队列的读取权限。用当前共享拓扑生成准确的 Read 正则（`id` 传入已有实例 ID），避免通配符或未转义的点：

```sh
node --input-type=module -e 'import { computePermissions } from "./scripts/service/compute-broker-topology.ts"; console.log(JSON.stringify({ a: computePermissions("a"), b: computePermissions("b", process.argv[1]) }, null, 2))' "$MIO_LOCAL_COMPUTE_INSTANCE_ID"
```

清单内已有资源可直接重跑核对，出现冲突时先保留现有值与业务数据，再决定如何纠正。预置值与[共享拓扑定义](../../scripts/service/compute-broker-topology.ts)对应。

一次性部署的准备脚本检查运行 vhost 策略的作用对象，并从各 quorum 队列读回 1 GiB 消息体上限及 `reject-publish`，从音频结果 stream 读回其独立的策略及保留配置。策略优先级和定义合并遵循 [RabbitMQ 4.4 策略](https://www.rabbitmq.com/docs/4.4/policies)。

部署维护回归见 [local-broker 单测](../../tests/environment/local-broker.test.ts)、[配置测试](../../tests/environment/local-environment.test.ts) 和显式 [MQ 现场探针](../../tests/environment/local-brokers-live.ts)。现场探针核对角色权限、消息隔离、已确认消息重启保留、另一环境可用，以及空闲 Worker journal/进程接线；完整云端转码、负载和服务器验收另按需求取证。普通检查不访问这两套人工队列或历史 broker。

上游依据：[HTTP API](https://www.rabbitmq.com/docs/http-api-reference)、[访问控制](https://www.rabbitmq.com/docs/access-control)、[vhost](https://www.rabbitmq.com/docs/vhosts)、[告警](https://www.rabbitmq.com/docs/alarms)。公共参数、权限、持久化或恢复变化须沿实际 A/B 消费者回归；纯部署环境扩展不改变消息业务协议。

[常规协议回归](../../tests/integrations/rabbitmq-protocol.test.ts)真实验证 A 发布重媒体命令、B 收取并 ACK、B 发布关联结果、A 收取并 ACK、关闭各自消费通道后原消息不重投，以及反向读取返回 AMQP `403 ACCESS_REFUSED`。成功与故意失败的用例都检查临时 vhost 和 A/B 用户是否删除。运行条件见[测试导航](../engineering/testing.md#按变更定位测试)。

[音频隔离回归](../../tests/audio/media-rabbitmq.test.ts)使用同一隔离设施，验证两个 A 实例收到反序发布的各自结果、错误关联无法结算、未 ACK 命令重投，以及 stream 的生效保留策略。
