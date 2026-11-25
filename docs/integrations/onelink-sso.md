# 万联 OneLink SSO 集成契约

## 适用范围与接入事实

本契约适用于 Mio 服务端接入万联 OneLink SSO 的环境配置读取、管理端运行期热开关、客户端注册出站调用与只读策略快照边界。实际接入入口为[OneLink SSO 集成模块](../../src/integrations/onelink/sso.ts)、[管理端配置与服务](../../src/admin/service.ts)、[管理端持久化](../../src/admin/store.ts)、[认证只读策略类型](../../src/auth/config.ts)与[插件装配](../../src/plugin.ts)；管理 HTTP 入口见[管理后台契约](../apis/admin.md)，完整需求与安全边界见[万联第三方登录 PRD](../tasks/onelink-login/prd.md)。

当前单元测试与单元 ①（`admin-onelink-sso`）覆盖服务端环境变量解析、管理域配置表 `mio_admin_onelink_sso_config` 显式迁移、按环境乐观锁热更新、单次受控客户端注册及向认证域提供只读 `OneLinkSsoPolicyReader`；C 端授权发起、回调解析与账号绑定入口分别由后续开发单元交付。

## 必须遵守的约束

- **环境变量与 fail-closed 校验**：必需配置组为 `MIO_ONELINK_SSO_ENC_KEY`、`MIO_ONELINK_SSO_AUTHORIZE_URL` 与 `MIO_ONELINK_SSO_REGISTER_URL`，模板占位见[.env.example](../../.env.example)。三项均未定义时视为未配置并返回 `undefined`；任一项已定义时三项均须非空且合法，否则以 `ONELINK_SSO_CONFIG` 拒绝启动。`MIO_ONELINK_SSO_ENC_KEY` 须为精确 32 位可打印非空白 ASCII 字符（`/^[\x21-\x7e]{32}$/`，精确 32 字节 UTF-8，用于 AES-256-GCM 加密，拒绝非 32 位、空白、控制字符与多字节 UTF-8）；授权与注册 URL 须为无用户凭据的 `https:` 地址（仅测试回环主机 `localhost`、`127.0.0.1`、`[::1]` 允许 `http:`）。可选变量 `MIO_ONELINK_SSO_CLIENT_NAME`（默认 `miioo`，`1..50` 字符、无空白/控制字符且禁止 `routerClientId`）、`MIO_ONELINK_SSO_APP_NAME`（默认 `Miioo`，`1..50` 非空字符、无控制字符）与 `MIO_ONELINK_SSO_ENV`（默认取 `MIO_ENVIRONMENT` 或 `dev`，匹配 `^[A-Za-z0-9_.-]{1,32}$`）。已配置 OneLink SSO 但未启用认证域时拒绝装载插件。
- **固定出站客户端注册**：`registerOneLinkSsoClient` 仅向配置的 `registerUrl` 发送 `POST`，请求头为 `application/json`，正文固定为 `{"clientName": "<config.clientName>"}`。单次请求强制 10 秒真实中止期限（与外部取消信号组合，服务关闭时立即中止在途请求）、响应体上限 32 KiB（超限取消读取）、`redirect: 'error'` 且零自动重试。管理端以进程内单飞守卫阻止并发注册（并发请求返回 `409 ONELINK_REGISTER_IN_PROGRESS`）。
- **响应判别与状态保留**：仅当 HTTP 为 2xx、业务码 `code === 200`、存在合法非空 `data.clientId`（`1..128` 字符、无空白/控制字符、非 `routerClientId` 且不含密钥）且可选 `data.clientName` 与本环境 `clientName` 一致时判定为 `registered`；业务码 `362` 判定为 `already_exists`（不阻塞，保留既有 `enabled`、`expectedClientId` 与已有 `clientId`，尚无 `clientId` 时按 `expectedClientId ?? clientName` 标记为 `trusted_existing`）；`363` 与 `364` 映射为脱敏拒绝码 `ONELINK_CLIENT_NAME_INVALID` / `ONELINK_CLIENT_TEMPLATE_MISSING`；其余 HTTP/业务/网络/体积/超时/重定向异常统一归类为 `ONELINK_REGISTER_UPSTREAM_FAILED`。`rejected` 与 `failed` 绝不覆盖现有可用配置或登记状态。
- **严格脱敏与密钥隔离**：`MIO_ONELINK_SSO_ENC_KEY` 仅停留在服务端进程配置中，严禁入库、写入仓库、进入日志、审计或任何 HTTP 响应（管理接口仅回传布尔值 `hasEncryptionKey` 与不含凭据的 `authorizeOrigin` / `registerOrigin`）。上游原始响应正文与错误消息绝不透传或入库；失败审计 `onelink.sso.register_failed` 仅记录 `code` 与经脱敏校验的 `traceId`。
- **模块边界与默认关闭热开关**：`src/auth/*` 绝不导入 `src/admin/*`。管理域负责持久化配置表并在启动及每次读写/注册提交后刷新内存策略快照，`src/plugin.ts` 将窄只读回调 `OneLinkSsoPolicyReader` 注入认证域。各环境热开关默认 `enabled: false`；未配置服务端 `.env` 必需组时管理端拒绝开启（`400 ONELINK_SSO_NOT_CONFIGURED`），且策略快照始终要求配置就绪与 `enabled === true` 同时成立。允许的客户端标识集合由 `resolveAllowedOneLinkClientIds` 统一解析，任何情况下排除中间态 `routerClientId`。

