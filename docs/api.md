# Foundation API v1

当前只提供服务探针与能力查询。没有会话、消息、生成任务、流式事件或文件接口。后续 API 的业务语义需要另行确定。

| 方法与路径                 | 认证   | 成功响应                                                               |
| -------------------------- | ------ | ---------------------------------------------------------------------- |
| `GET /healthz`             | 无     | `{"status":"ok","service":"mio-foundation"}`                           |
| `GET /readyz`              | 无     | `{"status":"ready","instanceId":"每次插件激活生成的 UUID"}`            |
| `GET /api/v1/capabilities` | Bearer | `{"apiVersion":"v1","stage":"foundation","tools":[],"sessions":false}` |

`readyz` 只有配置有效且插件已装载才存在。它证明基础插件就绪，不证明模型、业务数据库或生成供应商可用。端口打开本身不能替代该检查。

认证使用部署注入的 `MIO_API_TOKEN`，至少 32 个 URL-safe 字符，要求精确的 `Authorization: Bearer <token>`。这是单信任域服务凭据；不能放入公开前端构建或当作 SaaS 用户登录方案。浏览器联调只能由受信任操作者在运行时提供开发凭据。多用户认证与每个会话/资产的授权尚未实现。

`MIO_ALLOWED_ORIGINS` 是精确 Origin 字符串的 JSON 数组，默认 `[]`。存在 Origin 请求头时必须匹配；无 Origin 的服务调用仍需 Bearer。CORS 不代替认证。允许的 OPTIONS 预检无须 Bearer，实际查询必须认证；只允许 GET 和 Authorization 请求头，不启用 Cookie 凭据。

已知路由不支持的方法返回 405，未知 mio API 返回 404，凭据缺失/不符返回 401，Origin 不允许返回 403。错误为 `{"error":{"code":"...","message":"...","requestId":"..."}}`；服务器生成的请求标识也在 `X-Request-Id` 中返回。不返回 token、异常栈或内部路径。所有响应禁止缓存。

插件卸载后撤销自身路由与执行守卫；其他插件生命周期由 DSH 管理。部署只使用当前完整 Profile；不能把此插件加载到含任意工具或不受信任插件的通用 Web 配置后，仍宣称整实例具备相同隔离。

下一接口切片须确定：调用者与会话归属、提交凭据与执行完成的区别、事件传输/重连、取消语义、持久化恢复，以及真实业务副作用。这里不预置这些接口或状态机。
