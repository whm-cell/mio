# Foundation HTTP 契约

[API 领域导航](index.md)。本域提供探针与服务凭据能力查询；账号与可选对话分别见[认证域](auth.md)和[对话域](conversations.md)，不从本域服务 token 推导用户授权。生成任务与文件接口未实现。

## 本域共同约定

`readyz` 只有配置有效且插件已装载才存在。它证明基础插件就绪，不证明模型、业务数据库或生成供应商可用。端口打开本身不能替代该检查。

本域的认证使用部署注入的 `MIO_API_TOKEN`，至少 32 个 URL-safe 字符，要求精确的 `Authorization: Bearer <token>`。这是单信任域服务凭据；不能放入公开前端构建或当作 SaaS 用户登录方案。浏览器联调只能由受信任操作者在运行时提供开发凭据。用户会话由认证入口单独验证；项目/资产授权尚未实现。

本域的 `MIO_ALLOWED_ORIGINS` 是精确 Origin 字符串的 JSON 数组，默认 `[]`。存在 Origin 请求头时必须匹配；无 Origin 的服务调用仍需 Bearer。CORS 不代替认证。允许的 OPTIONS 预检无须 Bearer，实际查询必须认证；只允许 GET 和 Authorization 请求头，不启用 Cookie 凭据。认证路由和 `/api/v1/me` 采用另行声明的 Origin/会话 cookie 契约。

本域的已知路由不支持的方法返回 405，未知 mio API 返回 404，凭据缺失/不符返回 401，Origin 不允许返回 403。无效 Origin 先于路由、方法和凭据处理而拒绝；无 Origin 的已知 OPTIONS 仍可返回 204，未知 OPTIONS 为 404。错误为 `{"error":{"code":"...","message":"...","requestId":"..."}}`；服务器生成的请求标识也在 `X-Request-Id` 中返回，包装错误的头体标识一致。不返回 token、异常栈或内部路径。所有响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 与 `Content-Type: application/json; charset=utf-8`，包括无正文的 204 预检。共同实现入口见[运行时公共能力](index.md#运行时公共能力)。

插件卸载后撤销自身路由与执行守卫；其他插件生命周期由 DSH 管理。部署只使用当前完整 Profile；不能把此插件加载到含任意工具或不受信任插件的通用 Web 配置后，仍宣称整实例具备相同隔离。

## GET /healthz

身份：无用户或服务凭据。

输入：无正文；存在 Origin 时遵循本域精确白名单。

成功：200：`{"status":"ok","service":"mio-foundation"}`。

错误：遵循本域错误体；Origin 不允许为 403，已知路由方法不支持为 405；能力查询凭据缺失或不符为 401。未知 mio API 为 404。

副作用：只读探针或能力查询；不创建业务资源，所有响应禁止缓存。

## GET /readyz

身份：无用户或服务凭据。

输入：无正文；存在 Origin 时遵循本域精确白名单。

成功：200：`{"status":"ready","instanceId":"每次插件激活生成的 UUID"}`。仅表示本次插件装载就绪。

错误：遵循本域错误体；Origin 不允许为 403，已知路由方法不支持为 405；能力查询凭据缺失或不符为 401。未知 mio API 为 404。

副作用：只读探针或能力查询；不创建业务资源，所有响应禁止缓存。

## GET /api/v1/capabilities

身份：部署注入的服务 Bearer 凭据；不是用户身份。

输入：无正文；存在 Origin 时遵循本域精确白名单。

成功：200：`{"apiVersion":"v1","stage":"foundation","tools":[],"sessions":false}`；显式配置并装载本地对话入口时 sessions 为 true，它不表示真实模型可用或生产接受。

错误：遵循本域错误体；Origin 不允许为 403，已知路由方法不支持为 405；能力查询凭据缺失或不符为 401。未知 mio API 为 404。

副作用：只读探针或能力查询；不创建业务资源，所有响应禁止缓存。
