# 创作基础视频迁移候选设计

状态：2026-11-23 的独有设计候选，归属[视频 PRD](prd.md)。本页接口尚非现行能力，采用的部分须在各单元 verify 前进入领域规范。身份/恢复原则沿[生成共同设计](../onelink-image-generation/design.md)，A 执行云生成的已采用边界沿[图片迁入 A](../onelink-image-generation/changes/image-generation-in-a/change.md)。

## 1. 职责与最小复用

| 位置             | 拟增加/复用职责                                                      | 边界                                                                       |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 插件装配/HTTP    | Cookie/Origin、限长 JSON、共同响应原语、服务启停与视频入口           | DSH/Cordis 只在既定适配入口，不改上游、不开放视频工具                      |
| providers        | `video.generate`、原厂 driver、精确型号×模式能力、准入快照与验证元组 | 成员/路由/偏好/运行验证分开，不靠任意参数创造能力                          |
| A generations    | 视频请求解码、幂等、持久意图、一次 submit/poll、认领、物化与恢复     | 复用图片实际共同步骤，不复制调度平台、不移植 Python 双执行体系             |
| OneLink 协议适配 | 方舟/Kling/Vidu/Veo/HappyHorse 窄载荷、回包、安全下载                | 固定端点，不导入开发脚本/相邻源码，不复制 TLS 补链、线路回退和未知模型兜底 |
| assets/COS       | 本人 ready 原件解析、上游读取签名、有界视频写入、输出身份            | `putImage` 不接 MP4；URL/COS key 不是公开资源身份                          |
| A compute 桥/B   | 已取回媒体的真实探测、必要封面/播放派生，复用 MQ/journal             | B 不持供应商 Key、不发生成 POST；A 唯一写视频业务状态                      |
| materials/U1     | 认证解析/在途持有、历史/墓碑/作品引用                                | 调用领域契约，不越域写表或复制个人库                                       |

候选采用视频 jobs/outputs/executions 与图片表并存，复用具有相同身份、时序、错误和副作用语义的实际执行步骤；不先将全部图片表泛化。V1 核对最小代码形状，避免预建无人调用的 helper、driver 框架、缓存和通用工作流。

## 2. 能力声明与请求冻结

### 2.1 路由和能力

候选 operation 为 `video.generate`，模式为 `text_to_video`、`first_frame`、`last_frame`、`start_end`、`reference_subjects`、`full`、`video_ref`、`video_edit`。仅有实际开放的精确路由才增加 `multiframe`；Kling `multiShot` 是独立参数，数字人等不混入基础模式。

五个封闭 driver 对应方舟任务、Kling video、Vidu video、Veo operation、HappyHorse video，最终字面值在 V1 冻结。平台路由保存精确 rawModelId、operation/driver、受控 submit/query/cancel/download 相对模板、模式/参数组合、输入类型/数量/大小/时长、默认项、预期输出数量/格式、取消策略与协议依据。方法/路径/模板按 driver 校验，禁止任意外站、脚本、JSONPath 或未实现驱动配置。

公开 `capabilitiesVersion` 是不透明版本，客户端提交 `expectedCapabilitiesVersion` 检测表单陈旧；它不是 Key 或内部全量快照。可调用性取当前用户目录成员、平台可见策略、启用且已实现路由、账号准入的交集；缺成员、缺路由、未知参数和暂不可用分别投影。目录出现不能自动把 observed/accepted 置真。

### 2.2 冻结与凭据

服务端一次一致准入冻结 owner、modelRef/rawModelId、providerConfigId、credentialVersion、catalogVersion、路由声明版本、driver/mode、有效声音/水印与参数、输入身份/原件版本摘要、预期输出数。请求意图摘要保留数组顺序/重复位置，规范化数字，不包含临时 URL、当前默认项、时间或服务端新分配 ID。

同 owner/requestId 查原任务先于新目录/路由资格校验，但仍须当前登录身份有权读取；同意图直接返回原任务，异意图 409。新请求才核对能力版本和默认项。客户端不得指定 owner、providerConfigId、driver、baseUrl、上游 taskId 或 credentialVersion；凭据明文只在受控出站内存存在，不进入 HTTP/日志/检查点。

已受理外部资源按系统 user_id、原供应商/协议和上游 ID 归属。已提交任务的查询/受保护下载/受支持取消用同用户当前可用账号快照做传输鉴权，不重新检查新生成的模型目录资格、不切用户或供应商。当前 Key 无法访问旧资源时保留 ID 和访问受阻原因；本地完成资产不丢失。不建历史 Key 仓库；尚未出站的旧快照在轮换后不能悄悄借新 Key 提交，保留明确的未提交拒绝/阻塞结果。

