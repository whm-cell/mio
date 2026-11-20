# 常驻开发与测试环境

本机使用两套长期保留的 Docker PostgreSQL 18.6、Redis 8.2.11 和 RabbitMQ 4.4.0，供开发调试及人工测试。应用由 Node 24 和官方 DSH 运行，配置入口见 [README](../README.md#本地运行)。两环境共享代码仓库，各自拥有容器、账号、端口、卷、Profile、会话和 Worker 目录；不在退出应用或运行普通检查时重建、清空业务数据。默认启用账号认证与 Redis 限流；MQ 拓扑可独立准备，计算业务仍需媒体数据库与 COS 配置后显式启用。

| 项目                            | 开发                       | 测试                        |
| ------------------------------- | -------------------------- | --------------------------- |
| 私有配置                        | `.env`                     | `.env.test`                 |
| Compose 项目                    | `mio-dev`                  | `mio-test`                  |
| HTTP origin                     | `http://localhost:4310`    | `http://127.0.0.1:4311`     |
| PostgreSQL 回环端口／人工使用库 | `55432` / `mio_dev`        | `55433` / `mio_test`        |
| 同实例隔离自动化回归库          | `mio_regression_test`      | `mio_regression_test`       |
| Redis 回环端口／namespace       | `56379` / `dev`            | `56380` / `test`            |
| RabbitMQ AMQP／管理回环端口     | `56720` / `15680`          | `56721` / `15681`           |
| RabbitMQ vhost                  | `mio-dev`                  | `mio-test`                  |
| DSH home                        | `.runtime/dev/dsh`         | `.runtime/test/dsh`         |
| A 图片持久目录                  | `.runtime/dev/generations` | `.runtime/test/generations` |
| Worker 持久目录                 | `.runtime/dev/compute`     | `.runtime/test/compute`     |

保持不同访问主机名，避免同一浏览器的同名 Cookie 跨端口覆盖。应用均只监听回环地址；容器不向局域网暴露数据库端口。两环境可同时运行；测试应用重启加载当前构建产物，长期固定候选仍应使用独立产物目录，不把同一 checkout 的开发构建当成版本隔离。

## 初始化与日常入口

`pnpm env:init` 生成两份 mode 600 的配置及各自随机秘密；旧版缺少 MQ/Worker 配置或缺少回归库配置的文件只无损追加缺失组设置，已有数据库和认证秘密保留。部分缺失的 MQ/Worker 或回归库配置拒绝自动补密钥，须恢复原配置；缺少 A 图片目录时只追加本环境的 `MIO_GENERATIONS_DATA_DIR`，不自动启用生成；完整文件重复初始化不变。公开格式见 [模板](../.env.example)，实际配置和 `.runtime/` 不入库。文件丢失时先恢复原配置，不能对已有卷换一套随机密码后期待账号自动更新。

```sh
pnpm env:init
pnpm infra:up:dev
pnpm regression:init:dev
pnpm infra:up:test
pnpm regression:init:test
pnpm build
pnpm broker:init:dev
pnpm broker:init:test
pnpm migrate:dev --apply
pnpm migrate:test --apply
# 在不同终端启动；pnpm start 等同 start:dev。
pnpm start:dev
pnpm start:test
```

中间件 up 等待健康检查，Docker Engine 运行期间按 `unless-stopped` 恢复容器；主机重启后还须启动 Docker Engine。应用命令在前台运行，Ctrl+C 正常关闭；本入口不安装应用的系统开机服务。普通应用启动准备对应 Profile 并只读检查数据库结构，不自动迁移。

手机号短信默认关闭。需要使用时，仅在选定环境的私有配置文件中按[模板](../.env.example)填写该环境授权的腾讯短信应用、签名、模板和凭据，再设 `MIO_AUTH_SMS_ENABLED=true`；另一个环境不会继承这些设置。应用启动不发送短信，实际调用会产生外部费用；模板须有验证码与有效分钟数两个参数。认证结构仍需先预览并显式迁移，详见[认证底座](auth.md#配置与迁移)。

`broker:init:dev/test` 只准备本地重媒体命令、结果及各自 DLQ/DLX，先核对已有资源和受限 A/B 权限；任何不匹配报 `LOCAL_BROKER_CONFLICT`，不覆盖、不清队列、不轮换密码。旧图片队列及权限不被初始化静默收缩，须先按下面的切换步骤对账后单独退役。仅启用图片生成时无需运行 broker 初始化或启动 B。

主服务 A 与 Worker B 是两个进程，`start:dev/test` 只启动 A。构建完成后，首次使用 `pnpm compute:init:dev` / `pnpm compute:init:test` 创建独占 journal；已有目录不能重新初始化。之后在两个终端分别用 `pnpm compute:start:dev` / `pnpm compute:start:test` 启动 B。入口注入本环境的 B 身份、稳定实例 ID 和持久目录，缺 COS 配置时明确失败；不会借用历史计算环境的凭据。B 生命周期和恢复见 [Worker 说明](../compute/README.md)。

W1/W2 的供应商和文本服务不需要资产/COS 配置。转码使用媒体数据库、COS、`compute` 迁移、`MIO_COMPUTE_ENABLED=true` 和 B/MQ；图片使用同一资产域数据库、COS、`generations` 迁移、`MIO_GENERATIONS_ENABLED=true` 和 A 专属持久目录，允许完全不配置 B/MQ。两者都先迁移 assets，初始化不会新建业务媒体数据库或 COS 桶。

本地配置中的 `MIO_GENERATIONS_DATA_DIR=.runtime/dev/generations`（test 对应 test）由启动器解析为绝对路径；目录需持久保留，与媒体 PG 和 provider master key 一起备份。图片不再根据 RSA 字段推导启用，旧 `MIO_IMAGE_PUBLIC_KEY`、`MIO_IMAGE_PRIVATE_KEY`、`MIO_IMAGE_KEY_ID` 不注入 A/B。旧恢复数据未对账前仍保留私有备份。生成停止会停止认领新任务，后续从 PG 与文件检查点恢复，不重放对话工具。已有旧 B 任务无 A 执行行时保持历史只读，不被 A 接管重生成。

本地 `dev` 和 `test` 各自在同一私有环境文件设置一次 `MIO_COS_BUCKET`、`MIO_COS_REGION`、`MIO_COS_SECRET_ID` 和 `MIO_COS_SECRET_KEY`，临时凭据同时设置 `MIO_COS_SESSION_TOKEN`。同环境的 A 和 B 使用这套受限身份，其权限覆盖两项服务实际需要的 COS 操作。旧环境文件中的 `MIO_LOCAL_COMPUTE_COS_*` 可保留，由启动器忽略。`compute:start:dev/test` 仍使用本环境的 B 专用 RabbitMQ 身份和独占持久目录。独立部署的 B 进程自行注入自己的环境，见 [Worker 入口](../compute/README.md)。服务使用非 Root 凭据。临时凭据到期后，更换凭据并重启对应进程，签名 URL 受凭据有效期约束。

`pnpm migrate:dev` / `pnpm migrate:test` 默认预览认证迁移，`--apply` 才执行。可以在环境文件配置相应业务后指定 `conversations`、`providers`、`assets` 、`compute` 或 `generations`，例如 `pnpm migrate:dev conversations --apply`；资产必须先于计算或生成迁移，分库供应商引用迁移沿[供应商规范](providers.md)。供应商单轨模型路由通过 `pnpm route:dev <routes.json | --stdin>`（或 `pnpm route:test`）受控导入所选环境库，不向运行时暴露管理密码。未启用域不自动迁移。

## 常驻 dev 的 OneLink 与对话

以下只配置本人授权的开发环境。先停止旧 dev 应用，备份目标库和现有 `.env`，保留原文件的 600 权限；不要覆盖已有主密钥。向 `.env` 显式加入模板中的 `MIO_PROVIDERS_DATABASE_URL`、`MIO_PROVIDERS_MASTER_KEY`、`MIO_PROVIDERS_MASTER_KEY_ID` 和 `MIO_CONVERSATIONS_DATABASE_URL`。两个 URL 可以各自填写 `.env` 中 `MIO_AUTH_DATABASE_URL` 的完整值；这只是共用物理数据库，各域仍持独立池。文件读取不展开 `$MIO_AUTH_DATABASE_URL`，不能只写变量引用。主密钥是独立 32 字节随机数的标准 base64（初次可用 `openssl rand -base64 32` 生成），ID 可用稳定的 `dev-onelink-v1`；与数据库及 DSH 目录一起安全备份，后续启动继续使用相同值。不要放进仓库、命令历史或共享日志。`.env.test` 仅在需要该环境时独立配置，不回退 `.env`。

核对 SQL 和目标库后执行；已有对话在同库时供应商迁移会读取其旧模型引用，若对话位于独立库，按[供应商迁移](providers.md#配置与迁移)冻结源记录并显式使用 `--with-conversations`：

```sh
pnpm infra:up:dev
pnpm migrate:dev providers
pnpm migrate:dev providers --apply
pnpm migrate:dev conversations
pnpm migrate:dev conversations --apply
pnpm build
pnpm start:dev
```

启动只检查结构，不自动迁移、发现或调用模型。下面是使用当前账号的手动路径；认证、供应商和对话具体错误分别见[认证 HTTP](apis/auth.md)、[供应商 HTTP](apis/providers.md)及[对话 HTTP](apis/conversations.md)。命令中的 `REV`、`MODEL_REF`、`OWNER_ID` 和 `CONVERSATION_ID` 都应按每一步真实返回值替换，不要粘贴其他用户的值。

1. 创建私有操作目录 `mkdir -p .runtime/dev/onelink-review && chmod 700 .runtime/dev/onelink-review`。将登录正文 `{"email":"本人测试邮箱","password":"本人密码"}` 保存为其中的 `login.json` 并设为 600。执行以下登录及身份查询；Cookie 文件同样只保存在该目录。

   ```sh
   curl -sS -c .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' --data-binary @.runtime/dev/onelink-review/login.json http://localhost:4310/api/auth/sign-in/email -o /dev/null -w 'HTTP %{http_code}\n'
   curl -sS -b .runtime/dev/onelink-review/cookies http://localhost:4310/api/v1/me
   curl -sS -b .runtime/dev/onelink-review/cookies http://localhost:4310/api/v1/providers/onelink
   ```

2. 若尚未保存 Key，将 `{"apiKey":"本人授权的万联 Key","expectedRevision":0}` 写入 600 权限的 `credential.json`；已有配置则使用上一步返回的最新 revision，注意这会轮换当前 Key。只通过文件提交，不把明文放在命令行或共享日志。接着显式发现目录，读取实际 `modelRef`、`revision` 和待适配状态。

   ```sh
   curl -sS -X PUT -b .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' --data-binary @.runtime/dev/onelink-review/credential.json http://localhost:4310/api/v1/providers/onelink/credential
   curl -sS -X POST -b .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' -d '{}' http://localhost:4310/api/v1/providers/onelink/test
   curl -sS -b .runtime/dev/onelink-review/cookies http://localhost:4310/api/v1/providers/onelink/models
   ```

3. 用刚返回的稳定引用和最新 revision 编辑展示信息；不要求该模型已经可运行。每次写入后重新读取 revision，`null` 可清除覆盖。

   ```sh
   curl -sS -X PATCH -b .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' -d '{"modelRef":"MODEL_REF","expectedRevision":REV,"name":"我的模型","description":"开发用途"}' http://localhost:4310/api/v1/providers/onelink/models
   ```

4. 只为当前发现且有可靠协议依据的模型导入[单轨模型路由目录](providers.md#受控适配声明与实际验证)：先取得当前 Key 的成功模型目录，再按路由契约准备私有 `routes.json`。官方文档仅提供协议参考，不能创建或替代本人已发现的目录成员；如下通过 `route:dev` 显式导入 `mio_dev`（清除 shell 继承的其他环境设置），导入不会创建成员或直接标为 `verified`。

   ```sh
   pnpm route:dev .runtime/dev/onelink-review/routes.json
   ```

5. 重新 GET 模型目录取得 revision，以稳定引用设置 chat 默认。然后创建对话并发送唯一 requestId；`202` 仅是受理，按原 requestId 查询终态并读历史，不用新 ID 重发状态未知的请求。发送会产生真实模型调用和可能费用。

   ```sh
   curl -sS -X PATCH -b .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' -d '{"modelRef":"MODEL_REF","usage":"chat","isDefault":true,"expectedRevision":REV}' http://localhost:4310/api/v1/providers/onelink/models
   curl -sS -X POST -b .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' -d '{}' http://localhost:4310/api/v1/conversations
   curl -sS -X POST -b .runtime/dev/onelink-review/cookies -H 'Origin: http://localhost:4310' -H 'Content-Type: application/json' -d '{"requestId":"dev-review-1","text":"你好"}' http://localhost:4310/api/v1/conversations/CONVERSATION_ID/messages
   curl -sS -b .runtime/dev/onelink-review/cookies http://localhost:4310/api/v1/conversations/CONVERSATION_ID/requests/dev-review-1
   curl -sS -b .runtime/dev/onelink-review/cookies http://localhost:4310/api/v1/conversations/CONVERSATION_ID/history
   ```

凭据正文和登录材料用完后按本机秘密管理方式处理；不要将它们加入仓库。重启后使用原配置和原 DSH home，观察模型覆盖与历史，不自动重放已受理请求。此路径是人工验证说明，不意味着其他模型、媒体或生产已验证。

启动、迁移及 Compose 明确选择一份完整配置，不叠加开发文件作为测试默认值；继承 shell 中的 Mio/DSH/PG/Redis/RabbitMQ/Compose 配置会被清除，避免开发连接覆盖测试文件。应用只取得运行所需的配置，不继承 `MIO_LOCAL_*` 管理密码和 `MIO_TEST_*` 回归配置。`NODE_ENV` 只表达 Node 运行模式：开发为 development，人工测试为 production；环境选择由显式 dev/test 参数决定。

DSH 在所选 home 内启动，避免其内置 dotenv 层再次读取仓库根的开发配置。环境配置统一维护在根 `.env` / `.env.test`，不要在 DSH home 另放 `.env`。

## 数据与恢复

每套 PostgreSQL 的命名卷挂到 `/var/lib/postgresql`；每套 Redis 的命名卷挂到 `/data`，启用 AOF everysec，保留独占、128 MiB maxmemory、noeviction 和自身 namespace ACL。每套 RabbitMQ 使用独立 `/var/lib/rabbitmq` 命名卷和稳定节点名，固定 quorum 命令/结果队列及 DLQ；A/B 仅有相反方向的读写权限，没有 configure 或管理权限。应用 PG 账号 `mio` 无 superuser/建角色权限，Redis 账号不能 CONFIG 或清库。初始化角色只在空卷首次建立时运行，正常启动不覆盖已有数据。持久化及故障语义见 [PostgreSQL](integrations/postgres.md)、[Redis](integrations/redis.md)、[RabbitMQ](integrations/rabbitmq.md)。

`pnpm infra:status:dev` / `pnpm infra:status:test` 查看状态；`infra:stop:dev` / `infra:stop:test` 停止容器并保留卷。日常恢复使用 up；没有把删卷或业务清库包装成日常入口。备份和版本升级应保留卷及原秘密；本机持久化不等于灾难恢复备份或生产验收。

重启数据库/Redis 前停止该环境应用并确认旧操作结束。按[认证恢复](auth.md#限流存储与恢复)从排清后实际等待 65 秒，再启动应用并复查登录。AOF 不证明最后一个计数已落盘，不能据此跳过等待或加入自动重连。另一环境继续运行。对话域启用后，PG 元数据与 DSH 原生日志成对保留；计算域保留媒体 PG、MQ 卷、Worker journal 及未确认文件和 COS 对象。环境名与实例 ID 不能为了重试随意更换；历史独立 broker 不由这些入口接管或删除。

## 自动化回归与人工数据

两套常驻 PostgreSQL 实例均在同一容器内另建权限隔离的 `mio_regression_test` 与专属账号 `mio_regression`（首次空卷由初始化脚本建立，既有数据卷通过 `pnpm env:init && pnpm regression:init:dev` 或 `regression:init:test` 无损幂等补建，不重置已有密码、不清业务表）。`mio_regression` 无权连接 `mio_dev` 或 `mio_test`；集成测试仅在 `mio_regression_test` 内创建并删除本轮随机 schema。

本地测试分别探测 PostgreSQL 和 Redis 的专用回归通道，每项优先选 `mio-dev`，其次 `mio-test`。缺少对应通道的配置或找不到可达端口时，由用例为该服务启动独立临时进程。选定通道后发生的登录、初始化或权限错误按实际失败报告。测试进程只从 `.env`／`.env.test` 提取专用回归通道配置。入口与显式环境选择见[测试导航](engineering/testing.md#按变更定位测试)。

Redis 常规限流回归复用仅授权 `~mio:regtest-*:*` 前缀的 `mio_regression` ACL 账号，并在结束后清理本轮键。全局 OOM 或停进程的 Redis 故障用例使用独立临时进程，可自动识别 `.runtime/redis-build/redis-8.2.11/src/redis-server`。RabbitMQ 集成测试动态创建并清理独立临时 vhost 与账号。

区分**常规自动化回归**、**开发推进／协议摸底与本地真实业务验收**和**破坏性故障演练**：

- **常规自动化回归（`pnpm test`、`pnpm check` 与 CI）**：覆盖空库首迁、旧结构升级、破坏约束与故障注入，严格使用常驻服务的隔离通道（`mio_regression_test` 随机 schema、`~mio:regtest-*:*` 前缀、临时 vhost 与协议替身）或独立临时夹具，严禁读写 `mio_dev` 业务表与凭据、`mio:dev:*` 键或 `mio-dev` 业务队列，也不因本机存在凭据而自动联网。
- **开发推进、协议摸底与本地真实业务验收（默认放行常驻 `mio_dev`）**：当用户指示推进功能开发、协议摸底（如 Pre-C1）或业务验收时，默认允许直接使用常驻 `mio_dev`（`.env`、已加密落库的供应商凭据、私有测试 COS、`mio_dev` PG、`mio-dev` Redis/MQ 与 `.runtime/dev/{dsh,compute}`）执行单次有界、最小规格的真实外部调用与非破坏增量迁移并保留数据，Agent 无需为读取 `mio_dev` 既有凭据再停下二次索要账号或调用口令。`providers-live.ts`、`conversations-live.ts`、`live-cos-probe.ts` 及 `live-image-loop.ts dev` 模式均先对 `mio_dev` 执行增量迁移，再复用既有账号／凭据或保留的测试账号完成真实业务验证，不再新建即用即删的隔离库，使生成的路由、会话、资产与验证记录直接留在 `mio_dev` 中可查可用。独立 `*-live.ts`／`*-probe.ts` 脚本的显式环境变量开关（如 `MIO_RUN_COS_PROBE=yes`、`MIO_RUN_LIVE_IMAGE=yes`）保留，用作防止普通测试误触发的脚本安全阀，不再解释为需要向用户二次讨口令。
- **三条核心安全底线**：
  - **常规自动化回归离线隔离**：`pnpm test`、`pnpm check` 与 CI 仍严格走隔离通道与协议替身，严禁读取 `mio_dev` 凭据或自动联网；`*-live.ts`／`*-probe.ts` 的环境变量开关继续作为防误触发安全阀。
  - **只读与纯文档不联网**：纯讨论、只读审阅或纯文档编制任务不触发真实外部调用。
  - **单次有界与高敏例外**：真实外部调用须保持单次有界与最小规格，禁止自动无限重试（保留单次生成 POST 审计等防失控机制）；若传入新 `apiKey` 覆盖既有用户凭据、改写影响他人的全局路由、发送真实扣费手机短信、采集需本人扫码配合的真人生物识别信息或执行大额批量付费生成，仍须最小必要触发或由用户明确指定／配合。
- **破坏性中间件／重放故障演练**：如强杀在途执行器与故障重放（使用隔离 generation 场景；旧 `live-image-loop.ts prepare/execute` 已退役）、容器停启探针（`local-environments-live.ts`、`local-brokers-live.ts`）或队列容量告警探针（`live-compute-queue-probe.ts`），因会中断在途进程或触发容器级告警，仍按场景使用显式隔离现场。

Redis 故障测试保留独占夹具，不能对常驻 Redis 执行 OOM、淘汰策略修改或停机。CI 不读取私有环境文件，使用相同 PostgreSQL 镜像版本。改变常驻配置后须重新核对外部条件和实际行为，不能直接复用旧环境的验证结论。

显式现场探针 `node tests/environment/local-environments-live.ts --restart-local-environments` 要求两套中间件已经 up、认证迁移完成且应用已停止。它真实注册同邮箱的独立账号、检查跨环境凭据拒绝、依次重启各套中间件并实际等待 65 秒，验证账号、旧会话和 Redis AOF 数据保留。探针不属于普通测试，会保留账号和 Redis 标记；私有账号记录及日志在 `.runtime/local-acceptance/<run>/`。退出后关闭它启动的应用，中间件继续运行。

MQ 显式探针 `node tests/environment/local-brokers-live.ts --restart-local-brokers` 要求拓扑已初始化、A/B 停止、四个重媒体队列（命令、结果及各自 DLQ）为空且 Worker 无保留任务。它拒绝清理未知数据，检查 A/B 权限及跨环境连接拒绝，保留已确认消息后重复初始化、逐套停启 MQ 并验证另一环境继续收发。它还用不访问 COS 的配置实启空闲 Worker、停启两次并核对 journal 身份；不能据此宣称媒体处理或 COS 已验收。日志在 `.runtime/local-broker-acceptance/<run>/`，退出后关闭探针启动的 Worker 并保留中间件和 journal。自动故障回归须使用单独 vhost/身份或独立实例，不清空人工测试队列。

## 图片生成迁移与切换

先暂停新的图片提交但继续历史查询。对媒体库执行增量迁移，再运行 `node scripts/service/local.ts dev generations-preflight`（或 test）；默认只读，不发送供应商生成请求。它核对旧 PG 状态/outbox、旧图片命令和 DLQ 的消息与消费者、B journal 的未完成项及未确认上传身份，并检查 A 目录。目录缺失先创建权限为 700 的专属目录；不自动删除现有内容。

旧 B 的 `partial` 要与 journal 完成记录中的任务、命令和请求数量对账，并逐项核对 PG 已登记产物的原序号、对象键、类型和大小。早期数组载荷需要至少一项能与 PG 核对的实际产物，且所有产物都要一致。journal 缺失、缺少对应终态记录或证据不符时，预检报告 `LEGACY_IMAGE_PARTIALS_UNRECONCILED` 并停止切换。已对账的旧部分结果保留 `partial` 状态，未确认上传仍单独阻断。仅有已确认的完整旧历史或 A 自有任务时，继续核对其余门禁。

本地 dev 的项目负责人明确决定放弃某笔旧 `partial` 的未确认上传后，可用 `node scripts/service/local.ts dev generations-preflight --legacy-partial-disposition <file>` 提交单笔决定。把来源核对和人类决定保存在私有证据中，并将决定存为权限 `0600` 的 JSON 对象。字段包括 `decision` 固定为 `abandon-unconfirmed-upload`，任务、旧命令和上传标识 `jobId`、`commandId`、`index`、`fileId`，旧 SQLite `image_attempts.payload` UTF-8 文本的 `journalPayloadSha256`，以及确认人 `acceptedBy`、时间 `acceptedAt` 和依据 `reason`。预检只为与原 PG `partial` 和旧 journal 完成记录一致的单个未确认上传报告 `acceptedLegacyUpload`。原状态、任务、上传记录和旧 journal 继续保留，其他切换条件照常核对。后续独立业务请求的结果另行关联原决定。

`generations-preflight --probe-cos` 显式在 A 现有 COS 身份范围内写入一个唯一小 PNG，再 HEAD/条件读取并核对原始字节。探针对象保留在报告的唯一键供对账，不自动删除；此选项验证实际写读权限。没有 COS 探针证据的只读预检保持不就绪。旧 unknown、未确认上传/消息、缺失恢复文件或权限不足均阻止切换，不能把失败标为已排空。

预检不停止进程、不消费/清空队列、不接受或重跑任务。操作者逐项处理阻断并确认旧进程已不再发送生成 POST 后，才启动 A 图片执行器。新链路及历史读取验证后恢复接单，再退役图片专用队列和 RSA 密钥；视频队列、B 重媒体 journal、历史任务表及旧恢复原件保留。A 尚无新任务时可回旧版本；存在 A 新任务时先对账，不把任务交旧 B 重跑。

新的 `live-image-loop.ts dev` 只启动 A，并在进程中安装单次生成 POST 审计；入口不配置 RabbitMQ 或启动 B，继续走正式登录、目录刷新、图片 HTTP、资产下载、重启和幂等读取。用户指示推进开发或验收时，默认允许复用常驻 `mio_dev` 既有账号／凭据与私有测试 COS 执行单次有界、最小规格的真实供应商验收（脚本的 `MIO_RUN_LIVE_IMAGE=yes` 环境变量保留为防普通测试误触发的脚本安全阀，不再要求为此二次索要口令），正式验收取证仍须基于干净候选且未执行不算通过；若传入新 `apiKey` 覆盖既有凭据或改写影响他人的全局路由，仍须最小必要触发或由用户明确指定。该入口保留测试用户、业务任务、COS 产物及私有审计证据。
