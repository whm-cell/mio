# Web 管理后台（动态模板、模型主表 CRUD 与白名单总控、运行及基础设施监控、管理员账号）PRD

状态：Unit 1（`web-admin-console`）实施推进中。详细表结构、鉴权加密边界与前后端职责见[详细设计](design.md)。关联权威规范：[管理后台 HTTP](../../apis/admin.md)、[供应商配置](../../providers.md)、[用户万联 HTTP](../../apis/providers.md)、[认证底座](../../auth.md)、[常驻环境](../../local-environments.md)、[Redis 契约](../../integrations/redis.md)、[RabbitMQ 契约](../../integrations/rabbitmq.md)、[协调协议](../../coordination.md#当前任务的生命周期)。返回[任务资料与成果](../index.md)。

## 1. 背景与目标

现行 Mio 已通过 `mio_provider_model_routes` 将上游原厂协议驱动与逐型号参数规格解耦（见[万联原厂协议路由 PRD](../onelink-vendor-routing/prd.md)），但平台侧仍需要完整的可视化治理与基础设施观测能力：

1. **前后端零写死与全动态基础配置**：路由协议快捷模板及尺寸/比例推荐选项不得写死在前端或后端生产源码中，须作为新数据库首次迁移预留的基础配置落库，并支持管理员在后台对模板完整增删改查。
2. **平台模型主表白名单总控与完整 CRUD**：管理员可使用任意 OneLink API Key 拉取上游 `/v1/models` 预览候选列表并勾选导入，对平台模型目录执行完整增、删、改、查；启用管理后台或平台白名单总控时，仅在平台模型主表中已存在且开启可见（`user_visible = true`）的型号才向普通用户开放展示与调用。
3. **隐藏模型双向治理**：一方面可将平台已导入但不对外开放的型号设为对普通用户隐藏屏蔽；另一方面可手动新建 OneLink `/v1/models` 未列出但实际可调的隐藏型号（`allow_undiscovered = true`）并维护实际调用要求备注（`call_notes`）与路由参数。
4. **在线审计回滚、业务监控与 RabbitMQ/Redis 完整档监控**：记录每次模型/模板/路由变更与删除修订，并提供跨库生图/对话/计算 Outbox 运行监控，以及独立最小权限账号驱动的 RabbitMQ（完整档）与 Redis（完整档）实时健康看板。

本需求在 `mio` 后端建立独立管理员认证、动态协议快捷模板、平台模型主表 CRUD 与白名单门控、路由版本历史及跨库/中间件只读运行监控 API，并在同级独立前端工程 `mio-admin-web`（Vite + React + TypeScript）交付完整的 Web 管理控制台。

## 2. 已确认 C0 决策与范围边界

| 决策项                      | 已确认结论（人类决策）                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端技术栈与登录体验        | 同级独立前端工程 `mio-admin-web`（Vite + React + TypeScript + Tailwind CSS）；登录页支持「记住账号密码」（`localStorage` 方案 B），修改本人账号用户名或密码后同步更新本地保存记录                                                                                                                                                                                                                                                                                                             |
| 超级管理员账号              | 建立独立于 C 端普通用户的管理员账号体系；本地 `mio_dev` 预置超级管理员用户名 `miioo_admin`、初始密码 `miioo_admin`（源码不硬编码生产口令）；后台支持修改本人用户名与密码（修改密码须校验原始密码）                                                                                                                                                                                                                                                                                            |
| 零写死与动态快捷配置模板    | 移除前端写死的模板文件与尺寸/比例常量；新库首次迁移仅预留 7 套原厂协议快捷模板（含 UI 推荐选项）至 `mio_admin_route_templates`（通过 `mio_admin_seed_history` 防重复迁移覆盖或复活已删模板），后台提供完整模板增删改查                                                                                                                                                                                                                                                                        |
| 平台模型白名单总控与 CRUD   | 建立平台模型主表 `mio_provider_catalog_models`，平台模型真值完全收敛至 `mio_provider_catalog_models` + `mio_provider_model_routes`（退役冗余 `mio_provider_model_policies`、`mio_provider_model_adaptations`、`mio_provider_models.classification*` 列及旧 `PUT /api/v1/admin/models/policy` 入口）；管理员使用任意 Key 预览并勾选导入 OneLink 模型或手动新建/编辑/删除模型；启用平台目录白名单总控时，未导入或后台已删除/已隐藏的模型对普通 C 端用户一律隐藏且以 `409 MODEL_HIDDEN` 阻断调用 |
| RabbitMQ & Redis 完整档监控 | RabbitMQ 使用独立只读 `monitoring` 账号（`mio-<env>-monitor`，零队列读写配置权限）采集 Broker 概览、节点内存/磁盘告警、队列与 DLQ 积压及 PG `mio_compute_jobs`/`mio_compute_outbox`；Redis 使用独立 `resetkeys` 零键值权限 ACL 账号 `mio_monitor` 采集内存水位、延迟、时钟偏差、OPS 与持久化指标                                                                                                                                                                                              |
| 本期范围与明确非目标        | 聚焦管理员账号、动态协议模板 CRUD、模型加载导入与完整 CRUD、路由版本回滚及业务/MQ/Redis 监控；**不包含普通注册用户管理页**，不新增动态脚本协议引擎，不收集含明文 Key 或预签名 URL 的请求日志                                                                                                                                                                                                                                                                                                  |

## 3. 本期开发单元与 C0/C1 规划

生命周期状态遵循[协调协议](../../coordination.md#当前任务的生命周期)。本期包含一个完整可验收开发单元：

| 开发单元 ID | 绑定成果键（`result.key`） | 范围摘要                                                                                                                                                                                  | 前置依赖与调用性质                                                   |
| ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unit 1      | `web-admin-console`        | 管理员认证与记住账号密码、动态协议快捷模板 CRUD、平台模型主表白名单总控与完整模型/路由 CRUD、修订回滚、业务+RabbitMQ(完整档)+Redis(完整档)监控、常驻环境初始化与独立 `mio-admin-web` 前端 | 隔离 PG/Redis 回归 + 本地 `mio_dev` 迁移、监控账号初始化与浏览器联调 |

### 3.1 Unit 1：`web-admin-console`（后台管理 API、模型策略与独立 Web 控制台）

- **目标与成果归属**：绑定本 PRD 成果键 `web-admin-console`，交付后端 `/api/v1/admin/*` 管理域、供应商域平台模型主表与白名单总控、RabbitMQ/Redis 只读监控适配器、显式迁移与监控初始化脚本、受影响公共规范同步，以及同级 `mio-admin-web` 控制台。
- **C0 就绪条件**：动态模板预留范围、平台目录白名单总控规则、登录记住账号密码方案（方案 B）以及 RabbitMQ/Redis 完整档监控边界均已由用户拍板收口。
- **C1 实施顺序**：
  1. **平台模型主表、白名单门控与 C 端生图参数投影（`src/providers/`）**：新增 `mio_provider_catalog_models` 并升级 `mio_provider_model_route_revisions` 支持 `delete` 修订记录；在 `config`、`state`、`catalog`、`store`、`onelink/router` 与 `service` 实现平台目录白名单过滤与 `409 MODEL_HIDDEN` 调用阻断，通过 `GET /api/v1/providers/onelink/models` 的 `items[].image.parameters` 实时透出管理员配置的生图路由参数边界（`allowedSizes`、`defaultSize`、`allowedAspectRatios`、`maxN` 等；非生图或 `ADAPTER_PENDING` 路由为 `null`），并在 `listImageModels` 复用该派生逻辑（严格保持 19 字段工具输出契约与平台 `display_label` 名称回退），同时保持无管理域的无头 CLI 测试兼容。
  2. **动态协议快捷模板与模型完整 CRUD（`src/admin/`）**：新增 `mio_admin_seed_history`、`mio_admin_ignored_models` 与 `mio_admin_route_templates`（仅新库首次迁移预留原厂协议模板）；实现 OneLink 候选预览与勾选导入、模型增删改查、路由单删与级联删除、模板完整增删改查。
  3. **RabbitMQ 与 Redis 完整档监控（`src/integrations/`、`deploy/local/`、`scripts/service/`）**：扩展 `src/integrations/redis.ts` 增加独立零键值探针 `probeRedisMetrics`，新建 `src/integrations/rabbitmq-monitor.ts` 采集 Management HTTP 只读指标，联动 `AdminStore` 采集 `mio_compute_jobs`/`mio_compute_outbox`，并提供 `pnpm monitor:init:dev` 一键预置最小权限监控身份。
  4. **独立前端控制台升级（同级 `mio-admin-web` 工程）**：删除前端写死预设文件，改造登录页记住账号密码、OneLink 预览勾选导入弹窗、新建/编辑/删除模型交互、动态模板驱动的路由抽屉、独立「快捷配置模板」CRUD 页面，以及含 RabbitMQ/Redis 完整档面板的运行监控页。
- **验收判据与接受门禁**：
  - **自动化回归与静态护栏**：`pnpm check:static`、`tests/admin/`、`tests/providers/`、`tests/conversations/conversation-image-tools.test.ts`、`tests/environment/`、`tests/harness/` 及打包 `pnpm test:smoke` 全部通过；验证平台白名单对普通用户的未导入/删除隐藏阻断、OneLink 预览勾选导入、模型与动态模板 CRUD（含重跑迁移不复活已删模板）、后台发布/更新生图路由参数边界实时同步至 C 端 `GET /api/v1/providers/onelink/models` 的 `image.parameters` 及 `listImageModels` 工具边界，以及 RabbitMQ/Redis 只读监控探针。
  - **独立前端构建与联调验证**：`mio-admin-web` 零硬编码模板并通过 `pnpm build`；本地 `mio_dev` 完成显式迁移与 `pnpm monitor:init:dev` 后，经真实浏览器验证记住账号密码、模型导入/CRUD、动态模板管理及 RabbitMQ/Redis 实时监控看板。
  - **交付门禁**：完成源码 `quality-review` 与 `norms-review`，待用户审阅确认后按协议执行交付。
