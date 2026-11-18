# 测试导航

## 按变更定位测试

从本次 PRD、轻量变更或 bug 的目标定位下面相关能力，再核对实际差异、调用关系和测试断言。PRD 归属不能排除其他能力的消费者；这里不维护完整依赖清单、测试状态或另一套验收规则。

直接浏览源码时从 [tests 目录索引](../../tests/README.md)进入；目录按稳定能力归属，不随 PRD 拆分或完成迁移。

本地使用 `pnpm test <测试文件或业务子目录>`，可提供多个范围，例如 `pnpm test tests/auth tests/environment/local-environment.test.ts`；`compute/tests` 也是有效范围。每个范围必须命中配置发现的测试文件，仓库根、`tests` 总目录和越界路径不接受。支持用例名称、报告等常用 Vitest 选项，不允许通过选项改写文件发现。`pnpm test <范围>` 与 `pnpm check:local <范围>` 分别探测 PostgreSQL 和 Redis 的隔离通道，每项优先复用 `mio-dev`，其次 `mio-test`。没有针对该服务的配置或端口不可达时，由用例启动隔离临时进程。显式运行 `node scripts/service/local.ts <dev|test> check <范围>` 时只探测选定环境，已有配置不合规时会报错。

PostgreSQL 复用 `mio_regression_test` 随机 schema（既有卷首次执行 `pnpm env:init && pnpm regression:init:dev`）。Redis 常规限流回归复用 `~mio:regtest-*:*` 前缀账号并自动清理，全局 OOM／停机故障用例自动识别 `.runtime/redis-build` 临时进程。RabbitMQ 集成测试自动创建并清理临时 vhost。完整 `pnpm check` 由 GitHub Actions 执行。

本地可运行 `pnpm check:static:base`，依次执行格式、类型、lint 和护栏；`pnpm check:static` 运行这四项后再构建，均不运行测试或插件装载 smoke。完整 `pnpm check` 先验证 GitHub Actions 环境，再依次运行相同的四项静态检查、全部测试、完整构建和 `test:smoke`，使最终 smoke 使用测试后的构建产物；静态通过不能替代测试、完整覆盖或业务验收结论。

现有 [CI 工作流](../../.github/workflows/check.yml)仅在全部差异属于 `scripts/harness/**/*.ts`、`tests/harness/**/*.ts` 或 `docs/coordination.md`、`docs/work-records.md`、本页时执行四项静态检查及 `tests/harness/`、`tests/environment/`。定向和全量共用同一个固定版本的 PostgreSQL 服务，环境分组的图片切换回归在专用测试库中创建隔离 schema。Redis 和 FFmpeg 仅在全量检查准备。测试入口 `validation-entry.ts`、CI 选择脚本自身、业务／共享代码、依赖、配置、混合或未知改动仍执行原 `pnpm check`；main／默认分支和手动运行始终全量。选择器比较本次 push 的 before→SHA，或本次 PR 合并候选的第一父节点→合并结果，保留重命名两端；缺失或不匹配的比较信息退回全量。定向成功只证明所列检查，不能清除先前全量的失败或待定；完整覆盖仍须结合有效全量基线和实际差异沿既有证据协议核对，不自动继承其他提交的通过结论。

