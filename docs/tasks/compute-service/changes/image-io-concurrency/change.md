# 图片 I/O 计算队列解耦、独立配额与 Worker 有界并发

```mio-change
{"version":1,"type":"feature","section":"目标与边界"}
```

针对多轮对话生图工具与直接图片接口在重 CPU 视频转码负载下的队头阻塞及配额挤占风险，项目负责人确认推进 `image-io-concurrency` 轻量扩展：将图片生成、异步查询与物化恢复这类纯网络/对象存储 I/O 任务从单并发重 CPU 视频转码队列分离，建立独立队列拓扑、独立活动任务配额、Service A 有界批量排空与立即唤醒，以及 Worker B 独立并发消费通道（按 `jobId` 串行互斥）。既有视频转码队列、消息格式与已接受成果保持不变；实现、隔离环境验证和最终人类接受分别判断。

## 本期范围与 C0/C1 安排

| 单元                   | 结果与非目标                                                                                                                                                                    | C0：决定、授权、依赖与边界                                                                                                                                                                             | C1：实施顺序、验收与接受条件                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image-io-concurrency` | 独立图片命令队列 `mio.compute.image.commands.v1`（`image.v1` + 独立 DLX/DLQ）、旧 v1 B 权限无损幂等升级、视频/图片配额分离、Service A 批量排空唤醒、Worker B 图片通道有界并发 4 | 已获授权实施本地拓扑升级、Service A 与 Worker B 并发改造及现行规范同步；依赖 `@mio/compute-contracts` 共享常量、现有图片路由与对话生图工具能力。不改变视频单并发（`prefetch=1`）或视频配额（`10/500`） | 先注册变更卡与共享协议常量，再升级拓扑脚本、Service A 配额/路由/批量排空与 Worker B 独立图片通道，同步现行规范并在隔离真实 PG + RabbitMQ + Worker B 下验证满视频负载并发物化与零重复生图，经独立审查后准备交付 |

视频/音频新媒体类型、多 Worker 分布式锁、外部付费实网压测及生产部署均不属于本变更范围。

## Review Contract

| 字段                    | 本期约定                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| objective               | 视频转码占满单实例执行或个人视频配额时，图片任务仍可按独立配额受理、经独立队列快速批量投递，并在单个 Worker B 实例内以最多 4 路跨 `jobId` 并发安全物化且不重复调用上游生图。                                            |
| scope / allowed_changes | `@mio/compute-contracts` 队列与配额常量、RabbitMQ 拓扑与本地初始化脚本、Service A `ComputeStore`/`ComputeService`/`ComputeBroker`、Worker B `Broker`/`Maintenance`/`main`、相关测试与现行规范及计算设计协议文档。       |
| obligations             | 队列持久与死信可靠保留、仅精确旧 v1 B 权限允许增量升级而未知漂移报 `LOCAL_BROKER_CONFLICT`、视频与图片配额独立锁不互相挤占、关闭排空全部在途图片与结果回调、同 `jobId` 严格串行访问 SQLite `Journal` 且断线不重复提交。 |
| review_dimensions       | 正确性、并发与锁顺序、可靠性与死信语义、优雅关闭排空、兼容性、实现复杂度（`DESIGN-OVER-001`）与规范三方一致性（`NORMS-01`）。                                                                                           |
| required_evidence       | 本地拓扑升级单测、Service A/Worker B 适配层并发与排空单测、隔离真实 PG + RabbitMQ + Service A + Worker B 满视频负载下并发图片端到端测试、受影响对话生图回归、完整静态检查覆盖结论、独立只读审查与规范审查。             |
| prohibited_changes      | 不修改共享 `mio_dev` 数据库、不执行 `broker:init:dev` 修改共享 `mio-dev`、不改变视频转码队列语义、不破坏 Unit 1 已接受对话生图能力、不发起外部真实付费请求、不自行记录 `deliver complete` 或提交/推送代码。             |
| human_confirmed         | 项目负责人在接受 `onelink-conversation-image-tools` 后明确授权推进 `image-io-concurrency` 本地实施与隔离验证，完成后停在 `HOLD_FOR_HUMAN_REVIEW` 交回审阅。                                                             |
| ai_proposed             | `IMAGE_WORKER_PREFETCH = 4`、每用户 `32` / 全局 `1000` 活动图片配额、单轮 `32` 图片 / `10` 视频批量排空及进程内 `Map<jobId, Promise>` 互斥为满足上述约束的最小技术参数。                                                |
| open_decisions          | 多机高并发实网环境下的容量压测参数与长稳观察仍随[父 PRD](../../prd.md) 承载能力延期项保留。                                                                                                                             |
| stop_condition          | 代码、规范、隔离验证与独立审查全部通过并完成 `deliver prepare` 后交回人类审阅；缺证或未接受保持 pending。                                                                                                               |

## 技术边界与协议约束

1. **拓扑与最小权限升级**：沿用 `mio.compute.commands.v1` direct exchange（A 写权限不变），新增持久 quorum 队列 `mio.compute.image.commands.v1`（绑定 `image.v1`，`x-delivery-limit: -1`、`x-overflow: reject-publish`、`x-dead-letter-strategy: at-least-once`）及独立死信交换机 `mio.compute.image.commands.dlx.v1` / 持久 quorum 死信队列 `mio.compute.image.commands.dlq.v1`（`image.dead.v1`）。B 的读权限精确扩展为 `^(?:mio\.compute\.commands\.v1|mio\.compute\.image\.commands\.v1)$`；本地 `prepareLocalBroker` 仅在现有 B 权限精确匹配旧版单队列读权限时执行无损更新，其余任何权限、队列、交换机或策略漂移仍拒绝并抛 `LOCAL_BROKER_CONFLICT`。
2. **配额分离与批量唤醒排空**：视频任务 `store.create` 仅统计活动 `mio_compute_jobs`（每用户 `10` / 全局 `500`）；图片任务 `store.imageCreate` 与 `store.imageRecover` 使用独立事务锁仅统计 `mio_image_jobs` 中 `accepted` 与 `materializing` 活动任务（每用户 `32` / 全局 `1000`）。`ComputeService` 在任务落库后立即触发 `wakePoll()`（并发触发合并续跑，遇 Broker 故障严格遵守指数退避，`stopping` 立即终止），每轮最多批量排空 `32` 条到期图片命令和 `10` 条视频命令；`RESULT_QUEUE` 消费 `prefetch` 提升至 `4`，关闭时完整排空所有在途结果处理后再关闭连接与连接池。
3. **Worker B 独立通道与同任务互斥**：Worker B 在同一消费连接上建立独立图片通道（`prefetch=4` 消费 `mio.compute.image.commands.v1`），不受视频 `Worker` 繁忙状态或周期 `Maintenance` 暂停影响，同时保留旧 `mio.compute.commands.v1` 上遗留图片消息的兼容处理；误入图片队列的非图片或非法消息直接 `reject(message, false)` 进入图片死信队列。图片处理入口按 `jobId` 串行互斥并及时清理锁表，跨 `jobId` 并发执行上游 HTTP 与 COS I/O，同 `jobId` 严格串行读写 SQLite `Journal`；退出或重连关闭前先同步关闭消费闸门使晚到消息重回队列，再等待全部已受理图片任务及结果发布确认完成后才关闭通道、连接与本地 `Journal`。

现行公共约束同步维护于[RabbitMQ 集成契约](../../../../integrations/rabbitmq.md)、[计算任务 HTTP 契约](../../../../apis/compute.md)、[本地环境说明](../../../../local-environments.md)及计算任务[协议](../../protocol.md)与[设计](../../design.md)；对话工具层的底层配额说明同步见[对话工具 PRD](../../../onelink-agent-tools/prd.md)。
