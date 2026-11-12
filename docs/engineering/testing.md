# 测试导航

## 按变更定位测试

从本次 PRD、轻量变更或 bug 的目标定位下面相关能力，再核对实际差异、调用关系和测试断言。PRD 归属不能排除其他能力的消费者；这里不维护完整依赖清单、测试状态或另一套验收规则。

直接浏览源码时从 [tests 目录索引](../../tests/README.md)进入；目录按稳定能力归属，不随 PRD 拆分或完成迁移。

本地使用 `pnpm test <测试文件或业务子目录>`，可提供多个范围，例如 `pnpm test tests/auth tests/environment/local-environment.test.ts`；`compute/tests` 也是有效范围。每个范围必须命中配置发现的测试文件，仓库根、`tests` 总目录和越界路径不接受。支持用例名称、报告等常用 Vitest 选项，不允许通过选项改写文件发现。`pnpm check:local <范围>` 以隔离回归环境运行定向测试；完整 `pnpm check` 由 GitHub Actions 执行。

现有 [CI 工作流](../../.github/workflows/check.yml)仅在全部差异属于 `scripts/harness/**/*.ts`、`tests/harness/**/*.ts` 或 `docs/coordination.md`、`docs/work-records.md`、本页时执行四项静态检查及 `tests/harness/`、`tests/environment/`，不准备 PostgreSQL、Redis、FFmpeg；环境测试覆盖目录外的护栏消费者。测试入口 `validation-entry.ts`、CI 选择脚本自身、业务／共享代码、依赖、配置、混合或未知改动仍执行原 `pnpm check`；main／默认分支和手动运行始终全量。选择器比较本次 push 的 before→SHA，或本次 PR 合并候选的第一父节点→合并结果，保留重命名两端；缺失或不匹配的比较信息退回全量。定向成功只证明所列检查，不能清除先前全量的失败或待定；完整覆盖仍须结合有效全量基线和实际差异沿既有证据协议核对，不自动继承其他提交的通过结论。

- **任务资料、变更卡片与交付**：`tests/harness/changes.test.ts`、`tests/harness/documents.test.ts`、`tests/harness/*read.test.ts`、`tests/harness/work*.test.ts`、`tests/harness/delivery.test.ts`。从[变更 CLI 测试](../../tests/harness/changes.test.ts)追查读取、登记、候选或交付中实际受影响的路径。
- **源码与工程护栏**：`tests/harness/guardrail*.test.ts`、`tests/harness/quality-review.test.ts`；AST、别名、源码发现和跨包变化保留合法／违规对照，见[源码护栏](source-guardrails.md)。
- **插件、Profile 与内核**：[插件](../../tests/foundation/plugin.test.ts)、[内核](../../tests/foundation/kernel.test.ts)、[Profile 准备](../../tests/foundation/prepare-profile.test.ts)；装载、关闭与工具拒绝沿 [DSH 集成](../integrations/dsh.md)核对，产物 smoke 另由 `pnpm test:smoke` 执行。
- **认证、限流与 Redis**：`tests/auth/*.test.ts`、[Redis 公共能力](../../tests/integrations/redis.test.ts)、[认证消费者](../../tests/auth/auth-redis.test.ts)。超时、关闭或错误语义变化追查 HTTP、失败无写入与恢复；环境沿 [Redis](../integrations/redis.md#验证入口与变更影响)／[PostgreSQL](../integrations/postgres.md#验证入口与变更影响)契约准备。
- **供应商与 OneLink**：`tests/providers/*.test.ts`、`tests/onelink/*.test.ts`；共享模型绑定追查对话消费者，领域要求见[供应商规范](../providers.md)／[OneLink 集成](../integrations/onelink.md)。
- **对话**：`tests/conversations/*.test.ts`；沿[对话规范](../conversations.md)追查 HTTP、执行引擎、Profile、持久化与恢复。
- **私有素材与 COS**：`tests/assets/*.test.ts`；资源归属、存储和计算输入的消费者见[素材 API](../apis/assets.md)／[COS 集成](../integrations/cos.md)。
- **计算协议、A 服务与 B Worker**：`tests/compute/*.test.ts`、`tests/integrations/rabbitmq-lifecycle.test.ts`、`compute/tests/*.test.ts`；共享协议追查两端，队列、journal、COS 与真实 FFmpeg 条件见[计算协议](../tasks/compute-service/protocol.md)／[Worker 入口](../../compute/README.md)。
- **本地环境与部署工具**：`tests/environment/*.test.ts`；配置、拓扑、启动和迁移沿[常驻环境](../local-environments.md)核对。

名称模式只用于定位。文件发现以 [Vitest 配置](../../vitest.config.ts)和实际文件为准，例如 `rg --files tests compute/tests -g '*.test.ts'`；同域新增测试不逐个登记，未知或未匹配文件保持待判断。新增能力只补对应入口；PRD 迁移追查身份、链接和交付，不按目录名重新分配运行时测试。

共享影响还包括非 import 关系：CLI 由子进程执行，测试可能读取文档、模板、配置或构建产物；辅助文件与共享 fixture 也须追查消费者。[provider setup](../../tests/providers-setup.ts)全局加载，不能按文件名限定为供应商域。公共 setup、依赖或测试配置改变时重新判断全部消费者与原覆盖依据。`*-live.ts` 等现场入口按领域契约单独核对环境、凭据和费用授权，发现入口不等于授权执行。

在已有任务记录简记目标、差异、所选入口与理由、复用原件及覆盖缺口。区分文件发现、正文展开、实际执行和证据覆盖：局部成功不自动产生完整通过，同候选摘要不能替代原件，失败仍保留。复用方法沿[证据协议](../work-records.md#增量验证与同输入复用)，完整验证条件沿[验证协议](../coordination.md#验证与接受)；导航不改变 `pnpm check`、CI 或人工接受。
