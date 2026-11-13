# 微信网站应用登录契约

## 适用范围与接入事实

本契约适用于 Mio 的微信**网站应用**扫码登录与当前用户首次显式绑定。固定 Better Auth 1.7.18 负责授权地址、state、账号和会话；[微信适配器](../../src/integrations/wechat.ts)只完成服务端的授权码兑换和用户资料请求，[认证插件](../../src/auth/wechat.ts)补充本期身份和并发保护。短信、账号归属和 HTTP 行为分别见[认证底座](../auth.md)与[认证 HTTP 契约](../apis/auth.md)。

服务端通过 `MIO_AUTH_WECHAT_ENABLED=true`、`MIO_AUTH_WECHAT_APP_ID` 和 `MIO_AUTH_WECHAT_APP_SECRET` 启用；配置缺项或不合法时拒绝装载，默认关闭。固定 `MIO_AUTH_BASE_URL` 的 `/api/auth/callback/wechat` 是回调，微信开放平台的授权回调域与实际 HTTPS 代理必须与该地址匹配，不能从请求头推导。AppID 与 secret 不进入前端构建、公共日志或仓库。配置存在不代表微信平台、域名路由或浏览器链路已经验证。

## 必须遵守的约束

- 服务端只请求 `https://api.weixin.qq.com/sns/oauth2/access_token` 和 `/sns/userinfo`，每次请求使用 5 秒真实中止期限，响应最多保留 32 KiB，超限取消读取，拒绝重定向和自动重试。非成功状态也取消读取；供应商异常统一脱敏。请求 URL 可能包含 secret 或 token，不记录原始 URL、正文或异常。
- 账号主体以网站应用 AppID 与微信返回的 openid 固定组成；兑换结果和用户资料的 openid 必须一致。unionid 有无变化不改变主体，不按昵称或邮箱推断同人。微信不提供已验证邮箱，系统生成 `wechat-…@auth.mio.invalid` 占位值；该域不可用邮箱密码注册，不能当作联系邮箱或所有权证明。
- 授权由发起浏览器的签名 state Cookie 和库的数据库 state 共同校验；回调进入兑换前以 PostgreSQL 保留记录限制并发重放，失败后需重新发起。绑定在回调执行权威会话核验时，要求发起会话仍有效且当前浏览器使用同一 userId 和 sessionId。核验已通过的在途绑定不会因并发退出或撤销自动取消，可能在撤销成功后完成；后续请求仍受撤销约束。OAuth token 使用认证 secret 加密后保存在认证库，不交给浏览器或写日志。
- 一份认证数据库的所有启用实例须配置相同 AppID。启动时检查已有微信账号的 AppID 命名空间，发现旧格式或不一致即拒绝启动并要求先设计单独迁移；该检查不提供跨实例配置锁，不能用于无协调地运行多个 AppID。变更 AppID 或迁移旧 openid 不会自动证明同一用户。

## 验证入口与变更影响

`tests/integrations/wechat.test.ts` 使用本地响应替身检查目的地、重定向、结果大小、中止及脱敏；`tests/auth/wechat.test.ts` 使用隔离 PostgreSQL、真实认证 HTTP 和替身覆盖登录、绑定、唯一性与重放。它们不调用真实微信，不证明扫码、微信回调域登记、跨站浏览器 Cookie、生产路由或容量。变更固定版本、provider 钩子、数据库模型或上游协议时须重验这些边界；真实网站应用和浏览器联调单独记录。
