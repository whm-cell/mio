# PostgreSQL 使用契约

## 适用范围与接入事实

当前 PostgreSQL 用于认证、[本地对话元数据](../conversations.md)、[用户万联配置/偏好](../providers.md)及[用户资产元数据](../apis/assets.md)，驱动采用 [package.json](../../package.json) 固定的 `pg 8.23.1`。账号/登录会话、认证配置和库模型按[认证底座](../auth.md)维护，对话、供应商与资产各自维护业务生命周期。本页记录公共约束，入口见[集成契约](index.md)。

[认证服务](../../src/auth/service.ts)、[对话存储](../../src/conversations/store.ts)、[供应商存储](../../src/providers/store.ts)、[资产存储](../../src/assets/store.ts)、[计算任务存储](../../src/compute/store.ts)、[素材存储](../../src/materials/store.ts)和[图片生成存储](../../src/generations/store.ts)各持有自己的池，装配由[插件入口](../../src/plugin.ts)负责。对话的专用租约连接及各域显式迁移见业务规范；没有共享认证内部池或通用数据层。资产迁移由 `pnpm assets:migrate --apply` 显式执行，只读取资产数据库 URL，不连接 COS。计算任务使用同一媒体数据库的独立池，先执行资产迁移，再执行 `pnpm compute:migrate --apply`；增量迁移保留已有资产并允许结果资产没有 staging 对象。任务与待发布命令在一个事务中写入，结果事件去重、结果资产及任务终态也在一个事务中提交；消息 broker 与 COS 不在该事务中。图片生成独立执行 `pnpm generations:migrate --apply`，增量复用 `mio_image_jobs`、`mio_image_outputs` 并增加 A 内部执行记录；没有 A 执行行的旧任务不会重新提交。A 通过原子认领和短事务持久化提交意图、查询预算及文件检查点，外部网络请求不持长事务，图片不写入 MQ。单 A 的执行器锁只防止同库重复启动，不提供多副本接管保证。

素材库在同一 `MIO_ASSETS_DATABASE_URL` 独立持最多 5 个连接，连接/语句/查询等待各 5 秒。先迁移 assets，再显式 `pnpm materials:migrate --apply`；三表为 groups/materials/operations，不变更 mio_assets 核心列、不建跨供应商或认证库外键。启动只读核验列与确切全局部分唯一索引；现行素材状态、墓碑、租约和恢复见[素材 HTTP](../apis/materials.md)。网络在短事务外，迟到同步/刷新及操作终态在同一事务按当前租约和生命周期提交。

## 必须遵守的约束

