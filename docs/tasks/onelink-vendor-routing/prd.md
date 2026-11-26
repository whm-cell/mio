# 万联数据库模型路由目录与原厂协议解耦 PRD

本文中旧图片执行链的 A→B 路径和行号对应当时设计。后续执行入口及退役范围见[图片迁入 A 的方案](../onelink-image-generation/changes/image-generation-in-a/change.md)。

状态：Unit 1（`onelink-db-vendor-routing`）实施与待人类接受阶段；Unit 2（`onelink-route-live-expansion`）待推进。详细表结构、消息契约、修枝说明与全仓硬编码处置见[详细设计](design.md)。关联权威规范：[供应商配置](../../providers.md)、[万联集成](../../integrations/onelink.md)、[计算服务协议](../compute-service/protocol.md)、[协调协议](../../coordination.md#当前任务的生命周期)。既有已接受范围分别以[万联接入成果](../onelink-integration/complete/report.md)、[图片能力成果](../onelink-image-generation/complete/report.md)和[计算服务成果](../compute-service/complete/report.md)为准，本需求不重开或改写任何旧接受。返回[任务资料与成果](../index.md)。

## 1. 问题依据与现网模型实证

在隔离验证库对万联（OneLink，`https://api.onelinkai.cloud`）真实 `/v1/models` 目录与历史迁移快照（`92` 条预设、`21` 组能力配置、`25` 条旧禁用项）交叉核对后，当前模型适配与调用链路存在三项实证瓶颈：

### 1.1 `/v1/models` 元数据缺失与逐用户导入瓶颈

- **现网目录规模与模态分布**：当前测试凭据成功发现 **87 项 `current` 模型**，按实际协议模态分为：`59` 项文本/多模态对话与机器翻译、`1` 项文本向量（`qwen3.7-text-embedding`）、`7` 项图片生成、`18` 项异步视频、`1` 项语音合成（`speech-2.8-turbo`）与 `1` 项音乐生成（`Music-3.0`）。对比旧版 92 项预设，仅 **41 项**精确命中（另有 `1` 项大小写漂移：现网 `glm-5.1` 对比旧预设 `GLM-5.1`），**46 项**为新增或旧禁用模型；旧预设另有 **51 项**（含 `26` 项 OpenAI 如 `` `gpt-image-2*` ``/`sp-gpt-image-2`、`8` 项 Anthropic `` `claude-*` ``/`` `s-claude-*` ``、`6` 项 Google/Gemini/Veo 及部分数字人/音频变体）受上游渠道 Key 权限门控而未出现在当前目录。
- **上游目录字段极简**：全部 87 项模型的 `supplier_metadata` 仅含 `["object", "created", "owned_by", "description"]` 四个键，**不含任何业务分类、请求端点路径、同步/异步标志或参数约束**。
- **逐用户适配表无法横向扩展**：现行 `mio_provider_model_adaptations` 以 `(provider_id, model_key, operation)` 按单个用户配置存储适配声明。未手动逐用户导入前，**86/87** 项已发现模型对每位新接入用户均停留在 `ADAPTER_PENDING`；每上线一个新模型或新用户都需按 owner 重复写入声明。

### 1.2 禁止按 `owned_by`、模型 ID 前缀或描述推断协议的实证原因

现网 87 项模型跨越 11 家国内原厂与渠道托管方（阿里/百炼 `30`、字节火山 `14`、MiniMax `9`、智谱 `7`、月之暗面 `7`、快手可灵 `5`、DeepSeek `4`、腾讯混元与 Vega `4`、生数 Vidu `3`、小米 MiMo `3`、阶跃星辰 `1`），加上渠道门控的 OpenAI、Anthropic、Google，任何基于 `owned_by`、前缀或自由描述的自动猜测都会造成错误出站：

1. **跨厂商协议借壳**：`vega-1.0-pro` 与 `vega-1.5-pro` 的 `owned_by` 为 `"腾讯"`、ID 前缀为 `` `vega-*` ``，但实际通信协议是**火山方舟（Volcengine Ark）异步视频协议**；`WL-Qwen2.5-72B-Instruct` 的 `owned_by` 为 `"NVIDIA"` 且 `description` 为空。
2. **同一 `owned_by` 混装多种不兼容协议**：`"阿里"` 同时涵盖标准 OpenAI 兼容对话（16 项）、全模态音频输出（`qwen3.5-omni-flash`）、带专用 `translation_options` 字段的机器翻译（`` `qwen-mt-*` `` 4 项）、`/v1/embeddings` 向量接口（`qwen3.7-text-embedding`，不在 Mio 现行五类用途枚举内）及百炼 HappyHorse 异步视频（7 项）；`"MiniMax"` 同时跨越 `/v1/chat/completions`、Anthropic `/v1/messages`、原生 `/v1/t2a_v2` 配音与 `/v1/music_generation` 音乐；`"Google"` 同时跨越 OpenAI 兼容文本、Gemini 原生 `generateContent` 生图与 Veo 异步视频。
3. **命名前缀、大小写与描述失真**：异步视频模型 `kling-v2-5-turbo` **无 `video-` 前缀**，且其上游 `description` 错误写为“支持文生图和图生图功能”；同厂模型存在 `Music-3.0` 与 `music-2.6`、`glm-5.1` 与 `GLM-5.1`、`doubao-seed-2.1-pro` 与 `doubao-seed-2-1-turbo`、`hy4` 与 `hunyuan-3.0`、`` `s-gpt-*` ``/`` `s-claude-*` ``/`sp-gpt-image-2` 等异构命名。

### 1.3 同厂商内部端点与参数分化要求“数据库存规格 + 代码写纯原厂驱动”

现行代码在 `contracts/compute/src/images.ts`、`compute/src/images.ts`、`src/providers/schema.ts`、`src/providers/catalog.ts` 和 `src/dsh/onelink.ts` 中将协议选择、完整 URL、输出张数与参数白名单硬编码在 4 个图片 profile 与固定 `1024` token 常量上，导致同原厂新模型被自身代码锁死：

- **火山 Seedream 同步生图分化**：现行 `seedream-4-images-v1` 将火山协议锁死为仅 `1024x1024`、`n === 1`、固定 `jpeg`、强制 `watermark: true` 且禁止参考图；而现网同端点（`/volc/api/v3/images/generations`）的 `doubao-seedream-4.5` 与 `` `doubao-seedream-5.0*` ``（`5.0-lite`、`5-0-pro-260628`）支持高分辨率（`4.5` 为 `1024x1024`/`2K`/`4K`，`5.0*` 为 `1024x1024`/`2K`/`3K`/`4K`）、最多 14 张参考图、`sequential_image_generation` 最多 **15 张输出**及用户水印开关覆盖；其中 `doubao-seedream-4.5` 仍固定输出 `jpeg`（不支持 `output_format`），而 `` `doubao-seedream-5.0*` ``（`5.0-lite`、`5-0-pro-260628`）支持 `png`/`jpeg`。
- **可灵异步生图双端点分化**：现网 `image-kling-v3` 走 `/kling/v1/images/generations`（0–4 张参考图、1–4 张输出），而同厂 `image-kling-v3-omni` 走独立 `/kling/v1/images/omni-image`（`maxReferenceImages: 1`、`maxN: 1`、`auto` 比例），且现行 `src/providers/catalog.ts` 将 `references.maxImages` 硬编码为 `2..16`，直接拒绝单参考图声明。
- **OpenAI 生图分化**：`` `gpt-image-2*` `` 支持 `/v1/images/generations` 与 multipart `/v1/images/edits`（最多 10 张、含 `'auto'` 尺寸），而 `sp-gpt-image-2` 走 JSON 兼容路径且最多 1 张、无 `'auto'` 尺寸。

## 2. 目标能力、核心边界与已收口 C0 决定

本需求建立**平台级 PostgreSQL 模型路由目录 + 按上游原厂（Vendor）协议解耦的无硬编码驱动架构**，使兼容既有原厂协议的新模型无需改动 TypeScript 源码或重新发版即可受控接入，同时严格保持多租户目录隔离与安全边界。

### 2.1 核心目标与架构原则

1. **单轨数据库模型路由表（`mio_provider_model_routes`）**：在供应商域 PostgreSQL 建立平台级受控路由目录表作为唯一模型协议与规格权威，以 `(provider_type, raw_model_id, operation)` 为区分大小写的复合主键，存储上游原厂标识（`vendor`）、服务端已实现协议驱动名（`driver`）、业务分类（`classification`）、相对请求路径（`submit_path`、`edit_path`、`query_path_template`）、结构化参数规格（`param_spec`）、请求默认项（`request_defaults`）、输出规格（`output_spec`）、文本能力元数据（`capability_metadata`，含 `contextWindow` 与默认 `1024`、`1..65536` 的 `maxOutputTokens`）以及来源依据（`source_kind` 仅限 `protocol-reference` 或 `runtime-observation`、`source`、`source_version`、`declaration_version`）。由受控部署命令 `pnpm providers:route <--stdin | routes.json>`（`scripts/service/import-provider-route.ts`）维护，不开放普通用户 HTTP 写入，生产代码与构建产物不内置任何预设模型清单或种子表。
2. **动态目录成员唯一权威与单轨路由解析**：
   - **成员权威不变**：仅当前用户、当前有效凭据的完整成功 `/v1/models` 刷新可在 `mio_provider_models` 建立 `current` 成员。`mio_provider_model_routes` 只提供路由与能力声明，**绝不创建、补齐或跨用户泄漏目录成员**；用户目录未发现的 `raw_model_id` 即使存在于路由表，对该用户仍不存在（`MODEL_NOT_FOUND` 或 `MODEL_REMOVED`）。
   - **单条 SQL MVCC 合并与单轨判定**：`providerStateSQL` 在同一事务快照中按精确 `(provider_type, raw_model_id)` 关联本人 `mio_provider_models` 与已启用 `mio_provider_model_routes`，按 **`平台 mio_provider_model_routes 有效路由 -> ADAPTER_PENDING`** 单轨解析生效适配，消除双轨单用户 CLI 覆盖带来的复杂度与遮蔽风险。
   - **真实验证独立按用户存储**：在供应商域以单用户验证表 `mio_provider_model_verifications`（主键 `(provider_id, model_key, operation)`）独立保存 `verification_status`（仅 `'unverified' | 'verified'`）、`verified_at`、`verification_evidence`、`tested_tuple`、`declaration_version` 与 `driver`。导入或更新平台路由绝不将任何用户标记为 `verified`；实质更新平台路由递增 `declaration_version`，自动使旧版本验证回到 `'unverified'`，幂等重放相同路由不虚增版本号。
3. **纯原厂协议驱动拆分与 Worker 零数据库隔离**：
   - **按上游原厂解耦驱动**：将 `compute/src/images.ts` 拆分为 `compute/src/providers/onelink/{router.ts, shared/, openai/, volcengine/, vidu/, kling/}`，并在 Service A 建立逻辑路由器 `src/providers/onelink/router.ts`。各原厂驱动只负责本厂报文编解码、状态机归一与响应提取，**零硬编码具体模型名、零硬编码完整 URL、零旧 profile 回退分支**。
   - **AMQP 命令强制携带冻结路由快照**：因 Worker B（`compute/`）不连接 PostgreSQL，Service A（`src/compute/service.ts`）在准入时将解析后的 `ImageRouteConfig`（含 `vendor`、`driver`、相对路径、参数/输出规格及按 `allowWatermarkOverride` 合成的用户 `default_image_watermark`）作为必填 `route` 字段（`profile` 必填 `ImageDriver`）写入 `@mio/compute-contracts` 消息负载并与凭据信封 AAD 绑定；异步任务持久化 `route_snapshot` 供后续 `image.query` 与重启恢复使用（未发旧 `image.request` 缺失合法 `route` 时 fail-closed 结算 `rejected` / `IMAGE_HANDLER_UNAVAILABLE`，在途 `image.query` 或恢复缺失/非法快照时一律 fail-closed 结算 `failed` / `IMAGE_QUERY_FAILED`，不回退任何硬编码规则表），异步截止时间按声明 `maxAgeSeconds`（最高 `86_400` 秒）计算而不再硬截断为 10 分钟。
   - **解除历史硬上限**：共享契约将多图输出序号从单数字 `0..9`（`<= 10` 张）扩展至 `0..15`（`^([0-9]|1[0-5])-`，最多 `16` 张）以支持多图生成上限；`maxReferenceImages` 放开至 `0..16`（解锁单参考图 `1`）；`compute/src/image-worker.ts` 在 `allowGenerateReferences` 为真时统一在写提交日志前预读取私有 COS 参考图。

### 2.2 安全护栏与明确非目标（`DESIGN-OVER-001`）

- **固定网关与路径前缀双重白名单**：`ONELINK_ORIGIN = 'https://api.onelinkai.cloud'` 保持代码常量；数据库路径列只允许匹配 `^/[A-Za-z0-9._/{}-]+$` 且不含 `..` 或 `//` 的相对路径，且 `router.ts` 与文本出站层强制校验各原厂驱动允许的路径前缀（`/v1/`、`/volc/`、`/vidu/`、`/kling/`），防止配置误写导致跨协议越权请求或 SSRF。异步结果下载继续强制经 `withPublicHttps` 公网地址校验与图片签名/解码核验。
- **明确非目标**：
  1. 本需求**不实现视频、语音、音乐或向量（Embedding）的执行 Worker 与公开业务 API**；异步视频与语音/音乐仍分别由[视频需求](../onelink-video-generation/prd.md)与[音频需求](../onelink-audio-generation/prd.md)按各自 C0/C1 推进，未知或未实现执行器的分类（如 `qwen3.7-text-embedding`）继续保持不可调用。
  2. **不建设通用协议模板引擎、JSONPath 映射 DSL、动态脚本加载或管理员 Web 后台**（遵循 `DESIGN-OVER-001`：全新原厂协议仍通过新增受类型与测试保护的 TypeScript 驱动接入，数据库仅承载已实现驱动的路由与参数规格）。
  3. 不新增平台代付 Key、费用结算/配额账本、跨用户目录共享或模型工具（Agent Tools）放行。

### 2.3 C0 决定收口摘要

| 决定项               | 已收口结论                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单轨平台路由         | 统一由平台级 `mio_provider_model_routes` 承载路由与参数规格；退役单用户 CLI 适配覆盖与代码内种子表，解析链路收敛为 `平台有效路由 -> ADAPTER_PENDING`                        |
| 目录成员与验证隔离   | 平台路由不创造目录成员，必须命中用户本人 `mio_provider_models` 的 `current` 快照；运行验证按用户独立存入 `mio_provider_model_verifications`（`'unverified' \| 'verified'`） |
| 原厂驱动与路径安全   | 拆分为 `openai`、`volcengine`、`vidu`、`kling` 纯协议驱动与 `router.ts`；固定 `ONELINK_ORIGIN`，DB 仅存受正则与驱动前缀白名单双重约束的相对路径                             |
| 跨进程路由传递与恢复 | Service A 准入强制冻结 `route: ImageRouteConfig` 与 `profile: ImageDriver` 进入 AMQP 命令和 `mio_image_jobs.route_snapshot`，Worker B 保持零 PG 依赖，缺损快照 fail-closed  |
| 容量与参数上限修正   | 输出序号扩展至 `0..15`（`<= 16` 张），`maxReferenceImages` 支持 `0..16`（含 `1`），异步 `maxAgeSeconds` 支持至 `86_400` 秒，文本支持路由级上限                              |

### 2.4 机制退役与修枝说明（`DESIGN-OVER-001`）

依据[底座规格](../../foundation.md)（当前处于本地底座阶段、尚无生产环境历史存量负担）与[供应商配置规范](../../providers.md)（生产代码与构建产物不内置静态预设模型列表），为彻底消除双轨兼容复杂度与产品代码中的模型/规格硬编码，本需求显式退役并修枝以下过渡机制：

1. **退役双轨单用户 CLI 适配覆盖**：移除 `pnpm providers:adapt`（`scripts/service/import-provider-adaptation.ts`）、运行时对 `mio_provider_model_adaptations` 的覆盖读取、`mio_provider_model_verifications.adaptation_origin` 列及目录响应中的 `adaptation.origin` 字段。单用户 CLI 覆盖与平台级路由功能完全重叠，且会遮蔽后续平台路由修正；收敛为 `mio_provider_model_routes` 单轨路由 + `mio_provider_model_verifications` 单用户验证。
2. **退役生产源码内置模型种子（`--seed`）**：不在 `src/providers/onelink/` 或 `scripts/service/` 内置任何硬编码模型 ID 清单，`pnpm providers:route <--stdin | routes.json>` 仅从显式输入导入受控路由；测试所需路由样本集中保存在 `tests/providers/fixtures/`。
3. **退役旧四类图片 profile 与回退规则表**：从 `@mio/compute-contracts`、`src/` 与 `compute/src/` 全面移除 `IMAGE_PROFILES`（`gpt-images-v1`、`seedream-4-images-v1`、`vidu-image-v1`、`kling-image-v1`）、`IMAGE_PROFILE_RULES`、`LEGACY_PROFILE_ROUTES`、`resolveLegacyImageProfileRoute`、`DEFAULT_DRIVER_BASE_ROUTES`、可选 `route?` 回退、`createImageProtocol` 及驱动内尺寸硬编码回退（如 `?? '1024x1024'`），统一强制消费 `ImageRouteConfig` 与 `ImageDriver`。
4. **非破坏性本地数据库升级保证**：`providerSchemaSQL` 不删除或清空既有本地 `mio_provider_model_adaptations` 表数据，幂等移除旧 `adaptation_origin` 列，并在存在匹配的已启用 `mio_provider_model_routes` 记录时将存量 `verified` 记录（剥离 `tested_tuple.adaptationOrigin`）幂等回填至 `mio_provider_model_verifications`。

## 3. 本期开发单元与 C0/C1 规划

按[规划交付要求](../../coordination.md#规划交付要求)与[统一 C0/C1 生命周期](../../coordination.md#当前任务的生命周期)，本规划文档任务自身 `result: null`，仅交付注册 PRD 与详细设计，不代表后续代码单元已就绪或已接受。后续实施拆分为两个有序开发单元，按需逐个建档推进，不预建全部执行记录：

| 开发单元 ID | 拟绑定成果键（`result.key`）   | 范围摘要                                                                                                       | 前置依赖与调用性质                                     |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Unit 1      | `onelink-db-vendor-routing`    | PG `mio_provider_model_routes`、迁移与 CLI、共享 `ImageRouteConfig`、原厂驱动拆分、规范同步                    | 无外部收费调用前置；隔离 PG/MQ/HTTP + 确定性全回归验收 |
| Unit 2      | `onelink-route-live-expansion` | 基于新路由架构对现网新解锁图片模型（如 `doubao-seedream-4.5`/`5.0-lite`、`image-kling-v3-omni`）做受控真实闭环 | 依赖 Unit 1 候选就绪；每次场景显式单 POST 真实调用预算 |

### 3.1 Unit 1：`onelink-db-vendor-routing`（数据库模型路由目录与原厂驱动解耦）

- **目标与成果归属**：绑定本 PRD 成果键 `onelink-db-vendor-routing`，交付完整的数据库路由表、单条 SQL 成员门控合并、受控路由导入 CLI、共享 `ImageRouteConfig` 契约、Service A 文本/图片路由冻结及 Worker B 四原厂纯驱动拆分，并在 `verify` 前同步受影响现行公共规范。
- **C0 核对范围（编码前）**：
  - 表结构、约束、驱动边界、硬编码处置及护栏合规已在[详细设计](design.md)收口，无待定架构分歧。
  - Unit 1 建档进入 `C0_READY` -> `C1_IMPLEMENTATION` 前，仅需核对当前工作区 Git 基线、本机隔离测试 PG/RabbitMQ 可用性，以及 `plan.norms` 声明的受影响现行规范清单（`docs/providers.md`、`docs/apis/providers.md`、`docs/integrations/onelink.md`、`docs/apis/compute.md`、`docs/conversations.md`），不将 Unit 2 的真实外部生图调用前置为 Unit 1 阻塞项。
- **C1 实施顺序**：
  1. **共享计算契约（`contracts/compute/`）**：定义纯原厂 `ImageDriver`（`openai-images`、`volcengine-ark-images`、`vidu-images`、`kling-images`）、必填 `ImageRouteConfig` 与 `validateImageInputByRoute`，移除旧 4-profile 硬编码规则表与回退映射，将输出键序号扩展至 `0..15`（`outputs.length <= 16`），构建 `@mio/compute-contracts` 供 A/B 两侧类型检查消费。
  2. **供应商域持久化、逻辑路由与受控 CLI（`src/providers/`、`scripts/service/`）**：在 `providerSchemaSQL` 建立 `mio_provider_model_routes` 与单用户 `mio_provider_model_verifications`（无损保留既有 `mio_provider_model_adaptations` 表并在路由匹配时幂等回填已验证记录）并更新 `checkProviderSchema`；建立零模型硬编码的 `src/providers/onelink/router.ts`（支持 `references.maxImages: 1..16`）；在 `providerStateSQL` 实现受本人 `mio_provider_models` 成员门控的单条 SQL 路由与验证合并，更新 `recordVerification` 幂等写入 `mio_provider_model_verifications`；新增 `scripts/service/import-provider-route.ts`（`pnpm providers:route <--stdin | routes.json>`）并退役 `import-provider-adaptation.ts`。
  3. **Service A 文本与图片消费及计算迁移改造（`src/dsh/`、`src/integrations/onelink/`、`src/compute/`）**：文本侧接入路由 `submit_path`（校验 `PiAiAdapter` 固定 SDK 路径后缀约束：OpenAI 须以 `/chat/completions` 结尾且前缀为 `/v1/`，Anthropic 须为 `/v1/messages`）与 `capability_metadata.maxOutputTokens`（默认 `1024`，上限 `65536`）；计算侧在 `src/compute/schema.ts`（`computeSchemaSQL` 与 `checkComputeSchema`）为 `mio_image_jobs` 新增 `route_snapshot jsonb`，在 `src/compute/service.ts` 准入合成 `effectiveWatermark`、按 `maxAgeSeconds`（上限 `86_400` 秒）计算异步截止时间，并将必填 `ImageRouteConfig` 快照封入 AMQP 命令与 `mio_image_jobs` 恢复记录（缺失或非法快照 fail-closed）。
  4. **Worker B 原厂驱动拆分（`compute/src/providers/onelink/`、`compute/src/image-worker.ts`）**：按 `openai`、`volcengine`、`vidu`、`kling` 与 `shared` 拆分原 `compute/src/images.ts`，由 `router.ts` 统一校验驱动与路径前缀白名单；更新 `image-worker.ts` 强制校验 `command.route` 并支持 `allowGenerateReferences` 下的同步参考图私有 COS 预读取。
  5. **公共规范同步（`verify` 前）**：同步更新 `docs/providers.md`、`docs/apis/providers.md`、`docs/integrations/onelink.md`、`docs/apis/compute.md` 与 `docs/conversations.md`，确保现行规范与代码候选完全一致，且不改动既有已接受 PRD 目录。
- **验收判据与人类接受门禁**：
  - **确定性单测、零硬编码审计与护栏检查**：覆盖 `ImageRouteConfig` 边界校验（`0..15` 输出键、`maxReferenceImages: 1`、`maxN: 15`、非法路径 `..`/`//` 与跨驱动前缀拒绝、缺失 `route`/`profile` 拒绝）、四家原厂驱动报文构造与异步状态归一；确认生产源码与构建产物零具体模型名与零旧 profile 字符串；`pnpm guard`（含 `pg` 导入白名单、跨包边界、DSH 边界、纯 `.ts` 源码根、`scripts/service` 依赖白名单）与覆盖 `pnpm check` 的有效结论全部通过。
  - **隔离 PG + HTTP + RabbitMQ + 正式打包 Profile 集成验收**：
    1. **多用户共享路由就绪**：通过 `pnpm providers:route` 导入平台路由后，两个独立登录用户各自 `/v1/models` 发现同一 `raw_model_id` 时立即具备调用资格，无需按 owner 重复导入适配声明。
    2. **严格目录成员隔离**：未在本人当前 `/v1/models` 快照发现该 `raw_model_id`（或已移除、已轮换 Key 未重扫）的用户，查询不展示为当前可用、调用返回 `MODEL_NOT_FOUND`/`MODEL_REMOVED`，证明路由表零成员注入。
    3. **多用户验证状态严格隔离与路由版本失效**：用户 A 的成功运行观察写入 `mio_provider_model_verifications` 仅对用户 A 生效，绝不污染用户 B 的 `verification_status`；平台路由实质更新递增 `declaration_version` 使旧版本验证回到 `unverified`，幂等重放相同路由不虚增版本号。
    4. **零代码改动接入新模型闭环**：在不修改任何 `.ts` 文件、不重新构建产物的条件下，向 `mio_provider_model_routes` 插入全新虚构模型 ID（含大小写及误导性前缀如 `WL-Next-Seedream-X`、`s-chat-custom`）并经模拟 `/v1/models` 发现后，完整跑通对话 HTTP/DSH 与图片 HTTP -> MQ -> Worker 原厂驱动 -> 私有 COS 资产落库闭环。
    5. **存量无损升级与缺失快照 fail-closed**：含历史 `mio_provider_model_adaptations` 的数据库非破坏性增量迁移及匹配路由验证回填通过；未发旧 `image.request` 缺失合法 `route` 时 fail-closed 结算 `rejected` / `IMAGE_HANDLER_UNAVAILABLE`，缺少有效 `route_snapshot` 的异常在途异步任务 fail-closed 结算 `failed` / `IMAGE_QUERY_FAILED`；既有已接受的文本与图片确定性回归套件全部通过。
  - **交付门禁**：完成源码 `quality-review` 与 v2 `norms-review`，执行 `pnpm work deliver <task> --stdin`（`prepare`）生成待接受草稿并停在 `HOLD_FOR_HUMAN_REVIEW`，待人类真实接受后方可执行 `complete`。

### 3.2 Unit 2：`onelink-route-live-expansion`（新解锁目录模型的受控真实闭环）

- **目标与成果归属**：绑定本 PRD 成果键 `onelink-route-live-expansion`，在 Unit 1 路由与原厂驱动基础上，对当前账号动态目录已存在、此前受硬编码限制的现网模型（如火山 `doubao-seedream-4.5` / `doubao-seedream-5.0-lite` 多规格同步生图，以及可灵 `image-kling-v3-omni` `/kling/v1/images/omni-image` 异步生图/单参考图）完成受控真实 OneLink + 私有 COS 闭环验证。
- **C0 核对范围（编码前）**：
  - 依赖 Unit 1 实施候选就绪；确认本机常驻 `mio_dev`、RabbitMQ、私有 COS 配置及本人测试登录或 OneLink Key 可用，并为正常验收保持其他 A/B 与任务提交者停用的独占窗口。强杀与消息重放另用隔离现场。
  - 核对测试账号当前 `/v1/models` 快照中精确存在的目标模型 ID 与本次人类显式授权的真实生图调用预算（每个授权场景严格保持 `maxUpstreamGeneratePosts = 1` 单次提交安全互锁）。当前 Key 目录为 0 项的模型（如 `` `gpt-image-*` ``、`` `gemini-*` ``）不在无模型条件下强跑，须在出站前以 `LIVE_MODEL_NOT_FOUND` 零 POST 阻断并如实保留 `pending`。
- **C1 实施与验收**：
  - 扩展 `tests/compute/live-image-audit.ts` 与 `tests/compute/live-image-loop.ts` 支持路由化场景选择与审计白名单（如 `/kling/v1/images/omni-image` 及对应查询路径），保持 `maxUpstreamGeneratePosts = 1`、脱敏诊断落盘与零密钥输出。
  - 正常 `dev` 入口直接读写常驻开发环境并保留数据（媒体数据库以 `MIO_ASSETS_DATABASE_URL` 实际配置为准），通过公开 HTTP -> MQ -> Worker -> OneLink -> 私有 COS -> `GET /api/v1/assets/{id}` 获取本人短期下载地址并从 COS 下载，核验真实生成、SHA-256、跨用户 `404`/未登录 `401` 和 A 重启后的同请求 HTTP 幂等；详见[测试入口](../../engineering/testing.md)。强杀在途 Worker 与重复消息重放在独立隔离现场通过 `prepare`／`execute` 验证 `0` 重复 POST，不能由 `dev` 的 HTTP 重启观察代替。若实测观察到新的网关字段或状态细节，同步记录至[万联集成契约](../../integrations/onelink.md)并在候选内完成 `quality-review`、`norms-review` 与 `deliver prepare`，由人类单独接受。

## 4. 迁移、验证与接受边界

1. **显式迁移与无损回退诊断**：供应商与计算数据库结构变更统一经 `pnpm providers:migrate --apply`、`pnpm compute:migrate --apply`（或常驻环境封装 `pnpm migrate:dev providers --apply`、`pnpm migrate:dev compute --apply` 及对应 `migrate:test`）显式执行；服务普通启动只读运行 `checkProviderSchema` 与 `checkComputeSchema` 校验表、列及约束存在，绝不自动建表或改约束。迁移前须备份目标库；新增 `mio_provider_model_routes`、`mio_provider_model_verifications`、`mio_image_jobs.route_snapshot` 均为非破坏性增量变更，保留既有历史 `mio_provider_model_adaptations` 行不删除（并在命中已启用路由时幂等回填已验证记录），不删除或改写既有 `mio_provider_configs`、`mio_provider_models`、`mio_provider_model_preferences`、`mio_conversations` 或 `mio_image_jobs` 历史行。
2. **静态通过、隔离集成与真实调用分别报告**：本规划文档的通过仅表示需求依据、硬编码清点、架构设计与 C0/C1 拆解完备；Unit 1 的确定性回归与隔离集成通过不自动推导未实测型号线上可用；Unit 2 的单模型真实成功只标记受验元组，不外推同原厂全部别名或未授权模态（视频、音频、向量）就绪。
