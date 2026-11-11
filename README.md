# Mio 插件服务底座

本仓库是独立的后端 TypeScript 插件服务，由官方 DeepSeek Harness Profile 启动，不包含前端 UI。提供基础 HTTP、账号认证及全部拒绝的工具策略；[本地对话服务](docs/conversations.md)包括用户归属、BYOK 文本、多轮、原生内容持久化、历史、SSE 与取消。实际接受范围与限制见[成果入口](docs/tasks/conversation-service/complete/report.md)，开发安排见[对话 PRD](docs/tasks/conversation-service/prd.md)。项目/媒体生成尚未实现。认证边界见[认证底座](docs/auth.md)，内核边界见 [DSH 契约](docs/integrations/dsh.md)。

用户资产入口按[资产 API](docs/apis/assets.md)和[私有 COS 契约](docs/integrations/cos.md)配置独立媒体数据库与桶；显式执行 `pnpm assets:migrate --apply` 后启用。当前开发与真实云验收状态以[任务资料](docs/tasks/compute-service/prd.md)及实际证据为准，不能据此推断转码链路已完成。

计算服务的 A/B 独立产物、官方 DSH 宿主、本机迁移与启动顺序见[计算服务设计](docs/tasks/compute-service/design.md#本机独立产物与启动)。运行秘密和数据使用各自的受保护环境与目录；真实服务器部署和生产验收留待后续节点。

- [资料导航与权威位置](docs/index.md)
- [底座范围、边界与规则](docs/foundation.md)
- [任务需求、设计与候选](docs/tasks/index.md)
- [HTTP API](docs/api.md)
- [账号注册、登录与会话配置](docs/auth.md)
- [本地对话配置、迁移与恢复](docs/conversations.md)
- [用户万联 Key、目录与显式迁移](docs/providers.md)
- [基础设施与外部集成契约](docs/integrations/index.md)
- [验收标准与入口](docs/acceptance.md)
- [PRD 成果索引](docs/tasks/index.md)
- [开发入口](AGENTS.md)
- [团队任务协调](docs/coordination.md)

## 安装与检查

使用 Node 24.22.2（DSH 最低要求 24.9）及 pnpm 11.6.0。版本固定在 package.json 和锁文件；公共安装、构建和 CI 不需要相邻源码仓库、全局 Skills 或成员的个人记录。

认证集成测试需要隔离 PostgreSQL 和 Redis 8.2.11 二进制，选择与清理要求见 [PostgreSQL](docs/integrations/postgres.md#验证入口与变更影响) 和 [Redis 验证入口](docs/integrations/redis.md#验证入口与变更影响)。Redis 测试各自启动临时进程，不能指向共享实例；切换/恢复演练真实等待三次 65 秒，完整检查需要数分钟。认证运行配置和迁移见[认证底座](docs/auth.md)。

全新 checkout 的工作 CLI 尚未装依赖时，先核对仓库、锁文件、写入范围和缓存/临时目录，执行下面的一次受控冻结安装并保留命令结果；CLI 可用后按事实补录初始化，不追认安装前已有 C1。缺依赖时 `pnpm work` 显式报错，不自动安装；后续依赖变更仍按[实施与协作](docs/coordination.md#实施与协作)执行。

```sh
pnpm install --frozen-lockfile --ignore-scripts
# Redis 8.2.11 已在 PATH 时直接执行；也可先按下方准备并设置 MIO_TEST_REDIS_SERVER。
pnpm check
```

本机没有固定 Redis 时，可编译到忽略的任务目录，不启动长期全局服务：

```sh
mkdir -p .runtime/redis-build
curl --fail --location https://download.redis.io/releases/redis-8.2.11.tar.gz -o .runtime/redis-build/redis-8.2.11.tar.gz
echo 'fba14b77c4bdcb2d5418b6741fc0cdaac4b78bc73eab9b2e5f3c255d597f16fa  .runtime/redis-build/redis-8.2.11.tar.gz' | shasum -a 256 -c -
tar -xzf .runtime/redis-build/redis-8.2.11.tar.gz -C .runtime/redis-build
make -C .runtime/redis-build/redis-8.2.11 -j4 MALLOC=libc
export MIO_TEST_REDIS_SERVER="$PWD/.runtime/redis-build/redis-8.2.11/src/redis-server"
pnpm check
```

`check` 执行格式、类型、lint、文档/结构/索引护栏、测试、构建和官方 Profile 产物 smoke。安装不执行依赖构建脚本；当前最小 Profile 不使用需要额外原生构建的运行能力。

万联动态目录、稳定模型身份及文本消费者按[供应商规范](docs/providers.md)配置本域数据库与主密钥并显式迁移。分库历史引用迁移、部署适配声明和使用方式以该页为准；新 ID 由当前 Key 目录发现，不维护生产型号白名单。开发安排与实际接受见[万联 PRD](docs/tasks/onelink-integration/prd.md)及其成果入口。普通检查不自动访问万联；真实目录/文本须另行显式授权。目录成功不等于全部协议、媒体或生产验收。

启用 provider 域后，对话创建使用准确 modelRef 或本人显式 chat 默认，旧无绑定会话由 owner 一次绑定；按[对话 API](docs/apis/conversations.md)操作并显式执行增量 `conversations:migrate --apply`。未启用 provider 域时保留显式 legacy 路由，BYOK 缺配置不回退。独立真实入口为 `node tests/conversations/conversations-live.ts <authorized-private-key-file> [exact-model-id]`，默认 deepseek-v4.1-flash，不进入普通 check；执行前核对本人凭据、测试范围和费用授权，文本授权不扩大媒体、工具或部署范围，也不代表人类接受。

## 本地运行

开发与人工测试使用两套常驻持久化 Docker PostgreSQL 18.6 / Redis 8.2.11 / RabbitMQ 4.4.0。私有 `.env`、`.env.test` 由初始化命令分别生成，已有秘密保留；数据、密钥、Profile、会话和 Worker 目录按环境隔离。完整配置、恢复及自动化回归隔离见[常驻环境](docs/local-environments.md)。

```sh
pnpm env:init
pnpm infra:up:dev
pnpm infra:up:test
pnpm build
pnpm broker:init:dev
pnpm broker:init:test
pnpm migrate:dev --apply
pnpm migrate:test --apply
# 分别在两个终端运行；pnpm start 默认为开发。
pnpm start:dev
pnpm start:test
```

开发入口 `http://localhost:4310`，测试入口 `http://127.0.0.1:4311`。两套服务使用独立账号库；认证 POST 需要对应 Origin 和 JSON，注册/登录见[认证 HTTP](docs/apis/auth.md)。检查就绪：

```sh
curl http://127.0.0.1:4310/readyz
curl http://127.0.0.1:4311/readyz
```

启动命令自动准备所选 `DSH_HOME` 的 Profile 并链接当前插件，保留已有配置。底层 `profile:prepare` 仍支持显式目录，未设置 DSH_HOME 时保留旧 `.runtime/dsh` 默认。修改源码后重新构建并重启。`pnpm test:smoke` 使用打包产物和独立临时配置，结束后只清理自己的资源。测试中间件启动后可使用 `pnpm check:local` 对独立回归库执行完整检查，Redis 故障夹具仍需按安装章节准备。

配置：`MIO_HOST` 默认 `127.0.0.1`，`MIO_PORT` 默认 `4310`，`MIO_ALLOWED_ORIGINS` 默认 `[]`。DSH 当前不接受 `0.0.0.0` 通配绑定；远程部署使用明确的接口地址和已配置的 TLS 终止/反向代理。当前没有公网部署验收。

按 Ctrl+C 关闭，启动命令负责把终止信号交给 DSH 并等候退出。配置不完整时先修复，不以端口可连通判断就绪。

## 日常维护

使用能读取仓库指令、编辑文件和运行命令的 Agent 时，成员只需说“按这份 PRD 推进”“先验证”或“让当前任务进入 complete”。Agent 按[短句意图与下一步](docs/coordination.md#短句意图与下一步)定位任务、核对授权和证据后推进；用户无需提供 ID、哈希或 JSON。协议与 CLI 随仓库提供，没有正在执行的 Agent 就不会自行推进。

开发脚本按职责分为 `scripts/harness/`（工程护栏与任务协调）和 `scripts/service/`（Profile、启动、产物 smoke）。目录归属与开发模块依赖均由 `harness.config.json` 声明；`pnpm check` 组合公共检查与服务装载验证，生产代码保持独立。

一般修改执行相关测试与检查，交付前按[验证协议](docs/coordination.md#验证与接受)取得覆盖 `pnpm check` 的当前有效结论，可直接执行或复用有效基线并补齐受影响回归；全量条件由该协议统一规定。业务工具/权限变化必须测试真实执行链；接口变化更新同一份 API 契约。新增源文件自动继承所属模块规则，新模块需要在护栏配置中说明允许依赖。体量报告是审阅信号，不是自动拆分指令。

新目标从 `pnpm work guide start` 开始，原任务用 `status` 定位后取 `context`，记录阶段不代表现场已核验。编辑前建档并进入 C1，命令型实施经 `work exec`；源码质量审查与交回前三方对账按[验证协议](docs/coordination.md#验证与接受)执行。完整命令与字段查[记录索引](docs/work-records.md)。

公共资料的职责、稳定身份和增长规则见[资料导航](docs/index.md)，各 PRD 在本目录 `documents.json` 登记，`pnpm work documents` 只读列出资料与成果入口。静态[任务入口](docs/tasks/index.md)不随交付改写；complete 仅写所属 PRD 的 records/report，成果可按 key 读取，无需作者 `.work`。整理旧资料时，把仍有效的独有内容并入权威入口，核对必要证据和引用后删除被替代文档。

已有 PRD 的轻量修复、需求调整和小功能按[轻量变更归属](docs/index.md#增长与归属)维护；`pnpm work changes <prd> [key]` 按需读取目录或单项正文，实施步骤沿[任务协调](docs/coordination.md#关联并建立当前记录)。

公共协议、需求、源码、测试和检查配置入库；每人的 `.work/` 内容、运行资料 `.runtime/`、凭证 `.env*`、依赖与构建产物忽略。本地开发遵守统一记录协议；公共检查不要求任何成员的私人记录存在。忽略规则不提供备份或清除已跟踪内容，跨人交接需要单独提供代码与必要证据。

升级 DSH 时修改固定版本、审阅公开接口与 Profile 组成差异，再运行完整检查和产物装载。远端 CI/分支保护须在实际接入后单独验证。
