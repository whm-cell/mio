# 认证 HTTP 契约

[API 领域导航](index.md)；配置、迁移、模块职责和测试入口见[认证底座](../auth.md)。沿 Better Auth 1.7.18 的现有行为，不把它与 Foundation 错误格式或服务凭据合并。

## 本域共同约定

只开放下列认证路由，其他库插件、邮箱修改、邮件找回、账号删除及未列出的 OAuth 入口不隐式开放。所有 POST 必须携带允许的 Origin 和 JSON，正文最多 16 KiB、读取超时 10 秒。浏览器请求使用 `credentials: 'include'`。

OPTIONS 预检同样必须携带允许的 Origin，只允许目标入口的方法和 Content-Type 请求头，并允许 Cookie 凭据；204 无正文且不设置 JSON Content-Type。它与 Foundation 的 GET/Authorization、无 Cookie 预检不是同一套协议。无效 Origin 先于路由、方法和凭据处理而拒绝；缺少 Origin 时，未知路由仍先返回 404，已知 POST 与预检才返回 403。

cookie 使用 HttpOnly、SameSite=Lax，HTTPS 配置带 Secure，不设置跨域 cookie domain。固定 BASE_URL，不信任 Host/转发头决定 URL。前端与服务应同站点或同源反向代理部署；Origin 白名单不会让不同站点的浏览器发送 Lax cookie。本仓库不提供登录页面；浏览器与真实供应商的验收按具体候选单独记录。

会话默认 7 天、1 天后可刷新；禁用 cookie 会话缓存，身份与撤销查询以 DB 为准。`/api/v1/me` 只校验身份，不刷新会话；客户端经 `/api/auth/get-session` 同时续期 DB 与 cookie。数据库池和路由随插件生命周期初始化/释放；重载且 secret/数据库不变时会话继续有效。

