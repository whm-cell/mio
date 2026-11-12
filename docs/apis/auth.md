# 认证 HTTP 契约

[API 领域导航](index.md)；配置、迁移、模块职责和测试入口见[认证底座](../auth.md)。沿 Better Auth 1.7.18 的现有行为，不把它与 Foundation 错误格式或服务凭据合并。

## 本域共同约定

只开放下列认证路由，其他库插件、邮箱修改、邮件找回、账号删除及 OAuth 入口不隐式开放。所有 POST 必须携带允许的 Origin 和 JSON，正文最多 16 KiB、读取超时 10 秒。浏览器请求使用 `credentials: 'include'`。

OPTIONS 预检同样必须携带允许的 Origin，只允许目标入口的方法和 Content-Type 请求头，并允许 Cookie 凭据；204 无正文且不设置 JSON Content-Type。它与 Foundation 的 GET/Authorization、无 Cookie 预检不是同一套协议。无效 Origin 先于路由、方法和凭据处理而拒绝；缺少 Origin 时，未知路由仍先返回 404，已知 POST 与预检才返回 403。

cookie 使用 HttpOnly、SameSite=Lax，HTTPS 配置带 Secure，不设置跨域 cookie domain。固定 BASE_URL，不信任 Host/转发头决定 URL。前端与服务应同站点或同源反向代理部署；Origin 白名单不会让不同站点的浏览器发送 Lax cookie。当前没有浏览器页面或浏览器验收。

会话默认 7 天、1 天后可刷新；禁用 cookie 会话缓存，身份与撤销查询以 DB 为准。`/api/v1/me` 只校验身份，不刷新会话；客户端经 `/api/auth/get-session` 同时续期 DB 与 cookie。数据库池和路由随插件生命周期初始化/释放；重载且 secret/数据库不变时会话继续有效。

认证库响应沿固定版本契约，错误通常为 `{code,message}`，限流等保留库的状态、原始正文与响应头；多个 Set-Cookie 分别转发，库的 cache-control 不覆盖本服务禁缓存策略。适配器默认设置服务端生成的 `X-Request-Id`、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`；成功读取完整库响应后才复制上游响应头，除 cache-control 和 Set-Cookie 外，上游同名头优先，因此上游提供的 `X-Request-Id` 或 `X-Content-Type-Options` 可覆盖默认值。适配器的 Origin、方法、正文或基础设施错误采用 `{error:{code,message,requestId}}` 与 `Content-Type: application/json`；包装错误保留本地追踪头及 `nosniff`，其 requestId 与响应头一致。消费者按入口与 HTTP 状态处理，不能假定与 Foundation 错误体完全相同。共同实现入口见[运行时公共能力](index.md#运行时公共能力)。

限流采用直接连接地址，覆盖客户端传来的 IP 头；库按规范化 IP 和路径计数，查询参数不另开额度。当前完整规则如下，均在 `/api/auth` 下：

| 路径                                                                                                           | 窗口/额度           |
| -------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/sign-in/email`                                                                                               | 60 秒 / 10 次       |
| `/sign-up/email`                                                                                               | 60 秒 / 5 次        |
| `/change-password`                                                                                             | 10 秒 / 3 次        |
| `/sign-out`、`/get-session`、`/list-sessions`、`/revoke-session`、`/revoke-sessions`、`/revoke-other-sessions` | 各自 60 秒 / 100 次 |

错误凭据也占一次放行额度；适配器提前拒绝的 Origin、路径、方法、正文错误和 OPTIONS 不消费。窗口从最近放行计算，放行更新该时间，拒绝不更新；额度耗尽保留库 429 原始消息与 `X-Retry-After`（向上取整的剩余秒数）。代理后的客户端共享代理地址限额，正式部署需要在可信边缘配置限流；当前未验证任意代理链或多实例容量。库自身 CSRF 和适配器 Origin 检查均保留。

计数默认在 DB，显式 Redis 选择与恢复按[认证配置](../auth.md#限流存储与恢复)，资源边界见[Redis 契约](../integrations/redis.md)。Redis 失败返回包装 `503 AUTH_UNAVAILABLE`，不是超额 429；没有静默 DB 回退。未知状态后受限入口持续 503，直至操作者排清、等待并重启；已装载且 DB 正常时 `/api/v1/me` 仍查询 DB。PG 账号/会话、cookie 和原迁移模型不因 Redis 计数改变；整进程维护期间入口可能不可达。

## POST /api/auth/sign-up/email

身份：允许匿名自助注册。

输入：`name,email,password`；邮箱归一化，密码 12–128 字符。

成功：成功建立账号和会话，`emailVerified=false`。

错误：重复邮箱或无效输入按固定库响应失败；客户端不能自授验证状态。

副作用：创建持久账号及会话，签发 cookie；首期不验证邮箱。

## POST /api/auth/sign-in/email

身份：邮箱/密码登录。

输入：`email,password`。

成功：成功签发会话 cookie。

错误：错误凭据返回 401；其他错误按本域共同约定。

副作用：建立持久会话与 cookie。

## GET /api/auth/get-session

身份：会话 Cookie。

输入：无正文。

成功：返回会话和用户，无有效会话时返回 `null`。

错误：按本域共同约定，不能把无会话的 null 当作 /me 的 401。

副作用：按刷新条件续期数据库会话及 cookie；客户端通过本入口刷新 cookie。

## POST /api/auth/sign-out

身份：会话 Cookie。

输入：`{}`。

成功：成功退出，沿固定库响应。

错误：按本域共同约定。

副作用：撤销当前会话并清除 cookie。

## POST /api/auth/change-password

身份：会话 Cookie 与旧密码校验。

输入：`currentPassword,newPassword,revokeOtherSessions`。

成功：验证旧密码后修改密码，沿固定库响应。

错误：旧密码或输入不合法按库响应失败；其他错误见共同约定。

副作用：修改密码；最后一项为 true 时撤销其他会话。

## GET /api/auth/list-sessions

身份：会话 Cookie，仅当前用户。

输入：无正文。

成功：只列当前用户会话。

错误：按本域共同约定。

副作用：读取会话列表。

## POST /api/auth/revoke-session

身份：会话 Cookie，仅可撤销当前用户目标。

输入：`token`。

成功：返回 `{status:true}`；不存在或其他用户的目标也返回此结果，不代表已删除目标。

错误：按本域共同约定。

副作用：仅撤销当前用户拥有的目标会话，不泄露他人目标是否存在。

## POST /api/auth/revoke-other-sessions

身份：会话 Cookie。

输入：`{}`。

成功：成功沿固定库响应。

错误：按本域共同约定。

副作用：撤销当前用户其他会话。

## POST /api/auth/revoke-sessions

身份：会话 Cookie。

输入：`{}`。

成功：成功沿固定库响应。

错误：按本域共同约定。

副作用：撤销当前用户全部会话。

## GET /api/v1/me

身份：Cookie 经数据库校验后的可信身份；服务 token 不能替代。

输入：无正文。

成功：返回 `{userId,sessionId}`。

错误：无效、过期、撤销或仅有服务 token 时返回 401；其他错误见共同约定。

副作用：只校验身份，不刷新会话或 cookie，也不授予项目/资产访问权。
