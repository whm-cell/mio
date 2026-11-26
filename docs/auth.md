# 认证底座

项目负责人已确认：Mio 自建邮箱/密码登录，允许自助注册，首期注册即可登录；邮箱验证后续接入。当前按个人项目使用设计，用户具有稳定 userId，团队和多租户不在本切片建设。

实现采用 Better Auth 1.7.18 与 PostgreSQL，驱动版本和数据库公共约束见 [PostgreSQL 使用契约](integrations/postgres.md)。复用库的密码派生、签名 cookie、会话过期和撤销，不自行设计密码学或 JWT。认证表由固定版本的库模型定义；升级须审阅迁移和公开接口并重跑真实 DB、DSH 与打包产物验证。

[用户万联配置](providers.md)通过装配注入的 `Authentication.identity` 消费同一可信身份，独立检查 owner；不复用认证池或 secret 加密供应商 Key，C 端认证表不增加管理员/团队角色。平台管理后台使用独立的管理员账号与会话表（复用 `better-auth/crypto` 的密码派生与校验能力），与普通用户会话完全隔离，见[管理后台 HTTP](apis/admin.md)。其迁移、凭据生命周期与外部目录请求按本域规范维护。

## 配置与迁移

配置只从服务端环境注入，不写入仓库、Profile 或前端构建。

常驻开发与人工测试通过[本地环境入口](local-environments.md)分别读取私有 `.env` / `.env.test`，选择各自数据库、Redis 和稳定 secret。`pnpm migrate:dev --apply` / `pnpm migrate:test --apply` 执行对应认证迁移；`pnpm start:dev` / `pnpm start:test` 启动独立 Profile。原始迁移命令仍读取进程环境，不隐式加载文件。

