# 用户万联配置与动态模型目录

每个登录用户持有一个逻辑 `onelink` 配置；身份沿[认证底座](auth.md)，接口正文见[供应商 HTTP](apis/providers.md)，出站见[万联集成](integrations/onelink.md)。[万联 PRD](tasks/onelink-integration/prd.md)与[万联原厂协议路由 PRD](tasks/onelink-vendor-routing/prd.md)维护需求与安排，实际接受范围和限制见各自成果入口（如[万联成果](tasks/onelink-integration/complete/report.md)）。目录、协议实现、真实观察和业务接受分别判定。

## 配置与迁移

仅完整设置以下三项才启用本域；不回退认证数据库、登录 secret 或他人 Key：

| 变量                          | 含义                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `MIO_PROVIDERS_DATABASE_URL`  | 本域 PostgreSQL URL；独立持池，可与认证或对话同库           |
| `MIO_PROVIDERS_MASTER_KEY`    | 部署注入、独立于认证 secret 的 32 字节随机密钥，标准 base64 |
| `MIO_PROVIDERS_MASTER_KEY_ID` | 1–64 个字母、数字、下划线或连字符                           |

`pnpm providers:migrate` 展示 SQL；`pnpm providers:migrate --apply` 在一个事务内升级并检查。停止旧实例并按库责任备份后执行，启动只读检查，不自动迁移或联网。不兼容结构、约束冲突及迁移失败须核对原数据；失败事务不留下半套可运行结构，不承诺自动降级。

现行表为 configs、models、model_preferences、model_routes、model_verifications、catalog_models、model_route_revisions，均以 `mio_provider_` 为前缀。配置保存 owner、当前密文、凭据版本、最近成功目录和最近尝试；模型保存精确 raw ID、稳定 UUID、来源与成员状态；`catalog_models` 按 `(provider_type, raw_model_id)` 保存受控平台模型主表（展示标签、厂商、分类、描述、普通用户可见开关 `user_visible`、隐藏型号补录开关 `allow_undiscovered`、调用备注 `call_notes` 与来源 `origin_source`），当启用管理后台（`MIO_ADMIN_ENABLED=true`）或显式设置 `MIO_PROVIDERS_CATALOG_WHITELIST=true` 时开启平台目录白名单总控——普通用户仅可见并可调用 `catalog_models` 中已登记且 `user_visible=true` 的型号，后台未导入或已删除型号一律隐藏并以 `409 MODEL_HIDDEN` 阻断；`model_routes` 按 `(provider_type, raw_model_id, operation)` 保存受控平台级原厂协议路由目录（`vendor`、`driver`、相对端点、参数规格、默认项、输出规格与依据来源），不绑定具体用户且绝不创造用户目录成员；`model_route_revisions` 只追加记录每次平台路由新增、变更、启停、删除与回滚的前后快照、声明版本及操作来源；`model_verifications` 按 `(provider_id, model_key, operation)` 独立持久化每用户实际运行验证元组；偏好以配置/模型/usage 为键，并用部分唯一索引限制每用途一个默认。models、catalog_models 与 routes 的 raw ID 比较统一使用 C collation，偏好与用户验证均通过复合外键核对配置归属。若本地旧库存在历史 `mio_provider_model_adaptations` 表，迁移先在存在匹配已启用平台路由时将已验证记录（剥离旧 `adaptationOrigin`）幂等回填至 `model_verifications`，随后删除该历史表；若存在历史 `mio_provider_model_policies` 表，迁移先将其策略行幂等回填至 `catalog_models`（保留已有主表记录），随后删除该历史表；`mio_provider_models` 同步幂等移除已废弃的 `classification` 与 `classification_source` 列，C 端分类与来源由生效路由与 `catalog_models` 统一派生。

