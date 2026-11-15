# 万联图片生成、编辑与受管资产 PRD

状态：各切片按实际范围分步推进与接受，已接受范围以[本能力成果](complete/report.md)为准；未记入该成果入口的切片及目标（含当前目录 0 项的 GPT 真实供应商调用、Seedream edit、真实供应商 outpaint `geometry`、Kling omni `image-kling-v3-omni` 与 Gemini）保持待接受或 pending。W1/W2 旧接受不迁移。返回[任务资料与成果](../index.md)。

## 1. 结果与范围

覆盖 WL-04 的图片生成、参考图、编辑/扩图及异步差异，结果通过稳定 Asset ID 查询、鉴权下载和重启后再次读取。资产底座先由[私有资产与计算服务](../compute-service/prd.md)交付；W3 按图片场景核对和复用实际接受的资产能力，再补图片所需任务和资产行为，承接[共享候选设计](design.md)，不先建完整媒体平台。非目标为画布编辑器、项目/分镜、视频工作流、正式前端及 Agent 工具。

旧协议调查来自旧仓库 `backend/app/services/image_gen.py`，只作迁移参考：

| 协议族     | 必须保留的目标差异                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------- |
| GPT        | `/v1/images/generations` 与 multipart edits，区分无参考图、参考图及 mask/编辑。                 |
| Seedream   | `/volc/api/v3/images/generations`，按实际型号核对数量、供应商输出参数（如尺寸）、水印及参考图。 |
| Gemini     | generateContent/interactions，核对各自输入与结果格式，不由文本适配推导支持。                    |
| Kling/Vidu | 图片提交/查询的异步身份、状态与取回。                                                           |

先取得当前用户 Key 的完整成功 `/v1/models` 目录，再从其中选择精确代表；官方文档或运行观察只能以显式 `sourceKind` 为已发现成员补充协议/能力适配，不创建、补齐或替代成员。按实际协议和生成/参考图/编辑/多图/异步差异登记覆盖；单一型号不代表全部图片协议。目录与模型数量以当前用户 Key 及时刷新得到的最新成功响应为准。旧 92 项不是可用白名单，目标无权限或无代表时保留相应 pending，不默删目标；无法取得当前目录就停止，不查文档猜模型。

## 2. 直接依赖与 C0 缺口

