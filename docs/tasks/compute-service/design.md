# 私有资产与计算服务设计

本设计承接[本期需求](prd.md)；P3/P4 实施前使用[计算协议 v1](protocol.md)对齐消息和恢复边界。未来单元须在相应 C0 核对依赖后实现，不能把候选写作已部署事实。

## 服务与数据边界

A 保留现有根项目，管理登录、资产归属、任务事实与对外 API；B 位于 `compute/`，只执行明确类型的任务；跨服务数据协议位于 `contracts/compute/`。A 和 B 不导入对方内部源码。P2 按实际目录分别检查类型、构建、依赖方向与未知/重叠归属；仅检查导入文本或目录名称不足以证明隔离。

本期在本机以独立 A/B 进程、真实隔离 PG/RabbitMQ、FFmpeg 和私有测试 COS 验证；真实服务器互联、生产负载和部署验收是后续节点，不作为本机链路交回前置。生产边界需要时再明确并独立取证。

元数据放 Mio 媒体独立 PostgreSQL 域，不能把 DSH 会话或消息队列当作事实表。将任务和 outbox 同事务写入可避免已受理任务未留下待发送记录；消费者仍须以稳定任务和消息身份去重并处理不确定结果。恢复逻辑在 P3 依据实际协议设计，不能把重试等同于恰好一次。

计算任务按 owner 与 requestId 绑定输入摘要：同输入重试返回原任务，异输入冲突；accepted、queued、running、succeeded、failed 的更新需拒绝晚到消息造成的回退。配额为每用户 10、全局 500 个未结束任务，必须在并发受理下维持。队列满时拒绝新发布并保留已存在消息，outbox 不因发布被拒绝而误记成功。B 初期串行处理（prefetch 1），FFmpeg 的 `-threads`、`-filter_threads` 与 `-filter_complex_threads` 参数设为 2，不把它们当成进程总线程数或 CPU 硬上限；输入及输出各不超过 1 GiB，单次执行和单次上传对账各最多 60 分钟、最多三次实际执行；保守启动记账可能少于三次实际执行。消费者 ACK 无 broker 收到确认，终态持久及结果确认后的本地清理和重投由 journal 幂等恢复，具体边界见[计算协议](protocol.md)。75 分钟配置已核对，隔离队列以 2 秒验证了取消及重投机制，未作 75 分钟墙钟等待。1 CPU、1 GiB 内存、10 GiB 存储是 RabbitMQ 初始预算，容量与磁盘告警以实测确定。

quorum 队列单节点仍是单点；其默认 delivery-limit 与业务执行次数不是同一计数。P3 计划禁用 broker 的隐式投递上限，由 journal 限制实际执行，毒消息显式进入持久死信并验证保留/排查；有界队列选 reject-publish，发布和消费分连接。需要实测 consumer_timeout、死信可靠投递及资源告警下恢复，配置本身不能证明无消息丢失。

## 资产链路与不可变性

调用方请求上传时只提供文件描述和大小，A 从登录会话取得 owner、生成资产 ID 和临时对象键，签发短期 PUT。上传完成后，A 读取临时对象的大小及 ETag；不匹配或超限时拒绝登记。数据库条件抢占完成操作并持久冻结源 ETag/大小，按该 ETag 条件复制到服务端生成的原件键，再以当前抢占身份条件登记。并发或恢复尝试使用彼此独立、不可猜测的目标，过期抢占的旧执行者不能登记或覆盖获胜原件；未登记的复制残留要能识别和对账，不能混入自动删除已登记原件的规则。客户端仍可能在签名有效期内重传临时对象，条件复制只接受与冻结标识匹配的对象。完成过程崩溃后须有有界抢占恢复，不得把未确认复制当成功；提交成功后再次完成返回相同资产，不再改变已登记内容。ETag 用于 COS 条件匹配，不声称是防碰撞内容证明。

签名 URL 是短期 bearer 凭证，不记录在日志或持久化；查询须重新验证登录和 owner，临时对象不能作为最终资产暴露。24 小时清理只针对本服务持有且已过期的临时键，不扫描或删除桶中其他对象；原件和成品不自动删除。PG 与 COS 不是同一事务，复制后落库失败可能留下孤儿，需要可追踪的键和后续对账，不能声称原子提交。签名 PUT 和声明长度、COS CORS 与复制条件必须用官方 SDK/真实云分别核对；服务端 HEAD 仍是最终大小核验。

## 具体机制取舍

私有桶和短期签名解决长期公开链接及字节经过 A 的问题，代价是配置 CORS、权限和生命周期；现有鉴权下载代理不能满足直传要求。条件复制和独立原件键解决校验后临时对象被覆盖、并发完成覆盖已登记内容的问题，代价是一次服务端复制和孤儿对账；直接登记临时键无法保留不可变性。持久 outbox 解决 PG 提交与发送无法同事务的问题，代价是发布恢复和重复消费处理；直接发消息无法恢复提交后进程退出的缺口。各机制只实现实际消费所需的最小路径，不提前引入通用媒体平台。