模型表可空保存用户名称和描述覆盖，分别最多 100、500 个 Unicode 字符；显式迁移为已有四表结构增列及长度约束，启动只读核查列与约束。旧行保持空覆盖，原身份、元数据、偏好及未知发现时间不变。刷新、凭据轮换和重启保留覆盖；显示回退及修改规则见[模型 HTTP 契约](apis/providers.md#get-apiv1providersonelinkmodels)。

旧表升级只承接同凭据、connected、models-only 且完整合法的旧 discovery；成功空列表仍有目录版本。旧失败或其他凭据的观察不补成成功。旧偏好生成稳定映射或 historical 行，无发现来源的行不填发现时间/目录版本。原文不可解析的引用保留为 `legacy_ref` 与 `LEGACY_MODEL_REF_INVALID`，不猜模型。映射冲突回滚，要求核对备份中的原偏好。

迁移默认读取同库已有的对话及回执绑定，只为 owner/配置匹配的旧引用补 historical 行，不改原绑定、digest、回执或 JSONL。对话位于另一数据库时，显式提供 `MIO_CONVERSATIONS_DATABASE_URL` 并运行 `pnpm providers:migrate --apply --with-conversations`；该连接只读引用，供应商写入仍在本域事务，无跨库外键。升级前冻结这些源记录并备份；本地测试不构成生产迁移验收。

旧 92 项数据原样保存在[测试参考](../tests/providers/fixtures/onelink-legacy-snapshot.ts)，不为任何用户 seed 成员或适配。生产代码和构建不依赖该文件；构建先清理生成的 dist，防止已移出模块残留在包中。

供应商迁移同时创建或升级 `mio_provider_voices`、`mio_provider_voice_catalogs`、`mio_audio_jobs` 和 `mio_audio_records`，并扩展路由、验证和修订表的操作约束。同库启动检查对应类型与操作约束。按资产配置登记和读取试听、复刻样本、成品资产。启用管理后台时，使用它的显式迁移更新路由模板的操作约束。[音频 API](apis/audio.md) · [管理 API](apis/admin.md)

## 凭据与资源

Key 仅由凭据写入口接收。AES-256-GCM 使用随机 12 字节 nonce、16 字节 tag，AAD 绑定格式、owner、配置、credentialVersion 和主密钥 ID。元数据查询只返回 hasKey 和固定 mask，不解密。明文、密文、源异常均不得进入 HTTP、日志、Session 或工具参数。

轮换原位替换密文、递增 credentialVersion，保留启停、水印、模型身份、适配和偏好/default 目标；旧成员成为 historical，旧成功目录保留历史版本但不授予新凭据资格。新版本必须显式成功发现。当前只保存当前密文，不提供历史 Key 平台。重启须注入同一主密钥和 ID；缺失在配置阶段拒绝，错误密钥/篡改在解密时拒绝，不回退。

[存储](../src/providers/store.ts)自持最多 5 个连接、连接/查询等待各 5 秒。所有用户配置变更在配置行锁下串行；初建 owner 唯一约束及客户端 expectedRevision 防并发覆盖。刷新开始和完成、配置/展示覆盖及偏好更新递增 revision；平台路由实质更新独立递增 `mio_provider_model_routes.declaration_version`。关闭取消并等待发现，先收敛对话运行再关闭本域池；即使对话清理失败也释放本域并保留错误。共同资源约束沿[PostgreSQL](integrations/postgres.md)。

## 无模型账号资源凭据

[供应商服务](../src/providers/service.ts)的 `snapshotAccount(ownerId)` 只核验本人 onelink 配置存在、enabled 且 credential_auth_state 不是 rejected，返回配置身份、credentialVersion 与受控密文快照；不读取模型、默认项、路由或目录资格。`openAccountSnapshot(ownerId,snapshot)` 复用 AES-256-GCM/AAD 解密，仅供一次受控出站请求内存使用；错误 owner 或密钥篡改拒绝。快照与明文不进入 HTTP、日志或持久素材记录。

[素材域](apis/materials.md)是当前消费者。本地列表与详情不依赖当前 Key、不解密或联网；新出站使用当前账号快照，轮换不重绑资源 owner 或改写历史。对已有资源仅通过单资源 Get 核验访问，素材 403 只阻塞该资源出站，不把整个 provider 标 rejected，不删除本地映射；精确 404/ResourceNotFound 与 403 分开处理。素材操作成功不赋予模型 verified，模型目录发现也不授予素材资源权限。关闭先收敛素材消费者，即使消费者清理失败仍关闭供应商池并聚合错误。

## 素材认证会话密文

素材认证复用同一部署 32 字节主密钥与 AES-256-GCM 五元组；`sealMaterialAuth/openMaterialAuth` 仅给材料会话保存必要 H5Link/BytedToken，AAD 使用独立固定 `mio:materials:auth-session:1`、ownerId、sessionId 与 masterKeyId，不能与凭据用途互解，旧凭据 AAD 和字节格式保持原样。普通会话元数据读取不解密；只在公开 launch 的受控重定向或有 digest 证明的服务端结果复核时打开。会话完成/到期清密文与授权保留策略见[认证会话接口](apis/materials.md#post-apiv1materialsauth-sessions)。Key 轮换保留会话归属，验证使用当前 owner 账号资格，不给模型赋予 verified，不把资源 403 扩大为整个账号 rejected。

## 目录、刷新与资格

当前 Key 的完整成功 GET /v1/models 是唯一成员权威，raw ID 的大小写、标点和线路后缀不归一。新 ID 无需修改生产名单或发布即进入目录。稳定 `onelink:model:<UUID>` 不含分类/协议；同 ID 移除后再次发现仍复用身份。旧 `onelink:<category>:<rawId>` 无损解析 raw ID，分类不参与新身份，也不重写旧回执。

仅显式 POST /test 联网；保存、读取、选模、准入与启动不联网。每次开始先持久递增序号与凭据版本；仅最新开始且凭据未变的响应可提交。完整合法成功在同一事务发布新目录版本、成员增删及验证失效状态，默认有效性由同一数据库快照计算。

| 情况                           | 目录及新请求                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| 当前凭据从未成功               | 拒绝选择和调用，历史条目不可补成当前                                                            |
| 成功空目录                     | 发布新的成功版本和时间，旧成员 removed，默认目标保留但失效                                      |
| 超时、限流、临时失败、非法响应 | 只改最近尝试；保留同凭据成功目录，返回 stale/成功时间/错误，已启用且适配的成员仍可用            |
| 401/403                        | 当前凭据 rejected，阻止新调用；刷新开始及后续临时失败不能清除，须同版本明确成功或轮换后重新发现 |
| Key 轮换                       | 旧目录不再属于当前凭据，重新发现前无新请求资格                                                  |
| 并发晚到                       | 旧序号或旧凭据响应拒绝写回，不能覆盖新成功或新错误                                              |

供应商禁用阻止新选择/调用，保留偏好；仍允许显式只读目录诊断。模型移除、禁用、凭据失效均不自动换默认。usage 是业务用途，与供应商 classification 分离；未知分类不自动产生 chat 默认。用户明确指定 chat 用途，且目标当前有效、有已实现 chat 适配、已启用，才可设置默认。禁用模型保留默认目标并显示无效；修改偏好也执行当前资格检查。

已受理异步图片的已知上游任务沿任务所属 `user_id` 查询当前保存的 Key，不因禁用新准入、目录刷新或 Key 版本变化而改变归属；Key 无法解密时保留任务，供应商拒绝或不同账户无权查询时不能承诺上游结果可取回。发送时取得的 Key 是一次出站快照，与并发轮换并非原子操作。

用户可以修改本人已存在实体的展示覆盖，即使其当前不可运行或属于历史；这不创造成员，也不改变分类、声明、验证或偏好。元数据与偏好同次修改共用配置行锁与 revision，在同一事务成功或失败。

## 受控适配声明与实际验证

目录成员、供应商 metadata/classification、服务实现、用户偏好和实际验证分开返回。当前官方 /v1/models 结构只承诺描述性字段，不足以证明逐模型协议；名称前缀、owned_by、description 均不用于推断。当前解析器不会虚构自动关联；未来出现可核实的结构化协议字段时，须先核对供应商契约再增加识别。

元数据不足的模型立即显示 ADAPTER_PENDING。适配解析对同一用户已发现成员采用单轨路由判定：`平台原厂路由（mio_provider_model_routes） -> ADAPTER_PENDING`。部署通过受控路由入口维护平台级路由目录（不创造成员、不写 `verified`、不内置静态模型种子）：

```sh
pnpm providers:route <--stdin | routes.json>
```

普通文件路径或 `--stdin` 导入单条路由对象、`{ routes: [...] }` 或 `1..500` 条路由数组 JSON（读取前校验普通文件或标准输入上限 `65536` 字节），写入前复用[逻辑路由器](../src/providers/onelink/router.ts)纯结构校验器核对已注册驱动（文本 `openai-chat`/`anthropic-messages`；图片 `openai-images`/`volcengine-ark-images`/`vidu-images`/`kling-images`）、驱动前缀路径不变量与 `paramSpec`；幂等重放相同路由不递增 `declaration_version`。路由条目形如：

```json
{
  "rawModelId": "<exact-discovered-model-id>",
  "operation": "chat",
  "vendor": "openai",
  "driver": "openai-chat",
  "classification": "chat",
  "submitPath": "/v1/chat/completions",
  "sourceKind": "protocol-reference",
  "source": "已核对的协议文档或实际观察依据",
  "sourceVersion": "依据版本"
}
```

`sourceKind` 必填且只能是 `protocol-reference`（协议/文档依据）或 `runtime-observation`（对应模型和操作的实际运行观察）。它只说明适配依据，不建立模型成员；`catalog-membership`、目录快照或旧模型清单不是适配来源，`onelink-v1-models` 等目录事实不能填入 `source`。来源类型按显式字段判断，不从 URL、名称或描述猜测。刷新继续由 `metadata_source='onelink-v1-models'` 表达目录成员事实，不能写入路由表。

图片路由统一使用纯原厂协议驱动（`openai-images`、`volcengine-ark-images`、`vidu-images`、`kling-images`），所有操作、尺寸、输出张数、参考图与异步边界均由路由 `paramSpec`、`requestDefaults` 与 `outputSpec` 显式声明，不按名称或前缀自动推断，也不保留按型号写死的旧图片 profile 表。目录返回的图片 `metadata.image` 由生效路由 `paramSpec` 确定性派生：`modes` 必须包含 `generate`，参考图能力可声明 `references.maxImages`（整数 `1..16`，支持单参考与多参考），`edit` 须声明合法 `editPath`（或驱动同端点承载）与正数参考图上限，PNG 遮罩须显式开启 `allowMaskPng:true`，`outpaint` 必须在 `supportedOperations` 中列出并同时开启 `allowOutpaintGeometry:true`（派生像素 `geometry` 边界）；异步能力必须显式声明 `async:{operations,maxQueries,maxAgeSeconds}` 与恰好包含一个 `{task_id}` 的 `queryPathTemplate`，且 operations 必须是支持操作的子集。不得从模型名称、旧 92 项或目录数量推断 edit、mask、outpaint、async 或其他媒体协议。`references.maxImages` 只约束供应商明确声明的参考图能力，不是固定模型或图片容量策略；async 边界只约束有界查询（`maxAgeSeconds` 最长 86400 秒）。当前用户 Key 成功刷新得到的全量模型和数量仍是唯一目录权威。启用图片前执行供应商迁移，启动只读检查路由与验证表约束；声明和目录发现均不证明真实生成可用。运行与未接受边界见[计算 HTTP](apis/compute.md#post-apiv1computeimages)。

平台路由仅对用户已存在成员补充空缺分类，未知分类仍不自动归入 chat；可选文本 `capabilityMetadata.contextWindow` 为正整数，`capabilityMetadata.maxOutputTokens` 为 `1..65536` 正整数（缺省按 1024 执行）。未知上下文/价格/工具/媒体能力不补值。来源明确是部署路由声明，不冒充供应商元数据。路由入口不创造成员、不接收任意外部主机 URL/Key/verified，不开放普通用户管理 API（平台管理员通过独立鉴权的[管理后台 HTTP](apis/admin.md)维护路由、修订回滚与模型策略）。每次实质路由更新递增 `declaration_version`、追加 `mio_provider_model_route_revisions` 快照并使旧版本验证回到 `unverified`，分类变化保留身份/偏好。

文本路由可声明 `capabilityMetadata.cacheRetention`，值限于 `none`、`short`、`long`。该字段随 fresh 请求的路由快照冻结。`anthropic-messages` 缺省为 `short`，发送 `cache_control` 的 `ephemeral` 标记。`long` 在该标记上添加 `ttl: '1h'`，须确认目标支持并显式配置。`none` 省略标记。`openai-chat` 由上游自动处理前缀缓存，Mio 保持原请求形状，省略显式缓存字段与会话关联头。实际缓存读写以对应调用的供应商用量为准。[OneLink 集成](integrations/onelink.md#使用经验与适用条件)

聊天路由通过 `capabilityMetadata.reasoning` 声明推理支持。`{supported: true, efforts: ['low', 'high']}` 开放已核对的档位，列表如有提供须非空、互异，值限 `low`、`medium`、`high`。`{supported: true}` 允许投影上游默认产生的实时思考。未声明或声明 `{supported: false}` 时，平台目录显示 `supported: false`。只有 `supported: true` 的路由可设 `capabilityMetadata.streamIdleTimeoutMs`，范围为 `1..120000` 的整数。省略时为 30 秒。创建会话时校验显式档位，接纳新消息时按当前路由重新校验并冻结能力和期限。推理能力以管理员路由声明为准，和目录成员、当前凭据、实际单次模型观测各自独立。[OneLink 集成](integrations/onelink.md#使用经验与适用条件)

平台模型主表 `mio_provider_catalog_models` 直接控制隐藏模型双向行为：`user_visible=false` 时对普通用户屏蔽该模型（不进入模型列表，显式调用或修改返回 `MODEL_HIDDEN`，已有默认保留目标但 `effective=false`）；`allow_undiscovered=true` 且 `user_visible=true` 时，仅对配置启用、凭据未拒绝且已完成当前凭据目录刷新的用户幂等补录稳定 `admin-curated-hidden` 模型身份，使其在具备生效路由时可选择、调用和记录本人验证，关闭后立即停止对未实际发现用户的开放。

chat 路由可显式声明 `capabilityMetadata.inputModalities`；必须包含 `text`，仅接受互异的 `text`、`image`，缺省按纯文本处理。只有声明二者的路由可使用对话图片，并可声明四项正整数预算：`maxRequestImages` 默认 4、上限 16；`maxRequestImageBytes` 默认 10 MiB、上限 20 MiB，是每次请求全部图片的 Base64 硬上限；`requestImagePixelBudget` 默认 4,194,304、上限 16,777,216；`requestImageMaxBytes` 默认 5 MiB、上限 10 MiB，是单张预览的软目标。纯文本或未声明视觉的路由不能携带视觉预算。能力声明和预算不证明真实视觉调用成功。

验证只来自当前用户本人的成功运行观察（文本对话完成或图片全部请求输出物化完成），独立写入 `mio_provider_model_verifications`，绑定 `credentialVersion/catalogVersion/adaptationVersion` 及 `operation/profile`（不跨用户共享 `verified`）。chat 现有 verified 维度不区分文本和视觉，历史文本成功不代表视觉已实证。刷新、轮换或平台路由 `declaration_version` 递增均使当前有效验证回到 `unverified` 但保留旧观察引用；旧运行晚完成不能覆盖新版本验证，原请求观察仍保留。实际调用允许已实现但未实测项用于授权验证，不能提前展示已验证。

### 音频操作和音色登记

语音路由使用 `classification='voice'`、`vendor='minimax'`，各操作按本人 Key 最近成功发现的精确模型 ID 准入，并遵循模型可见性、供应商启停及 `voice` 用途偏好。平台补录的未发现模型不参与语音准入。每个操作单独读取验证状态，成功的配音观察仅更新该凭据、目录、模型和声明版本的 TTS 验证。

| 操作                | 驱动             | 路径                              |
| ------------------- | ---------------- | --------------------------------- |
| `audio.voices.list` | `minimax-voices` | `/minimax/v1/get_voice`           |
| `audio.tts`         | `minimax-tts`    | `/minimax/v1/t2a_v2`              |
| `audio.clone`       | `minimax-clone`  | `/minimax/v1/t2a_pro/voice_clone` |

语音目录路由接受空参数规格。配音与复刻规格必须声明 `speed`、`volume`、`pitch` 的 `{min,max,default}`、`formats`、`defaultFormat`、`textMaxCodePoints`、`textMaxBytes`、`sampleMaxBytes`、`sampleMinSeconds`、`sampleMaxSeconds`。路由只能收紧服务端预算。固定协议仅接受上述路径，`editPath` 与 `queryPathTemplate` 留空，`requestDefaults`、`outputSpec` 和 `capabilityMetadata` 保持空对象。[OneLink 语音协议](integrations/onelink.md#使用经验与适用条件)

在测试账号下确认一个上游系统音色 ID 对应精确 TTS 模型可用后，使用下面的入口预览登记，增加 `--apply` 写入。`--evidence` 填脱敏的实际运行或已有授权记录引用。前端展示清单可用于寻找待核实的音色。

```sh
pnpm audio:voices:import --owner-id <id> --model-ref <ref> --voice-id <id> --name <label> --evidence <reference>
```

登记限定为本人配置、一个上游音色和已发现的 TTS 模型。同身份重放保留 `voiceRef`、收藏和试听。换 Key 后保留目录条目和收藏，重新发现且路由仍启用时恢复相应系统音色的使用资格。复刻音色需属于本人有效凭据或已有的当前目录快照。用户刷新只读取本地音色。

有授权试听文件时，使用 `pnpm audio:previews:import --stage --source-manifest <file> --source-directory <dir>` 准备清单与 MP3 文件，再用 `pnpm audio:previews:import --owner-id <id> --model-id <exact-id>` 查看计划。核对后加 `--apply`，脚本复用私有资产登记并绑定对应音色。试听资产按本人配置和文件摘要使用固定文件名。重跑可补齐已登记资产但绑定失败的步骤。复用旧试听前须核对本人音色绑定、资产所有者、就绪状态、对象标识、大小、类型、ETag 和内容摘要，并确认该 COS 对象的 ACL 为私有。无法确认时保留已有绑定或待绑定的资产记录，通过复跑继续恢复。[音频 API](apis/audio.md)

### 模型扩展边界

新精确 ID 经成功目录发现后可关联已有且实际兼容的 profile，不新增生产型号名单。声明仅接受字符串形式的已实现 profile；未知或非字符串值拒绝。运行适配层显式选择路由、codec、端点及兼容项，未知值不落入 OpenAI 默认路径。参数差异或新协议须有实际依据，在适配边界补实现、必要准入/存储约束及回归；配置不创造能力，也不重建稳定身份、账号或会话。

各协议分别保留确定性回归与真实观察，某个模型或协议通过不推导其他目标已验证；实际核验目标、未验条件与接受范围见[万联 PRD](tasks/onelink-integration/prd.md#对话验收衔接)及其成果。

## 文本消费与验证入口

selectChat 一致读取本人配置、目录、适配、偏好，不解密。fresh resolveChat 核对同一逻辑身份并冻结稳定模型键、raw ID、凭据/目录/声明版本及 operation/profile，再解密到请求内存。已有 requestId 先返回原回执，当前资格变化不重发；在途运行不换版本。详情见[对话规范](conversations.md)。

[HTTP/加密测试](../tests/providers/providers.test.ts)、[刷新测试](../tests/providers/providers-refresh.test.ts)、[迁移测试](../tests/providers/providers-migration.test.ts)、[打包 Profile](../tests/providers/providers-profile.test.ts)与[目录参考测试](../tests/providers/providers-catalog.test.ts)各自提供实际观察。普通检查使用隔离 PG 和协议替身，不读取私有 Key 或自动调用供应商；宿主 provider 配置由[测试 setup](../tests/providers-setup.ts)隔离。

显式 live 入口 `node tests/providers/providers-live.ts <authorized-private-key-file>` 经隔离账号、公开 HTTP、正式 Profile 保存本人 Key、发现目录、部署声明测试默认，并重启再发现；只输出受控元数据。真实目录成功不等于聊天、全部模型、媒体或生产验收。源异常、代理配置、原响应和 Key 不打印。
