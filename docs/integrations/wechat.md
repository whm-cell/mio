# 微信网站应用登录契约

## 适用范围与接入事实

本契约适用于 Mio 的微信**网站应用**扫码登录与当前用户首次显式绑定。固定 Better Auth 1.7.18 负责授权地址、state、账号和会话；[微信适配器](../../src/integrations/wechat.ts)只完成服务端的授权码兑换和用户资料请求，[认证插件](../../src/auth/wechat.ts)补充本期身份和并发保护。短信、账号归属和 HTTP 行为分别见[认证底座](../auth.md)与[认证 HTTP 契约](../apis/auth.md)。

匿名 QR polling 复用同一 OAuth 与 Session 流程：[QR 插件](../../src/auth/wechat-qr.ts)发起授权并提供状态查询，[QR 存储](../../src/auth/wechat-qr-store.ts)保存短期关联与原子消费。电脑主页面保持打开，由同一浏览器的授权窗口展示微信授权页、完成 callback 并取得 Session Cookie，主页面再轮询确认。授权 URL 不是可脱离微信页面加载的二维码图片；本期不提供手机端独立 callback 后向电脑重新发放凭据的跨设备 state 模型，也不承诺 iframe 在真实微信页面的可嵌入性。

服务端通过 `MIO_AUTH_WECHAT_ENABLED=true`、`MIO_AUTH_WECHAT_APP_ID` 和 `MIO_AUTH_WECHAT_APP_SECRET` 启用；配置缺项或不合法时拒绝装载，默认关闭。固定 `MIO_AUTH_BASE_URL` 的 `/api/auth/callback/wechat` 是回调，微信开放平台的授权回调域与实际 HTTPS 代理必须与该地址匹配，不能从请求头推导。AppID 与 secret 不进入前端构建、公共日志或仓库。配置存在不代表微信平台、域名路由或浏览器链路已经验证。

## 必须遵守的约束

- 服务端只请求 `https://api.weixin.qq.com/sns/oauth2/access_token` 和 `/sns/userinfo`，每次请求使用 5 秒真实中止期限，响应最多保留 32 KiB，超限取消读取，拒绝重定向和自动重试。非成功状态也取消读取；供应商异常统一脱敏。请求 URL 可能包含 secret 或 token，不记录原始 URL、正文或异常。
- 账号主体以网站应用 AppID 与微信返回的 openid 固定组成；兑换结果和用户资料的 openid 必须一致。unionid 有无变化不改变主体，不按昵称或邮箱推断同人。微信不提供已验证邮箱，系统生成 `wechat-…@auth.mio.invalid` 占位值；该域不可用邮箱密码注册，不能当作联系邮箱或所有权证明。
- 授权由发起浏览器的签名 state Cookie 和库的数据库 state 共同校验；回调进入兑换前以 PostgreSQL 保留记录限制并发重放，失败后需重新发起。绑定在回调执行权威会话核验时，要求发起会话仍有效且当前浏览器使用同一 userId 和 sessionId。核验已通过的在途绑定不会因并发退出或撤销自动取消，可能在撤销成功后完成；后续请求仍受撤销约束。OAuth token 使用认证 secret 加密后保存在认证库，不交给浏览器或写日志。
- QR 会话有效 5 分钟，独立 QR Cookie 与 OAuth state 仅以摘要进入 QR 表；库自身数据库 state 仍按原策略管理，不以 QR 存储规则改写。QR Cookie 精确限定到单个 ID 的 poll 路径，保留 15 分钟以便过期观察；每次创建最多删除 100 条过期至少 10 分钟的记录。清理后旧 ID 为未知，不保留永久状态查询。
- QR callback 复用签名 state Cookie 和原子重放保留，过期 QR 在兑换前拒绝。只有本次 callback 的新 Session 才能确认 QR；用户拒绝参数对 QR 路线脱敏为 `WECHAT_AUTH_FAILED`，供应商细节不返回轮询。错误浏览器 Cookie 或重复 callback 不覆盖正常 QR 结果。poll 取得 confirmed 前须核对数据库有效 Session 的 userId 与确认用户一致，并在行锁事务内转为 consumed；poll 不创建或转发 Session，普通登录与绑定仍由原入口负责。
- 一份认证数据库的所有启用实例须配置相同 AppID。启动时检查已有微信账号的 AppID 命名空间，发现旧格式或不一致即拒绝启动并要求先设计单独迁移；该检查不提供跨实例配置锁，不能用于无协调地运行多个 AppID。变更 AppID 或迁移旧 openid 不会自动证明同一用户。

## 验证入口与变更影响

`tests/integrations/wechat.test.ts` 使用本地响应替身检查目的地、重定向、结果大小、中止及脱敏；`tests/auth/wechat.test.ts` 使用隔离 PostgreSQL、真实认证 HTTP 和替身覆盖登录、绑定、唯一性与重放。它们不调用真实微信，不证明扫码、微信回调域登记、跨站浏览器 Cookie、生产路由或容量。变更固定版本、provider 钩子、数据库模型或上游协议时须重验这些边界；真实网站应用和浏览器联调单独记录。

QR 的回归入口沿同一认证集成测试，验收维度包括新老用户、全部状态、错配 Cookie／身份、并发 callback／poll、到期与有界清理、迁移及回滚、限流、HTTPS Cookie 与禁用供应商。具体候选是否通过以实际原件为准；这些测试即使通过也不代替电脑主页面、授权窗口、手机扫码和真实 callback 域的浏览器验收。新增 QR schema 无论微信是否启用均由现有显式认证迁移和启动检查核对，启动不自动建表。