| 变量                                                                                                                                                                      | 要求                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIO_AUTH_BASE_URL`                                                                                                                                                       | 固定对外 origin，如 `https://mio.example.com`，不含路径或末尾 `/`；HTTPS，回环主机可用 HTTP 开发                                                                                      |
| `MIO_AUTH_SECRET`                                                                                                                                                         | 至少 32 字符的随机秘密，重启时保持；轮换会使旧签名 cookie 失效                                                                                                                        |
| `MIO_AUTH_DATABASE_URL`                                                                                                                                                   | 专用 PostgreSQL 数据库连接，凭据只在服务端持有                                                                                                                                        |
| `MIO_AUTH_ALLOWED_ORIGINS`                                                                                                                                                | 额外精确 origin 的 JSON 数组，默认 `[]`；BASE_URL 自身自动包含，禁止通配符                                                                                                            |
| `MIO_AUTH_RATE_LIMIT_BACKEND`                                                                                                                                             | `database`（缺省）或显式 `redis`；Redis 资源配置见[公共契约](integrations/redis.md)                                                                                                   |
| `MIO_AUTH_EMAIL_PASSWORD_ENABLED`                                                                                                                                         | 默认 `true`，作为启动与无管理后台时的默认开关；启用管理后台后可由[全局配置](apis/admin.md#patch-apiv1adminsettingsglobal)在线热覆盖且无需重启，关闭时仅影响邮箱入口，不影响短信与微信 |
| `MIO_AUTH_SMS_ENABLED`                                                                                                                                                    | 默认 `false`；设为 `true` 时须完整配置腾讯短信，见[短信契约](integrations/tencent-sms.md)                                                                                             |
| `MIO_TENCENT_SMS_SECRET_ID`、`MIO_TENCENT_SMS_SECRET_KEY`、`MIO_TENCENT_SMS_APP_ID`、`MIO_TENCENT_SMS_SIGN_NAME`、`MIO_TENCENT_SMS_TEMPLATE_ID`、`MIO_TENCENT_SMS_REGION` | 启用短信时全部必填；模板须接受验证码和有效分钟数两个参数                                                                                                                              |
| `MIO_AUTH_SMS_PHONE_HOUR_LIMIT`、`MIO_AUTH_SMS_PHONE_DAY_LIMIT`、`MIO_AUTH_SMS_IP_HOUR_LIMIT`、`MIO_AUTH_SMS_IP_DAY_LIMIT`、`MIO_AUTH_SMS_GLOBAL_DAY_LIMIT`               | 可选正整数，只允许收紧默认额度，依次最多 5、10、20、100、1000                                                                                                                         |
| `MIO_AUTH_SMS_ACCOUNT_OPS_DAY_LIMIT`                                                                                                                                      | 可选正整数，只允许收紧账号操作桶的默认滚动 24 小时 300 次；不改变日常登录／注册全局额度                                                                                               |
| `MIO_AUTH_WECHAT_ENABLED`、`MIO_AUTH_WECHAT_APP_ID`、`MIO_AUTH_WECHAT_APP_SECRET`                                                                                         | 默认关闭；启用时须完整配置网站应用凭据与实际回调域，见[微信契约](integrations/wechat.md)                                                                                              |
| `MIO_ONELINK_SSO_ENC_KEY`、`MIO_ONELINK_SSO_AUTHORIZE_URL`、`MIO_ONELINK_SSO_REGISTER_URL`（及可选 `CLIENT_NAME` / `APP_NAME` / `ENV`）                                   | 可选服务端凭据组，默认未配置；须同时经管理端开启运行期热开关后对外开放，见[万联 OneLink SSO 契约](integrations/onelink-sso.md)                                                        |

三个必要配置均未提供时保持原无 DB 的 foundation Profile；提供任一却不完整会拒绝装载，不能静默降级。此兼容边界用于既有基础插件和开发环境；启用认证须配置完整并先迁移。

```sh
pnpm migrate:dev
pnpm migrate:dev --apply
pnpm build
pnpm start:dev
```

第一条只输出迁移计划，第二条才执行。发现库无法自动修复的结构问题（例如额外必填列）时，两种模式均报错，须先审阅并修复目标结构。迁移和运行时复用 `src/auth/config.ts`，普通插件启动只检查结构和连接，不自动建表。目标库需单独备份；升级时的删除、改名、回填应单独审阅，不能假定自动回滚。通用 guard 不连接或修改业务库。

认证配置通过 [AuthPostgresDialect](../src/auth/database.ts) 的公开 `createIntrospector` 扩展提供元数据，直接依赖固定的 Kysely 0.29.8。启动 `getMigrations`、显式迁移和首次运行时 adapter 结构校验共用该入口。表、列和 schema 在 SQL 内限定为连接 `current_schemas(false)` 的有效 search_path，并保留系统 schema 排除；迁移仍以第一个目标 schema 为准，运行时可沿有效路径找到后续 schema 的实际表。序列与列按 OID 依赖关系关联，覆盖 serial／identity，不对无关 schema 执行按名称解析的权限或序列函数，避免其他隔离 schema 并发删除引起探测失败。

探测返回真实列顺序、类型、nullable、default、注释和序列归属，并保留内部迁移表选项、Better Auth 表／列差异、额外无默认必填列检查及启动／迁移的必需索引检查。运行时结构检查不代表持续索引巡检。配置显式保留 `transaction:true`；注册事务、认证池所有者及关闭责任不变，不自动修改目标结构。

认证基础 schema 包括可空且唯一的手机号与 `displayId`、账号禁用列 `disabled`（默认 `false`）与 `disabledAt`、头像资产引用 `avatarAssetId`、验证码挑战、短信预算键表及账号复合唯一索引。运行与显式迁移都检查基础结构；短信事件表的迁移和启用条件见[发送预算切换与回退](#发送预算切换与回退)。账号表的 `(providerId, accountId)` 唯一约束防止同一凭据跨用户归属，`(userId, providerId)` 唯一约束确保一个用户至多有一个微信身份或一个万联身份；后一约束也适用于当前的 `credential` 账号。若既有账号违反任一约束，迁移失败并保留冲突供人工处理，不能静默合并或删除。未来支持同一 provider 的多个账号前须重新评估该约束。旧用户及会话保留，启动不自动应用变更；对已有用户表执行 `auth:migrate --apply` 时，`disabled` 按列默认值回填为 `false`，`displayId` 与 `avatarAssetId` 保持可空兼容。`account.wechatNickname` 也是可空字段，通过同一显式迁移添加，旧账号不回填；只有已核验的微信登录或绑定回调才刷新微信展示名，不覆盖用户自行编辑的 `name`。启用供应商但配置不全会拒绝装载；未启用或关闭配置开关时相应入口返回不可用，不影响其余已启用入口。

新注册用户（邮箱、手机、微信或万联）在创建事务内自动分配唯一 `displayId`（`miioo_` 加 6 位数字）；客户端注册输入不可伪造 `displayId`、`avatarAssetId`、`disabled` 或 `disabledAt`。通过事务性服务方法 `Authentication.setUserDisabled(userId, disabled)` 禁用账号时，在同一 PostgreSQL 事务内写入禁用状态并删除该用户全部活动会话；禁用账号无法通过邮箱、短信验证码、微信 OAuth、微信 QR 或万联 OneLink 签发新会话，若存在并发或遗留会话行，`/api/v1/me`、`/api/v1/me/profile`、`Authentication.identity`、`/api/auth/get-session` 及受会话保护的认证入口均将其视为无效并清理会话。重新启用后恢复登录能力，不恢复已撤销会话。

用户资料通过 `GET /api/v1/me/profile` 与 `PATCH /api/v1/me/profile` 读写，仅允许修改昵称（`name`）与头像资产（`avatarAssetId`）；非空 `avatarAssetId` 须经装配注入的资产核验回调确认属于本人、状态 `ready` 且 MIME 为 `image/jpeg`、`image/png` 或 `image/webp`，核验另检查实际 HEAD 大小（1 字节至资产域上限 1 GiB；GIF 转换另限 20 MiB）与 Content-Type，不依赖通用下载签名。不在认证表持久化签名 URL。默认资料回执保持兼容；`?view=display` 返回脱敏手机号、旧账号 `displayId` 回落和短期内联头像 URL，资产读取或签名故障仅将该 URL 降级为 `null`。新的非空头像绑定仍强核验并在媒体不可用时返回 503。GIF 首帧转换入口、边界与回执见[认证 HTTP 契约](apis/auth.md#post-apiv1meprofileavatarnormalize)。`src/auth` 不直接导入 `src/assets`；装配入口注入核验、签名和转换三个窄回调。

微信 QR polling 使用同一认证库中的 `mioWechatQR` 模型，包含不透明 ID、唯一且可空的 OAuth state 摘要、QR Cookie 摘要、带索引的状态与过期时间，以及可空的确认用户、确认时间和失败原因码。模型通过 `authOptions` 的插件 schema 进入现有显式迁移与启动检查；即使微信关闭，升级后也须先显式迁移 QR 结构才能启用认证。QR 表不保存 state、Cookie、Session secret 或供应商 token 明文；Better Auth 自身的数据库 OAuth state 仍沿用原策略，不受这条 QR 表存储规则替代。

U2 另以 `mioWechatPending` 保存未绑定微信的短期候选、浏览器 Cookie 摘要、候选令牌及期限，并给 `mioWechatQR` 增加可空候选关联，保留既有 QR 与用户／会话行。模型和约束通过显式 `auth:migrate` 预览／`--apply` 幂等增量安装；启动仅做只读结构检查，供应商关闭也不隐式跳过所需结构。SMS 预算仍复用原两表，本次不做预算数据迁移。解绑后的旧回调失效使用有期限的瞬态记录，不写永久解绑历史或阻止后续显式建号。

万联 OneLink 授权流程使用同一认证库中的 `mioOneLinkPending` 模型，记录唯一 `tokenDigest`（待处理 Cookie 的 SHA-256 摘要）、用途 `intent`（`login` / `bind`）、带索引的 `status`（`started` / `candidate_ready` / `completed` / `rejected` / `cancelled`）与 `expiresAt`、可选发起身份（`initiatorUserId` / `initiatorSessionId`）、暂存候选信息（`candidateSub` / `candidateClientId` / `candidateToken`）、受限回跳路径 `returnPath` 以及 `createdAt` / `updatedAt`。`oneLinkPlugin` 无条件注册在 `authOptions().plugins` 中，因此无论是否配置 `MIO_ONELINK_SSO_*` 环境变量，`auth:migrate` 与启动 `getMigrations` 均始终检查并保持 `mioOneLinkPending` 结构同步。该表绝不保存待处理 Cookie 原文、上游 `access_token`、`refresh_token` 或 AES 密钥。

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

### 手机验证码与发送预算

大陆手机号统一为 `+86` 和 11 位号码；随机六位验证码有效 5 分钟，最多错误 3 次。登录（`login`）、首次绑号（`bind`）、换绑（`phone_rebind`）、微信与万联绑定已有手机号账号（`wechat_existing`、`onelink_existing`）以及账号注销（`account_deletion`）按用途隔离，复用既有 `mioPhoneChallenge`。首次绑号和换绑挑战绑定发起的 `userId`、`sessionId` 与规范化手机号；换绑还核对发起时的原已验证号码。第三方绑定已有账号的挑战绑定本次待处理候选、候选令牌摘要与目标手机号。验证码只保存含用途和操作上下文的 HMAC，不同会话、候选或用途不可交叉消费。

`/phone-binding/*` 继续只负责空号账号的首次绑号。已有验证号通过 `/phone-rebind/*` 换绑：发送前拒绝当前号与已占用号，最终在短事务内重新核对账号、创建不足 10 分钟的原有效会话、原号码及新号唯一性并一次性消费挑战。成功后原 `userId`、当前设备及其他设备原本有效的 Mio 会话均保留；旧号不再登录原账号。未绑定手机的账号不能借换绑入口首次绑号。

短信验证运行时受管理后台「全局配置」`smsMode`（`live` / `bypass` / `disabled`，默认 `live`）热控制。`live` 调用腾讯短信并预约持久预算；`disabled` 拒绝所有短信发码和短信验码路径，不调用供应商。第三方 `link_existing` 的近期目标会话路径不依赖短信，可在目标无手机号或短信停用时继续使用。

`bypass` 使用管理员配置的合法 6 位固定测试码，以恒定时间比较，不调用供应商或占用持久预算，仍执行输入、身份、账号状态与路由限流检查。普通登录和首次绑号沿用各自现行测试码契约；换绑及第三方绑定已有账号必须先调用本操作的 `send-otp` 建立挑战，再核对原会话或待处理候选归属并单次消费，固定码不能绕过挑战、期限或跨操作保护。该模式仅限受控开发／测试环境，不能用作真实短信送达证据。

短信预算独立于挑战和请求限流，复用 `mioSmsBudget` 与 `mioSmsBudgetEvent`，本次不迁移预算结构。同一手机号在各用途之间共享 60 秒冷却、滚动 1 小时 5 次及 24 小时 10 次；IP 共享 20/100 次。日常登录／注册保留原全局 24 小时 1000 次额度；`phone_rebind`、`wechat_existing`、`onelink_existing` 与 `account_deletion` 使用独立 `global:account_ops` 桶，默认 24 小时 300 次，配置只允许收紧。账号操作不扣减日常登录／注册全局额度，但仍受共享手机号和 IP 限制。使用直接连接地址及相同的 IP 规范化，代理后共享代理地址额度；号码和 IP 键的 SHA-256 仅用于固定长度，不代表匿名化。正常重启、验证码消费、认证 secret 轮换及 Redis 恢复不会清除预算；数据库恢复到旧快照可能丢失近期预约，须按最长窗口排清后恢复发送。

发送前按全局、IP、手机的固定顺序取得预算键行锁，再以数据库毫秒时间检查窗口。每个预算键追加一条带毫秒时间的事件，与 pending 挑战同事务提交；只有供应商明确受理才激活匹配的挑战。失败和未知不返额度，不自动重发。若供应商已受理、数据库激活提交结果未知，客户端会收到失败，但挑战可能已生效，不能据此推断短信未发出。后续成功预约清理触达键中已过期的事件，并分批清理过期挑战和长期未更新的预算键；删除预算键会一并删除对应的过期事件。正确码由数据库锁和条件删除保证单次消费；绑定同时检查原会话并更新用户。登录的用户／会话创建在消费之后，若后续失败，该码不会恢复，用户需重新发码；不能宣称包括认证库调用的全过程原子。手机号自注册用户获得 `phone-…@auth.mio.invalid` 占位邮箱，该域不允许邮箱密码注册认领，不等于已验证联系邮箱。

#### 发送预算切换与回退

旧版把毫秒时间数组保存在 `mioSmsBudget.events`。新版用 `mioSmsBudget` 保持原预算键和行锁，`mioSmsBudgetEvent` 用预算键与时间的非唯一联合索引查询滚动窗口，同毫秒的每笔预约各占一条记录。新发送要求已完成事件迁移。停用 SMS 时，具备完整基础认证结构的旧预算库可继续邮箱和微信认证；启动只读检查，发现半迁结构时拒绝装载。运行时将键表与事件表绑定到同一预算 schema，显式迁移限定于认证迁移目标 schema；回退后仍运行的新实例会拒绝发送，即使 search_path 的后续 schema 也有事件表。

切换与回退前先备份目标认证库、暂停所有短信发送入口并排空在途发送及供应商调用，确认所选环境与数据库，再执行对应显式命令。两种预览都只读，正向预览还核对旧数组的事件格式。

```sh
pnpm auth:migrate
pnpm auth:migrate --apply
pnpm auth:migrate --rollback-sms-budget
pnpm auth:migrate --rollback-sms-budget --apply
```

本地环境对应 `pnpm migrate:dev [auth]` 或 `pnpm migrate:test [auth]`，参数按上例透传。打包环境使用随包构建的 `node dist/tools/scripts/service/migrate-auth.js`，使用同一参数与进程环境。空库先由 Better Auth 显式创建基础认证结构，再安装事件表。

- 正向在锁住原预算键表的同一个 PostgreSQL 事务内校验旧数组、复制当时滚动 24 小时内的每笔记录，再清空旧数组并加数据库约束。约束会在供应商调用之前拒绝仍运行的旧发送写入。应用启动成功后恢复新版短信发送。
- 回退锁住同一预算键表，按键与时间顺序重建当前 24 小时窗口的旧数组，包含切换后新增的预算，再移除事件表和旧写入约束。完成后恢复旧版并验证启动，再开放短信发送。仍在运行的新版会在写预算时拒绝发送。用户、会话和挑战仍使用原表。
- 任一事件迁移或回退失败会撤销本次事件布局和数据修改，可以保留暂停状态并重试。两种切换均可重复运行；旧数据格式不合法或事件表、索引、外键、写入约束不完整时显式失败，供人工核对后恢复。

### 微信登录与绑定

微信可独立登录，手机号可选。当前已绑定身份沿原归属登录；当前未绑定身份（从未绑定与已解绑一致）在回调建号前进入 `mioWechatPending` 的 `candidate_ready`，不自动创建用户或签发会话。浏览器显式选择 `create`，或以已有账号的验证号短信／同一登录流程取得的近期目标会话执行 `link_existing`，最终复核候选期限、浏览器归属、账号有效及身份唯一性后完成。微信授权只证明持有该微信身份，不证明目标 Mio 账号或邮箱所有权。占位邮箱仍为 `emailVerified=false`，不按同邮箱合并账号。

个人中心从创建不足 10 分钟的原会话调用 `link-social` 发起微信绑定，回调沿用原身份核验、用户锁和最终禁用检查。解绑只删除当前关联及微信昵称，不保留永久解绑墓碑；解绑前发起的旧回调必须失效，之后的新授权仍可显式创建新账号或绑定已有账号。身份键、供应商调用及 AppID 变更前置条件见[微信契约](integrations/wechat.md)。

匿名 QR 与普通 `sign-in/social` 共用未绑定候选及显式确认。电脑主页面保持打开，由同源内嵌微信官方 `WxLogin({ self_redirect: true })`（iframe）或同一浏览器授权窗口完成 callback；已绑定身份取得会话后轮询确认，未绑定身份轮询返回 `pending_confirm`，凭本次 QR 与候选 Cookie 归属进入确认流程，不要求先有 Mio 会话。候选 Cookie 为 `Path=/api/auth`、HttpOnly、SameSite=Lax，HTTPS 带 Secure。授权 URL 仍须由微信官方页面或 `WxLogin` 渲染，不是二维码图片 URL；不提供无同浏览器 Cookie 的跨设备凭据交接。QR 有效 5 分钟，QR Cookie 保留 15 分钟，创建时最多清理 100 条已过期至少 10 分钟的记录；清理后旧 ID 为未知。

跨站 `WxLogin` iframe 省略 Lax state Cookie 时，认证适配器保留原单跳同源 HTML 桥接和 `mio_bridge` 防循环。第二跳仍须通过签名 state Cookie、数据库单次保留和 QR 期限检查；旧登录 Cookie 不能把失败回调变成成功。`pending_confirm` 只表示存在待确认候选；`confirmed` 则要求本次流程已签发的有效会话归属正确，并在行锁内原子转为 `consumed`。poll 不创建、续期或发放会话，也不扩大 `Authentication.identity` 的通用含义。HTTP 状态和 Cookie 细节见[认证 HTTP 契约](apis/auth.md#post-apiauthwechatqr-session)。

### 万联 OneLink 登录、回调与账号归属

万联 OneLink 第三方登录默认关闭，受服务端 `.env` 配置就绪度与管理端按环境运行期热开关双重门控；未配置或热开关关闭时，`/api/auth/onelink/start`、`/api/auth/callback/onelink`、`/api/auth/onelink/pending`、`/api/auth/onelink/existing/send-otp` 与 `/api/auth/onelink/complete` 均返回 `503 ONELINK_UNAVAILABLE`，`/api/auth/onelink/cancel` 仍可用于清理遗留待处理 Cookie。发起授权时创建 10 分钟有效的 `mioOneLinkPending` 记录（创建时最多清理 100 条已过期至少 10 分钟的旧记录），并下发 `Path=/api/auth`、15 分钟 `Max-Age` 的 HttpOnly/SameSite=Lax 待处理 Cookie（HTTPS 名称 `__Secure-mio.onelink_pending` 且带 `Secure`，回环 HTTP 名称 `mio.onelink_pending`）；`intent="bind"` 额外要求当前持有创建时间不足 10 分钟、未撤销且未禁用的会话且尚未绑定万联账号。

回调 `GET /api/auth/callback/onelink` 统一附带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，按[万联 OneLink SSO 契约](integrations/onelink-sso.md)构造的 6 字段加密跳转返回后处理 `unauthorized=true` 或解析 `access_token`。**v1 安全边界声明（`payload_sub_unverified`）**：当前版本仅对 JWT payload 执行严格 Base64URL 解码与 `sub`/`exp`/`client_id`（显式拒绝 `routerClientId`）校验，不执行 JWT 密码学验签，也不向万联发起在线令牌自省，无法防御不可信公网直接伪造三段式 JWT 访问回调接口；因此仅适用于默认关闭热开关控制下的受控开发、测试与管理端验证沙箱，公网生产放量前须补充正式验签或自省能力。已绑定活跃用户的登录回调原子完成待处理记录后签发 Mio 会话并 `303` 跳转至干净结果地址；已禁用账号拒绝签发；未绑定登录与已登录绑定回调**绝不在 GET 中写入新的永久 `user` 或 `account` 记录**，而是原子暂存为 `candidate_ready` 并保留待处理 Cookie，通过 `GET /api/auth/onelink/pending` 只读返回候选元信息（`bind` 复核原近期会话）；迟到或并发回调不能覆盖已进入 `candidate_ready` 的候选记录，也不清除其待处理 Cookie。

待绑候选通过 `POST /api/auth/onelink/complete` 完成显式账号归属（客户端绝不传入目标 `userId` 或万联 `sub`）；认证域跨表行锁统一遵守 `mioPhoneChallenge` → `user` → `session` → `mioOneLinkPending` → `account` 固定顺序，且待处理过期判断始终在取得 `FOR UPDATE` 行锁后重新取库时钟核验：

- `action="create"`：在同一 PostgreSQL 事务内锁定待处理记录、分配唯一 `displayId` 并创建 `name="万联用户"`、占位邮箱 `onelink-…@auth.mio.invalid`（`emailVerified=false`）、空手机号的新用户、写入 `(providerId='onelink', accountId=sub)` 关联并标记待处理为 `completed`；若遭遇并发唯一约束冲突（`23505`），整个事务回滚不留孤儿用户并返回 `409 ONELINK_ALREADY_BOUND`。成功后签发 C 端会话 Cookie 并清理待处理 Cookie；新用户后续可经 `/api/auth/phone-binding/*` 补绑空闲手机号。
- `action="link_existing"`：仅用于 `intent="login"` 的显式确认。手机路径在 live 与 bypass 下均须先经 `POST /api/auth/onelink/existing/send-otp` 建立 `onelink_existing` 挑战，绑定 pending 与候选令牌摘要后单次消费；bypass 不调用短信或扣预算，但固定码不能跳过挑战。另一条路径使用同一登录流程取得的创建不足 10 分钟的目标会话，不依赖手机号或短信。最终短事务重新检查候选、目标账号、会话或挑战与万联身份唯一性，不自动建号；禁用、过期、已占用或重放均不能改变原归属。
- `action="bind_current"`：在非续期核验 10 分钟内有效且未禁用的当前 C 端会话后，于同一事务内依序锁定用户、原近期会话与 `intent="bind"` 待处理记录并比对发起 `userId`/`sessionId` 与 `candidateToken`；若当前用户已绑定同一 `sub` 则幂等完成待处理并返回 `alreadyBound=true`，其余冲突回滚并保留原归属返回 `409 ONELINK_ALREADY_BOUND`。成功后仅清理待处理 Cookie，不改写或重建当前 C 端会话 Cookie。

`GET /api/v1/me/profile` 与 `PATCH /api/v1/me/profile` 返回只读布尔字段 `onelinkBound`，实时反映当前用户在 `account` 表是否存在 `providerId='onelink'` 绑定记录。

### 登录方式解绑与会话

`DELETE /api/v1/me/wechat` 与 `DELETE /api/v1/me/onelink` 从当前 C 端会话取本人身份，执行精确 Origin 校验，并在同一用户锁下串行检查和移除关联。允许移除前必须还剩至少一种实际可用方法：已验证手机号且短信登录可用、可登录邮箱已设置真实密码且邮箱登录开启，或另一已绑定且当前启用的服务商。仅有手机号字段、占位邮箱、空密码或停用服务商不计入可用方式；并发解绑不能分别通过检查后清空全部方式。

成功删除登录关联，微信同时删除 `account.wechatNickname`，不撤销当前或其他设备的有效会话，不修改万联独立供应商凭据。只保存当前归属，不建立永久解绑墓碑；解绑前发起的旧授权回调失效，之后的新授权仍可正常显式创建或绑定。自然过期、已退出、已撤销和禁用账号的会话继续无效。

## 职责与限制

- [认证配置](../src/auth/config.ts)的 `readAuthConfig` 与 `authOptions` 由装配、运行时和显式迁移按职责复用；`AUTH_BASE_PATH` 是库选项、插件前缀注册和认证 HTTP 路径截取的同一权威值。`authOptions` 始终挂载邮箱/密码路由及 `oneLinkPlugin`，并分别接受只读 `AuthPolicyReader` 与 `OneLinkSsoPolicyReader` 回调，由 `src/plugin.ts` 在完成管理域数据库水合后注入内存策略快照并注册 `/api/auth` 路由，`src/auth` 不直接导入 `src/admin`。`service.ts` 持有认证库与 DB 池，`http.ts` 负责白名单、来源、动态邮箱/密码策略门控、万联回调无来源引用头与响应适配，并使用 A 内共同有界读取取得原始正文；`plugin.ts` 仅装配与释放。响应头、包装错误与读取入口见 [API 领域导航](apis/index.md#运行时公共能力)，库原始响应仍由认证适配器转发。
- [认证服务](../src/auth/service.ts)的 `Authentication.identity(headers)` 返回经数据库验证且未禁用账号的 `{userId,sessionId}` 或 `null`；`/api/v1/me`、`/api/v1/me/profile` 和[对话 HTTP](../src/conversations/http.ts)等业务适配器是实际消费者，调用时禁止刷新会话。`Authentication.profile`、`updateProfile` 与 `setUserDisabled` 分别承载当前用户资料读写及事务性账号禁启用与会话撤销。装配入口注入身份解析能力及窄头像资产核验回调，再把可信主体传给[对话应用服务](../src/conversations/service.ts)等业务服务检查资源归属；应用服务不依赖 Node HTTP、DSH 或认证驱动，也不信任请求体 userId 或服务 token。长流失效与已受理轮次的关系按[对话规范](conversations.md)执行。项目 CRUD 尚未实现。
- 首期邮箱未验证，不能凭同邮箱自动合并第三方账号，也不能用于团队邀请信任或邮件找回；微信显式绑定依靠当前会话与微信授权。邮箱验证、邮件找回、MFA、团队与生成分别按后续契约接入；未开放的入口返回 404。
- 数据库凭据与错误脱敏按 [PostgreSQL 使用契约](integrations/postgres.md#必须遵守的约束)执行；密码、cookie、会话 token 和部署秘密不写入公共日志或报告。

## 验证

`pnpm test` 包含真实 PostgreSQL 集成，数据库环境选择、隔离和清理要求统一见 [PostgreSQL 验证入口](integrations/postgres.md#验证入口与变更影响)。

`tests/auth/auth.test.ts` 经真实 DSH HTTP 覆盖注册、重复邮箱、错误密码、会话失效/撤销与续期、密码更新、跨账号隔离、重载持久化、HTTPS cookie、来源/请求体/限流、迁移幂等与结构异常、注册事务回滚/并发唯一性、启动失败和启动中卸载；还构建并装载正式打包产物验证认证。原有工具拒绝、HTTP 错误与端口释放测试保留。`tests/auth/schema-isolation.test.ts` 通过真实隔离 PostgreSQL 覆盖启动与首次运行时元数据 SQL、无关 serial schema 并发建删、多项 search_path、元数据保持、目标表／列／必需索引／额外必填列负例；缺索引检查属于启动与迁移。

测试不等于邮箱所有权、真实浏览器、生产容量或项目业务验收。指定候选的原接受结果见 [所属 PRD 成果入口](tasks/ai-drama-foundation/complete/report.md#auth-registration-foundation)，验证摘要与限制可经[成果读取入口](work-records.md#核对与同步)展开。公共成果不保存详细原件或可恢复代码；资料整理没有重验历史认证专项，也不宣告后续项目或生成能力完成。复用取舍和读取器尚缺的直接验证见[设计](tasks/ai-drama-foundation/design.md#auth-http-reuse)，当前验证方法沿 [验收入口](acceptance.md) 查询。

实现依据：[固定版本数据库与迁移](https://github.com/better-auth/better-auth/blob/v1.7.18/docs/content/docs/concepts/database.mdx)、[邮箱密码认证](https://github.com/better-auth/better-auth/blob/v1.7.18/docs/content/docs/authentication/email-password.mdx)，以及本地安装包公开类型/实现；上游说明不替代本项目真实入口验证。
