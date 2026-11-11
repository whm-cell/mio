# HTTP API 领域导航

按受影响领域展开接口正文，不维护第二份手工接口清单。接口以域文件中的 `## METHOD /path` 标题唯一定位，各有身份、输入、成功、错误、副作用段；文档检查核对重复身份、字段和本地标题链接。尚未实现的接口留在需求/设计。

- [Foundation](foundation.md)：服务探针、部署服务凭据和能力查询。
- [认证](auth.md)：邮箱密码注册登录、持久会话与可信用户身份。
- [对话](conversations.md)：用户归属的本地对话、持久回执、历史、SSE 与取消。
- [用户万联](providers.md)：本人 Key、启停/水印、持久模型偏好与显式目录发现。
- [用户资产](assets.md)：本人私有直传、确认和短期下载。
- [计算任务](compute.md)：本人资产的固定转码任务、幂等受理及状态查询。

外部响应、Cookie 与 Bearer 的语义仍分别随域维护。配置、迁移与可信身份见[认证底座](../auth.md)，实际路由与行为仍需源码审阅及入口测试；文档结构检查不证明实现语义一致。

## 运行时公共能力

[响应原语](../../src/http-response.ts)供 [Foundation `createHandler`](../../src/http.ts) 与[认证 `createAuthHandler`](../../src/auth/http.ts)实际调用，只公开两个函数：

- `startHttpResponse(response): string` 每个请求在适配器入口调用一次，生成服务端 UUID 请求标识并设置 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 与 `X-Request-Id`，返回该标识。
- `writeApiError(response, status, detail, contentType): void` 将运行时独立的 [ApiError](../../src/contracts.ts) 的 `error` 明细序列化为 `{error: detail}`；调用方传入同一个请求标识、原有错误码/消息，以及 `application/json` 或 `application/json; charset=utf-8`。

后续业务 HTTP 适配器可复用这两个函数处理本服务定义的包装错误；成功 JSON、204 空体、CORS、认证和原始库响应继续由各适配器维护，具体 HTTP 判据只在所属域声明。原始响应或其他协议有不同语义时保留独立实现并说明理由。该模块只使用 Node HTTP 类型、UUID 能力和 `ApiError` 类型，依赖方向与静态检查范围见[源码护栏](../engineering/source-guardrails.md)。

响应原语不解析身份、不访问数据库。后续业务从装配入口注入 `Authentication.identity(headers)`，把验证后的主体交给应用服务，再验证项目/资源归属；当前消费者与禁止信任请求体身份的边界见[认证职责](../auth.md#职责与限制)。