## 3. 候选 HTTP 与公开数据

### 3.1 路径、响应和副作用

沿现有图片公开命名空间扩展，路径含 compute 不表示云生成在 B 执行。以下全部待 V1 冻结和采纳。

| 方法/路径                                             | 输入与响应                                                                  | 副作用/边界                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/v1/providers/onelink/models?category=video` | 扩展本人模型投影，带能力摘要、版本、不可用原因                              | 保留既有分页/身份语义，不自动刷新或生成                                      |
| `GET /api/v1/compute/video-capabilities/{modelRef}`   | 精确模式、参数/组合、输入约束、取消和有效默认政策                           | 无生成；非本人 404，本人但缺路由明确不可调                                   |
| `POST /api/v1/compute/videos`                         | `{requestId,modelRef,expectedCapabilitiesVersion,parameters}`；202 VideoJob | 受理后最多一次生成 POST；同 ID 同意图返回原任务、异输入 409                  |
| `GET /api/v1/compute/videos/{id}`                     | 当前本人 VideoJob 与逐项输出                                                | GET 不提交/轮询供应商；不存在/越权统一 404                                   |
| `GET /api/v1/compute/videos?cursor=&limit=`           | 本人任务索引，默认 20/最大 100，createdAt/id 稳定游标，可筛本域任务状态     | 供观察恢复，不冒充 U1 全局历史，不提供项目/来源历史筛选                      |
| `POST /api/v1/compute/videos/{id}/cancel`             | 202 当前任务与 cancellation，重复取消幂等                                   | 记录意图，仅支持的上游动作按保存身份执行一次，不承诺已停止/退款              |
| `POST /api/v1/compute/videos/{id}/recover`            | 202 原任务，并发恢复幂等                                                    | 仅恢复已知 ID 查询、检测/物化/登记，不生成、不重置次数或续期；无安全路径 409 |
| `GET /api/v1/assets/{assetId}`                        | 复用本人 Asset 与短期下载，增加实际采纳的视频检测/派生元数据                | A 不代理长视频，不透传上游下载地址                                           |

复用[HTTP 公共约定](../../apis/index.md)、可信 Cookie/精确 Origin、有界正文与错误信封。候选业务错误为 `VIDEO_INPUT_INVALID`、`VIDEO_MODE_UNSUPPORTED`（400），`VIDEO_CAPABILITIES_STALE`、`VIDEO_RECOVERY_NOT_AVAILABLE`、请求输入冲突（409），`VIDEO_QUOTA_EXCEEDED`（429），`VIDEO_UNAVAILABLE`（503）；资产/任务越权统一 404。最终码与当前原语在 V1 对齐，禁止透传供应商 body/exception。异步任务错误投影为状态/errorCode，不用 GET 500 隐藏已存在的任务。

### 3.2 提交形状与字段

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "modelRef": "22222222-2222-4222-8222-222222222222",
  "expectedCapabilitiesVersion": "opaque-version",
  "parameters": {
    "mode": "start_end",
    "prompt": "镜头从晨雾中的街道缓慢推向亮灯的窗口",
    "ratio": "16:9",
    "resolution": "720P",
    "durationSeconds": 5,
    "generateAudio": true,
    "firstFrame": { "assetId": "33333333-3333-4333-8333-333333333333" },
    "lastFrame": { "assetId": "44444444-4444-4444-8444-444444444444" }
  }
}
```

上例仅示意，无真实模型、素材和可用性承诺。各层拒绝未知键；按 mode 使用判别联合，禁止首尾帧与普通参考残留混发。

| 字段                                                     | 校验/语义                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode`、`prompt`                                         | 精确路由内模式，提示词最多 5000 Unicode 码点，规范化后非空；主体/片段另受数量和总正文上限约束                                     |
| `ratio/resolution/durationSeconds`                       | 枚举/有限正数，精确型号支持小数才允许；组合表优先于三个独立集合，不静默取整/截短/换档                                             |
| `generateAudio/audioType/audioSetting/watermark/offPeak` | 仅支持时可传；不支持明确拒绝，账号默认按现行策略合成 effectiveParameters；快照不能写开音频而出站忽略                              |
| `firstFrame/lastFrame`                                   | 本人 ready 图片 `{assetId}`，角色/索引稳定；同图用两槽仍算两个位置                                                                |
| `references`                                             | 有序 `[{assetId,mediaType,role}]`，真实 Asset 类型权威；V5 允许互斥 `{materialId,role}`，不接任意远端 `asset://`                  |
| `subjects`                                               | `[{name,images:[{assetId}],voiceId?}]`，名称唯一且提示词对应；voiceId 仅精确协议支持且有可靠归属/目录才采用，不开任意声音 ID 通道 |
| `multiShot/shots`                                        | 精确声明支持的 Kling 参数；shots 有序提示词/时长，数量与累计时长有界，不能在任意型号上透传                                        |
| `multiframeSegments`                                     | 已开放 multiframe 型号专用的有序 `{prompt,keyImage:{assetId},durationSeconds}`，逐段/总时长校验；源 2–7 秒非全局规则              |

