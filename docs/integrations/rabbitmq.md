# RabbitMQ 集成契约

返回[集成入口](index.md)。计算服务使用固定 RabbitMQ 4.4.0 management 镜像及摘要，客户端为锁定的 amqplib；A 的适配入口是 [RabbitMQ 集成](../../src/integrations/rabbitmq.ts)，B 是 [Worker 适配器](../../compute/src/adapters/rabbitmq.ts)。业务消息和幂等/恢复约束见[计算协议](../tasks/compute-service/protocol.md)，本页不将消息确认等同于计算成功。

## 环境与持久化

本机开发、人工测试分别部署独立 broker，容器、卷、固定节点名、端口、vhost 和账号由[常驻环境](../local-environments.md)维护，使用同一份 [Compose](../../deploy/local/compose.yaml)。端口只映射回环地址。单个 broker 的 vhost 提供逻辑资源隔离，不能隔离重启、内存或磁盘告警；两套环境的日常操作不得接管历史独立部署。

`rabbitmq-data` 挂载 `/var/lib/rabbitmq`，使用 `unless-stopped`。命名卷、原配置秘密和节点名成套保留；删除卷、换项目名或丢失密码不能当作恢复手段。单节点 quorum 仍是单点，持久化不等于高可用或备份。

## 拓扑与权限

命令/结果队列名称来自[共享协议](../../contracts/compute/src/index.ts)，环境隔离由 broker/vhost 完成。队列、交换机、绑定和权限定义统一在[部署拓扑](../../scripts/service/compute-broker-topology.ts)，同时供常驻环境和原隔离探针初始化使用；运行时不声明拓扑。

拓扑采用持久 direct exchange、quorum queue 和各自持久 DLQ，保留 at-least-once 死信、reject-publish、禁用隐式投递次数上限及每队列 1 GiB 消息体 operator policy。消费确认超时、资源预算与容器日志限制沿[部署说明](../../deploy/rabbitmq/README.md)，不得因本地隔离改弱保护。发布方必须使用自身 `userId`、持久消息、mandatory 和 publisher confirm；消费者核对预期发送身份。队列容量拒绝和未知结果不得冒充成功。

A 仅写命令、读结果；B 仅读命令、写结果。两者独立密码、无管理标签、无 configure 权限；管理密码只用于部署入口，不传给 A/B。Worker 启动只接收 B 的 MQ 和本环境 COS 配置，不能继承 A 的数据库、认证秘密或管理配置。

## 初始化与验证

`broker:init:dev/test` 在当前配置下先核对已有资源，不匹配即停止，再仅创建缺失项；重复执行不覆盖用户、策略、队列，不清消息。密码通过真实 AMQP 登录核对。中途失败或请求结果未知时保留现场，恢复同一配置后核对并重试，不能用重建队列绕过冲突。普通 `infra:up` 只启动容器并检查节点/端口及资源告警，拓扑初始化仍是显式步骤。

部署维护回归见 [local-broker 单测](../../tests/environment/local-broker.test.ts)、[配置测试](../../tests/environment/local-environment.test.ts) 和显式 [MQ 现场探针](../../tests/environment/local-brokers-live.ts)。现场探针核对角色权限、消息隔离、已确认消息重启保留、另一环境可用，以及空闲 Worker journal/进程接线；完整云端转码、负载和服务器验收另按需求取证。普通检查不访问这两套人工队列或历史 broker。

上游依据：[HTTP API](https://www.rabbitmq.com/docs/http-api-reference)、[访问控制](https://www.rabbitmq.com/docs/access-control)、[vhost](https://www.rabbitmq.com/docs/vhosts)、[告警](https://www.rabbitmq.com/docs/alarms)。公共参数、权限、持久化或恢复变化须沿实际 A/B 消费者回归；纯部署环境扩展不改变消息业务协议。
