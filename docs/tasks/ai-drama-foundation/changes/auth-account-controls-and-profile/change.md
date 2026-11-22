# 邮箱密码配置开关、账号禁用与用户资料扩展

```mio-change
{"version":1,"type":"feature","section":"架构前提与未决项"}
```

2026-11-22，项目负责人决定推进旧后端数据迁移（[旧数据迁移 PRD](../../../legacy-migration/prd.md)），并明确要求把迁移前置的三项认证能力合并为本次变更实施：邮箱密码登录配置开关、账号禁用与会话失效、以及用户资料字段（`displayId`、头像资产）和资料读写接口。本变更沿用 Better Auth 1.7.18、认证 PostgreSQL 与 Cookie 会话，不改写 [手机号与微信认证扩展](../phone-wechat-auth/change.md)、[微信 QR polling](../wechat-qr-polling/change.md) 或原认证底座的既有接受事实。

## 本期范围与安排

- **邮箱密码配置开关**：新增 `MIO_AUTH_EMAIL_PASSWORD_ENABLED`（默认 `true` 以保持既有测试与环境兼容，显式设 `false` 时关闭邮箱密码注册、登录与改密，对应入口 `/api/auth/sign-up/email`、`/api/auth/sign-in/email`、`/api/auth/change-password` 返回 `503 EMAIL_PASSWORD_UNAVAILABLE`，不影响短信验证码、微信扫码与现有有效会话退出/查询）。
- **账号禁用**：在 Better Auth `user` 表扩展可空布尔列 `disabled`（默认 `false`）与可空时间列 `disabledAt`。通过事务性服务方法 `Authentication.setUserDisabled(userId, disabled)` 禁用用户时，在同一事务内更新标记并删除该用户全部活动会话；所有登录路径（邮箱、手机验证码、微信 OAuth 与微信 QR）在签发会话前拒绝禁用账号（返回 `403 ACCOUNT_DISABLED`，OAuth 回调带 `ACCOUNT_DISABLED` 错误重定向且 QR 标为 `failed`）；即使存在并发或遗留会话行，`/api/v1/me`、`/api/v1/me/profile`、`Authentication.identity`、`/api/auth/get-session` 及所有受会话保护的认证接口均将其视为无效并清理会话。
- **用户资料与 `displayId`、头像资产**：在 `user` 表扩展唯一可空列 `displayId`（新注册用户自动分配 `miioo_XXXXXX` 6 位数字，迁移用户可保留原值，客户端不可伪造或改写）和可空列 `avatarAssetId`（本人 ready 图片资产 UUID）。新增 `GET /api/v1/me/profile` 与 `PATCH /api/v1/me/profile`，支持读写昵称（`name`，1–50 字符，不含控制字符）和 `avatarAssetId`（`null` 清空；非空 UUID 须经资产服务核验属于本人、状态 `ready` 且 MIME 为 `image/jpeg`、`image/png` 或 `image/webp`，未装配资产服务时返回 `503 ASSET_UNAVAILABLE`）。`GET /api/v1/me` 保持 `{userId,sessionId}` 不变。
- **历史记录同步**：在 [追加认证方案](../../pending/auth-extension.md) 与 [手机号与微信认证扩展](../phone-wechat-auth/change.md) 顶部补充指向本变更与迁移 PRD 的说明，保留原历史背景与接受范围。

不纳入本期：旧数据迁移脚本实现或执行、管理后台 C 端用户管理 HTTP 接口、向 C 端认证表增加管理员或团队角色、手机号/微信换绑与解绑、账号合并或注销、真实外部短信/微信调用、推送与部署。

## Review Contract