不接收旧 provider_params 任意字典、直接 URL/Base64/路径、session/shot/project 伪归属字段或上游 ID。未来内部业务消费者须从已授权上下文建立业务引用，外部客户端不能填字段跨项目写入。

### 3.3 VideoJob 投影

最小字段为 id/requestId/modelRef/mode、state/stage、createdAt/updatedAt/completedAt、effectiveParameters、inputSnapshot、outputs、error、cancellation、recovery。inputSnapshot 仅本人可读原文、稳定输入引用和有效参数；不含签名 URL、COS key、Key、上游 body、claim/检查点。已删/失效输入标明不可再用，不替换为看似有效媒体。

输出有固定 index，核验完成后的 assetId、mediaType=video、真实 width/height/durationSeconds/hasAudio/sizeBytes，以及独立封面/预览状态。多输出不截取第一项后谎称完成；封面失败不抹去有效原件，封面不是独立生成历史。

cancellation 分开记录 requested、supported、`pending/confirmed/not_supported/rejected/unknown/too_late`；recovery 返回 available 与 query/materialize/record 等原因。取消请求不代表上游停止或无费用；Mio 无退款/结算逻辑。重新编辑由外部客户端消费脱敏快照，服务端不因此自动提交新任务。

## 4. 状态、持久化与并发

### 4.1 状态事实

候选公开状态为 accepted/submitted/processing/materializing/completed/partial/materialization_failed/failed/rejected/unknown/cancelled。内部至少区分 ready/submitting/waiting/querying/materializing/done；不能用 accepted 掩盖是否出站。

| 场景                   | 持久事实与动作                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------- |
| accepted/ready         | 已受理尚无提交意图，提交前取消可安全 cancelled，0 POST                             |
| submitting             | 先存意图再 POST；无法证明未发送则 unknown，不自动重发                              |
| submitted/processing   | 上游 task/operation、查询模板与预算落库后安排下一次 poll；先核身份再解释状态       |
| materializing          | 上游有结果，继续下载/检测/登记；逐项检查点可恢复，不重新生成                       |
| completed/partial      | 预期输出全核验登记才 completed；有有效项及缺项则 partial，逐项保留，不能吞缺项     |
| materialization_failed | 上游有结果但媒体/存储/登记失败，暴露恢复责任，不伪称模型失败                       |
| unknown                | 提交结果不明、协议未知、查询预算耗尽等原因分开；仅有 ID 且预算未耗尽时可恢复原查询 |
| cancelled/竞态         | 未提交安全取消或上游确认才 cancelled；已成功则保留产物/too_late，不因意图删结果    |

未知/缺失/冲突状态或 ID 不推进成功；每族封闭映射在途/失败/完成及结果结构，HTTP 2xx 与 success 文字不足。取消确认后又成功等矛盾事件进入对账，不静默覆盖终态；真实已产出结果仍须保存归属与引用。

### 4.2 增量数据形状

沿现有媒体域自持池/迁移，不借认证池或承诺跨库原子性；表名待 V1 冻结。

