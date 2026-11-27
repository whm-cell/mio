# 认证 HTTP 契约

[API 领域导航](index.md)；配置、迁移、模块职责和测试入口见[认证底座](../auth.md)。沿 Better Auth 1.7.18 的现有行为，不把它与 Foundation 错误格式或服务凭据合并。

个人空间计量与提醒使用同一已验证 Cookie 身份，接口见[存储用量与提醒](assets.md#get-apiv1mestorage-usage)。认证域不依赖资产或管理模块；头像持有同步通过装配层回调完成，失败保留既有头像降级行为并由后台对账恢复。

## 本域共同约定

只开放下列认证路由，其他库插件、邮箱修改、邮件找回、账号删除及未列出的 OAuth 入口不隐式开放。所有 POST、PATCH 与 DELETE 必须携带允许的 Origin；POST 与 PATCH 另须为 JSON，正文最多 16 KiB、读取超时 10 秒。本文列出的 DELETE 不需要正文。浏览器请求使用 `credentials: 'include'`。

OPTIONS 预检同样必须携带允许的 Origin，只允许目标入口的方法和相应请求头，并允许 Cookie 凭据；204 无正文且不设置 JSON Content-Type。它与 Foundation 的 GET/Authorization、无 Cookie 预检不是同一套协议。无效 Origin 先于路由、方法和凭据处理而拒绝；缺少 Origin 时，未知路由仍先返回 404，已知 POST／PATCH／DELETE 与预检才返回 403。

邮箱/密码登录开关与短信验证模式由运行时认证策略控制：未启用管理后台或尚未写入全局配置时回落到启动环境默认（`MIO_AUTH_EMAIL_PASSWORD_ENABLED`，默认 `true`；短信模式默认为 `live`）；启用管理后台后可通过[全局配置](admin.md#patch-apiv1adminsettingsglobal)在线热更新，无需重启服务（不新增 `GET /api/auth/methods` 或其他 C 端公开探测接口）。当运行时策略 `emailPasswordEnabled=false` 时，`/api/auth/sign-up/email`、`/api/auth/sign-in/email` 与 `/api/auth/change-password` 在完成来源、方法与 JSON 校验后直接返回 `503 EMAIL_PASSWORD_UNAVAILABLE`（不消费限流额度），不影响短信验证码、微信扫码及既有有效会话的查询与退出。万联 OneLink 登录同步受服务端 `.env` 就绪度与管理端[万联 SSO 运行期热开关](admin.md#patch-apiv1adminonelinksso)（默认关闭）双重门控；未配置或热开关关闭时，`/api/auth/onelink/start`、`/api/auth/callback/onelink`、`/api/auth/onelink/pending`、`/api/auth/onelink/existing/send-otp` 与 `/api/auth/onelink/complete` 返回 `503 ONELINK_UNAVAILABLE`，`/api/auth/onelink/cancel` 仍可用于清理遗留待处理 Cookie。被禁用账号在全部登录入口均被拒绝签发会话，已有或遗留会话在 `/api/v1/me`、`/api/v1/me/profile`、`/api/auth/get-session` 及受会话保护的认证接口上均按无效处理。

cookie 使用 HttpOnly、SameSite=Lax，HTTPS 配置带 Secure，不设置跨域 cookie domain。固定 BASE_URL，不信任 Host/转发头决定 URL。前端与服务应同站点或同源反向代理部署；Origin 白名单不会让不同站点的浏览器发送 Lax cookie。本仓库不提供登录页面；浏览器与真实供应商的验收按具体候选单独记录。

会话默认 7 天、1 天后可刷新；禁用 cookie 会话缓存，身份与撤销查询以 DB 为准。`/api/v1/me` 只校验身份，不刷新会话；客户端经 `/api/auth/get-session` 同时续期 DB 与 cookie。数据库池和路由随插件生命周期初始化/释放；重载且 secret/数据库不变时会话继续有效。

微信与万联在账号归属事务完成后创建登录会话，在下发 Cookie 前再次核对账号有效、原外部身份仍归属该用户及本次授权未被解绑失效。若此时检查失败，只删除本次刚创建的会话并拒绝登录，保留其他原有效会话；账号归属提交与 Cookie 签发不宣称为一个原子事务。检查通过后的正常解绑仍按保留有效会话的规则处理。

认证库响应沿固定版本契约，错误通常为 `{code,message}`，限流等保留库的状态、原始正文与响应头；多个 Set-Cookie 分别转发，库的 cache-control 不覆盖本服务禁缓存策略。适配器默认设置服务端生成的 `X-Request-Id`、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`；成功读取完整库响应后才复制上游响应头，除 cache-control 和 Set-Cookie 外，上游同名头优先，因此上游提供的 `X-Request-Id` 或 `X-Content-Type-Options` 可覆盖默认值。适配器的 Origin、方法、正文或基础设施错误采用 `{error:{code,message,requestId}}` 与 `Content-Type: application/json`；包装错误保留本地追踪头及 `nosniff`，其 requestId 与响应头一致。消费者按入口与 HTTP 状态处理，不能假定与 Foundation 错误体完全相同。共同实现入口见[运行时公共能力](index.md#运行时公共能力)。

限流采用直接连接地址，覆盖客户端传来的 IP 头；库按规范化 IP 和路径计数，查询参数不另开额度。当前完整规则如下，均在 `/api/auth` 下：

| 路径                                                                                                           | 窗口/额度            |
| -------------------------------------------------------------------------------------------------------------- | -------------------- |
| `/sign-in/email`                                                                                               | 60 秒 / 10 次        |
| `/sign-up/email`                                                                                               | 60 秒 / 5 次         |
| `/phone-number/send-otp`、`/phone-binding/send-otp`                                                            | 各自 60 秒 / 100 次  |
| `/phone-rebind/send-otp`                                                                                       | 60 秒 / 100 次       |
| `/phone-rebind/confirm`                                                                                        | 60 秒 / 10 次        |
| `/phone-number/verify`、`/phone-binding/confirm`                                                               | 各自 60 秒 / 10 次   |
| `/sign-in/social`、`/link-social`                                                                              | 各自 60 秒 / 10 次   |
| `/wechat/qr-session`                                                                                           | 60 秒 / 20 次        |
| `/wechat/qr-session/{qrcode_id}/poll`                                                                          | 各 ID 60 秒 / 300 次 |
| `/callback/wechat`                                                                                             | 60 秒 / 100 次       |
| `/wechat/pending`                                                                                              | 60 秒 / 60 次        |
| `/wechat/pending/send-otp`                                                                                     | 60 秒 / 100 次       |
| `/wechat/pending/confirm`                                                                                      | 60 秒 / 10 次        |
| `/onelink/start`                                                                                               | 60 秒 / 20 次        |
| `/onelink/pending`                                                                                             | 60 秒 / 60 次        |
| `/onelink/cancel`                                                                                              | 60 秒 / 30 次        |
| `/onelink/existing/send-otp`                                                                                   | 60 秒 / 100 次       |
| `/onelink/complete`                                                                                            | 60 秒 / 10 次        |
| `/callback/onelink`                                                                                            | 60 秒 / 100 次       |
| `/change-password`                                                                                             | 10 秒 / 3 次         |
| `/sign-out`、`/get-session`、`/list-sessions`、`/revoke-session`、`/revoke-sessions`、`/revoke-other-sessions` | 各自 60 秒 / 100 次  |

错误凭据也占一次放行额度；适配器提前拒绝的 Origin、路径、方法、正文错误、OPTIONS 以及 `/callback/wechat` 的单跳 iframe 桥接响应不消费。窗口从最近放行计算，放行更新该时间，拒绝不更新；额度耗尽保留库 429 原始消息与 `X-Retry-After`（向上取整的剩余秒数）。代理后的客户端共享代理地址限额，正式部署需要在可信边缘配置限流；当前未验证任意代理链或多实例容量。库自身 CSRF 和适配器 Origin 检查均保留。

计数默认在 DB，显式 Redis 选择与恢复按[认证配置](../auth.md#限流存储与恢复)，资源边界见[Redis 契约](../integrations/redis.md)。Redis 失败返回包装 `503 AUTH_UNAVAILABLE`，不是超额 429；没有静默 DB 回退。未知状态后受限入口持续 503，直至操作者排清、等待并重启；已装载且 DB 正常时 `/api/v1/me` 仍查询 DB。PG 账号/会话、cookie 和原迁移模型不因 Redis 计数改变；整进程维护期间入口可能不可达。

QR 创建按直接连接 IP 共享额度，不额外消费内部复用的普通 `/sign-in/social` 额度。QR poll 按该 IP 与具体 ID 路径分别计数；查询参数不产生新额度。客户端建议每秒轮询一次，并在过期或终态后停止。其他限流、Origin 拒绝顺序和基础设施错误仍沿本域共同约定。

## POST /api/auth/wechat/qr-session

身份：允许匿名发起微信网站注册或登录；本入口不绑定当前用户的微信。

输入：JSON 对象，可选 `callbackURL`，不接受其他字段。该值仅接受以单个 `/` 开始且位于固定 `MIO_AUTH_BASE_URL` 下的相对路径，拒绝反斜线和控制字符。仅省略时使用 `/auth/wechat/qr-complete`，显式 `null` 返回 400 `INVALID_INPUT`。Origin、正文类型、16 KiB 与读取期限沿共同约定。

成功：201 和 `{qrcode_id,authorization_url,expire_seconds:300}`。QR ID 为不透明 UUID v4；同时转发 Better Auth 的 OAuth state Cookie 并设置 `mio.wechat_qr` Cookie（HTTPS 名称带 `__Secure-` 前缀）。QR Cookie 为 HttpOnly、SameSite=Lax，HTTPS 带 Secure，路径精确到本 ID 的 poll 入口，Max-Age 为 900 秒；QR 本身仍只在 300 秒内有效，较长 Cookie 只用于观察过期。响应保持 `Cache-Control: no-store`。

`authorization_url` 必须由微信官方授权页面或同源页面内嵌的微信官方 `WxLogin({ self_redirect: true })` 自定义容器（iframe）承载，不是可直接作为二维码图片加载的地址；不提供无同浏览器 Session Cookie 的跨设备凭据交接。同源内嵌容器（须满足 `SAMEORIGIN` / `frame-ancestors 'self'`）或同一浏览器的授权窗口在 callback 处设置会话或待处理候选 Cookie；主页面须与服务满足共同的同站点／同源 Cookie 部署条件。返回 URL 不表示已经授权或登录，本仓库不实现完成页。

错误：无效输入为 400 `INVALID_INPUT`，未启用微信为 503 `WECHAT_UNAVAILABLE`，数据库或授权地址创建失败为脱敏 503 `AUTH_UNAVAILABLE`；来源、方法、正文和 429 沿共同约定。

副作用：先建立 QR 持久状态，再复用 Better Auth 生成授权 URL 并关联 OAuth state 摘要；QR 表只存独立 Cookie 和 state 的摘要，不存 Session secret。创建时最多清理 100 条已过期至少 10 分钟的记录。创建中途失败不等于已经取得登录身份，失败遗留的短期记录由同一有界清理收敛。

## GET /api/auth/wechat/qr-session/{qrcode_id}/poll

身份：本 ID 对应的 QR state Cookie。`pending_confirm` 另须持有与本次 QR 关联的有效微信待处理 Cookie，不要求 Mio 用户会话；`confirmed` 另要求有效的 Mio Session Cookie，且数据库确认用户与 QR 确认用户一致。服务 token 不能替代这些 Cookie。

输入：路径 ID 为 UUID v4，无正文。Origin 可省略；提供时必须在允许列表内。除精确 QR poll 路径外，不开放其他动态认证路径或隐式 Better Auth 插件入口。

成功：200 和以下一个状态；不返回用户资料、Session token 或供应商凭据。

| status          | 含义                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| pending         | 尚未由本次微信 callback 完成授权。                                                                                         |
| pending_confirm | 已完成微信授权但身份当前未绑定；本浏览器持有匹配候选，可进入显式账号确认，尚未创建用户或会话。                             |
| confirmed       | 本次 callback 已产生 Session，当前浏览器 Session 有效且属于该确认用户；服务端锁定该 QR 记录并重验期限后原子转为 consumed。 |
| failed          | 对应 callback 授权失败；不返回供应商原始错误或内部失败原因码。                                                             |
| expired         | 已超过 5 分钟；即使此前 confirmed、failed 或 consumed，过期检查也优先返回此状态。                                          |
| consumed        | 有效期内的成功结果已经被首次 confirmed 轮询消费，不能再次取得确认结果。                                                    |

`pending_confirm` 表示本次授权命中当前未绑定微信，浏览器须通过 `GET /api/auth/wechat/pending` 取得候选并显式选择绑定已有账号或创建新账号；此状态不证明已登录，不消费候选，也不生成用户或会话。普通 `sign-in/social` 使用同一候选确认接口。

不提供无法可靠观察的 scanned。并发轮询至多一个返回 confirmed；其他请求读取 consumed。若记录已被后续创建清理，则返回未知 ID 的 404，不承诺永久保留 expired 状态。

错误：未知或无效 ID 为 404 `NOT_FOUND`，此判断不要求 Cookie；已知 ID 缺少或错配 QR Cookie 为 400 `STATE_MISMATCH`。confirmed 状态下 Session 缺失、过期、撤销或用户不符为 401 `UNAUTHORIZED`，且不消费记录。微信关闭为 503 `WECHAT_UNAVAILABLE`，数据库或会话查询失败为脱敏 503 `AUTH_UNAVAILABLE`；来源、方法和限流沿共同约定。

副作用：稳定 pending 只读 QR 状态；`pending_confirm` 另只读并核对当前有效候选与本浏览器 Cookie 归属，不消费候选。成功确认流程建立归属及会话后，confirmed poll 先核对会话和确认用户，再在 QR 锁内以同一数据库时刻重验期限并原子转为 consumed。poll 不新建、续期或发放 Session Cookie，响应始终禁缓存；客户端确认后调用 `/api/v1/me` 取得同一可信身份。

## POST /api/auth/sign-in/social

身份：允许匿名发起微信网站登录。

输入：`provider` 必须为 `wechat`；可选 `callbackURL` 只接受以单个 `/` 开始的本站路径。仅省略时使用 `/`，显式 `null` 在建立 OAuth state 前返回 400 `INVALID_INPUT`。不接受 `idToken`、其他 provider、额外授权参数或未声明字段。

成功：返回库的 `{url,redirect:false}` 并设置短期 state Cookie；前端在同一浏览器中打开 `url`，完成授权后返回指定本站路径。返回的授权地址并不代表已经登录。

错误：输入无效为 400，未启用为 503；来源、限流和数据库错误沿共同约定。

副作用：建立短期授权 state。回调命中当前已绑定身份时登录原账号；当前未绑定身份（含已解绑）进入短期待确认候选，确认前不自动建号或签发会话。客户端不传微信主体或持久化 provider token，不按相同邮箱自动合并账号。

## POST /api/auth/link-social

身份：当前有效且创建不足 10 分钟的会话；当前用户尚未绑定微信。

输入：与微信登录发起相同。回调必须仍携带相同会话与 state Cookie；新的微信授权仅绑定发起人。

成功：返回授权地址并设置短期 state Cookie，响应格式与微信登录发起相同。

错误：无近期会话、已绑定微信或输入无效为 400，未启用为 503；微信已属于另一用户时回调返回错误，不转移或合并账号。

副作用：建立绑定用途的授权 state，不在此步骤直接写入微信主体。

## GET /api/auth/callback/wechat

身份：微信授权返回的 code、state 和发起浏览器的 state Cookie；个人中心绑定仍要求创建不足 10 分钟的原有效会话、相同 userId 与 sessionId，最终写入在用户锁内重新核对账号未禁用。解绑前发起的旧回调必须失效。

输入：库处理的 `code`、`state` 或微信授权错误；只开放 GET，不要求普通 POST 的 Origin，但如提供 Origin 仍必须获准。同源 iframe 桥接第二跳可附带内部参数 `mio_bridge`，适配器在转交认证库前将其移除。

成功：已绑定身份签发原用户会话；当前未绑定身份在建号前暂存 `candidate_ready` 并下发微信待处理 Cookie，确认前不生成用户或会话；个人中心绑定只写入发起用户的微信关联。均重定向到批准的本站路径；未绑定候选附带 `wechat_result=choose_account`，页面再读取 pending 确认信息。当请求携带 `Sec-Fetch-Dest: iframe`、未携带 `mio_bridge`、缺少对应协议的 state Cookie（HTTPS 为 `__Secure-mio.state`，回环 HTTP 为 `mio.state`）且 `state` 为非空且不超过 512 字符的字符串时，适配器在完成 Origin、方法与微信启用检查后不进入认证库，直接返回 200 `text/html; charset=utf-8` 固定同源桥接页（无动态插值，内联脚本仅为当前 URL 添加 `mio_bridge=1` 并执行 `location.replace`），保留 `X-Request-Id`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，并设置 `X-Frame-Options: SAMEORIGIN`、`Content-Security-Policy: default-src 'none'; script-src 'sha256-…'; frame-ancestors 'self'` 与 `Referrer-Policy: no-referrer`；浏览器在同源 iframe 内发起第二跳并附带 state Cookie 后，适配器移除 `mio_bridge` 并交由认证库完成校验与 302 重定向。

错误：缺少或错误 state Cookie、重复 state 为 400；已携带 `mio_bridge` 的第二跳若仍缺少或错配 state Cookie，直接交由认证库返回 400 `STATE_MISMATCH` 且不再返回桥接页（零循环）。非 iframe 请求、缺少或超长 `state` 不触发桥接；微信未启用时即使携带 `Sec-Fetch-Dest: iframe` 仍返回 503 `WECHAT_UNAVAILABLE`。库拒绝过期 state、供应商失败、被占用微信、已禁用账号（`ACCOUNT_DISABLED`）或失效绑定会话时按库错误重定向或返回失败。回调过程中如遇依赖故障，不得将失败推断为登录成功。

副作用：第一跳 iframe 桥接不调用认证库，不消费 `/callback/wechat` 限流额度，也不触碰数据库或微信接口。进入微信兑换前原子保留 state；之后即使失败也需重新发起。微信出站、账号主体、token 加密和 AppID 生命周期见[微信契约](../integrations/wechat.md)。

当 state 对应 QR 会话时，在原签名 Cookie 和单次保留检查后关联 QR；过期 QR 在供应商兑换前以 400 拒绝。已绑定登录由本次 callback 的新会话确认 QR；当前未绑定身份将 QR 关联至微信待处理候选，poll 返回 `pending_confirm`，最终确认后才建立账号归属及会话。已有登录 Cookie 不会让失败回调变成成功。重复／并发 callback 不替换已有候选、已确认或已消费结果；用户拒绝脱敏为 `WECHAT_AUTH_FAILED` 后回到批准路径。缺失或错误发起 Cookie 在关联 QR 前拒绝，不将该 QR 标记失败。

## GET /api/auth/wechat/pending

身份：当前浏览器的微信待处理 Cookie，普通 QR 与 `sign-in/social` 回调共用。Cookie 名为 `mio.wechat_pending`（HTTPS 带 `__Secure-` 前缀和 Secure），属性为 HttpOnly、SameSite=Lax、`Path=/api/auth`，不把原始 Cookie 或微信主体交给页面。

输入：无正文。Origin 可省略，提供时须在允许列表内。

成功：200 和 `{status:"candidate_ready",candidateToken,wechatNickname,expiresAt}`。`candidateToken` 为不透明确认令牌，`wechatNickname` 为服务端核实的微信昵称或 `null`，`expiresAt` 为 ISO 时间。候选期限继承本次 OAuth state；QR 路径还受原 5 分钟 QR 期限限制，以回执为准。待处理 Cookie 的 Max-Age 为 900 秒，不延长候选。未绑定候选不要求 Mio 会话，也不代表已登录。

错误：Cookie 缺失、未知、候选过期或已非 `candidate_ready` 统一返回 404 `WECHAT_PENDING_NOT_FOUND`；微信未启用为 503 `WECHAT_UNAVAILABLE`，基础设施故障为 503 `AUTH_UNAVAILABLE`。本只读入口不把已完成候选重新返回给页面。

副作用：只读候选，不创建用户、永久关联或会话，也不续期候选。确认必须携带本浏览器 Cookie 与回执候选令牌，客户端不能指定微信身份或目标 userId。

## POST /api/auth/wechat/pending/send-otp

身份：本浏览器有效、未过期的 `candidate_ready` 微信待处理 Cookie。

输入：严格 `{phoneNumber}`，接受 11 位大陆手机号或其 `+86` 格式，不接受额外字段。

成功：200 和 `{status:true,expiresIn:300}`。不暴露目标手机号是否已注册；live 表示供应商已受理，不证明送达。

错误：输入非法为 400 `INVALID_INPUT`；Cookie 缺失、未知、过期或非待确认状态为 404 `WECHAT_PENDING_NOT_FOUND`；预算耗尽为 429 `SMS_RATE_LIMITED`；短信策略、固定码、发送或激活不可用为 503 `SMS_UNAVAILABLE`；微信未启用为 503 `WECHAT_UNAVAILABLE`，基础设施故障为 503 `AUTH_UNAVAILABLE`。

副作用：创建 `wechat_existing` 专用挑战，绑定本候选、候选令牌摘要和规范化手机号。live 预约独立账号操作全局预算与共享手机号／IP 预算后发送；失败与未知不返预算、不重试。bypass 不发短信、不扣预算，但仍建立并激活同样范围的挑战，后续不能直接凭固定码跳过本入口。

## POST /api/auth/wechat/pending/confirm

身份：本浏览器有效的微信待处理 Cookie 与 `candidateToken`。`link_existing` 还须通过本候选手机挑战，或本次授权发起后取得、创建不足 10 分钟的有效目标会话证明目标账号归属。

输入：仅接受以下精确字段集合，不接受客户端 userId、openid 或额外字段：

- 创建新账号：`{action:"create",candidateToken}`。
- 验证已有手机号账号：`{action:"link_existing",candidateToken,phoneNumber,code}`。
- 使用近期目标会话：`{action:"link_existing",candidateToken}`。

成功：200 和 `{status:true,action,userId}`，完成本候选并清理待处理 Cookie，使浏览器进入确认的目标账号；创建路径分配独立新 userId，绑定路径始终使用已有 userId。个人中心的微信绑定仍由 `link-social` 发起，不把此处近期目标会话路径当成隐式绑定。

错误：输入非法为 400 `INVALID_INPUT`；缺失或未知候选为 404 `WECHAT_PENDING_NOT_FOUND`；过期、状态／令牌或旧回调失效栅栏不符为 400 `WECHAT_PENDING_INVALID`；已完成或重放为 409 `WECHAT_PENDING_ALREADY_COMPLETED`。手机挑战错误、过期、跨用途／跨候选或未发起为 400 `INVALID_OTP`，目标手机号未注册／未验证为 404 `EXISTING_PHONE_NOT_FOUND`；禁用目标为 403 `ACCOUNT_DISABLED`；无有效同流程近期会话为 401 `SESSION_REQUIRED`；身份已占用或目标已有其他微信为 409 `WECHAT_ALREADY_BOUND`。微信、短信路径或数据库不可用分别按对应 503 返回；短信停用不阻止近期目标会话路径。

副作用：在短事务中重验候选期限、浏览器归属、目标账号／会话、旧回调失效栅栏和身份唯一性，再一次性完成候选及微信关联。手机路径在 live 与 bypass 下均要求存储挑战及单次消费；不按手机号暗中建号。`create` 对从未绑定和已解绑身份同样开放。并发、过期、迟到／重放、跨浏览器或失败确认不能覆盖已有归属或留下孤儿用户。

## POST /api/auth/onelink/start

身份：`intent="login"` 允许匿名发起；`intent="bind"` 要求当前浏览器持有创建时间不足 10 分钟、未撤销且未禁用的 C 端会话，且该用户尚未绑定万联账号。

输入：JSON 对象，必填 `intent`（仅 `"login"` 或 `"bind"`），可选 `returnPath`（省略时默认 `"/"`；须为 `1..256` 字符、以单个 `/` 开头、不含 `//`、`\` 或控制字符且解析后 origin 与 `MIO_AUTH_BASE_URL` 严格一致的本站相对路径，允许附带查询串如 `"/?nav=onelink-sandbox"`；显式 `null` 或未知字段拒绝）。Origin、JSON 正文类型、16 KiB 与读取期限沿共同约定。

成功：200 与 `{url}`，其中 `url` 为经服务端 `.env` 32 字节密钥 AES-256-GCM 加密 6 字段明文（`clientType="web"`、`clientName`、`name`、`url`、`callback`、`timestamp`）构造的万联授权地址；同时下发待处理 Cookie（HTTPS 名称 `__Secure-mio.onelink_pending` 且带 `Secure`，回环 HTTP 名称 `mio.onelink_pending`；属性为 `HttpOnly`、`SameSite=Lax`、`Path=/api/auth`、`Max-Age=900`）。响应保持 `Cache-Control: no-store`。

错误：输入或 `returnPath` 非法返回 400 `INVALID_INPUT`；`intent="bind"` 缺失/过期/失效/禁用会话返回 401 `SESSION_REQUIRED`；当前用户已绑定万联账号返回 409 `ONELINK_ALREADY_BOUND`；未配置服务端 `.env` 或运行期热开关关闭返回 503 `ONELINK_UNAVAILABLE`；数据库或加密构造失败返回脱敏 503 `AUTH_UNAVAILABLE`；来源、方法、正文与 429 沿共同约定。

副作用：清理最多 100 条已过期至少 10 分钟的 `mioOneLinkPending` 记录后，插入 10 分钟有效的 `status="started"` 待处理记录（仅保存 Cookie 的 SHA-256 摘要，不存原文，绑定用途另记录发起 `userId` 与 `sessionId`）；禁用用户会话被一并撤销并清 Cookie。本入口不创建或修改永久 `user`/`account` 记录。

## GET /api/auth/callback/onelink

身份：发起浏览器的待处理 Cookie（`mio.onelink_pending` / `__Secure-mio.onelink_pending`）以及万联回调查询参数（`unauthorized=true` 或 `access_token`）；当待处理记录为 `intent="bind"` 时，还要求当前浏览器仍持有与发起时一致的 `userId`、`sessionId` 且创建时间不足 10 分钟、未撤销、未禁用的 C 端会话。

输入：只开放 GET，不要求普通 POST 的 `Origin`（如提供 `Origin` 仍须在允许列表内）。读取查询参数 `unauthorized` 与 `access_token`（忽略且绝不持久保存 `refresh_token`）；v1 阶段按 `payload_sub_unverified` 规则对 `access_token` 执行 3 段 Base64URL JWT 结构检查、payload UTF-8 JSON 解码及 `sub`、`exp`、`client_id`（显式拒绝 `routerClientId` 并校验命中当前环境 `allowedClientIds`）语义校验，**不执行密码学验签或万联在线自省**，公网生产放量前须补充正式验签/自省或严格受控热开关评估。

成功：统一返回 `303 See Other` 并附带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，`Location` 固定为干净的本站相对路径 `${returnPath}` 并设置唯一结果参数 `onelink_result`（绝不携带 `access_token`、`refresh_token`、`sub` 或 `candidateToken`）：已绑定活跃用户登录签发 Mio 会话 Cookie、清除待处理 Cookie 并跳转 `onelink_result=logged_in`；未绑定登录暂存待绑候选、保留待处理 Cookie 并跳转 `onelink_result=choose_account`；已登录绑定暂存待绑候选、保留待处理 Cookie 并跳转 `onelink_result=confirm_bind`；用户拒绝、无效/过期/错配令牌、禁用账号、缺失/失效待处理状态或失效绑定会话分别以 `303` 收敛至 `unauthorized`、`invalid_token`、`account_disabled`、`invalid_state` 或 `session_required`。

错误：未配置服务端 `.env` 或运行期热开关关闭返回 503 `ONELINK_UNAVAILABLE`（同样携带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`）；数据库或会话基础设施异常返回脱敏 503 `AUTH_UNAVAILABLE`；非法 `Origin`、非 GET 方法与限流沿共同约定（响应仍保持 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`）。

副作用：本 GET 回调**绝不写入新的永久 `user` 或 `account` 记录**。已绑定活跃用户登录在条件更新 `status="started" -> "completed"` 成功后签发会话并清除待处理 Cookie；其余失败分支按条件更新 `started -> rejected` 并清除待处理 Cookie。未绑定登录与绑定路径原子更新 `started -> candidate_ready` 并写入 `candidateSub`、`candidateClientId`、`candidateToken`；若待处理记录已处于未过期的 `candidate_ready`，迟到或并发回调绝不覆盖既有候选记录且不清除待处理 Cookie，直接 `303` 跳转 `onelink_result=invalid_state`。上游令牌与 AES 密钥绝不落库或写入日志。

## GET /api/auth/onelink/pending

身份：持有有效 `candidate_ready` 状态对应待处理 Cookie 的当前浏览器；当 `intent="bind"` 时，还要求当前浏览器持有与发起时一致且创建时间不足 10 分钟、未撤销、未禁用的 C 端会话。

输入：无正文；`Origin` 可省略，提供时须在允许列表内。

成功：200 与 `{status:"candidate_ready",intent,candidateToken,onelinkSub,onelinkSubMasked,clientId,expiresAt}`（`clientId` 可为 `null`，`expiresAt` 为 ISO 8601 时间戳），不返回上游 `access_token`、`refresh_token`、Cookie 原文、内部 `tokenDigest` 或 AES 密钥。

错误：缺失 Cookie、待处理记录不存在/已过期/非 `candidate_ready` 返回 404 `ONELINK_PENDING_NOT_FOUND`；`intent="bind"` 下缺失、过期、切换或已禁用会话返回 401 `SESSION_REQUIRED`；未配置服务端 `.env` 或运行期热开关关闭返回 503 `ONELINK_UNAVAILABLE`；数据库异常返回脱敏 503 `AUTH_UNAVAILABLE`；来源、方法与 429 沿共同约定。

副作用：只读查询 `mioOneLinkPending`（并在 `intent="bind"` 发现已禁用账号遗留会话时撤销该会话并清会话 Cookie）；不写入永久用户或账号记录，不修改待处理状态。

## POST /api/auth/onelink/cancel

身份：允许匿名或已登录浏览器调用，按可选待处理 Cookie 定位当前待处理记录。

输入：严格空 JSON 对象 `{}`，拒绝任何额外字段；Origin、JSON 正文类型、16 KiB 与读取期限沿共同约定。

成功：200 与 `{ok:true}`，并始终下发 `Max-Age=0`、`Path=/api/auth` 的空值待处理 Cookie 清除浏览器端状态。

错误：非空对象或非法 JSON 返回 400 `INVALID_INPUT`；数据库异常返回脱敏 503 `AUTH_UNAVAILABLE`；来源、方法、正文与 429 沿共同约定。本入口不受万联运行期热开关关闭阻断，确保随时可清理遗留待处理状态。

副作用：若携带有效待处理 Cookie，则将对应处于 `started` 或 `candidate_ready` 状态的 `mioOneLinkPending` 记录原子更新为 `cancelled`，随后清除待处理 Cookie；不影响当前 C 端登录会话或既有永久绑定。

## POST /api/auth/onelink/existing/send-otp

身份：持有有效、未过期且处于 `candidate_ready` 状态的 `intent="login"` 待处理 Cookie 的当前浏览器。

输入：严格 JSON 对象 `{phoneNumber}`，接受 11 位大陆手机号或其 `+86` 格式，拒绝任何额外字段；Origin、JSON 正文类型、16 KiB 与读取期限沿共同约定。

成功：200 与 `{status:true}`；live 表示供应商已受理，不证明送达；bypass 在校验候选、合法 6 位固定码及直连 IP 后建立并激活本候选专用挑战，不调用供应商或占预算。两种模式均不暴露手机号是否已注册。

错误：输入无效返回 400 `INVALID_INPUT`；缺失待处理 Cookie 或记录不存在返回 404 `ONELINK_PENDING_NOT_FOUND`；待处理记录已完成返回 409 `ONELINK_PENDING_ALREADY_COMPLETED`；待处理记录过期、非 `candidate_ready` 或用途非 `login` 返回 400 `ONELINK_PENDING_INVALID`；短信预算耗尽返回 429 `SMS_RATE_LIMITED`；未配置服务端万联 `.env` 或万联热开关关闭返回 503 `ONELINK_UNAVAILABLE`；运行时策略 `smsMode='disabled'`、`smsMode='live'` 下未启用真实短信供应商、`smsMode='bypass'` 下未配置合法 6 位固定测试码、缺失客户端 IP 或供应商拒绝／激活失败返回 503 `SMS_UNAVAILABLE`；数据库异常返回脱敏 503 `AUTH_UNAVAILABLE`。

副作用：live 预约独立账号操作全局预算及跨用途共享手机号／IP 预算，并写入 `onelink_existing` 挑战，绑定本 `pendingId`、候选令牌摘要和规范化手机号；供应商受理后激活。失败与未知不返预算、不重发，也不清除候选。bypass 不调用供应商、不扣预算，但同样建立并激活操作挑战；确认仍须先经过本入口并核对归属、期限与单次消费。

## POST /api/auth/onelink/complete

身份：持有有效待处理 Cookie 的当前浏览器。登录意图的 `action="link_existing"` 通过本候选专用手机号验证码，或在同一登录流程取得的创建不足 10 分钟的有效目标会话核验已有账号；客户端不指定目标 userId。`action="bind_current"` 仍只接受由原有效近期会话发起的绑定意图。

输入：严格 JSON 对象，按 `action` 仅允许精确字段集合，拒绝任何额外字段（包括客户端传入的目标 `userId` 或万联 `sub`）；Origin、JSON 正文类型、16 KiB 与读取期限沿共同约定：

- `action="create"`：`{action:"create", candidateToken}`
- `action="link_existing"`：手机路径为 `{action:"link_existing", candidateToken, phoneNumber, code}`（规范化大陆手机号与 6 位数字码）；近期目标会话路径为 `{action:"link_existing", candidateToken}`，不混入手机字段。
- `action="bind_current"`：`{action:"bind_current", candidateToken}`

成功：按 `action` 返回 200 与 `{status:true, action, userId}`（`bind_current` 幂等命中时附带 `alreadyBound:true`），并始终清除待处理 Cookie：

- `action="create"`：200 与 `{status:true, action:"create", userId}`，签发新用户 C 端会话 Cookie 并清除待处理 Cookie。
- `action="link_existing"`：200 与 `{status:true, action:"link_existing", userId}`，进入已核验的原目标账号并清除待处理 Cookie。
- `action="bind_current"`：200 与 `{status:true, action:"bind_current", userId}`（若当前用户已绑定同一万联 `sub`，额外返回 `alreadyBound:true`），仅清除待处理 Cookie，**不修改或重建现有 C 端会话 Cookie**。

错误：输入非法或额外字段为 400 `INVALID_INPUT`；缺失待处理记录为 404 `ONELINK_PENDING_NOT_FOUND`；已完成或重放为 409 `ONELINK_PENDING_ALREADY_COMPLETED`；候选过期、状态／用途或令牌不符为 400 `ONELINK_PENDING_INVALID`。手机路径的错误、过期、跨用途／跨候选、未发起挑战或已锁定验证码为 400 `INVALID_OTP`，未注册或未验证号码为 404 `EXISTING_PHONE_NOT_FOUND`（不自动建号，保留候选），短信策略不可用为 503 `SMS_UNAVAILABLE`。近期目标会话路径或 `bind_current` 缺失、过期、撤销、切换及账号失效时为 401 `SESSION_REQUIRED`；禁用目标账号为 403 `ACCOUNT_DISABLED`；身份或目标用户绑定冲突为 409 `ONELINK_ALREADY_BOUND`，保留原归属。万联关闭为 503 `ONELINK_UNAVAILABLE`，数据库／会话故障为 503 `AUTH_UNAVAILABLE`；近期目标会话路径不受短信停用阻断。

副作用：最终账号归属写入在单 PostgreSQL 事务内锁定 `mioOneLinkPending` 并执行原子提交，唯一约束冲突完整回滚且保留原归属：

- `create`：在同一 PostgreSQL 事务内锁定待处理记录、分配唯一 `displayId` 并创建 `name="万联用户"`、保留域占位邮箱 `onelink-…@auth.mio.invalid`（`emailVerified=false`）、`phoneNumber=null` 的新用户、插入 `(providerId='onelink', accountId=sub)` 关联并更新待处理为 `completed`；若遭遇 `account` 唯一冲突则整个事务回滚（零孤儿用户）。成功后签发会话并清除待处理 Cookie；新用户后续可经 `/api/auth/phone-binding/*` 补绑空闲手机号。
- `link_existing`：先复核登录意图、候选状态与 `candidateToken`。手机路径在 live 与 bypass 下均须先调用 `existing/send-otp` 建立本候选专用挑战，再验证并单次消费；bypass 只替换发送与码值，不绕过候选或挑战归属。近期目标会话路径不依赖短信，在最终事务内复核目标用户、同一近期有效会话及候选，适用于无手机号或短信停用的目标账号。两条路径均不创建用户，绑定成功后完成待处理状态并进入目标账号。
- `bind_current`：非续期校验近期会话后，在同一事务内依次锁定用户、原近期会话与 `intent="bind"` 待处理记录并复核发起身份与 `candidateToken`；若当前用户已绑定同一 `sub` 则幂等完成待处理，否则写入万联关联并标记 `completed`，成功后仅清除待处理 Cookie。

## POST /api/auth/phone-number/send-otp

身份：允许匿名请求登录或自助注册验证码。

输入：`phoneNumber`，接受 11 位大陆号码或其 `+86` 格式；未声明字段拒绝。

成功：200 和 `{status:true}`；`smsMode='live'` 下表示供应商已受理（不证明送达），`smsMode='bypass'` 下在校验号码、已配置合法 6 位固定测试码与直连客户端 IP 后直接返回 `{status:true}`（无需配置腾讯短信）。

错误：输入无效为 400，短信预算耗尽为 429，运行时策略 `smsMode='disabled'`、`smsMode='live'` 下未启用短信、`smsMode='bypass'` 下未配置合法 6 位固定测试码或供应商拒绝／结果未知为 503 `SMS_UNAVAILABLE`；预算 429 不承诺返回重试秒数。

副作用：`smsMode='live'` 下先占用持久短信预算并建立短期挑战，再调用[腾讯短信](../integrations/tencent-sms.md)（失败和未知不返预算、不自动重发）；`smsMode='bypass'` 下不调用短信供应商、不占用短信预算，但仍受认证路由限流约束；`smsMode='disabled'` 下无发送与预算副作用。

## POST /api/auth/phone-number/verify

身份：持有此号码的登录用途验证码（`smsMode='bypass'` 下为后台配置的 6 位固定测试验证码）。

输入：`phoneNumber,code`；验证码为 6 位字符串，未声明字段拒绝。

成功：返回 `{status:true}` 并设置会话 Cookie，已有号码登录其所属用户，新号码自助注册并分配唯一 `displayId`。

错误：输入、验证码或用途无效（含 `bypass` 模式下验证码不匹配）为 400 `INVALID_OTP`，账号已禁用为 403 `ACCOUNT_DISABLED`，运行时策略 `smsMode='disabled'`、`smsMode='live'` 下短信未启用或 `smsMode='bypass'` 未配置合法 6 位固定验证码为 503 `SMS_UNAVAILABLE`。

副作用：`smsMode='live'` 下原子消费验证码后创建或查询用户并创建库会话（后续失败不恢复该码）；`smsMode='bypass'` 下无需提前调用 `send-otp` 且不依赖腾讯短信运行时，以恒定时间比对固定测试码后执行相同的用户校验（含未验证号码与禁用账号拦截）、自动建号与签发会话流程，并保持路由限流生效。

## POST /api/auth/phone-binding/send-otp

身份：创建时间不超过 10 分钟且未撤销的当前会话。

输入：`phoneNumber`；格式与登录发码相同。

成功：200 和 `{status:true}`；`smsMode='live'` 下表示供应商已受理（不证明送达），`smsMode='bypass'` 下在校验近期会话、已配置合法 6 位固定测试码与直连客户端 IP 后直接返回 `{status:true}`（无需配置腾讯短信）。

错误：输入无效为 400，无近期会话为 401，预算耗尽为 429，运行时策略 `smsMode='disabled'`、`smsMode='live'` 下未启用真实短信供应商、`smsMode='bypass'` 下未配置合法 6 位固定测试码或供应商拒绝／结果未知为 503 `SMS_UNAVAILABLE`。

副作用：`smsMode='live'` 下占用短信预算并发送绑定用途验证码，绑定原用户、会话和号码；失败和未知不返预算、不自动重发。`smsMode='bypass'` 下不调用短信供应商、不占用短信预算，但仍受近期会话与认证路由限流约束。

## POST /api/auth/phone-binding/confirm

身份：与发码相同且仍有效的近期会话，以及该号码的绑定用途验证码（`smsMode='bypass'` 下为后台配置的 6 位固定测试验证码）。

输入：`phoneNumber,code`；格式与登录验证相同。

成功：返回 `{status:true}`，在当前用户首次绑定空闲号码，userId 不变。

错误：输入、验证码（含 `bypass` 模式下固定码不匹配）、用途或发起会话不符为 400，无近期会话为 401，号码已占用或当前用户已有号码为 409，运行时策略 `smsMode='disabled'`、`smsMode='live'` 下未启用真实短信供应商或 `smsMode='bypass'` 下未配置合法 6 位固定测试码为 503 `SMS_UNAVAILABLE`。

副作用：`smsMode='live'` 下消费验证码并在事务中检查原会话、更新当前用户；`smsMode='bypass'` 下无需前置 `send-otp` 或真实短信运行时，在校验近期会话并以恒定时间比对固定测试码后，以相同行锁顺序（`"user"` → `"session"`）在事务中复核原会话并写入空闲号码；不转移或合并账号。持久预算及恢复边界见[认证底座](../auth.md#手机验证码与发送预算)。

## POST /api/auth/phone-rebind/send-otp

身份：创建不足 10 分钟、未撤销且账号有效的原 C 端会话；当前用户必须已有验证手机号。

输入：严格 `{phoneNumber}`，接受 11 位大陆手机号或其 `+86` 格式，不接受额外字段。拒绝与当前号相同或已被其他账号占用的新号。

成功：200 和 `{status:true,expiresIn:300}`。live 表示供应商已受理，不证明送达；bypass 建立同样的操作挑战，不调用供应商。

错误：无有效近期会话为 401 `SESSION_REQUIRED`；无当前已验证号码为 409 `PHONE_REQUIRED`；当前号或已占用号为 409 `PHONE_CONFLICT`；持久预算耗尽为 429 `SMS_RATE_LIMITED`；短信停用、live 未配置供应商、bypass 未配置合法固定码、缺少直连 IP、发送或挑战激活失败为 503 `SMS_UNAVAILABLE`。输入、来源、方法和正文错误沿共同约定。

副作用：创建 `phone_rebind` 挑战，绑定本用户、原会话、原已验证号和新号。live 预约独立 `global:account_ops` 预算，并受跨用途共享手机号与 IP 限制；失败或未知不退预算、不自动重试。bypass 仍须经过本入口，不能只凭固定码提交换绑。

## POST /api/auth/phone-rebind/confirm

身份：与发送时相同且仍创建不足 10 分钟的有效原会话，以及本次操作的新号验证码。

输入：严格 `{phoneNumber,code}`，手机号格式同发码，code 为 6 位数字字符串；不接受额外字段。

成功：200 和 `{status:true}`。新号仍进入原 `userId`，旧号不能再登录原账号；当前及其他设备原本有效的会话全部保留，客户端随后回读个人资料。

错误：会话失效、过期或切换为 401 `SESSION_REQUIRED`；并发唯一性或原号变化冲突为 409 `PHONE_CONFLICT`；错误、过期、重放、未发起挑战或跨会话／用途验证码为 400 `INVALID_OTP`；短信策略或依赖不可用为 503 `SMS_UNAVAILABLE`。

副作用：在最终短事务内重新核对用户、原会话、原号码与新号唯一性，一次性消费本操作挑战并替换手机号。live 与 bypass 均核对存储挑战及其归属；成功不撤销、续期或重建既有会话。

## POST /api/auth/sign-up/email

身份：允许匿名自助注册。

输入：`name,email,password`；邮箱归一化，密码 12–128 字符。

成功：成功建立账号和会话，`emailVerified=false`。

错误：重复邮箱、无效输入或伪造受保护字段（如 `displayId`、`avatarAssetId`、`disabledAt`）按固定库响应返回 400；邮箱密码开关关闭时返回 503 `EMAIL_PASSWORD_UNAVAILABLE`；客户端不能自授验证或禁用状态。

副作用：创建持久账号（自动分配唯一 `displayId`）及会话，签发 cookie；首期不验证邮箱。

## POST /api/auth/sign-in/email

身份：邮箱/密码登录。

输入：`email,password`。

成功：成功签发会话 cookie。

错误：错误凭据返回 401；凭据正确但账号已禁用返回 403 `ACCOUNT_DISABLED` 且不签发 cookie；邮箱密码开关关闭返回 503 `EMAIL_PASSWORD_UNAVAILABLE`；其他错误按本域共同约定。

副作用：建立持久会话与 cookie。

## GET /api/auth/get-session

身份：会话 Cookie。

输入：无正文。

成功：返回会话和用户，无有效会话或账号已禁用时返回 `null`。

错误：按本域共同约定，不能把无会话的 null 当作 /me 的 401。

副作用：按刷新条件续期数据库会话及 cookie；客户端通过本入口刷新 cookie。若发现账号已禁用，删除对应遗留会话行与 cookie 并返回 `null`。

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

错误：旧密码或输入不合法按库响应失败；账号已禁用返回 401；邮箱密码开关关闭返回 503 `EMAIL_PASSWORD_UNAVAILABLE`；其他错误见共同约定。

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

身份：Cookie 经数据库校验后的未禁用可信身份；服务 token 不能替代。

输入：无正文。

成功：返回 `{userId,sessionId}`。

错误：无效、过期、撤销、账号已禁用或仅有服务 token 时返回 401；其他错误见共同约定。

副作用：只校验身份，不刷新会话或 cookie，也不授予项目/资产访问权。

## DELETE /api/v1/me/wechat

身份：当前有效 C 端 Cookie 会话，服务 token 和管理员 Cookie 不能替代。只作用于当前用户的微信关联。

输入：无正文，必须携带精确匹配允许列表的 Origin。OPTIONS 仅放行该路径声明的 DELETE；缺失或非法 Origin 拒绝后才处理身份与解绑。

成功：200 和 `{status:true}`；重复移除本来未绑定的微信按幂等成功处理。移除关联及 `account.wechatNickname`，客户端回读 U1 展示资料。

错误：无有效会话为 401 `UNAUTHORIZED`；将移除最后一种实际可用登录方式时为 409 `LAST_LOGIN_METHOD`；来源、方法和基础设施故障按本域包装错误返回。

副作用：以用户为单位串行处理并发解绑，最终复核本人有效会话及剩余方式。剩余方式必须实际可用：本人已验证号且短信登录可用、可登录邮箱已设置真实密码且邮箱登录开启，或另一已绑定且当前启用的服务商。占位邮箱、空密码、未验证号和停用服务商不计入。保留当前及其他设备全部原有效会话，不改写独立万联供应商凭据；已退出、撤销或到期会话不恢复。仅移除当前归属，不写永久解绑历史；解绑前发起的旧回调失效，后续重新授权仍可显式创建或绑定账号。

## DELETE /api/v1/me/onelink

身份：当前有效 C 端 Cookie 会话，仅移除当前用户的万联登录关联；服务 token 和管理员 Cookie 不能替代。

输入：无正文，精确 Origin 与 OPTIONS 校验沿[微信解绑](#delete-apiv1mewechat)的共同规则。

成功：200 和 `{status:true}`，未绑定时幂等成功。客户端随后回读 U1 的 `onelinkBound`。

错误：无有效会话为 401 `UNAUTHORIZED`，移除最后一种实际可用登录方式为 409 `LAST_LOGIN_METHOD`；其余错误沿共同约定。

副作用：串行复核剩余实际可用登录方式并使解绑前发起的旧回调失效；保留全部原有效 Mio 会话，以及按独立供应商配置契约保存的万联凭据，不设置永久解绑历史。剩余方式的判定沿微信解绑规则。

## GET /api/v1/me/profile

身份：Cookie 经数据库校验后的未禁用可信身份；服务 token 不能替代。

输入：无正文。Origin 可省略，提供时必须在允许列表内。

成功：200 和 `{userId,displayId,name,avatarAssetId,phoneNumber,phoneNumberVerified,wechatBound,onelinkBound}`；`displayId`、`avatarAssetId` 与 `phoneNumber` 可为 `null`，不返回密码哈希、邮箱占位、供应商 token 或头像签名 URL。

错误：未登录、会话失效或账号已禁用返回 401 `UNAUTHORIZED`；来源或方法错误与数据库故障沿共同约定。

副作用：只读取当前用户资料与微信、万联绑定状态，不刷新会话或写入数据。

指定 `?view=display` 时，成功回执仅为 `{userId,displayId,name,avatarAssetId,avatarUrl,maskedPhoneNumber,phoneNumberVerified,wechatBound,wechatNickname,onelinkBound}`。`displayId` 为旧账号缺失时回落到 `userId`；未绑手机时 `maskedPhoneNumber=null`，大陆号形如 `+86138****8000`，不含原始手机号；微信未绑时 `wechatNickname=null`，已绑但缺已核实展示名时为“已绑定”。微信展示名只取服务端已核验的微信授权资料，旧数据不自动回填。`avatarUrl` 为本人 ready 静态头像的 300 秒 HTTPS inline 地址；头像缺失、资产库或签名暂不可用时仍返回 200，保留 `avatarAssetId` 并返回 `avatarUrl=null`。URL 不写入认证数据库，过期后重新 GET。

## PATCH /api/v1/me/profile

身份：Cookie 经数据库校验后的未禁用可信身份；读取正文后重新核对身份。

输入：JSON 对象，至少包含 `name` 或 `avatarAssetId` 之一，拒绝任何其他字段（包括 `displayId`、`disabled`、`email`、`phoneNumber`、`onelinkBound`）。`name` 为去首尾空白后 1–50 个 Unicode 字符且不含控制字符的字符串；`avatarAssetId` 为小写 UUID v4 或 `null`。来源、JSON、16 KiB 与 10 秒读取期限沿共同约定。

成功：200，返回更新后的完整用户资料对象（结构同 `GET /api/v1/me/profile`，含 `onelinkBound`）。

错误：字段非法或头像资产非 `image/jpeg`、`image/png`、`image/webp` 返回 400 `INVALID_INPUT`；未登录或账号已禁用返回 401 `UNAUTHORIZED`；头像资产不存在或不属于当前用户返回 404 `ASSET_NOT_FOUND`；头像资产非 `ready` 返回 409 `ASSET_NOT_READY`；资产服务未装配或不可用时设置非空头像返回 503 `ASSET_UNAVAILABLE`；正文与来源错误沿共同约定。

副作用：设置非空 `avatarAssetId` 前经装配注入的资产服务核验归属、就绪状态与图片 MIME；在单事务内更新当前未禁用用户的对应字段与 `updatedAt`，不修改 `displayId` 或登录凭据。

`?view=display` 同 GET 的精确展示字段。仅改昵称、清空头像，以及资料已成功写入后的 URL 签发阶段遇到媒体故障仍返回 200；保存原有资产 ID，仅把 `avatarUrl` 降级为 null。绑定非空资产 ID 必须核验本人归属、ready、实际 HEAD 大小（1 字节至资产域上限 1 GiB；20 MiB 仅限制 GIF 转换输入）、登记与 HEAD 的 JPEG/PNG/WebP 类型一致；404 表示他人或不存在，409 表示未就绪或大小冲突，400 表示类型或大小不合法，核验不可用返回 503 `ASSET_UNAVAILABLE`。默认响应和服务端昵称 1–50 个 Unicode 字符的规则不变；只改头像时不截断历史长昵称。

## POST /api/v1/me/profile/avatar/normalize

身份：仅接受当前有效 Cookie 会话；读取正文后核验身份。

输入：要求允许的精确 Origin、`application/json`，正文上限 16 KiB、10 秒。严格对象 `{sourceAssetId}`，值须为 UUID v4，不接受 owner 或其他字段。

成功：200 `{avatarAssetId}`。原件必须属于本人、ready、登记和实际 HEAD 均为 GIF，实际大小与登记相等且不超过 20 MiB（含恰好 20 MiB）。按 HEAD ETag 的 If-Match 有界读取，核对实际字节数和 GIF 格式；在主服务 A 仅解码首帧（`pages:1`），单帧最多 16,000,000 像素、单边最多 8192，输出最大 512×512、2 MiB 的静态 WebP。随后用返回的 ID 调用资料 PATCH；转换本身不改用户资料。

同一源资产用版本化的确定性 ID 和不可覆盖的私有对象键复用结果；竞争或上传回执丢失时复核输出 HEAD 的大小、SHA-256、类型和 ETag，再幂等登记 ready 资产。重试和重启保留同一转换结果；已保存的 URL 仍按每次 GET/PATCH 签发。一次只允许一个进程内转换，无等待队列，打满快速返回 503 `ASSET_BUSY`；正常资料读取可继续执行。原件只沿既有 staging 清理规则处理，U6 暂存与共享物理 GC 不在本单元实施。

副作用：向私有桶写入不可覆盖的静态 WebP 并幂等登记 ready 资产；不改用户资料，资料 PATCH 由调用方另行完成。

错误：400 `INVALID_INPUT`/`ASSET_INPUT_INVALID`（包含格式、像素、尺寸或解码失败）；401 `UNAUTHORIZED`；403 `ORIGIN_DENIED`/`ORIGIN_REQUIRED`；404 `ASSET_NOT_FOUND`；409 `ASSET_NOT_READY`/`ASSET_SIZE_MISMATCH`/`ASSET_SOURCE_CHANGED`；503 `ASSET_BUSY`/`ASSET_UNAVAILABLE`/`ASSET_STORAGE_UNAVAILABLE`。正文和方法错误沿认证共同约定。无 RabbitMQ、计算 Worker、自动重试或外部供应商调用。
