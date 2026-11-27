# 微信网站应用登录契约

## 适用范围与接入事实

本契约适用于 Mio 的微信**网站应用**扫码登录、显式创建／绑定和解绑后的重新授权。固定 Better Auth 1.7.18 负责授权地址、state 及既有账号会话，认证插件在当前未绑定身份的回调建号前暂存候选，确认后才写入归属并签发会话。[微信适配器](../../src/integrations/wechat.ts)只完成服务端授权码兑换和用户资料请求，[认证插件](../../src/auth/wechat.ts)维护身份与并发保护。短信、账号归属和 HTTP 行为分别见[认证底座](../auth.md)与[认证 HTTP 契约](../apis/auth.md)。

匿名 QR polling 与 `sign-in/social` 共用 OAuth 回调和未绑定候选确认：[QR 插件](../../src/auth/wechat-qr.ts)提供授权与状态，[QR 存储](../../src/auth/wechat-qr-store.ts)保存短期关联及原子消费。电脑主页面保持打开，由同源内嵌微信官方 `WxLogin({ self_redirect: true })`（iframe）或同一浏览器授权窗口完成 callback。已绑定身份取得 Session Cookie；未绑定身份取得专用待处理 Cookie，主页面凭 QR 与候选归属读取 `pending_confirm`，此时不要求用户会话。`authorization_url` 须由微信官方页面或 `WxLogin` 渲染，不是独立二维码图片；不提供无同浏览器 Cookie、由手机直连服务端后向电脑交接凭据的模型。

服务端通过 `MIO_AUTH_WECHAT_ENABLED=true`、`MIO_AUTH_WECHAT_APP_ID` 和 `MIO_AUTH_WECHAT_APP_SECRET` 启用；配置缺项或不合法时拒绝装载，默认关闭。固定 `MIO_AUTH_BASE_URL` 的 `/api/auth/callback/wechat` 是回调，微信开放平台的授权回调域与实际 HTTPS 代理必须与该地址匹配，不能从请求头推导。AppID 与 secret 不进入前端构建、公共日志或仓库。配置存在不代表微信平台、域名路由或浏览器链路已经验证。

## 必须遵守的约束

