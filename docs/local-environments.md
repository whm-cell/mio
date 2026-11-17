# 常驻开发与测试环境

本机使用两套长期保留的 Docker PostgreSQL 18.6、Redis 8.2.11 和 RabbitMQ 4.4.0，供开发调试及人工测试。应用由 Node 24 和官方 DSH 运行，配置入口见 [README](../README.md#本地运行)。两环境共享代码仓库，各自拥有容器、账号、端口、卷、Profile、会话和 Worker 目录；不在退出应用或运行普通检查时重建、清空业务数据。默认启用账号认证与 Redis 限流；MQ 拓扑可独立准备，计算业务仍需媒体数据库与 COS 配置后显式启用。

| 项目                            | 开发                    | 测试                    |
| ------------------------------- | ----------------------- | ----------------------- |
| 私有配置                        | `.env`                  | `.env.test`             |
| Compose 项目                    | `mio-dev`               | `mio-test`              |
| HTTP origin                     | `http://localhost:4310` | `http://127.0.0.1:4311` |
| PostgreSQL 回环端口／人工使用库 | `55432` / `mio_dev`     | `55433` / `mio_test`    |
| 同实例隔离自动化回归库          | `mio_regression_test`   | `mio_regression_test`   |
| Redis 回环端口／namespace       | `56379` / `dev`         | `56380` / `test`        |
| RabbitMQ AMQP／管理回环端口     | `56720` / `15680`       | `56721` / `15681`       |
| RabbitMQ vhost                  | `mio-dev`               | `mio-test`              |
| DSH home                        | `.runtime/dev/dsh`      | `.runtime/test/dsh`     |
| Worker 持久目录                 | `.runtime/dev/compute`  | `.runtime/test/compute` |

保持不同访问主机名，避免同一浏览器的同名 Cookie 跨端口覆盖。应用均只监听回环地址；容器不向局域网暴露数据库端口。两环境可同时运行；测试应用重启加载当前构建产物，长期固定候选仍应使用独立产物目录，不把同一 checkout 的开发构建当成版本隔离。

## 初始化与日常入口

`pnpm env:init` 生成两份 mode 600 的配置及各自随机秘密；旧版缺少 MQ/Worker 配置或缺少回归库配置的文件只无损追加缺失组设置，已有数据库和认证秘密保留。部分缺失的 MQ/Worker 或回归库配置拒绝自动补密钥，须恢复原配置；完整文件重复初始化不变。公开格式见 [模板](../.env.example)，实际配置和 `.runtime/` 不入库。文件丢失时先恢复原配置，不能对已有卷换一套随机密码后期待账号自动更新。

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

`broker:init:dev/test` 是显式拓扑初始化入口：先核对全部已有资源，再补缺失的策略、持久队列（含独立图片命令队列 `mio.compute.image.commands.v1` 及其 DLX/DLQ）、绑定和受限 A/B 用户，且仅当现有 B 权限精确匹配旧版单命令队列读权限时执行无损幂等升级；任何其他已有资源不匹配时立即停止并报 `LOCAL_BROKER_CONFLICT`，不覆盖、不清队列、不轮换密码。最后真实验证两个身份的 AMQP 登录。首次准备后日常 up 不改拓扑；请求结果未知时保留现场，核对后可重复执行初始化。权限与恢复边界见 [RabbitMQ 契约](integrations/rabbitmq.md)。

主服务 A 与 Worker B 是两个进程，`start:dev/test` 只启动 A。构建完成后，首次使用 `pnpm compute:init:dev` / `pnpm compute:init:test` 创建独占 journal；已有目录不能重新初始化。之后在两个终端分别用 `pnpm compute:start:dev` / `pnpm compute:start:test` 启动 B。入口注入本环境的 B 身份、稳定实例 ID 和持久目录，缺 COS 配置时明确失败；不会借用历史计算环境的凭据。B 生命周期和恢复见 [Worker 说明](../compute/README.md)。

W1/W2 的供应商和文本服务不需要资产/COS 配置。完整转码以及 W3 图片真实闭环才须在各自环境文件配置独立媒体数据库 `MIO_ASSETS_DATABASE_URL`、本环境授权的 COS 桶与可用凭据，先迁移 assets 再迁移 compute，并为 A 设置 `MIO_COMPUTE_ENABLED=true`。现有代码没有可配置的 COS 环境前缀，不能仅换一个本地目录就宣称云资源隔离。初始化中间件不自动新建媒体数据库或 COS 桶，也不证明完整云端转码已通过。

图片候选还需供应商域迁移和显式图片密钥：A 使用 `MIO_IMAGE_PUBLIC_KEY`、`MIO_IMAGE_KEY_ID`，B 使用同 ID 的 `MIO_IMAGE_PRIVATE_KEY`。Key ID 须为 1–64 个字母、数字、下划线或连字符。本地环境文件可按 dotenv 引号格式保存多行 PEM；启动器不会把 B 私钥传给 A，也不会把 A 公钥传给 B。图片消息加入显式 profile 后，升级时须先停图片准入、核对已受理命令，再升级 B 并确认其支持新协议后升级 A；旧 B 不能消费新消息。不同测试批次须使用已授权且隔离的桶、数据库和队列，旧凭据或旧目录不能仅凭存在视为当前授权。运维与恢复边界见 [Worker](../compute/README.md) 和[图片候选](apis/compute.md#post-apiv1computeimages)。

移除 A 图片准入配置不会清理已有任务：图片表已存在时启动检查其当前结构，继续投递、接收和恢复已受理任务；仅旧视频库没有图片表时，误入的图片结果进入 broker 死信，需核对数据库和消息后处理，不冒充完成。已有图片表但结构不兼容须先迁移或恢复正确库，不能静默继续消费。

本地 A 使用原 `MIO_COS_SECRET_ID/KEY`；本地 B 必须在同一私有环境文件另设受限的 `MIO_LOCAL_COMPUTE_COS_SECRET_ID/KEY`，缺失不回退 A，ID 与 A 相同时拒绝启动。升级已有本地 COS 配置时先补 B 独立身份，再启动 Worker；桶与地域继续共用。长期受限 Key 可直接使用；若选定临时凭据，A 使用 `MIO_COS_SESSION_TOKEN`、B 使用 `MIO_LOCAL_COMPUTE_COS_SESSION_TOKEN`，B 字段不会注入 A。两进程由同一本地用户管理，该约定不隔离同用户对环境文件的读取权限。不得使用 Root 凭据；临时凭据失效后操作会失败，签名下载 URL 也不会超出其实际有效期，此时更换同一权限边界的凭据并重新启动对应进程即可。本配置不自动续期。

`pnpm migrate:dev` / `pnpm migrate:test` 默认预览认证迁移，`--apply` 才执行。可以在环境文件配置相应业务后指定 `conversations`、`providers`、`assets` 或 `compute`，例如 `pnpm migrate:dev conversations --apply`；资产必须先于计算迁移，分库供应商引用迁移沿[供应商规范](providers.md)。供应商单轨模型路由通过 `pnpm route:dev <routes.json | --stdin>`（或 `pnpm route:test`）受控导入所选环境库，不向运行时暴露管理密码。未启用域不自动迁移。

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

准备原有隔离 Redis 测试二进制后，本地运行 `pnpm test <测试范围>` 或 `pnpm check:local <测试范围>` 均会自动检测并优先复用本机已启动容器（优先 `mio-dev` `55432`，其次 `mio-test` `55433`）中的 `mio_regression_test`，仅注入回归库连接串，不加载 `.env`／`.env.test` 中的业务开关、万联 Key 或 COS 凭据；仅当本地两套容器均未启动或无环境文件时，`pnpm test` 才退回 `initdb` 临时集群兜底。需要真实 RabbitMQ 的本地集成测试同样自动连接已启动的本地 broker（`mio-dev` 或 `mio-test`）创建并清理独立临时 vhost 与临时账号，不触碰常驻 `mio-dev`／`mio-test` 业务队列，日常开发只需保持 `mio-dev` 运行即可。

区分**破坏性自动化回归**与**获授权的本地真实业务／模型验收**：

- **自动化确定性回归（Vitest）**：覆盖空库首迁、旧结构升级、破坏约束与故障注入，始终运行在 `mio_regression_test` 随机 schema 及临时 vhost／临时 Redis 夹具中，严禁连接 `mio_dev` 或 `mio_test`。
- **获授权的本地真实业务／模型验收**：默认直接在常驻 `dev` 环境（`.env` + `mio_dev` + `.runtime/dev/{dsh,compute}` + `mio-dev` MQ/Redis）执行——先对 `mio_dev` 预览并执行增量迁移（`pnpm migrate:dev <domain> --apply`）及路由同步（`pnpm route:dev`），再复用本人既有账号、万联凭据、主密钥和常驻 Worker 完成非破坏性真实验证，既检验既有开发数据的增量升级兼容性，也让验证通过的路由、`verified` 记录、会话和资产直接保留在 `mio_dev` 可继续使用；不再为普通模型／业务验收在 `.runtime/dev/` 反复新建一次性空数据库与临时密钥目录。
- **破坏性中间件／重放故障演练**：如强杀在途 Worker、向交换机重投重复密文命令（`tests/compute/live-image-loop.ts`）或逐套重启容器（下述 `local-environments-live.ts`、`local-brokers-live.ts`），因会中断在途进程或抢占结果消费，才按场景使用显式隔离现场，且演练通过不替代常驻 `mio_dev` 的增量迁移同步。

Redis 故障测试保留独占夹具，不能对常驻 Redis 执行 OOM、淘汰策略修改或停机。CI 不读取私有环境文件，使用相同 PostgreSQL 镜像版本。改变常驻配置后须重新核对外部条件和实际行为，不能直接复用旧环境的验证结论。

显式现场探针 `node tests/environment/local-environments-live.ts --restart-local-environments` 要求两套中间件已经 up、认证迁移完成且应用已停止。它真实注册同邮箱的独立账号、检查跨环境凭据拒绝、依次重启各套中间件并实际等待 65 秒，验证账号、旧会话和 Redis AOF 数据保留。探针不属于普通测试，会保留账号和 Redis 标记；私有账号记录及日志在 `.runtime/local-acceptance/<run>/`。退出后关闭它启动的应用，中间件继续运行。

MQ 显式探针 `node tests/environment/local-brokers-live.ts --restart-local-brokers` 要求拓扑已初始化、A/B 停止、六个队列（视频命令、图片命令、结果及各自 DLQ）为空且 Worker 无保留任务。它拒绝清理未知数据，检查 A/B 权限及跨环境连接拒绝，保留已确认消息后重复初始化、逐套停启 MQ 并验证另一环境继续收发。它还用不访问 COS 的配置实启空闲 Worker、停启两次并核对 journal 身份；不能据此宣称媒体处理或 COS 已验收。日志在 `.runtime/local-broker-acceptance/<run>/`，退出后关闭探针启动的 Worker 并保留中间件和 journal。自动故障回归须使用单独 vhost/身份或独立实例，不清空人工测试队列。
