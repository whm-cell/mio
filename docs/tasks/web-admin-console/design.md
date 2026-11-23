# Web 管理后台详细设计

关联需求：[Web 管理后台 PRD](prd.md)。关联现行规范：[管理后台 HTTP](../../apis/admin.md)、[供应商配置](../../providers.md)、[用户万联 HTTP](../../apis/providers.md)、[Redis 契约](../../integrations/redis.md)、[RabbitMQ 契约](../../integrations/rabbitmq.md)。

## 1. 模块边界与仓库拓扑

1. **后端插件服务（`mio` 仓库）**：
   - `src/auth/admin-password.ts`：在 `src/auth/` 边界内封装 `better-auth/crypto` 的 `hashPassword` 与 `verifyPassword`，供 `src/admin/` 与初始化 CLI 复用。
   - `src/providers/`：持有平台模型主表 `mio_provider_catalog_models` 与路由修订历史表 `mio_provider_model_route_revisions`（平台模型真值 100% 收敛至 `mio_provider_catalog_models` + `mio_provider_model_routes`；迁移先幂等回填历史 `mio_provider_model_policies` 与 `mio_provider_model_adaptations` 再删除两张历史表，并移除 `mio_provider_models` 已废弃的 `classification` / `classification_source` 列）。当 `MIO_ADMIN_ENABLED=true`（或显式 `MIO_PROVIDERS_CATALOG_WHITELIST=true`）时，在单条 `providerStateSQL` 快照读取与准入链路中开启平台白名单总控；并通过 `ImageParameterView`（`contracts.ts`）与 `deriveImageParameterView(route)`（`onelink/router.ts`）在 C 端 `catalogView`（`items[].image.parameters`）中以 `O(1)` 投影管理员配置的生图路由参数边界，同时在 `service.ts` 的 `listImageModels` 复用派生逻辑。
   - `src/admin/`：持有管理员账号与会话（`mio_admin_accounts`、`mio_admin_sessions`）、动态协议快捷模板（`mio_admin_route_templates`、`mio_admin_seed_history`）、上游探测缓存与忽略名单（`mio_admin_catalog_models`、`mio_admin_ignored_models`）、加密探测凭据（`mio_admin_probe_configs`）、全局运行时配置（`mio_admin_global_settings`）及操作审计（`mio_admin_audit_logs`）。
   - `src/integrations/redis.ts` 与 `src/integrations/rabbitmq-monitor.ts`：分别提供物理隔离于业务主连接的 Redis 只读探针 `probeRedisMetrics` 与 RabbitMQ Management HTTP 只读探针 `probeRabbitmqMetrics`。
2. **独立管理前端（同级 `mio-admin-web` 工程）**：
   - 采用 Vite + React + TypeScript + Tailwind CSS + Lucide Icons，前后端生产源码零硬编码模型清单或快捷模板；所有协议模板、推荐尺寸/比例与支持驱动列表均实时从 `/api/v1/admin/templates` 动态读取。

## 2. 数据库结构与关键不变量

### 2.1 平台模型主表与白名单总控（`MIO_PROVIDERS_DATABASE_URL`）