- **任务资料、变更卡片与交付**：`tests/harness/changes.test.ts`、`tests/harness/documents.test.ts`、`tests/harness/*read.test.ts`、`tests/harness/work*.test.ts`、`tests/harness/delivery.test.ts`。从[变更 CLI 测试](../../tests/harness/changes.test.ts)追查读取、登记、候选或交付中实际受影响的路径。
- **源码与工程护栏**：`tests/harness/guardrail*.test.ts`、`tests/harness/quality-review.test.ts`；AST、别名、源码发现和跨包变化保留合法／违规对照，见[源码护栏](source-guardrails.md)。
- **插件、Profile 与内核**：[插件](../../tests/foundation/plugin.test.ts)、[内核](../../tests/foundation/kernel.test.ts)、[Profile 准备](../../tests/foundation/prepare-profile.test.ts)；装载、关闭与工具拒绝沿 [DSH 集成](../integrations/dsh.md)核对，产物 smoke 另由 `pnpm test:smoke` 执行。
- **认证、限流与 Redis**：`tests/auth/*.test.ts`、[Redis 公共能力](../../tests/integrations/redis.test.ts)、[认证普通回归](../../tests/auth/auth-redis.test.ts)与[独立 Profile 切换/恢复演练](../../tests/auth/auth-redis-rehearsal.test.ts)。普通回归和三次真实等待各 65 秒的长演练可分别选择，完整检查包含两者；超时、关闭或错误语义变化追查 HTTP、失败无写入与恢复。环境沿 [Redis](../integrations/redis.md#验证入口与变更影响)／[PostgreSQL](../integrations/postgres.md#验证入口与变更影响)契约准备。
- **供应商与 OneLink**：`tests/providers/*.test.ts`、`tests/onelink/*.test.ts`；共享模型绑定追查对话消费者，领域要求见[供应商规范](../providers.md)／[OneLink 集成](../integrations/onelink.md)。
- **对话**：`tests/conversations/*.test.ts`；沿[对话规范](../conversations.md)追查 HTTP、执行引擎、Profile、持久化与恢复。
- **私有素材与 COS**：`tests/assets/*.test.ts`；资源归属、存储和计算输入的消费者见[素材 API](../apis/assets.md)／[COS 集成](../integrations/cos.md)。
- **A 图片生成与恢复**：`tests/generations/*.test.ts`、`tests/compute/images*.test.ts`、`tests/compute/image-concurrency.test.ts` 以及对话图片工具回归；供应商协议、独立执行、持久检查点、原始字节、查询边界与无重复生成沿[OneLink 集成](../integrations/onelink.md)／[图片 API](../apis/compute.md)核对。
- **计算协议、A 服务与 B Worker**：`tests/compute/*.test.ts`、`tests/integrations/rabbitmq-lifecycle.test.ts`、`compute/tests/*.test.ts`；共享协议追查两端，队列、journal、COS 与真实 FFmpeg 条件见[计算协议](../tasks/compute-service/protocol.md)／[Worker 入口](../../compute/README.md)。
- **本地环境与部署工具**：`tests/environment/*.test.ts`；配置、拓扑、启动和迁移沿[常驻环境](../local-environments.md)核对。

名称模式只用于定位。文件发现以 [Vitest 配置](../../vitest.config.ts)和实际文件为准，例如 `rg --files tests compute/tests -g '*.test.ts'`；同域新增测试不逐个登记，未知或未匹配文件保持待判断。新增能力只补对应入口；PRD 迁移追查身份、链接和交付，不按目录名重新分配运行时测试。

共享影响还包括非 import 关系：CLI 由子进程执行，测试可能读取文档、模板、配置或构建产物；辅助文件与共享 fixture 也须追查消费者。[provider setup](../../tests/providers-setup.ts)全局加载，不能按文件名限定为供应商域。公共 setup、依赖或测试配置改变时重新判断全部消费者与原覆盖依据。获授权的本地真实业务与模型验收（含 `providers-live.ts`、`conversations-live.ts`、`live-cos-probe.ts` 及下述图片 `dev` 模式）默认直接读写[常驻 mio_dev 环境](../local-environments.md#自动化回归与人工数据)并保留数据；发现入口不等于授权执行。

已授权的图片真实闭环使用 `dev` 模式，直接增量迁移并读写常驻开发环境（认证与供应商使用配置的 `mio_dev`，媒体任务和资产使用实际 `MIO_ASSETS_DATABASE_URL`，可为独立分域库），保留生成的资产、任务与路由：

```sh
MIO_RUN_LIVE_IMAGE=yes node tests/compute/live-image-loop.ts [--scenario <name>] dev <.runtime/run-dir> <login-or-key-file> <task-id>
```

入口只启动 A，显式启用图片生成并指定本环境的专属持久目录，不配置 RabbitMQ 或启动 B。旧 `prepare`／`execute` 阶段已退役，调用会拒绝；已有私人原件保持历史身份，不自动恢复或冒充 A 的当前证据。提交意图、落盘与 PG 检查点、COS 故障等恢复边界由 `tests/generations/` 在隔离回归通道注入故障验证。

任务须已 sync 到干净提交并处于 `C1_EVIDENCE_PENDING`。入口核对同一 task ID、`{commit, contractRevision}`、干净工作区与实际运行产物摘要；实际执行仍须核对场景、环境、凭据和费用授权。

`dev` 使用已有登录 JSON（`email`、`password`，可选 `apiKey`）可复用账号；若输入原始 Key，则创建保留的专用账号并在本次私有运行目录的 `owner-login.json`（仅文件所有者可读写）保存登录信息，不保存 Key。登录文件包含 `apiKey` 时入口会保存并轮换该账号的供应商凭据；导入与现有声明不同的全局模型路由也会影响其他用户。执行前须核对账号、凭据及现有全局路由，确认这些写入符合本次授权。运行目录和登录文件不得提交或输出。旧链路切换前的任务、消息、journal 与上传身份盘点沿[迁移与切换](../local-environments.md#图片生成迁移与切换)执行；该 live 入口不代替切换预检或旧执行器停机确认。

A 进程内的单次生成 POST 审计保留跨重启标记，不以重新运行或新 requestId 重发未知任务。异步查询只放行与本次提交后 PG 持久化的上游任务身份一致的请求，最多八次，受持久化的 600 秒绝对期限和命令期限约束；观察可等待已发起操作的下载与 COS 物化结束，不延长上游查询期限。超过观察上界保留现场并记为未验证，不承诺覆盖任意故障。完成后重启 A，检查相同 requestId 的 HTTP 幂等、历史与资产下载；这不代表已完成真实强杀、旧 MQ 重放、B 并行资源或生产验收。

在已有任务记录简记目标、差异、所选入口与理由、复用原件及覆盖缺口。区分文件发现、正文展开、实际执行和证据覆盖：局部成功不自动产生完整通过，同候选的简短结论不能替代原件，失败仍保留。复用方法沿[证据协议](../work-records.md#增量验证与同输入复用)，完整验证条件沿[验证协议](../coordination.md#验证与接受)；导航不改变 `pnpm check`、CI 或人工接受。