## 使用经验与适用条件

- **v1 令牌校验模式（`payload_sub_unverified`）安全声明**：管理接口 `runtime.tokenVerificationMode` 明确返回 `payload_sub_unverified`。v1 阶段万联回调仅对 JWT payload 执行 Base64URL 解码与 `sub`/`exp`/`client_id`（拒绝 `routerClientId`）结构语义校验，**不执行密码学验签，也不发起万联在线令牌自省**。该模式无法防御不可信公网直接向回调接口提交伪造三段式 JWT 的攻击，因此默认关闭运行期热开关，仅适用于受控开发、测试与管理端验证沙箱；面向公网生产开放前须补充正式验签或在线自省能力，或在完成风险评审后按环境严格控制热开关开放范围。
- **表迁移与热开关一致性**：`mio_admin_onelink_sso_config` 由显式迁移脚本 `pnpm admin:migrate --apply` 创建，启动阶段由 `checkAdminSchema` 核对全部列类型，启动不自动建表。`PATCH /api/v1/admin/onelink/sso` 采用基于 `revision` 的乐观锁并在事务提交后即时更新内存快照，无需重启服务。

## 验证入口与变更影响

- [OneLink SSO 集成单测](../../tests/integrations/onelink-sso.test.ts)使用本地 HTTP 替身覆盖环境变量解析（未配置、缺项 fail-closed、非法 URL/密钥、合法配置）及注册请求（`200`/`362`/`363`/`364`、非法 `200` 缺 `clientId`、重定向拒绝、超过 32 KiB 响应拒绝、超时中止与零密钥泄露）。
- [管理端 OneLink SSO 测试](../../tests/admin/onelink-sso.test.ts)使用隔离 PostgreSQL、真实管理 HTTP 路由与可注入注册传输，覆盖默认只读状态、乐观锁与并发冲突 `409`、未配置拒开 `400`、`routerClientId` 拒绝、内存策略快照即时刷新、重启 Hydration、单飞互斥 `409`、脱敏审计及未认证/普通用户/非法 `Origin` 拒绝。
- 上述自动化测试均不访问真实万联线上或测试环境，也不证明真实浏览器 Cookie 隔离、内网穿透 HTTPS 回调或线上验签契约。变更环境变量命名、注册请求/响应协议、`allowedClientIds` 解析或 `mio_admin_onelink_sso_config` 表结构时，须同步更新本契约、[管理后台契约](../apis/admin.md)及对应回归测试。