- **`mio_provider_catalog_models`**（主键 `(provider_type, raw_model_id)`，C collation）：
  - 字段：`display_label`、`vendor_label`、`category`、`description`、`supplier_metadata`、`user_visible`、`allow_undiscovered`、`call_notes`、`origin_source`（`onelink-import | admin-manual | route-import`）、`updated_by`、`created_at`、`updated_at`。
  - **白名单总控语义与单一写入面**：开启 `catalogWhitelist` 时，普通用户调用 `GET /api/v1/providers/onelink/models`、`selectChat`、`snapshotImage`、`listImageModels` 或 `PATCH /models` 时，若该型号不在 `mio_provider_catalog_models` 中或 `user_visible = false`，列表直接过滤剔除、调用直接返回 `409 MODEL_HIDDEN`。管理员通过 `PATCH /api/v1/admin/models` 统一维护模型元数据与可见性/补录策略（已退役 `PUT /api/v1/admin/models/policy`；`GET /api/v1/admin/models` 继续返回由 `mio_provider_catalog_models` 派生的嵌套 `policy` 视图字段，历史 `mio_admin_audit_logs` 中的 `model.policy.upsert` 记录继续保留有效）；在后台删除某模型时，同步级联删除其 `mio_provider_model_routes`（写入 `action = 'delete'`、`after_route = NULL` 的修订快照），普通用户侧即时不可见且不可调用。
  - **纯读单语句不变量**：`ProviderStore.state()` 保持单条 `SELECT c.*, ...` MVCC 只读语句；`allow_undiscovered = true AND user_visible = true` 的隐藏补录型号仅在写事务（后台创建/编辑/导入模型、用户完成目录刷新或启用配置）中幂等物化至 `mio_provider_models`。
  - **C 端生图参数边界投影与工具契约隔离**：`catalogView`（`GET /api/v1/providers/onelink/models`）在既有单次查询内存映射内为每个型号输出 `image.parameters`：`imageRoute?.asyncReady` 为真时调用 `deriveImageParameterView(imageRoute.route)` 返回完整 20 字段 `ImageParameterView`（含防御性数组拷贝），纯对话型号与未就绪 `ADAPTER_PENDING` 路由返回 `null`；原有 `deriveImageCapabilityMetadata` 与落库 `capability_metadata` JSONB 保持不变。`ProviderService.listImageModels` 复用 `deriveImageParameterView` 与平台 `display_label` 名称回退，但显式仅投影 `ConversationImageModelSummary` 的 19 个字段，严格满足对话生图工具 `list_image_models` 输出 schema 的 `additionalProperties: false` 约束。

### 2.2 动态协议快捷模板与新库一次性种子（`MIO_PROVIDERS_DATABASE_URL`）

- **`mio_admin_seed_history` & `mio_admin_route_templates`**：
  - `mio_admin_route_templates` 存储 `id uuid PK`、`template_key UNIQUE`、`label`、`description`、`operation`、`vendor`、`driver`、`route_template jsonb`（不含写死 `rawModelId`）、`ui_hints jsonb`（`recommendedSizes`、`recommendedAspectRatios` 等动态 UI 选项）、`sort_order`。
  - **防覆盖与防复活机制**：仅当 `mio_admin_seed_history` 不存在 `route_templates_v1` 时，首次迁移写入 7 套原厂驱动基础模板并登记 `route_templates_v1`；此后管理员在后台修改或删除任意默认模板，重复执行 `admin:migrate --apply` 绝不覆盖修改或复活已删记录。所有模板写入前统一经 `validateModelRouteEntry` 校验协议合法性。

### 2.3 OneLink 预览导入与忽略记忆

- `POST /api/v1/admin/onelink/discover` 使用内存临时 Key 或加密保存的探测 Key 拉取上游 `/v1/models`，仅刷新候选快照缓存 `mio_admin_catalog_models` 并对照 `mio_provider_catalog_models` 与 `mio_admin_ignored_models` 返回每项的 `importState`（`new | existing | ignored`），**不自动向平台模型主表插入未确认模型**。
- 管理员在前端勾选所需型号后调用 `POST /api/v1/admin/models/import` 正式入库；删除模型时若勾选 `ignoreFutureImports: true`，该 ID 记入 `mio_admin_ignored_models`，后续重新探测时自动归入 `ignored` 分组且默认不勾选。

### 2.4 全局配置热更新与边界隔离（`admin-global-settings`）