认证库响应沿固定版本契约，错误通常为 `{code,message}`，限流等保留库的状态、原始正文与响应头；多个 Set-Cookie 分别转发，库的 cache-control 不覆盖本服务禁缓存策略。适配器默认设置服务端生成的 `X-Request-Id`、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`；成功读取完整库响应后才复制上游响应头，除 cache-control 和 Set-Cookie 外，上游同名头优先，因此上游提供的 `X-Request-Id` 或 `X-Content-Type-Options` 可覆盖默认值。适配器的 Origin、方法、正文或基础设施错误采用 `{error:{code,message,requestId}}` 与 `Content-Type: application/json`；包装错误保留本地追踪头及 `nosniff`，其 requestId 与响应头一致。消费者按入口与 HTTP 状态处理，不能假定与 Foundation 错误体完全相同。共同实现入口见[运行时公共能力](index.md#运行时公共能力)。

限流采用直接连接地址，覆盖客户端传来的 IP 头；库按规范化 IP 和路径计数，查询参数不另开额度。当前完整规则如下，均在 `/api/auth` 下：

| 路径                                                                                                           | 窗口/额度            |
| -------------------------------------------------------------------------------------------------------------- | -------------------- |
| `/sign-in/email`                                                                                               | 60 秒 / 10 次        |
| `/sign-up/email`                                                                                               | 60 秒 / 5 次         |
| `/phone-number/send-otp`、`/phone-binding/send-otp`                                                            | 各自 60 秒 / 100 次  |
| `/phone-number/verify`、`/phone-binding/confirm`                                                               | 各自 60 秒 / 10 次   |
| `/sign-in/social`、`/link-social`                                                                              | 各自 60 秒 / 10 次   |
| `/wechat/qr-session`                                                                                           | 60 秒 / 20 次        |
| `/wechat/qr-session/{qrcode_id}/poll`                                                                          | 各 ID 60 秒 / 300 次 |
| `/callback/wechat`                                                                                             | 60 秒 / 100 次       |
| `/change-password`                                                                                             | 10 秒 / 3 次         |
| `/sign-out`、`/get-session`、`/list-sessions`、`/revoke-session`、`/revoke-sessions`、`/revoke-other-sessions` | 各自 60 秒 / 100 次  |

错误凭据也占一次放行额度；适配器提前拒绝的 Origin、路径、方法、正文错误、OPTIONS 以及 `/callback/wechat` 的单跳 iframe 桥接响应不消费。窗口从最近放行计算，放行更新该时间，拒绝不更新；额度耗尽保留库 429 原始消息与 `X-Retry-After`（向上取整的剩余秒数）。代理后的客户端共享代理地址限额，正式部署需要在可信边缘配置限流；当前未验证任意代理链或多实例容量。库自身 CSRF 和适配器 Origin 检查均保留。

计数默认在 DB，显式 Redis 选择与恢复按[认证配置](../auth.md#限流存储与恢复)，资源边界见[Redis 契约](../integrations/redis.md)。Redis 失败返回包装 `503 AUTH_UNAVAILABLE`，不是超额 429；没有静默 DB 回退。未知状态后受限入口持续 503，直至操作者排清、等待并重启；已装载且 DB 正常时 `/api/v1/me` 仍查询 DB。PG 账号/会话、cookie 和原迁移模型不因 Redis 计数改变；整进程维护期间入口可能不可达。

QR 创建按直接连接 IP 共享额度，不额外消费内部复用的普通 `/sign-in/social` 额度。QR poll 按该 IP 与具体 ID 路径分别计数；查询参数不产生新额度。客户端建议每秒轮询一次，并在过期或终态后停止。其他限流、Origin 拒绝顺序和基础设施错误仍沿本域共同约定。

## POST /api/auth/wechat/qr-session

身份：允许匿名发起微信网站注册或登录；本入口不绑定当前用户的微信。

输入：JSON 对象，可选 `callbackURL`，不接受其他字段。该值仅接受以单个 `/` 开始且位于固定 `MIO_AUTH_BASE_URL` 下的相对路径，拒绝反斜线和控制字符。仅省略时使用 `/auth/wechat/qr-complete`，显式 `null` 返回 400 `INVALID_INPUT`。Origin、正文类型、16 KiB 与读取期限沿共同约定。

成功：201 和 `{qrcode_id,authorization_url,expire_seconds:300}`。QR ID 为不透明 UUID v4；同时转发 Better Auth 的 OAuth state Cookie 并设置 `mio.wechat_qr` Cookie（HTTPS 名称带 `__Secure-` 前缀）。QR Cookie 为 HttpOnly、SameSite=Lax，HTTPS 带 Secure，路径精确到本 ID 的 poll 入口，Max-Age 为 900 秒；QR 本身仍只在 300 秒内有效，较长 Cookie 只用于观察过期。响应保持 `Cache-Control: no-store`。

`authorization_url` 必须由微信官方授权页面或同源页面内嵌的微信官方 `WxLogin({ self_redirect: true })` 自定义容器（iframe）承载，不是可直接作为二维码图片加载的地址；不提供无同浏览器 Session Cookie 的跨设备凭据交接。同源内嵌容器（须满足 `SAMEORIGIN` / `frame-ancestors 'self'`）或同一浏览器的授权窗口在 callback 处设置 Session Cookie；主页面须与服务满足共同的同站点／同源 Cookie 部署条件。返回 URL 不表示已经授权或登录，本仓库不实现完成页。

错误：无效输入为 400 `INVALID_INPUT`，未启用微信为 503 `WECHAT_UNAVAILABLE`，数据库或授权地址创建失败为脱敏 503 `AUTH_UNAVAILABLE`；来源、方法、正文和 429 沿共同约定。

副作用：先建立 QR 持久状态，再复用 Better Auth 生成授权 URL 并关联 OAuth state 摘要；QR 表只存独立 Cookie 和 state 的摘要，不存 Session secret。创建时最多清理 100 条已过期至少 10 分钟的记录。创建中途失败不等于已经取得登录身份，失败遗留的短期记录由同一有界清理收敛。

## GET /api/auth/wechat/qr-session/{qrcode_id}/poll

身份：本 ID 对应的 QR state Cookie；返回 confirmed 还要求有效的 Mio Session Cookie，且数据库确认的用户与 QR 会话确认用户一致。服务 token 不能替代任一 Cookie。

输入：路径 ID 为 UUID v4，无正文。Origin 可省略；提供时必须在允许列表内。除精确 QR poll 路径外，不开放其他动态认证路径或隐式 Better Auth 插件入口。

成功：200 和以下一个状态；不返回用户资料、Session token 或供应商凭据。

| status    | 含义                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| pending   | 尚未由本次微信 callback 完成授权。                                                                                     |
| confirmed | 本次 callback 已产生 Session，当前浏览器 Session 有效且属于该确认用户；这一响应同时在数据库行锁内将记录转为 consumed。 |
| failed    | 对应 callback 授权失败；不返回供应商原始错误或内部失败原因码。                                                         |
| expired   | 已超过 5 分钟；即使此前 confirmed、failed 或 consumed，过期检查也优先返回此状态。                                      |
| consumed  | 有效期内的成功结果已经被首次 confirmed 轮询消费，不能再次取得确认结果。                                                |

不提供无法可靠观察的 scanned。并发轮询至多一个返回 confirmed；其他请求读取 consumed。若记录已被后续创建清理，则返回未知 ID 的 404，不承诺永久保留 expired 状态。

错误：未知或无效 ID 为 404 `NOT_FOUND`，此判断不要求 Cookie；已知 ID 缺少或错配 QR Cookie 为 400 `STATE_MISMATCH`。confirmed 状态下 Session 缺失、过期、撤销或用户不符为 401 `UNAUTHORIZED`，且不消费记录。微信关闭为 503 `WECHAT_UNAVAILABLE`，数据库或会话查询失败为脱敏 503 `AUTH_UNAVAILABLE`；来源、方法和限流沿共同约定。

副作用：读取并按有效期更新 QR 状态；首次合格确认在同一事务中消费成功结果。poll 不新建、不续期也不发放 Session Cookie；前端在 confirmed 后调用现有 `/api/v1/me` 取得同一可信身份。响应始终禁缓存。

## POST /api/auth/sign-in/social

身份：允许匿名发起微信网站登录。

输入：`provider` 必须为 `wechat`；可选 `callbackURL` 只接受以单个 `/` 开始的本站路径。仅省略时使用 `/`，显式 `null` 在建立 OAuth state 前返回 400 `INVALID_INPUT`。不接受 `idToken`、其他 provider、额外授权参数或未声明字段。

成功：返回库的 `{url,redirect:false}` 并设置短期 state Cookie；前端在同一浏览器中打开 `url`，完成授权后返回指定本站路径。返回的授权地址并不代表已经登录。

错误：输入无效为 400，未启用为 503；来源、限流和数据库错误沿共同约定。

副作用：建立短期授权 state；首次通过微信授权可注册用户，不按相同邮箱自动合并已有账号。客户端不传微信主体或持久化 provider token。

## POST /api/auth/link-social

身份：当前有效且创建不足 10 分钟的会话；当前用户尚未绑定微信。

输入：与微信登录发起相同。回调必须仍携带相同会话与 state Cookie；新的微信授权仅绑定发起人。

成功：返回授权地址并设置短期 state Cookie，响应格式与微信登录发起相同。

错误：无近期会话、已绑定微信或输入无效为 400，未启用为 503；微信已属于另一用户时回调返回错误，不转移或合并账号。

副作用：建立绑定用途的授权 state，不在此步骤直接写入微信主体。

## GET /api/auth/callback/wechat

身份：微信授权返回的 code、state 和发起浏览器的 state Cookie；绑定在回调执行权威会话核验时，还要求发起会话有效且当前浏览器使用同一 userId 和 sessionId。核验已通过的在途绑定不会因并发退出或撤销自动取消，可能在撤销成功后完成；后续请求仍受撤销约束。

输入：库处理的 `code`、`state` 或微信授权错误；只开放 GET，不要求普通 POST 的 Origin，但如提供 Origin 仍必须获准。同源 iframe 桥接第二跳可附带内部参数 `mio_bridge`，适配器在转交认证库前将其移除。

成功：库校验后为微信登录签发持久会话 Cookie，或将新微信绑定当前 userId；响应重定向到发起时批准的本站路径。当请求携带 `Sec-Fetch-Dest: iframe`、未携带 `mio_bridge`、缺少对应协议的 state Cookie（HTTPS 为 `__Secure-mio.state`，回环 HTTP 为 `mio.state`）且 `state` 为非空且不超过 512 字符的字符串时，适配器在完成 Origin、方法与微信启用检查后不进入认证库，直接返回 200 `text/html; charset=utf-8` 固定同源桥接页（无动态插值，内联脚本仅为当前 URL 添加 `mio_bridge=1` 并执行 `location.replace`），保留 `X-Request-Id`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，并设置 `X-Frame-Options: SAMEORIGIN`、`Content-Security-Policy: default-src 'none'; script-src 'sha256-…'; frame-ancestors 'self'` 与 `Referrer-Policy: no-referrer`；浏览器在同源 iframe 内发起第二跳并附带 state Cookie 后，适配器移除 `mio_bridge` 并交由认证库完成校验与 302 重定向。

错误：缺少或错误 state Cookie、重复 state 为 400；已携带 `mio_bridge` 的第二跳若仍缺少或错配 state Cookie，直接交由认证库返回 400 `STATE_MISMATCH` 且不再返回桥接页（零循环）。非 iframe 请求、缺少或超长 `state` 不触发桥接；微信未启用时即使携带 `Sec-Fetch-Dest: iframe` 仍返回 503 `WECHAT_UNAVAILABLE`。库拒绝过期 state、供应商失败、被占用微信或失效绑定会话时按库错误重定向或返回失败。回调过程中如遇依赖故障，不得将失败推断为登录成功。

副作用：第一跳 iframe 桥接不调用认证库，不消费 `/callback/wechat` 限流额度，也不触碰数据库或微信接口。进入微信兑换前原子保留 state；之后即使失败也需重新发起。微信出站、账号主体、token 加密和 AppID 生命周期见[微信契约](../integrations/wechat.md)。

当 state 对应 QR 会话时，在原签名 Cookie 和单次保留检查后关联 QR；过期 QR 在供应商兑换前以 400 拒绝。只有本次 callback 的新 Session 用户能将 pending QR 标记为 confirmed，已有登录 Cookie 不会让失败回调变成成功；其余已进入的失败回调把对应 pending QR 标记为 failed。重复／并发 callback 不替换已经确认或消费的结果。QR 用户拒绝参数脱敏为 `WECHAT_AUTH_FAILED` 后回到批准的完成路径，普通 OAuth 重定向行为保持原契约。缺失或错误发起 Cookie 的请求在关联 QR 前拒绝，不将该 QR 标记失败。

## POST /api/auth/phone-number/send-otp

身份：允许匿名请求登录或自助注册验证码。

输入：`phoneNumber`，接受 11 位大陆号码或其 `+86` 格式；未声明字段拒绝。

成功：200 和 `{status:true}` 表示供应商已受理，不证明送达。

错误：输入无效为 400，短信预算耗尽为 429，未启用或供应商拒绝／结果未知为 503；预算 429 不承诺返回重试秒数。

副作用：先占用持久短信预算并建立短期挑战，再调用[腾讯短信](../integrations/tencent-sms.md)；失败和未知不返预算、不自动重发。

## POST /api/auth/phone-number/verify

身份：持有此号码的登录用途验证码。

输入：`phoneNumber,code`；验证码为 6 位字符串，未声明字段拒绝。

成功：返回 `{status:true}` 并设置会话 Cookie，已有号码登录其所属用户，新号码自助注册。

错误：输入、验证码或用途无效为 400，短信未启用为 503。

副作用：原子消费验证码，再创建或查询用户并创建库会话；后续失败不恢复该码，需重新请求。

## POST /api/auth/phone-binding/send-otp

身份：创建时间不超过 10 分钟且未撤销的当前会话。

输入：`phoneNumber`；格式与登录发码相同。

成功：200 和 `{status:true}` 表示供应商已受理，不证明送达。

错误：输入无效为 400，无近期会话为 401，预算耗尽为 429，未启用或供应商拒绝／结果未知为 503。

副作用：占用短信预算并发送绑定用途验证码，绑定原用户、会话和号码；失败和未知不返预算、不自动重发。

## POST /api/auth/phone-binding/confirm

身份：与发码相同且仍有效的近期会话，以及该号码的绑定用途验证码。

输入：`phoneNumber,code`；格式与登录验证相同。

成功：返回 `{status:true}`，在当前用户首次绑定空闲号码，userId 不变。

错误：输入、验证码、用途或发起会话不符为 400，无近期会话为 401，号码已占用或当前用户已有号码为 409，短信未启用为 503。

副作用：消费验证码并在事务中检查原会话、更新当前用户；不转移或合并账号。持久预算及恢复边界见[认证底座](../auth.md#手机验证码与发送预算)。

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