- 服务端只请求 `https://api.weixin.qq.com/sns/oauth2/access_token` 和 `/sns/userinfo`，每次请求使用 5 秒真实中止期限，响应最多保留 32 KiB，超限取消读取，拒绝重定向和自动重试。非成功状态也取消读取；供应商异常统一脱敏。请求 URL 可能包含 secret 或 token，不记录原始 URL、正文或异常。
- 账号主体以网站应用 AppID 与微信返回的 openid 固定组成；兑换结果和用户资料的 openid 必须一致。unionid 有无变化不改变主体，不按昵称或邮箱推断同人。微信不提供已验证邮箱，系统生成 `wechat-…@auth.mio.invalid` 占位值；该域不可用邮箱密码注册，不能当作联系邮箱或所有权证明。
- 授权由发起浏览器的签名 state Cookie 和库的数据库 state 共同校验；兑换前以 PostgreSQL 保留记录限制并发重放，失败后须重新发起。个人中心绑定要求创建不足 10 分钟的原有效会话及相同 userId、sessionId；最终账号写入持有用户锁并重新核对禁用状态，不能让迟到、失效或解绑前发起的旧回调改变归属。OAuth token 使用认证 secret 加密后保存，不交给浏览器或写日志。
- QR 会话有效 5 分钟，独立 QR Cookie 与 OAuth state 仅以摘要进入 QR 表；库自身数据库 state 仍按原策略管理，不以 QR 存储规则改写。QR Cookie 精确限定到单个 ID 的 poll 路径，保留 15 分钟以便过期观察；每次创建最多删除 100 条过期至少 10 分钟的记录。清理后旧 ID 为未知，不保留永久状态查询。
- 当 `WxLogin({ self_redirect: true })` 从 `open.weixin.qq.com` 发起跨站 iframe 回调时，浏览器会省略 `SameSite=Lax` state Cookie。`GET /api/auth/callback/wechat` 在 `Sec-Fetch-Dest: iframe`、未携带 `mio_bridge`、缺少对应协议 state Cookie（HTTPS 为 `__Secure-mio.state`，回环 HTTP 为 `mio.state`）且 `state` 非空（不超过 512 字符）时，不进入认证库或消费限流，直接返回单跳同源 HTML 桥接页（`200 text/html`，无动态插值，`X-Frame-Options: SAMEORIGIN`、`CSP: default-src 'none'; script-src 'sha256-…'; frame-ancestors 'self'`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`）；第二跳同源发起并携带 state Cookie 后，适配器移除 `mio_bridge` 并交由 Better Auth 校验，若仍无有效 state Cookie 直接返回 400 不循环。
- QR callback 复用签名 state Cookie 和原子重放保留，过期 QR 在兑换前拒绝。已绑定身份的本次新会话可确认 QR；未绑定身份先写 `mioWechatPending` 的 `candidate_ready`，QR 返回 `pending_confirm`，不会因扫码暗中建号或签发会话。普通 `sign-in/social` 同样走这一候选流程。候选 Cookie 限定 `Path=/api/auth`、HttpOnly、SameSite=Lax，HTTPS 带 Secure；最终确认须重验候选、浏览器、目标账号和唯一归属。用户拒绝参数脱敏为 `WECHAT_AUTH_FAILED`，错误 Cookie 或重复 callback 不覆盖正常结果。confirmed poll 仍须检查有效会话归属并原子转为 consumed；poll 不创建或转发会话。
- 当前已绑定／当前未绑定是仅有的归属状态；从未绑定和已解绑身份均可显式选择 `create` 或验证已有账号后 `link_existing`，不设置永久解绑墓碑或禁止建号的第三态。有验证号时用本候选专用短信挑战；无号或短信停用时，在同一流程取得近期目标会话后显式确认。不能只凭微信授权或相同邮箱定位目标账号。
- 可信微信昵称只从服务端核验过的授权资料刷新，写在当前 `account.wechatNickname`，不覆盖用户自行编辑的昵称。解绑删除微信关联及该昵称，保留原有效 Mio 会话和独立供应商凭据；序列化最终检查必须保留至少一种实际可用登录方式。解绑前发起的迟到回调须失效，但之后重新发起的授权仍可按当前归属正常处理。
- 一份认证数据库的所有启用实例须配置相同 AppID。启动时检查已有微信账号的 AppID 命名空间，发现旧格式或不一致即拒绝启动并要求先设计单独迁移；该检查不提供跨实例配置锁，不能用于无协调地运行多个 AppID。变更 AppID 或迁移旧 openid 不会自动证明同一用户。

## 验证入口与变更影响

`tests/integrations/wechat.test.ts` 使用本地响应替身检查目的地、重定向、结果大小、中止及脱敏；`tests/auth/wechat.test.ts` 使用隔离 PostgreSQL、真实认证 HTTP 和替身覆盖登录、绑定、唯一性与重放。它们不调用真实微信，不证明扫码、微信回调域登记、跨站浏览器 Cookie、生产路由或容量。变更固定版本、provider 钩子、数据库模型或上游协议时须重验这些边界；真实网站应用和浏览器联调单独记录。

QR 的回归入口沿同一认证集成测试，验收维度包括新老用户、全部状态、错配 Cookie／身份、并发 callback／poll、到期与有界清理、迁移及回滚、限流、HTTPS Cookie、禁用供应商，以及跨站 `WxLogin` iframe 单跳桥接、授权拒绝脱敏、防循环与非 iframe／HTTPS state Cookie 区分。具体候选是否通过以实际原件为准；这些测试即使通过也不代替电脑主页面、授权容器／窗口、手机扫码和真实 callback 域的浏览器验收。新增 QR schema 无论微信是否启用均由现有显式认证迁移和启动检查核对，启动不自动建表。