- **`mio_admin_global_settings`**（`MIO_PROVIDERS_DATABASE_URL`）：
  - 主键 `setting_key text CHECK (setting_key = 'auth')`，`value jsonb CHECK (jsonb_typeof(value) = 'object')`，乐观锁 `revision integer DEFAULT 1 CHECK (revision >= 1)`，`updated_by`、`created_at`、`updated_at`。
  - **启动水合与内存热生效**：`createAdminStore` 在 `checkAdminSchema` 之后同步预读已有 `'auth'` 行至 `store.initialAuthSettings`，`createAdminService` 构造时即完成内存 `AuthRuntimePolicy` 水合；`src/plugin.ts` 通过窄只读回调 `getAuthPolicy` 将策略注入 `createAuthentication` 与 `createAuthHandler`，并确保 `AUTH_BASE_PATH` 路由在 `admin` 完成水合后注册，保持 `src/auth/*` 绝不导入 `src/admin/*`。未启用管理后台时回退至 `MIO_AUTH_EMAIL_PASSWORD_ENABLED` 与 `smsMode: 'live'`。
  - **严格校验、并发控制与脱敏审计**：`PATCH /api/v1/admin/settings/global` 在单事务内按 `expectedRevision` 执行乐观锁写入（`0` 走 `INSERT ... ON CONFLICT DO NOTHING`，`>0` 走 `SELECT ... FOR UPDATE` + `UPDATE ... WHERE revision = $3`，冲突抛 `409 SETTINGS_CONFLICT`），同事务写入 `action = 'settings.global.update'`、`target_id = 'auth'` 的审计日志，且仅记录 `smsBypassCodeMasked`（前两位 + `****` 或 `null`），绝不在 `summary`、`before_state`、`after_state` 持久化固定测试验证码明文；事务提交后立即刷新内存快照。
  - **认证侧路由语义与不变量**：Better Auth 始终以 `emailAndPassword.enabled = true` 挂载邮箱密码路由，由 `createAuthHandler` 按 `readPolicy().emailPasswordEnabled` 热门控 `503 EMAIL_PASSWORD_UNAVAILABLE`；`phonePlugin` 按 `readPolicy().smsMode` 分流：`disabled` 拦截全部 4 个手机入口返回 `503 SMS_UNAVAILABLE`；`bypass` 仅放行 `/phone-number/send-otp`（校验输入、已配置合法 6 位固定测试码与 IP，跳过短信供应商与预算）与 `/phone-number/verify`（`timingSafeEqual` 校验 6 位固定测试码并执行原登录/禁用校验/自动建号流程，保留路由限流），`/phone-binding/*` 不跟随 `bypass`。不开放 `GET /api/auth/methods` 或任何新的 C 端探测接口；管理前端在独立「全局配置」菜单页提供配置表单。

## 3. 中间件完整档只读监控与最小权限隔离

1. **RabbitMQ 完整档监控**：
   - 本地通过 `pnpm monitor:init:dev`（`scripts/service/init-admin-monitors.ts`）预置专用只读账号 `mio-<env>-monitor`（`tags = "monitoring"`，对 `mio-<env>` vhost 的 `configure/write/read` 均为 `^$`，无权收发消息或改动队列拓扑），通过 `MIO_ADMIN_RABBITMQ_MONITOR_URL` 注入。
   - 并发只读请求 Management HTTP `/api/overview`、`/api/nodes` 与 `/api/queues/<vhost>`，结合媒体库 `mio_compute_jobs`、`mio_compute_outbox` 与 `mio_compute_inbox` 输出连接/通道、速率、节点内存/磁盘告警、各队列 Ready/Unacked/Consumers、`.dlq` 死信积压与 Outbox 待发滞留时长。
2. **Redis 完整档监控**：
   - `deploy/local/redis-start.sh` 在配置 `MIO_LOCAL_REDIS_MONITOR_PASSWORD` 时生成独立 ACL 账号：
     `user mio_monitor on >... resetkeys -@all +hello +auth +ping +client|setinfo +time +dbsize +info`
     `resetkeys` 确保该账号对所有业务键值零访问权限。
   - `probeRedisMetrics` 使用独立短生命周期客户端连接，绝不与认证限流 `RedisResource` 共享连接或错误熔断状态，采集 `PING` RTT、`TIME` 时钟偏差（核对 `< 2000ms` 护栏）、`DBSIZE` 活跃键总数、`used_memory / maxmemory` 水位与 `noeviction` OOM 风险、客户端连接数、每秒 OPS 及 AOF 持久化状态。