复用[供应商规范](../../providers.md)中的本人凭据、稳定模型身份、动态资格和有来源声明，必要已接受基线为 `onelink-user-provider-catalog`（[原成果入口](../onelink-integration/complete/report.md)）；W2 文本完整接受不构成图片前置。适配声明的 `sourceKind=protocol-reference` 只表示协议/文档依据，`runtime-observation` 只表示对应运行观察；二者均不替代当前目录成员。身份、PG、传输与资源约束直接沿[共享候选设计的现行依赖](design.md#1-现行依赖与采用边界)。图片场景各切片按[本能力成果](complete/report.md)与对应任务证据分别验证和接受；资产底座仍按本页首段核对实际接受范围，不能从目录成功推导可调用。

Seedream 图片调用使用当前用户已经配置的 OneLink 凭据。真实验收仍须确认当前目录包含目标模型、该账户具备图片权限、固定 profile 已实现，并记录实际请求/结果；缺少任一项只使 Seedream 图片验收保持 pending，不回退为另一模型，也不阻塞 W1/W2 文本结果。当前用户 Key 刷新的 `/v1/models` 目录包含 Seedream（`doubao-seedream-4.0`）、Kling（`image-kling-v3`；独立 `/kling/v1/images/omni-image` 协议的 `image-kling-v3-omni` 不纳入 `kling-image-v1`）与 Vidu（`image-vidu-q2`），但 `gpt-image-*` 与 `gemini-*` 为 0 项；因此 GPT 真实生成/编辑/多参考与上游 outpaint `geometry` 保持 pending，live 核验在目录无匹配模型时以 `LIVE_MODEL_NOT_FOUND` fail-closed 停止（0 次上游生成 POST）。

图片真实闭环使用项目私有 COS 配置和 A/B 的实际权限。现场注入可使用长期受限 `SecretId/SecretKey`，或在实现明确支持时使用带有效期的临时凭据；验收条件是运行时能完成受限读写和 owner 资产登记，不要求额外的 COS 会话配置。签名 URL 和 staging 生命周期仍按 [COS 集成](../../integrations/cos.md)执行。

C0 收口本图片切片的实施范围与调用授权（O1）、以系统 `user_id` 关联的 O2 外部资源关系、复用项目私有 COS 与上游可达输入（O4）、以及通过当前 Key 刷新的精确协议/操作清单（O5）；本轮不引入费用、计费、预算、余额或图片容量逻辑。最小解决动作见[共同决定](design.md#5-仍须收口的共同决定)。参考图无公网可达方式时可做隔离协议验证，不能接受真实参考图闭环。规划交回不等于这些决定已解决，也不预建未来执行记录。

## 3. C1 实施顺序

沿[统一生命周期](../../coordination.md#当前任务的生命周期)，本期先落一个可闭环的 GPT `image.edit` 切片：调用方提交本人 `imageAssetId` 和可选 `maskAssetId`，A 按 `user_id` 核对 ready/original 资产并 HEAD 冻结 raw ETag/长度，B 从私有 COS 读取后向 `/v1/images/edits` 发一次 multipart 请求，继续复用现有 journal、unknown、逐输出物化和结果 Asset 绑定。无 mask 的单图 edit 可承接单参考图场景；mask 只接受 PNG。Seedream edit、多参考数组、真正带画布几何的 outpaint、Gemini/Kling/Vidu 异步操作留作后续独立切片。

E2（`reference-outpaint-slice`）落地 owner 资产数组、多参考 multipart 和显式 `metadata.image.geometry` capability gate（上游 `geometry` 未验证前保持关闭，`DESIGN-OVER-001`）；E3（`async-image-slice`）落地显式 async capability 下的协议中立 submit/query/recovery、持久 upstream task ID、有界 query 及 `image-vidu-q2` 真实闭环；`seedream-sync-slice` 覆盖 `doubao-seedream-4.0` 真实同步 OneLink + 私有 COS 闭环与场景化 live 核验入口；`kling-async-image-slice` 覆盖 `kling-image-v1`（精确对应目录成员 `image-kling-v3`，排除 `image-kling-v3-omni`）异步提交/查询/恢复、`kling-async` live 核验与真实 OneLink + 私有 COS 闭环。各切片的已接受状态与范围以[本能力成果](complete/report.md)和对应任务证据为准；目录发现、协议适配和真实验证分别记录。每片仍以当前 Key 显式刷新得到的动态目录和显式 capability 声明为准。

生产性能基准、容量指标和生产压测是本期 non-goal；本地确定性检查与 CI 只证明功能、恢复和护栏，不推导生产性能结论。真实同步与异步 OneLink/COS、远端 CI 及各切片接受状态分别以[本能力成果](complete/report.md)和对应任务证据为准，不由适配代码推定通过。

每个切片同步实际采用的媒体/任务/存储规范、HTTP 与集成契约并接回权威导航，核对模块边界和资源关闭；图片独有参数留在图片能力，不放进共享设计。规划或基础切片通过不代表全部 WL-04 完成。

## 4. 验收与接受

共同证据、安全/恢复和接受规则沿[共同验证约定](design.md#6-共同验证约定)，本能力覆盖原 A1/A2/A5/A6/A7，并额外逐项核验：

- 本期隔离验收覆盖 GPT 单图/多参考 edit、可选 PNG mask、跨 user_id/非 ready/非 original/非图片资产拒绝、COS If-Match 读取、multipart 字段白名单和既有结果物化；因当前 Key `/v1/models` 目录含 0 项 `gpt-image-*`，真实 GPT 供应商闭环保持 pending，live 入口对 `gpt-sync`/`gpt-edit` 验证 `LIVE_MODEL_NOT_FOUND` fail-closed（0 次上游生成 POST）。
- 既有生成回归保持；`doubao-seedream-4.0` 同步生成、`image-vidu-q2` 异步生成与 `image-kling-v3` 异步生成按真实 OneLink + 私有 COS 闭环分别记录；`image-kling-v3-omni`、Gemini、Seedream edit、真实供应商多参考与上游 outpaint `geometry` 保持 pending，不以候选隔离测试或单型号成功代替全 W3。
- 生产性能基准、容量和压测不属于本期验收目标；它们不作为 E3 的 pending 或阻塞项。真实同步 OneLink/COS、真实供应商异步端点和远端 CI 沿各自接受边界分别报告。
- 注入“生成已成功 → 下载/元数据提交失败”，核对只恢复取回/落库、不重复提交上游生成、同 task/output 不重复 Asset；多图部分失败可见，保留可对账身份和有界临时文件清理。

确定性协议/隔离持久化与真实供应商结果分别报告。完整图片接受要求本页目标操作逐项有证据，未验项明确处置，所交切片的恢复、安全、完整检查及审查齐备并获真实接受；不得以基础切片或一次图片成功声明完整图片能力。