- 持有连接资源的实现负责释放。现行认证服务在创建失败时关闭数据库池，正常关闭由插件调用；启动过程中卸载后取得的认证服务也会被释放。[显式迁移工具](../../scripts/service/migrate-auth.ts)在 `finally` 中关闭自己创建的池。
- 跨域依赖由装配入口显式安排清理顺序，先收敛消费者再关闭其依赖池；前一清理失败仍须释放其他资源并汇总错误，不能依赖 effect 注册顺序。各域 URL 可不同，不建立跨库外键或借池事务。快照、绑定及跨库迁移的业务细则由[对话规范](../conversations.md)和[供应商规范](../providers.md)维护，迁移仍按所属域事务和备份责任执行。
- 数据库凭据仅由服务端配置注入，不写入仓库或前端；连接串和数据库异常栈不得返回客户端，日志与公共报告不得泄露数据库凭据。认证变量及缺配置行为仍按认证底座执行。
- 数据库结构的检查与修改按所属业务的迁移契约执行。当前认证的启动检查、迁移命令、备份、结构异常和升级审阅要求见[配置与迁移](../auth.md#配置与迁移)，不新增通用迁移入口或自动回滚承诺。
- 数据库包的导入范围沿[源码与依赖护栏](../engineering/source-guardrails.md)执行。增加其他业务接入时核对模块边界、真实消费者与验证，不能直接借用认证内部的数据库池。
- 常规自动化回归（`pnpm test`、`pnpm check` 与 CI 的 Vitest 集成测试）只使用权限隔离的测试资源，清理限定于本轮拥有的 schema 范围，严禁读写 `mio_dev`／`mio_test` 业务库或读取 `mio_dev` 凭据自动联网；当用户指示推进功能开发、协议摸底（如 Pre-C1）或业务验收时，默认放行直接在常驻 `mio_dev` 上执行非破坏增量迁移、读取既有加密凭据并保留数据，无需再为读取既有凭据二次索要口令（纯讨论／只读审阅／纯文档不触发外部调用，覆盖既有 `apiKey`、改写共享全局路由等高敏操作仍遵守三条核心安全底线），详见下节验证入口与[常驻环境](../local-environments.md#自动化回归与人工数据)。

## 使用经验与适用条件

当前 Better Auth 认证的运行时和迁移工具复用 [authOptions](../../src/auth/config.ts)，使库选项和结构检查使用同一来源；适用于现有认证模型，不能直接作为其他业务的数据模型。迁移幂等及异常结构由[认证集成测试](../../tests/auth/auth.test.ts)覆盖。

认证通过 [专用 dialect introspector](../../src/auth/database.ts) 在 SQL 内只读取连接有效 search_path 的元数据，以 OID 关联序列归属；启动、迁移及首次运行时结构校验共用该入口。它不接管其他业务的池或结构检查，具体依赖与检查保证见[认证配置与迁移](../auth.md#配置与迁移)。

连接池参数以当前持有者的实现为准；认证服务中的池大小和连接时限属于本切片配置，不是所有业务的默认值。复用上述接入方式时仍需核对实际负载、生命周期和失败行为，现有测试不提供通用容量或性能结论。

## 验证入口与变更影响

`pnpm test` 与 `pnpm check:local` 中的真实 PostgreSQL 验证使用[测试数据库辅助实现](../../tests/support/auth-database.ts)：

- 通过 `pnpm test` 显式提供 `MIO_TEST_DATABASE_URL` 时，目标必须是库名以 `_test` 结尾的专用数据库。每轮仅创建和删除自己的随机 schema。
- 本地自动探测按 `mio-dev`、`mio-test` 顺序选择已配置且端口可达的 `mio_regression_test`。没有候选库配置或候选端口均不可达时，用例使用 PATH 中的 `initdb`、`pg_ctl` 启动独立临时集群并在结束后清理。选定目标后，登录、权限或库未初始化等错误按实际失败报告。入口与显式环境选择见[测试导航](../engineering/testing.md#按变更定位测试)。
- [CI 配置](../../.github/workflows/check.yml)使用固定 PostgreSQL `18.6` 镜像，与[常驻开发/测试环境](../local-environments.md)一致。这是配置的验证环境，不代表已证明所有服务端版本兼容或远端门禁已通过。

两套常驻环境各自使用独立容器、账号和命名卷。常驻库 `mio_dev` 与 `mio_test` 长期保留；自动化回归使用同实例内另设的 `mio_regression_test`，其独立账号 `mio_regression` 无权连接 `mio_dev`／`mio_test`（既有数据卷通过 `pnpm env:init && pnpm regression:init:dev` 或 `regression:init:test` 无损补建）。服务账户 `mio` 仅有本业务库所需权限；用户指示推进功能开发、协议摸底或业务验收时，默认允许直接对 `mio_dev` 执行显式增量迁移、读取既有加密凭据与单次有界非破坏验证并保留数据（无需二次索要口令，并遵守[常驻环境](../local-environments.md#自动化回归与人工数据)三条核心安全底线），只有破坏性故障／重放演练才使用独立空库现场。PostgreSQL 18 卷挂到 `/var/lib/postgresql`，不沿用旧镜像的数据卷位置。

[认证集成测试](../../tests/auth/auth.test.ts)组合真实 PostgreSQL、DSH HTTP 和显式迁移命令，覆盖持久化、迁移、注册事务回滚与并发唯一性，并核对启动失败、启动中卸载的连接释放；认证业务覆盖和限制仍见[认证验证](../auth.md#验证)。当前结果须来自本次候选的实际执行，文档链接不等于测试通过。

改变驱动、连接生命周期、迁移行为或测试隔离方式时，沿调用关系核对运行时、显式迁移和测试消费者，执行受影响验证，并按[验证协议](../coordination.md#验证与接受)取得覆盖 `pnpm check` 的当前有效结论。新业务只沿用现有约束时，本页可保持不变，其模型、事务范围和业务行为由对应需求验收；公共约束改变时同步本页并回归受影响消费者。
