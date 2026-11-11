# 认证底座

项目负责人已确认：Mio 自建邮箱/密码登录，允许自助注册，首期注册即可登录；邮箱验证后续接入。当前按个人项目使用设计，用户具有稳定 userId，团队和多租户不在本切片建设。

实现采用 Better Auth 1.7.18 与 PostgreSQL，驱动版本和数据库公共约束见 [PostgreSQL 使用契约](integrations/postgres.md)。复用库的密码派生、签名 cookie、会话过期和撤销，不自行设计密码学或 JWT。认证表由固定版本的库模型定义；升级须审阅迁移和公开接口并重跑真实 DB、DSH 与打包产物验证。

[用户万联配置](providers.md)通过装配注入的 `Authentication.identity` 消费同一可信身份，独立检查 owner；不复用认证池或 secret 加密供应商 Key，不增加管理员/团队角色。其迁移、凭据生命周期与外部目录请求按本域规范维护。

## 配置与迁移

配置只从服务端环境注入，不写入仓库、Profile 或前端构建。

常驻开发与人工测试通过[本地环境入口](local-environments.md)分别读取私有 `.env` / `.env.test`，选择各自数据库、Redis 和稳定 secret。`pnpm migrate:dev --apply` / `pnpm migrate:test --apply` 执行对应认证迁移；`pnpm start:dev` / `pnpm start:test` 启动独立 Profile。原始迁移命令仍读取进程环境，不隐式加载文件。

| 变量                          | 要求                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `MIO_AUTH_BASE_URL`           | 固定对外 origin，如 `https://mio.example.com`，不含路径或末尾 `/`；HTTPS，回环主机可用 HTTP 开发 |
| `MIO_AUTH_SECRET`             | 至少 32 字符的随机秘密，重启时保持；轮换会使旧签名 cookie 失效                                   |
| `MIO_AUTH_DATABASE_URL`       | 专用 PostgreSQL 数据库连接，凭据只在服务端持有                                                   |
| `MIO_AUTH_ALLOWED_ORIGINS`    | 额外精确 origin 的 JSON 数组，默认 `[]`；BASE_URL 自身自动包含，禁止通配符                       |
| `MIO_AUTH_RATE_LIMIT_BACKEND` | `database`（缺省）或显式 `redis`；Redis 资源配置见[公共契约](integrations/redis.md)              |

三个必要配置均未提供时保持原无 DB 的 foundation Profile；提供任一却不完整会拒绝装载，不能静默降级。此兼容边界用于既有基础插件和开发环境；启用认证须配置完整并先迁移。

```sh
pnpm migrate:dev
pnpm migrate:dev --apply
pnpm build
pnpm start:dev
```

第一条只输出迁移计划，第二条才执行。发现库无法自动修复的结构问题（例如额外必填列）时，两种模式均报错，须先审阅并修复目标结构。迁移和运行时复用 `src/auth/config.ts`，普通插件启动只检查结构和连接，不自动建表。目标库需单独备份；升级时的删除、改名、回填应单独审阅，不能假定自动回滚。通用 guard 不连接或修改业务库。

认证与 `MIO_API_TOKEN` 分离，后者仍只保护 foundation 能力查询，不能作为 userId。认证启用失败时插件不注册 readyz 或业务路由；成功后 readyz 只表明本次装载就绪，不持续查询数据库健康。

## HTTP 入口

现行接口的身份、输入输出、错误和副作用在[认证 HTTP 契约](apis/auth.md)唯一维护；Foundation 服务凭据接口另见[Foundation 域](apis/foundation.md)。本章节保留旧导航，配置和迁移仍由本页维护。

## 限流存储与恢复

默认保留 PostgreSQL 限流；仅设置 Redis URL 不启用。显式 `redis` 必须有完整认证配置和有效 Redis URL/命名空间，否则拒绝装载。连接、固定版本、时限、权限及资源隔离沿 [Redis 公共契约](integrations/redis.md)；插件创建资源并将公开 `customStorage.consume` 注入认证。启动执行独占探测键的真实消费、TTL 检查和删除，成功才装载认证入口。

Better Auth 继续选择规则和 IP/路径键；[认证消费者](../src/auth/rate-limit.ts)把原键 SHA-256 后存为 `mio:<namespace>:auth:rate-limit:v1:<digest>`。摘要只用于固定长度，不是 IP 匿名化或授权。状态仅含计数和最近放行的毫秒时间，不存密码、cookie 或会话 token。Redis TIME 统一逻辑时间；单键 Lua 原子检查/计数/PX 过期。放行推动最近时间与 TTL，拒绝不改计数、不续 TTL，超过窗口重新从 1 开始；坏值、无过期或时钟倒退不清零放行。规则和原始 429 见[HTTP 契约](apis/auth.md)。

账号、凭据、会话和撤销仍以原 PostgreSQL 为准，不配置全局 secondaryStorage，`/me` 不经过 Redis 消费也不续期。`authOptions` 的 database 限流模型保持不变；运行时才注入 consume，显式迁移不读取 Redis 配置、不连接 Redis、不删旧表。