| 表/对象                | 字段与约束                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mio_video_jobs`       | UUID id、owner_id/request_id/input_hash、规范化 command、admitted/route_snapshot、状态/错误、创建/更新/完成时间、取消意图/结果、恢复序号；`UNIQUE(owner_id,request_id)` |
| `mio_video_executions` | job_id 一对一、phase/claim_id、冻结 snapshot、原 task/operation、query_attempt/max/deadline/next_query_at、checkpoint 位置/摘要、storage_failed；到期/未完成索引        |
| `mio_video_outputs`    | `(job_id,output_index)` 主键，完成前 asset_id 可空；远端输出身份/受限取回信息、物化阶段/错误、大小/格式/摘要/元数据；同逻辑输出重入不另造 Asset                         |
| 输入持有               | job/input_index/type、本人 Asset 或 Material、原件版本摘要/用途；使用 U1/素材实际公共存储，在途与作品持有分别释放/转换                                                  |
| 完成登记意图           | task/output 的 Asset/历史身份、待登记标志；补写前查墓碑，幂等登记                                                                                                       |
| A 恢复文件             | 显式持久目录下按 job/output/attempt 保存媒体与摘要，不存 Key/任意路径；COS/PG 对账后清理                                                                                |

本域任务/输出用实际可取得的事务；providers 与媒体可能异库，准入依靠冻结快照和可重入确认。U1 异库时先持久登记意图再调公共入口，历史 pending 可观察，不能以任务完成掩盖历史漏记。

claim 写回、取消、上游 ID 和完成须核当前执行身份/恢复序号，迟到回包不覆写新执行。ID 已到而 claim 失效仍须有安全的保存/对账路径，不能先因取消/租约丢弃 ID。所有权丢失停止新 POST；本地认领不保证供应商 exactly once。

## 5. 输入、取回与 A/B 物化

普通输入解析本人 ready 原件，核真实类型/可用性/路由上限，不以播放转码或缩略图代替原件。确需兼容代理时是显式派生 Asset，记录源/裁切压缩参数并公开有效输入，禁止隐式截短或覆盖原件；旧代理 15 秒/1080p 不是新全局政策。

稳定引用在最后出站边界转协议需要的短期可达 URL、inline 或 asset://，冻结媒体身份/版本，重签不改输入；签名期限覆盖真实读取窗口，不承诺过期链接永远可用。认证解析/持有和撤销竞态沿 V5 材料契约。

1. A 先存远端输出身份，再有界流式下载/解码，不将全视频读内存。普通 URL 复用公网 HTTPS、实际 DNS 连接校验、不跟随重定向；无鉴权头转发。
2. Veo 受保护资源只走核准上游下载端点；operation/resource 名受语法/长度校验及编码，禁止绝对地址/路径逃逸，不复制旧多地址尝试逻辑。URL/Base64 都需累计实际字节上限和解码检查。
3. A 保留临时原件/摘要，写私有 COS 内部 staging，对普通 Asset 查询不可见。
4. B 按固定身份读 staging，有界探测/解码核实容器、视频轨、宽高/时长/音轨/大小，回包关联原 job/output/source digest；协议不足由 V1 最小扩展，旧消费者保持兼容。
5. A 核关联与原件未变，再登记唯一 derived 视频 Asset/output；按 U1 完成历史与持有。COS 成功 DB 失败/重复回包沿原输出恢复，不重生视频。
6. 封面/HLS 等必要派生沿计算能力独立状态；可选封面不阻塞原件成功，私有播放须独立访问控制证据，不能用转码成功代替。

损坏/超限/检测失败不是可消费输出，保留可操作错误和有限恢复数据。该深度核验仅针对供应商生成结果，不扩大[资产库人工上传边界](../unified-asset-library/prd.md)。

## 6. 有界执行与停机

下列是 V1 要核对成本并冻结的候选值，非现行限制或上游保证；精确协议更严格时优先。冻结后通过能力/部署规范公开，不保留无界路径。

| 政策         | 候选值与理由                                                                                  | 收口/测试                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 正文         | 256 KiB、提示词 5000 码点                                                                     | 按 UTF-8 实际字节、结构深度/数组长度核验，不透传任意字典                           |
| 活动视频名额 | 每用户 5/全局 50，是保守容量起点；排队/执行/物化占用，unknown/失败/终态释放活动名额但保留任务 | 持久计数与事务；恢复重占名额，不与图片 32/1000 或转码 10/500 混用，V1 按成本冻结   |
| A 并发       | 复用现有 4 个网络步骤总上界，图片/视频共享，不另起无界视频循环                                | 到期任务选择不让长等待占住执行槽，核对最小公平策略                                 |
| 查询         | 提交起绝对 60 分钟、最多 360 次、最小间隔 10 秒，有界尊重 Retry-After                         | 持久墙钟/查询前计数，重启/429/recover 不清零不续期，任一上限到达停止并保留 unknown |
| 传输时间     | submit/poll 单次 120 秒、下载 300 秒，可由停止信号中止                                        | transport/SDK 不叠乘 retry，POST 超时不重发                                        |
| 字节         | 单输出候选不超过现有 Asset 1 GiB；输入同时受 assets 与精确协议约束                            | Content-Length 仅提示，实际流累计，多引用按有效字节计数，不套图片 16/32 MiB        |
| 安全物化重试 | 单次恢复最多 2 次取回/写入尝试，检测/登记按原输出重入                                         | 不含生成 POST，不延长查询期限，耗尽后显式恢复/对账状态                             |
| 停止/检测    | 停接收/新 claim，中止或等待有界步骤，B 子进程沿其已冻结超时                                   | 先存已得上游 ID/检查点，再按依赖释放；单资源失败仍释放其他资源                     |

不新增 Redis 队列、全局缓存、通用状态机、自动线路切换或持续模型探测。查询/取回属有界安全恢复；生成、取消/删除外部资源不使用同一重试器。取消回执未知只沿原资源查询，不自动反复删除。

## 7. 故障窗口与安全恢复

| 断点                         | 恢复依据                                           | 禁止行为                        |
| ---------------------------- | -------------------------------------------------- | ------------------------------- |
| 受理/唯一键竞争              | 本域事务、owner/requestId                          | 为并发重试换请求身份            |
| 意图已存、送达未知           | submitting 检查点/出站事实，不能证未发送则 unknown | 因服务重启而自动重发            |
| ID 到达但 PG 失败/claim 丢失 | 原响应身份安全保存/对账，失败现场保留              | 丢 ID、换供应商或新任务补证     |
| 查询断开/陌生 ID             | 原协议/ID/模板与剩余预算                           | 认领他人结果或未知状态当成功    |
| 轮换/禁用/移除目录           | 用户归属、原 ID、当前账号传输资格                  | 转绑 owner、偷用旧 Key、再生成  |
| 下载失败/链接过期            | 原输出身份、协议允许的原任务重新取回               | 新生成掩盖旧结果失败            |
| COS 已写/B 或 PG 未确认      | output/attempt/digest 对账，继续检测/登记          | 重复 Asset、未核验公开 ready    |
| Asset 完成/历史未记          | 唯一 task/output、登记意图和墓碑优先               | 复活已删历史/自动入个人库       |
| 取消与成功竞态               | 真实提交/终态与输出事实                            | 凭取消意图删产物/迟到写覆新执行 |
| 关闭失败/重启                | A/B 各自身份与恢复文件，释放所有依赖               | B 重试变生成、自动清掉恢复文件  |

无可靠上游幂等依据时，只承诺本地去重和不盲目重发，不能称供应商 exactly once。人工明确重新生成是新的用户意图/requestId，必须与原 unknown 对账区分，不由 recover 暗中执行。

## 8. 复杂度依据、验证与采纳

| 增量              | 具体失败模式/影响                               | 最小方案/成本                                                |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| 视频检查点        | 超时重启导致重复生成，物化失败不应重生          | 复用 A 短步骤/认领/意图，增加必要 schema/恢复测试，不建平台  |
| 五个窄 driver     | 查询/参数/下载差异会串协议或泄密                | 封闭字段校验+独立夹具/观察，优于任意映射 DSL                 |
| staging/B 核验    | HTML/截断/无视频轨可能仍 HTTP 200，直接成坏资产 | 有界取回+真实核验，成本为临时 COS/B 任务，不扫描全部人工上传 |
| 持有/登记意图     | 在途删除失去输入，补写复活已删历史              | 复用 U1/素材与 task/output 幂等，依赖缺失仅暂停相关单元      |
| 取消意图/结果分离 | 多协议没有停止保证，断开 HTTP 不代表停止        | 少量字段/竞态测试与真实投影，不实现退款/预算                 |

实现测试按 PRD CAP/F/A 追踪，使用实际 `tests/providers/`、`tests/generations/`、`tests/compute/`、`compute/tests/` 等消费者回归，新增具体文件随实现确定。普通回归走隔离通道/虚构模型/替身，不读业务 Key 或自动联网；真实入口独立、显式有界。

真实原件包含候选、脱敏 owner、精确 ID/mode/差异、目录/路由/凭据版本、上游 request ID、POST/查询次数与截止、Asset/媒体核验、取消/恢复及失败/未知。discovered/implemented/observed/accepted 分列，代表样例只证明共同链路，参数/路径/输入差异另验；旧解析兜底仅有可靠协议或真实响应依据时保留。

采纳时更新实际受影响的[供应商规范](../../providers.md)、[供应商 API](../../apis/providers.md)、[计算 API](../../apis/compute.md)、[资产 API](../../apis/assets.md)、[OneLink 集成](../../integrations/onelink.md)、必要 B [协议](../compute-service/protocol.md)及业务/导航，只写已采用部分。本轮仅三份资料，实际检查、独立性/正式候选/CI 缺口留 `.work` 并交回，不改其他成果接受。