| 字段                    | 本期约定                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| objective               | 支持通过配置关闭邮箱密码入口、原子禁用账号并阻断登录与会话、为新用户生成唯一 `displayId` 并通过 `/api/v1/me/profile` 安全读写昵称与本人就绪图片头像资产。                                                                                                                                                                                           |
| scope / allowed_changes | `src/auth/*`、`src/plugin.ts`、`.env.example`、认证现行规范（`docs/auth.md`、`docs/apis/auth.md`）、本变更文档与索引、历史提案与变更交叉引用、以及对应认证与环境模板测试。                                                                                                                                                                          |
| obligations             | 邮箱开关关闭后注册/登录/改密全阻断且不破坏短信与微信；禁用账号无法通过任何入口签发会话、活动及残留会话立即失效、重启用可恢复；`disabled`/`disabledAt`/`displayId`/`avatarAssetId` 禁止经公开注册参数篡改；`PATCH /api/v1/me/profile` 仅允许修改 `name`/`avatarAssetId`，非空头像严格校验本人归属、ready 与图片 MIME；已有数据表的增量迁移无损通过。 |
| review_dimensions       | 正确性、身份与权限边界、向后兼容、事务与并发安全、输入校验、实现复杂度（DESIGN-OVER-001）与已有资产/请求原语复用。                                                                                                                                                                                                                                  |
| required_evidence       | 隔离真实 PostgreSQL 与真实认证 HTTP 上覆盖开关、禁用、资料、头像归属校验及存量表增量迁移的集成测试；原有认证、手机、微信、schema 隔离、环境模板与文档回归；`pnpm check:static`、打包冒烟、源码 quality-review、规范对账与覆盖 `pnpm check` 的当前有效结论。                                                                                         |
| prohibited_changes      | 不改动 `/api/v1/me` 响应契约；不向 C 端认证表添加管理员角色；不在 `src/auth` 直接导入 `src/assets`；不持久化头像签名 URL；不改写历史接受记录；不推送或部署。                                                                                                                                                                                        |
| human_confirmed         | 2026-11-22 项目负责人明确要求将邮箱密码配置开关、历史记录同步、账号禁用与用户资料字段一并纳入本次认证变更并在新分支本地实施。                                                                                                                                                                                                                       |
| ai_proposed             | 独立 `src/auth/account.ts` 插件、通过 `plugin.ts` 注入窄头像核验回调复用现有 `assets.get`、以 `503 EMAIL_PASSWORD_UNAVAILABLE` 与 `403 ACCOUNT_DISABLED` 对齐既有错误口径是实现方案，须经测试与审阅核对。                                                                                                                                           |
| open_decisions          | 管理后台未来是否开放 C 端用户禁启用 HTTP 入口由后续管理需求决定，本期仅提供事务性服务方法供迁移 M2 与未来消费方调用。                                                                                                                                                                                                                               |
| stop_condition          | 代码、迁移、规范、回归测试、quality-review、norms-review 与覆盖 `pnpm check` 的证据齐备后交回用户评审；未经真实接受不执行 `deliver complete`。                                                                                                                                                                                                      |

## 持久化与迁移

新增列全部属于 Better Auth `user` 模型，通过 `accountPlugin` 的插件 schema 进入既有 `authOptions` 与 `auth:migrate` 显式迁移及启动只读检查：

- `disabled`（boolean，可空，默认 `false`，`input: false`）
- `disabledAt`（timestamptz，可空，`input: false`）
- `displayId`（text，可空，全局唯一索引，`input: false`）
- `avatarAssetId`（text，可空，`input: false`）

升级已有认证库前须先执行 `pnpm auth:migrate --apply`（本地对应 `pnpm migrate:dev --apply` / `pnpm migrate:test --apply`）。已有用户的 `disabled` 由列默认值回填为 `false`，`displayId` 保持可空兼容，不影响既有登录与会话。

## 验收与规范归属

配置、迁移、禁用语义与服务方法归 [认证底座](../../../../auth.md)，HTTP 路由、错误码、限流与 `/api/v1/me/profile` 归 [认证 HTTP 契约](../../../../apis/auth.md)，模板配置项同步到 `.env.example`。规范正文随代码进入同一受验候选；原接受成果保持不变。