## 本机独立产物与启动

A 和 B 分别是可复制的目录，各自包含本项目生产依赖和共享合同构建产物；A 是官方 DSH 的插件，启动还需要固定的官方 DSH `0.2.2-rc.1` 宿主，B 需要 Node 24、FFmpeg 与 ffprobe。不要把指向源码 checkout 的链接当作交付。以下命令要求先完成受控安装，在仓库根运行；输出父目录应为绝对路径、各目标尚不存在：

```sh
pnpm build
PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @mio/plugin --prod deploy --ignore-scripts "$MIO_OUTPUT_DIR/a"
PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @mio/compute-worker --prod deploy --ignore-scripts "$MIO_OUTPUT_DIR/b"
```

已在离线缓存中准备依赖时可加 `--offline`。pnpm 11 的 `--legacy` 预览出现指向工作树的 B 自引用，不能用于认定独立产物；应检查每个链接解析目标均在对应产物中，并从仓库外实际启动。为复现本机测试宿主，可另执行下列完整依赖导出；它包含开发依赖，只是本机测试宿主，不是生产精简部署。`--dev` 单独导出曾遗漏当前 macOS 的可选 native 包，不能代替实启验证。

交付时复制包含 `node_modules` 的完整目录并直接运行；依赖安装和重新构建在源仓库进行。`pnpm deploy` 生成的依赖元数据可能含构建源路径，不是可移植的重新安装清单。

```sh
PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @mio/plugin deploy --ignore-scripts "$MIO_OUTPUT_DIR/dsh-host"
```

先准备隔离 PostgreSQL、独立私有桶、[RabbitMQ 拓扑及独立身份](../../../deploy/rabbitmq/README.md)，分别在受保护的 A/B 环境文件中提供各自配置。A 的认证配置见[认证底座](../../auth.md)，资产配置见 [COS 契约](../../integrations/cos.md)；A 额外设置 `MIO_COMPUTE_ENABLED=true`、`RABBITMQ_URL`、`MIO_COMPUTE_BROKER_USER`、`MIO_COMPUTE_EXPECTED_RESULT_USER`。B 的配置和 journal 操作见 [Worker 说明](../../../compute/README.md)。分别使用干净的进程环境和各自环境文件，避免 A/B 继承对方秘密。

在实际数据库及身份已核对后，按顺序运行 A 产物内的显式迁移，然后准备独占 DSH home 并启动官方宿主。每次 `--apply` 是真实数据库写入；迁移只做增量变化，不自动执行破坏性降级。

```sh
node --env-file="$MIO_A_ENV" "$MIO_OUTPUT_DIR/a/dist/tools/scripts/service/migrate-auth.js" --apply
node --env-file="$MIO_A_ENV" "$MIO_OUTPUT_DIR/a/dist/tools/scripts/service/migrate-assets.js" --apply
node --env-file="$MIO_A_ENV" "$MIO_OUTPUT_DIR/a/dist/tools/scripts/service/migrate-compute.js" --apply
node "$MIO_OUTPUT_DIR/a/dist/tools/scripts/service/prepare-profile.js" "$MIO_DSH_HOME" "$MIO_OUTPUT_DIR/a"
DSH_HOME="$MIO_DSH_HOME" DSH_AGENTS_HOME="$MIO_DSH_HOME/agents" node --env-file="$MIO_A_ENV" "$MIO_OUTPUT_DIR/dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile mio
```

首次新建 B 的独占持久目录时运行一次 `node --env-file="$MIO_B_ENV" "$MIO_OUTPUT_DIR/b/dist/main.js" init`，之后用同一实例身份运行 `start`。已有 journal 不重新初始化；停止或回滚应保留 PG、MQ、journal 和 COS 数据。本节描述本机路径和前提，具体候选仍须分别通过迁移、独立实启、完整链路和人类审阅。

## 可观察结果

资产测试通过实际登录、HTTP、真实隔离 PG 和受控 COS 边界观察两个用户隔离、错误、过期、重复及并发；明确记录替身不能证明真实云权限、签名、CORS 和服务行为。完整链路还需独立 A/B、真实消息和 Worker、真实私有桶及人类接受；各项结果和候选分别保留。

本期验收与延期边界以 [PRD](prd.md#本期验收与延期项) 为准。正常视频业务验收聚焦 5 分钟以内（含 5 分钟）；现有 30 分钟保护及已完成的拒绝观察保留，更长视频的进一步验证后置。四组承载性能长窗口及其专用准备待目标环境明确后再执行；本期继续验证断线／重启、重复与失败恢复、配额及满队列拒绝、权限和资源约束。保留已有 CORS 与恢复原件，按当前差异增量复核；不能由功能或缩时故障观察推导长视频完整能力、服务器容量、高负载延迟、长期稳定性或单节点高可用。