消费失败转发为脱敏 503。仅能证明未发出的队列满、服务明确在脚本执行前拒写的 OOM 可只拒绝当前请求；恢复容量后仍按原计数继续。断连、总期限到期、脚本/数据异常等未知状态停止后续消费并销毁连接，无 DB 回退、自动重连、重放或 PING 自愈。已装载进程且 DB 正常时 `/me` 继续可用；登录、续期、退出、改密、撤销等受限入口都可能 503。

切换、回退或故障恢复由操作者停止整个 Mio Profile，确认旧进程、PG 语句和 Redis 消费已排清；排清预算 30 秒，从最后不再可能消费时刻用单调时间等待 65 秒（当前最大窗口 60 秒加 5 秒余量）。预检固定版本、资源策略、凭据、原表、secret、应用/Redis 时钟偏差不超过 2 秒，前置失败保持暂停。计划维护预算 5 分钟，超预算报告并选择继续暂停或安全回退，不能为守时限略过等待。

依赖初始化成功即恢复入口，随后核对原账号/cookie、已撤销会话、额度与存储，异常再次暂停。维护期间认证、`/me`、Foundation 均可能不可达，没有独立维护响应或现场验证后才放流的门控。正常计划重载仅在 Redis 未丢失且旧客户端已排清时复用计数；Redis 重启/清空、未知原因重启都按故障恢复等待，禁止外部进程管理器立即重启绕过。详细切片安排与验收见[PRD §6](tasks/auth-rate-limit-redis/prd.md#6-迁移回退与故障恢复)，真实环境部署须另有明确目标与授权。

## 职责与限制

- [认证配置](../src/auth/config.ts)的 `readAuthConfig` 与 `authOptions` 由装配、运行时和显式迁移按职责复用；`AUTH_BASE_PATH` 是库选项、插件前缀注册和认证 HTTP 路径截取的同一权威值。`service.ts` 持有认证库与 DB 池，`http.ts` 负责白名单、来源、私有的有界正文读取和响应适配；`plugin.ts` 仅装配与释放。两个 HTTP 适配器共用的响应头与包装错误入口见 [API 领域导航](apis/index.md#运行时公共能力)，库原始响应仍由认证适配器转发。
- [认证服务](../src/auth/service.ts)的 `Authentication.identity(headers)` 返回经数据库验证的 `{userId,sessionId}` 或 `null`；`/api/v1/me` 和[对话 HTTP](../src/conversations/http.ts)是实际消费者，调用时禁止刷新会话。装配入口注入身份解析能力，再把可信主体传给[对话应用服务](../src/conversations/service.ts)检查资源归属；应用服务不依赖 Node HTTP、DSH 或认证驱动，也不信任请求体 userId 或服务 token。长流失效与已受理轮次的关系按[对话规范](conversations.md)执行。项目 CRUD 尚未实现。
- 首期邮箱未验证，不能用于第三方账号联结、团队邀请信任或邮件找回。邮箱验证、邮件找回、MFA、团队与生成分别按后续契约接入；未开放的入口返回 404。
- 数据库凭据与错误脱敏按 [PostgreSQL 使用契约](integrations/postgres.md#必须遵守的约束)执行；密码、cookie、会话 token 和部署秘密不写入公共日志或报告。

## 验证

`pnpm test` 包含真实 PostgreSQL 集成，数据库环境选择、隔离和清理要求统一见 [PostgreSQL 验证入口](integrations/postgres.md#验证入口与变更影响)。

`tests/auth.test.ts` 经真实 DSH HTTP 覆盖注册、重复邮箱、错误密码、会话失效/撤销与续期、密码更新、跨账号隔离、重载持久化、HTTPS cookie、来源/请求体/限流、迁移幂等与结构异常、注册事务回滚/并发唯一性、启动失败和启动中卸载；还构建并装载正式打包产物验证认证。原有工具拒绝、HTTP 错误与端口释放测试保留。

测试不等于邮箱所有权、真实浏览器、生产容量或项目业务验收。指定候选的原接受结果见 [所属 PRD 成果入口](tasks/ai-drama-foundation/complete/report.md#auth-registration-foundation)，验证摘要与限制可经[成果读取入口](work-records.md#核对与同步)展开。公共成果不保存详细原件或可恢复代码；资料整理没有重验历史认证专项，也不宣告后续项目或生成能力完成。复用取舍和读取器尚缺的直接验证见[设计](tasks/ai-drama-foundation/design.md#auth-http-reuse)，当前验证方法沿 [验收入口](acceptance.md) 查询。

实现依据：[固定版本数据库与迁移](https://github.com/better-auth/better-auth/blob/v1.7.18/docs/content/docs/concepts/database.mdx)、[邮箱密码认证](https://github.com/better-auth/better-auth/blob/v1.7.18/docs/content/docs/authentication/email-password.mdx)，以及本地安装包公开类型/实现；上游说明不替代本项目真实入口验证。
