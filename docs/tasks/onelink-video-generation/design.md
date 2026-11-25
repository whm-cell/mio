# 万联基础视频生成迁移与路由设计

状态：规划与候选设计，尚未启动实施或接受。需求归属[万联异步视频与恢复 PRD](prd.md)；任务生命周期与规划交付遵循[当前任务的生命周期](../../coordination.md#当前任务的生命周期)与[规划交付要求](../../coordination.md#规划交付要求)。本页维护旧功能账本、协议矩阵、目标 TypeScript 设计、风险断言与 V0–V6 本期开发单元安排。动态目录、真实调用结果、候选提交和正式证据留在对应执行任务，不由本页预填。

## 1. 推荐方案

按 Mio 的现有职责重新实现旧行为，不复制旧 Python 模块结构：

1. `src/providers/` 继续拥有本人 OneLink Key、动态模型目录、稳定模型身份、平台路由和验证记录，新增有来源的 `video.generate` 路由及视频 capability（遵循[供应商规范](../../providers.md)）。
2. 新建独立 `src/video-generation/`，拥有视频任务准入、幂等、提交/查询/取消、恢复、结果收口和历史视图。
3. `src/integrations/onelink/video/` 按协议族实现严格 submit/query/cancel codec，不保留按模型名称猜供应商的大型分派器。
4. `src/assets/` 继续拥有私有 COS 和 Asset（遵循[资产 HTTP 契约](../../apis/assets.md)）；视频公开请求只接受本人 Asset ID，结果只在实际媒体核验后登记 Asset。
5. A 服务拥有供应商网络副作用和任务事实；B Worker 只执行可重放的本地视频探测（`media.probe`）、参考视频超规预处理（`video.reference_prepare`，按需压至 1080p、截取前 15 秒）与播放派生（`video.derivatives`），不持有 OneLink Key，计算边界统一对接[通用媒体处理设计](../compute-service/media-compute.md)。
6. 一条持久短步骤执行链处理 submit、poll 和 materialize。旧 server orchestrator 与 legacy worker 的重复路径不迁移。

首个垂直切片只选择一个当前目录中可取得、协议证据清楚、支持异步查询且同时支持文生与单首帧的型号。优先评估 Seedance 1.5/Vega 1.5，其次 Kling V3 或 Vidu Q3；最终型号由 V3 C0 根据当前用户目录、路由声明和真实调用授权确定，不把本页优先级写成静态白名单。

该顺序先证明任务内核、unknown、防重复 POST、结果接收和 Asset 闭环，再扩展模式和供应商。这样能把协议差异留在 driver 内，同时避免一次铺开六个协议族造成状态和参数契约反复漂移。

## 2. 盘点方法与源码事实

旧工程引用使用仓库名称加相对路径，仅作静态迁移依据；它们不是 Mio 运行时依赖，也不证明当前供应商在线可用。

### 2.1 四层交叉核对

| 层     | 核对对象                                                                             | 目的                                                |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 注册层 | `mio1.5.1/backend/app/main.py`、`routers/creation.py`                                | 只统计实际 include 的 HTTP 入口，排除未注册副本     |
| 请求层 | `schemas/creation_video_generate.py`、`services/creation/video_submit.py`            | 获取页面可达字段、素材、参数、scope 和幂等行为      |
| 能力层 | `services/model_capabilities.py`                                                     | 获取型号级模式、枚举、默认值和已明确下线项          |
| 执行层 | `services/creation/video_server_step.py`、`services/video_gen/`、`video_finalize.py` | 确认 submit/query、unknown、结果和 Asset 能走到终点 |

防遗漏结论只在这四层一致时成立。适配器中残留代码、注释中的未来能力、未注册路由或旧 UI 字段都不能单独算作可迁移的现成功能；它们仍进入相邻能力表，防止静默消失。

### 2.2 实际入口和主链

| 旧入口                                     | 源码事实                                                    | 目标处理                                                     |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /api/creation/videos/generate`       | `routers/creation_video_generate.py` 调用 `video_submit.py` | 迁为 `POST /api/v1/video/jobs`，返回稳定本地 jobId           |
| `GET /api/creation/videos/tasks/{task_id}` | 返回生成任务状态                                            | 迁为本人 JobView，拆分生成/物化/派生/取消事实                |
| `GET /api/creation/videos`                 | 历史列表                                                    | 由同一视频 job 事实提供稳定游标列表，不复制结果表            |
| 详情、软删、收藏                           | `routers/creation_videos_items.py`                          | 详情读取同一 job；收藏/隐藏显式 PATCH，重复设置幂等          |
| 下载                                       | 旧接口转发或签发结果                                        | 由 `resultAssetId` 复用 Asset 私有下载，不建第二套对象接口   |
| `POST /api/tasks/{task_id}/cancel`         | 本地标取消；仅 Seedance 尝试上游删除且异常被吞              | 拆取消意图、上游支持、请求结果和最终状态，不返回虚假“已取消” |

旧主链为 HTTP → `video_submit.py` → `GenTask/GenTaskSchedule` → server-orchestrated creation_video → `video_server_step.py` 单步 submit/poll → `video_gen/*` → `video_finalize.py`。目标保留“持久意图、单步执行、先资产后派生”的保护，删除重复 worker、兼容 pickling identity、静态模型分派和 Python fallback。

## 3. 完整功能迁移账本

“保留”表示本 PRD 要求，不表示 Mio 已实现。每项只有一个首个责任域和一个首个开发单元；后续单元只能扩展，不另起重复实现。

| ID  | 旧能力或字段                                             | 目标处置与唯一落点                                                                                                                                                                                                   | 首个单元 |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F01 | 本人 Key、视频模型选择、默认模型                         | 复用 providers 当前目录和 video 偏好；精确 `modelRef` 选择，不建视频 Key/模型表                                                                                                                                      | V1       |
| F02 | provider/model capability 与策略                         | 新增 `video.generate` route、VideoRouteConfig 和 capability；目录、实现、验证分列                                                                                                                                    | V1       |
| F03 | prompt、reference_materials、mentions                    | 公开请求使用受控 `promptReferences` 保存文本引用和 mention；关联媒体只收本人 Asset ID；服务端生成并冻结原文、解析结果和 effectivePrompt，未知 mention 不透传供应商                                                   | V2       |
| F04 | 文生 `text_to_video`                                     | 规范模式，driver 按 route 映射供应商字段                                                                                                                                                                             | V3       |
| F05 | 单首帧 `first_frame`                                     | 只接受本人 `firstFrameAssetId`，服务端按协议编码                                                                                                                                                                     | V3       |
| F06 | 单尾帧 `last_frame`                                      | 仅 route 明确声明时开放，禁止从 `start_end` 推断                                                                                                                                                                     | V4       |
| F07 | 首尾帧 `start_end`                                       | 首尾角色和顺序冻结，两个 Asset 都做 owner/type/HEAD 核对                                                                                                                                                             | V4       |
| F08 | 主体/多图 `reference_subjects`、`multi_image`            | 有序 subjects 与图片引用；主体名、每主体图片和可选 route 专属 `voiceRef` 严格声明                                                                                                                                    | V4       |
| F09 | Seedance `full` 多模态参考                               | 统一有序 `referenceAssets`，保留 image/video/audio 类型、ordinal 和角色；按 route 上限取交集；超规参考视频预处理对接[通用媒体处理设计](../compute-service/media-compute.md) `video.reference_prepare`                | V4       |
| F10 | `video_ref`                                              | 仅明确支持的 Kling Omni、Seedance 等 route 受理；输入视频先核验本人 Asset 和实际媒体，超规参考视频（超 1080p 或超 15 秒）预处理对接[通用媒体处理设计](../compute-service/media-compute.md) `video.reference_prepare` | V4       |
| F11 | ratio、resolution、duration                              | VideoRouteConfig 按型号声明枚举、范围、默认值和组合；请求只保存规范值，不跨型号套默认                                                                                                                                | V1/V2    |
| F12 | with_audio、audio_type、audio_setting                    | route 明确声明原生音频及策略；请求值与实际输出音轨分别记录，不能只信 toggle                                                                                                                                          | V1/V4    |
| F13 | off_peak、watermark                                      | 只在 route 声明时允许；默认来自路由和本人 provider 配置，冻结 effective 值                                                                                                                                           | V1/V2    |
| F14 | attachments、Asset ID、原始 URL                          | 公开契约仅保留 Asset ID；服务端解析本人 ready 资产，冻结 size/ETag/type/ordinal 并建立在途保留引用；不接受用户 URL、key 或 bucket                                                                                    | V2       |
| F15 | `provider_params`                                        | 删除公开透传；所有供应商参数进入 driver 的封闭 schema，未知字段拒绝                                                                                                                                                  | V1/V2    |
| F16 | project/session/shot 关联                                | 作为经过 owner 核对的可选业务上下文保存，不作为权限或幂等的唯一依据；画布发布不在基础生成内                                                                                                                          | V2       |
| F17 | scope digest、重复提交                                   | `(owner,requestId)` 唯一并核对 `inputHash`；同输入返回原 job，异输入 409                                                                                                                                             | V2       |
| F18 | GenTask 调度、submit/query、重启恢复                     | 新视频任务内核每次只做一个有界步骤；上游 ID、查询次数、期限、租约和 revision 持久化                                                                                                                                  | V2       |
| F19 | POST/query unknown、上游 ID 先保存                       | 提交意图先落库；可能已发送但没有上游身份为 `submission_unknown`；已有上游身份但无法安全自动推进为 `reconciliation_required`；上游 ID 独立持久并唯一                                                                  | V2/V5    |
| F20 | 公共取消                                                 | 拆分本地意图、provider capability、请求回执、轮询行为和晚到结果                                                                                                                                                      | V2/V5    |
| F21 | 结果 URL、下载、媒体校验                                 | A 受控接收，复用通用媒体处理 `media.probe`（或已接受最小视频探测合同）验证真实视频，COS 核对后登记唯一 Asset                                                                                                         | V3/V5    |
| F22 | thumbnail/HLS/metadata partial                           | 原视频 Asset 与派生状态分离；派生复用通用媒体处理 `video.derivatives`，失败为 degraded，可独立恢复，不重新生成                                                                                                       | V3/V5    |
| F23 | 列表、详情、收藏、软删、下载                             | 同一 job 兼作历史记录；favorite/hidden 字段显式设置；下载复用 Asset                                                                                                                                                  | V2/V3    |
| F24 | 再次使用参数                                             | 返回冻结 model/mode/params/input refs 的可编辑快照；不自动提交新任务                                                                                                                                                 | V2       |
| F25 | multi_shot、shot_type、multi_prompt、multiframe_segments | 登记为分镜编排相邻能力，首批拒绝；有专属产品契约后再新增 operation，不塞进基础模式                                                                                                                                   | 后续独立 |
| F26 | avatar/数字人、口型                                      | 登记为真人素材和音频驱动相邻能力，首批拒绝                                                                                                                                                                           | 后续独立 |
| F27 | video_edit、extend、motion-control、multi-elements       | 登记为编辑 operation，首批拒绝                                                                                                                                                                                       | 后续独立 |
| F28 | upscale、去字幕、裁剪、抽帧、配音回封                    | 归属[通用媒体处理设计](../compute-service/media-compute.md)或对应媒体产品能力；只复用已接受实现，不在 `src/video-generation/` 重写                                                                                   | 后续独立 |
| F29 | 旧任务/资产导入                                          | 不导成可 submit 的新任务；按可验证、只查询、人工对账、审计四类独立迁移                                                                                                                                               | 后续独立 |
| F30 | 旧 UI、Agent 工具、部署切换                              | 分别交付，不由后端基础能力自动开放                                                                                                                                                                                   | 后续独立 |

F01–F24 是基础后端完整闭环。任何单元发现新的实际注册入口或当前页面可达字段，必须先补本表、确定唯一 owner 和验收，再修改代码。

## 4. 旧型号与协议矩阵

下表来自旧 `VIDEO_MODEL_CAPABILITIES` 和可达适配器，是迁移清单，不是 Mio 静态白名单。别名只说明旧映射；目标仍以当前用户目录返回的精确 raw model ID 为成员真源。

| 协议族 / 旧型号组                  | 旧声明基础模式                               | 旧关键限制                                                       | 目标 driver 说明                                 |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Seedance 1.5 Pro / Vega 1.5 Pro    | 文生、首帧、首尾帧                           | 480P/720P/1080P；4-12s；原生音频、水印                           | `seedance-video`；不开放 last/full/video_ref     |
| Seedance 2.0 及 2-0/mini/fast 别名 | 文生、首帧、仅尾帧、首尾帧、full、video_ref  | 普通最高 4K、fast 最高 720P；4-15s；普通图≤9/视频≤3/音频≤3/总≤15 | 同 driver，route 保存每个 raw ID 的真实差异      |
| Seedance 2.5                       | 同 Seedance 2 六模式                         | 480P/720P；4-30s；图≤30/视频≤10/音频≤10/总≤50                    | 大参考池必须另做预算和真实验证，不能套 2.0 上限  |
| Vega 1.0 Pro                       | Seedance 2 主模式                            | 最高 1080P；4-15s                                                | 同 driver，独立 route/验证元组                   |
| Kling V3                           | 文生、首帧、首尾帧                           | 720P/1080P；5-15s；原生音频；旧多图/multi-shot 已下线            | `kling-video`；只开放三模式                      |
| Kling V3 Omni                      | 文生、首帧、首尾帧、参考视频                 | 720P/1080P/4K；3-15s；原生音频                                   | 同 driver，video_ref 独立验证                    |
| Kling 2.5 Turbo                    | 文生、首帧                                   | 720P/1080P；5/10s；无原生音频；尾帧曾实测静默无效                | 绝不从 Kling V3 外推 start_end                   |
| Vidu Q3 Pro                        | 文生、首帧、首尾帧                           | 540P/720P/1080P；1-16s；音频、水印、错峰                         | `vidu-video`；参考生/多图旧产品已下线            |
| Vidu Q2                            | 文生、主体参考                               | 4/8s；不传 resolution；≤7 主体、每主体≤3 图；音频 bool           | img2video/start_end 旧实测失败，必须关闭         |
| Veo 3.1 / Fast                     | 文生、首帧、首尾帧、主体多图                 | 16:9/9:16；720P/1080P/4K；固定 8s；主体图≤3                      | `veo-video`；不支持 video_ref                    |
| HappyHorse 1.0/1.1 t2v             | 文生                                         | 720P/1080P；3-15s                                                | `happyhorse-video`；route 分型号                 |
| HappyHorse 1.0/1.1 i2v             | 首帧                                         | 720P/1080P；3-15s；比例随图                                      | 同 driver，不接受 ratio override                 |
| HappyHorse 1.0/1.1 r2v             | 主体/多图                                    | 1-9 图；720P/1080P；3-15s                                        | 同 driver；video-edit 型号不在基础范围           |
| FAL stable-video                   | 首帧                                         | 比例/时长使用已证实官方默认                                      | `fal-video`；固定单图输入                        |
| FAL wan-flf2v                      | 首尾帧                                       | 480P/720P；16:9/9:16/1:1                                         | 同 driver，两个 Asset 必需                       |
| FAL Kling V3 text/image            | text 型文生；image 型首帧/首尾帧             | 3-15s；standard/pro 分 route                                     | motion-control 型排除                            |
| FAL Seedance normal/fast           | text 文生；image 首帧/首尾帧；reference full | 普通 image/ref 可至 1080P，fast 至 720P；4-15s                   | 每个 FAL endpoint 独立 route，不按模型前缀拼路径 |

所有协议的 query/cancel 也必须逐 route 声明。旧工程仅 Seedance 有尽力删除分支，而且本地会吞异常并返回“已取消”；因此目标初始取消能力一律为 `unknown/unsupported`，直到对应 driver 有协议依据和确定性/真实观察。同步和异步返回也由 route 显式声明，不能按供应商名称推断。

## 5. 参数、输入与能力契约

### 5.1 规范请求

目标请求逻辑形状如下，实际 TypeScript 名称由 V1/V2 冻结：

```ts
interface VideoJobCreate {
  requestId: string;
  modelRef: string;
  mode:
    | 'text_to_video'
    | 'first_frame'
    | 'last_frame'
    | 'start_end'
    | 'reference_subjects'
    | 'full'
    | 'video_ref';
  prompt: string;
  promptReferences?: (
    | { kind: 'text'; content: string }
    | {
        kind: 'mention';
        mentionId?: string;
        assetId?: string;
        assetType?: 'image' | 'video' | 'audio';
        displayText: string;
        start?: number;
        end?: number;
        intendedRole?: string;
      }
  )[];
  parameters?: {
    aspectRatio?: string;
    resolution?: string;
    durationSeconds?: number;
    generateAudio?: boolean;
    audioType?: string;
    audioSetting?: string;
    offPeak?: boolean;
    watermark?: boolean;
  };
  inputs?: {
    firstFrameAssetId?: string;
    lastFrameAssetId?: string;
    referenceImageAssetIds?: string[];
    referenceVideoAssetId?: string;
    referenceAssets?: {
      assetId: string;
      type: 'image' | 'video' | 'audio';
      role?: string;
    }[];
    subjects?: { name: string; imageAssetIds: string[]; voiceRef?: string }[];
  };
  context?: { projectId?: string; sessionId?: string; shotId?: string };
}
```

未知字段拒绝。`promptReferences` 保留旧 `reference_materials` 的文本合并和 `mentions` 的可编辑来源；引用媒体时只允许本人 ready Asset，asset 类型和 mention 区间必须核对，旧资产快照中的额外 JSON 只作为受控来源元数据，不授权下载。`referenceAssets` 的数组顺序是 full 模式跨 image/video/audio 的全局 ordinal，每项类型和角色随快照冻结；`referenceImageAssetIds` 只供主体/多图模式，`referenceVideoAssetId` 只供单参考视频模式，不能与 full 输入混用。`mode` 决定允许的输入组合；route 决定参数枚举、默认值、最大数量和协议映射。API 不接受 raw URL、对象键、bucket、Authorization、供应商名称、任意 JSON 参数或用户指定 endpoint。

### 5.2 VideoRouteConfig

`src/providers/` 增加一个 `video.generate` operation。每条 route 至少冻结：

- `driver`、`vendor`、`submitPath`、可选 `queryPathTemplate`、可选 `cancelPathTemplate`。
- 同步/异步返回形态、上游 task ID 和状态字段、结果 URL/对象的严格 `outputSpec`。
- `supportedModes`，每个模式的必需/禁止输入、素材数量和顺序规则。
- `ratio`、`resolution`、`duration` 的枚举/范围/default，以及不允许调用方覆盖的字段。
- 原生音频、`audioType`/`audioSetting`、`offPeak`、`watermark` 的支持和默认值。
- `maxQueries`、`maxAgeSeconds`、单次请求/响应上限、结果刷新策略和取消语义。
- `inputReleasePolicy`：inline/multipart、短期 URL 和 unknown/待对账分别使用可观察释放事件、最大保留期限及到期处置；不能用推测的“供应商已读完”作为释放条件。
- `sourceKind`/`source`/`sourceVersion`/`declarationVersion`；目录发现不能作为 route 来源。

`capabilityMetadata.video` 是供准入和展示使用的规范化能力；driver 仍对原始 payload 和 response 做完整 codec 校验。`paramSpec`、metadata 和 driver 必须相互校验，不允许声明一种模式而 codec 静默忽略。

视频验证不能复用当前 `(provider_id, model_key, operation)` 单行加 `tested_tuple` 的覆盖写法。V1 增加追加式模式证据历史，至少以 provider/model/operation、credential/catalog/adaptation/declaration version、driver、mode、规范参数元组 hash 和候选提交区分记录；当前资格从仍匹配现行目录与 route 版本的成功证据派生。失败、未知和旧版本证据保留但不证明当前格子，新的模式验证不得覆盖既有模式证据。

### 5.3 输入资产快照与参考视频预处理

每个输入记录 `assetId`、role、ordinal、owner、contentType、size、ETag/对象版本和必要媒体探测摘要。任务准入与 job 建立处于同一事务或等价补偿边界，并为每个输入建立活动任务引用或有期限保留租约；提交前重新 HEAD。准入前对象已删除、非 ready、类型不符、owner 不符或内容身份变化时不发生供应商 POST。

对于 `video_ref` 或 `full` 模式携带的参考视频输入，超规预处理统一对接[通用媒体处理设计](../compute-service/media-compute.md)的 `video.reference_prepare`（按需压至 1080p 并截取前 15 秒）：预处理由计算服务 Worker B 执行并产出受控预处理资产供上游提交使用；若原参考视频已符合 1080p 与 15 秒时长上限，`video.reference_prepare` 仅执行探测并返回 `compressed=false`、`trimmed=false` 与空 outputs，视频生成任务直接沿用 `inputs` 中的原 ready 资产，不重复转码或复制发布，原输入快照与活动引用继续受保护。

用户在任务受理后隐藏或逻辑删除 Asset，只改变用户视图，不得使在途对象进入物理清理。释放严格按冻结的 route `inputReleasePolicy`：inline/multipart 只能在取得权威 submitted/returned/rejected 回执且本地不再需要重编码后释放；短期 URL 在上游明确复制完成、generation 终态或 route 规定的可观察事件前保留；`submission_unknown`/`reconciliation_required` 至少保留到对账期限。达到最大保留期限仍未满足释放事件时，执行 route 冻结的审计清理处置并保留任务事实，不得静默当作供应商已读取。URL 到期只从保留对象重新签发并继续原任务，不创建新 job 或重新提交生成 POST。V2 必须覆盖“建任务后 POST 前删除”“POST 后删除”“临时 URL 到期”和“unknown 达到保留上限”四个窗口。

图片、视频和音频参考按 route 取真实限制与 Mio 本地安全限制的较小值。旧 Seedance 2.5 的 50 个总参考是最大迁移目标，不表示首个切片必须立即开放大集合；V4 在有资源预算和真实证据后逐档提升。

服务端可把本人 Asset 转成 data URI、multipart 或受控临时 URL。临时 URL 只发往已核准供应商 origin，不进入日志；重定向不得携带凭据。输入 URL 到期只恢复编码/签名步骤，不重新创建生成任务或生成 attempt。

## 6. 目标模块与责任

下列新建路径均为规划落点（主干当前尚未创建）：

```text
src/video-generation/
  contracts.ts       公共请求、视图、模式、状态和严格解析
  schema.ts          显式 PostgreSQL 迁移与只读 schema check
  store.ts           job、输入、上游事实、输出、租约和状态 CAS
  admission.ts       owner、modelRef、route、Asset、幂等与配额
  service.ts         create/get/recover/cancel/list/patch
  runner.ts          一次有界 submit/query/materialize 步骤
  materialize.ts     受控接收、探测、COS/Asset 收口
  http.ts            登录用户 HTTP 边界

src/integrations/onelink/video/
  contracts.ts       driver 合同与公共严格 codec 原语
  seedance.ts
  kling.ts
  vidu.ts
  veo.ts
  happyhorse.ts
  fal.ts
  public-result.ts   复用或扩展现有公网 HTTPS 安全接收原语
```

| 责任                         | 唯一 owner                        | 禁止重复                                                       |
| ---------------------------- | --------------------------------- | -------------------------------------------------------------- |
| 凭据、目录、路由、能力、验证 | `src/providers/`                  | `src/video-generation/` 不保存第二份 provider 配置或静态成员表 |
| 外部生成任务与恢复           | `src/video-generation/`           | 不塞入图片 `mio_image_jobs`，不建第二套 RabbitMQ 供应商 worker |
| 协议请求/响应                | `src/integrations/onelink/video/` | service 不出现供应商字段分支，driver 不访问数据库              |
| Asset、对象键、短期下载      | `src/assets/` 与 COS adapter      | 视频记录不保存可下载对象键或自建签名器                         |
| 本地媒体探测/预处理/派生     | 已接受的计算服务合同              | A 不执行无界 FFmpeg，B 不解密 Key 或请求供应商                 |
| HTTP 登录、Origin、错误      | 现有 auth/foundation              | 不建视频专用认证和错误 envelope                                |

当前主干已具备既有单路视频转码、标准语音生成与独立音频检测能力，而[通用媒体处理设计](../compute-service/media-compute.md)（`/api/v1/compute/media`，含 `media.probe`、`video.reference_prepare`、`video.derivatives`）处于 P0 规划与 M1–M6 待实施状态。V2/V3/V4 开工前由集成负责人核对对应计算单元是否已形成已接受候选：已接受则直接复用实际内部应用服务；若 V2/V3 先于通用媒体处理 M2 实施，则仅冻结视频所需最小探测合同，避免复制竞争实现。

## 7. 数据、状态和执行模型

### 7.1 最小持久数据

为避免任务与历史重复，`mio_video_jobs` 同时是执行任务和用户历史记录，公开 `recordId` 与 `jobId` 使用同一个 UUID。建议最小表：

| 表                            | 关键事实                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mio_video_jobs`              | owner/requestId/inputHash、冻结请求和 route/credential snapshot、三层状态及 reasonCode、取消事实、favorite/hidden、结果 Asset、revision、nextActionAt、租约 |
| `mio_video_job_inputs`        | jobId、role、ordinal、Asset ID、提交时 size/ETag/contentType/探测摘要、releasePolicySnapshot、活动引用或 retainUntil/releasedAt；唯一顺序和角色             |
| `mio_video_provider_attempts` | submission intent、POST started、上游 ID、原始状态摘要、查询次数/期限、cancel request/result；每 job 默认一个生成 attempt                                   |
| `mio_video_outputs`           | output ordinal、供应商结果身份摘要、接收检查点、内容 hash、materialization 状态、Asset ID；同 job/output 唯一                                               |

模式级真实验证证据归 `src/providers/`，不放进视频 job 表；视频 job 只冻结创建时使用的完整 verification snapshot 和证据身份，保证目录或 route 更新后仍能解释原任务。

不要另建“视频记录”表复制 prompt、收藏和 Asset。需要多个结果时，outputs 保留逐项事实，job 汇总不隐藏缺项。上游 ID 不只埋在 JSON 中；应有可索引、唯一和可恢复的列。

### 7.2 生成状态

```text
accepted -> submitting -> submitted -> processing -> returned
                    \-> submission_unknown
submission_unknown --authoritative reconciliation--> submitted/processing/returned/failed/cancelled
submitted/processing -> reconciliation_required -> submitted/processing/returned/failed/cancelled
submitted/processing -> failed
accepted -> cancelled
submitted/processing + cancel request -> submitted/processing，继续保存 provider final fact
submitted/processing + provider confirmed cancel -> cancelled
```

- `submitting` 表示持久意图已建立，runner 已进入可能发生外部副作用的步骤。
- 进程在 `submitting` 中断且没有可验证上游 ID 或结果检查点时，恢复为 `submission_unknown`，不得回到 `accepted`。
- `submission_unknown` 只有在有审计来源的权威对账取得上游 ID 或确定终态后，才能进入 `submitted`/`processing`/`returned`/`failed`/`cancelled`；对账来源和原始身份必须持久化。没有确定证据时保持原状态，任何 recover 都不得 submit。
- `reconciliation_required` 表示已有持久上游身份，但查询状态未知、查询预算耗尽、原凭据不可用或取消结果不明使自动推进不再安全；保存 `query_unknown`、`query_limit`、`credential_unavailable` 或 `cancel_unknown` 等 `reasonCode`。恢复只能沿原上游身份查询、恢复原凭据或人工对账，不得 submit。普通 recover 不重置 `queryCount`、`maxQueries` 或 deadline；`query_limit` 只有经受限人工决策显式扩展预算并记录 actor、reason、旧值和新值后才能继续查询。
- `returned` 只表示供应商产物已取得确定身份，不表示 Asset 已完成。
- `failed` 只用于确定失败；网络结果不明、非法未知状态或无法核对的上游响应不得猜成可重试失败。
- cancel request 是正交事实，不单独推动 generation 状态；`cancelled` 只表示 POST 前已确定终止，或供应商明确确认取消。取消结果未知但仍可安全查询时继续保存 generation 进展；只有无法继续自动核对时才进入 `reconciliation_required`。若取消请求后成功晚到，generation 记录 `returned`，展示和 Asset 可见性按冻结政策处理。
- 终态更新使用当前 phase/revision 条件；晚到 query、cancel、download 回执不使终态回退。

### 7.3 物化与派生

```text
pending -> receiving -> verifying -> uploading -> registered
            |             |             |
            +-----------> failed <------+

registered -> derivatives pending/running -> ready | degraded | failed
```

A 通过受限公网接收器下载供应商结果，写入任务私有本地 spool 或确定性私有 COS staging。中间对象不是 Asset，也不对用户可见。接收完成后保存字节数、内容摘要和来源身份；B 经 `media.probe`（或已接受的最小媒体探测接口）验证真实视频流、可解码性、时长、尺寸和音轨。A 再将不可变结果写入最终私有对象并核对，最后在数据库登记唯一 Asset。

任何阶段已有检查点时先恢复该阶段。下载、探测、COS 或数据库失败不得回到 submit。Asset 登记完成即满足基础结果；播放派生（`video.derivatives`）失败保留原视频并显示 `degraded`。

### 7.4 凭据身份

准入冻结 providers 的加密凭据快照及 `providerConfigId/credentialVersion/catalogVersion/modelKey/rawModelId/declarationVersion`。提交、查询、取消和受保护结果刷新都打开原任务快照；新请求才使用新版本。这样避免用户换账户或重存 Key 后用错误身份查询同名上游 ID。

凭据删除、主密钥缺失或 provider 明确撤销时，已有上游身份的原任务进入 `reconciliation_required`，并记录 `reasonCode=credential_unavailable`；没有上游身份但 POST 可能已发生时保持 `submission_unknown`。两者都不得回退当前 Key、其他用户 Key、管理员 Key 或其他供应商。快照终态后的清理期限由 V2 C0 冻结；unknown、待对账和待取消任务在对账期限内保留恢复所需身份。

## 8. 供应商执行合同

每个 driver 实现同一窄合同，协议差异留在严格 codec：

```ts
interface VideoDriver {
  submit(
    input: FrozenVideoInput,
    credential: string,
    signal: AbortSignal,
  ): Promise<
    | { state: 'submitted'; upstreamTaskId: string }
    | { state: 'returned'; outputs: ProviderVideoOutput[] }
    | { state: 'rejected'; code: string }
    | { state: 'unknown'; code: string }
  >;
  query?(
    input: FrozenVideoInput,
    credential: string,
    upstreamTaskId: string,
    signal: AbortSignal,
  ): Promise<
    | { state: 'processing' }
    | { state: 'returned'; outputs: ProviderVideoOutput[] }
    | { state: 'failed'; code: string }
    | { state: 'unknown'; code: string }
  >;
  cancel?(
    credential: string,
    upstreamTaskId: string,
    signal: AbortSignal,
  ): Promise<
    { state: 'confirmed' } | { state: 'not_supported' } | { state: 'unknown'; code: string }
  >;
}
```

driver 不决定 owner、配额、数据库状态、Asset 或重试。HTTP 2xx 内业务错误必须按协议拒绝；任务 ID、状态、结果数量和回显 ID 都做严格核对。submit 的不确定结果进入 `submission_unknown`；已有上游 ID 后 query 的未知枚举或不确定结果进入 `reconciliation_required` 并保存 `reasonCode` 与受控状态摘要，不把未认识的值当 processing、failed 或 success。

生成 POST 的 SDK retry、fetch retry 和 Mio retry 均为 0。只有某 route 有可验证的上游 idempotency key 或按请求 ID 对账机制，才能在声明中开启同一身份的安全恢复；开启前必须有故障替身和真实观察。

## 9. 风险清单与故障验收矩阵

### 9.1 P0 风险

| 风险                     | 设计阻断                                                                     | 必测断言                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 模糊提交导致重复付费     | POST 前持久 intent；发送后异常进入 unknown；上游 ID 独立保存                 | 四个提交窗口逐一杀进程；同 owner/requestId/inputHash 实际 POST≤1                                      |
| 查询使用错误账户         | 冻结加密凭据和 route 身份                                                    | Key 轮换后旧任务仍用原身份；换账户不能认领旧任务                                                      |
| 用户输入 URL/Asset 越权  | 公开接口只收本人 Asset ID；HEAD/媒体类型核对；任务引用阻止在途对象被物理清理 | 跨用户、准入前已删、pending、伪 MIME、对象替换、首尾颠倒拒绝；准入后删除和 URL 到期仍沿原任务安全恢复 |
| 供应商结果 SSRF/资源耗尽 | 公网 HTTPS、DNS 连接钉住、无重定向/代理、流式上限和磁盘预留                  | 私网/回环/重绑定/超限/慢流/长度冲突/残片清理逐项测试                                                  |
| 伪视频被登记成功         | 实际容器和解码 probe，输出与请求 owner/job 绑定                              | HTML、JSON、PNG、空文件、截断 MP4、无视频流和不可解码结果失败                                         |

### 9.2 P1 风险

| 风险                       | 设计阻断                                                | 必测断言                                                                           |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 目录成员被当作已实现       | 成员、route、driver、verification 四层门禁              | 无 route/未实现/未验证组合分别返回稳定不可用原因                                   |
| 参数同名语义不同           | route 白名单和组合约束                                  | duration、resolution、audio、水印、offPeak 不跨型号套用                            |
| 取消误报                   | 取消事实拆层；不支持时明确                              | POST 飞行中、无 cancel、回执丢失、晚到成功不覆盖取消                               |
| 查询不明被误判或重提       | 已有上游 ID 的 unknown 持久为 `reconciliation_required` | query unknown、查询上限、凭据不可用和取消不明保留 reasonCode；恢复 POST 次数不增加 |
| materialize 失败触发重生成 | output checkpoint 与 job submit phase 分离              | 下载/COS/DB/派生失败恢复次数增加，POST 次数不增加                                  |
| 并发查询和租约过期         | phase/revision CAS、一次有界步骤                        | 两实例只能提交一次，晚到 query 不覆盖终态，不重复 Asset                            |
| 派生失败隐藏原视频         | original registered 与 derivative 状态分离              | HLS/封面失败仍可下载原视频，重试只触发派生                                         |
| 配额复用错误               | 生成、轮询、接收、磁盘、Compute 分池                    | 幂等重放不重复占位；某一资源饱和不破坏其他任务事实                                 |
| 日志和错误泄露             | 受控字段、URL/Key/prompt 脱敏                           | Key 及其 Unicode 转义、签名 URL、供应商原文不出现在响应/日志                       |

### 9.3 具体故障窗口

| 窗口                            | 恢复动作                                                                                | 禁止动作                                        |
| ------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| intent 已写、POST 未开始        | 原 job 可继续一次 submit                                                                | 新建第二 job 或重复计入配额                     |
| POST 已开始、无回包             | 标 `submission_unknown`；权威对账找到 ID/终态后沿合法转换推进                           | 自动 POST、换 requestId、换 provider            |
| 已回上游 ID、未写 job           | 先从 provider attempt/独立事实恢复 ID                                                   | 重新生成                                        |
| ID 已写、未排 query             | 原 ID 进入有界查询                                                                      | 再次 submit                                     |
| query unknown/达到查询上限      | 标 `reconciliation_required` 并保留 reasonCode；普通 recover 不重置预算，只沿原 ID 对账 | 猜成 processing/failed、隐式加预算或再次 submit |
| 已有 ID、原凭据暂不可用         | 保留原身份，待凭据恢复或人工对账                                                        | 换用当前 Key、管理员 Key 或其他账户             |
| 建任务后 POST 前输入被逻辑删除  | 使用活动引用保留的同一对象并再次核对                                                    | 物理清理、换对象或新建 job                      |
| POST 后输入被逻辑删除           | 严格按冻结的 `inputReleasePolicy` 保留到可观察释放事件或审计到期处置                    | 提前清理在途对象                                |
| 输入短期 URL 到期               | 从保留对象重新签发，继续原 attempt                                                      | 新建 attempt 或再次生成                         |
| query 回结果、未保存 checkpoint | 用同 ID 查询或按已存原始回执恢复                                                        | 创建新任务                                      |
| 文件已接收、未 probe            | 从不可变接收检查点继续 probe                                                            | 重新下载或生成，除非内容核对失败                |
| probe 通过、COS 未完成          | 继续上传/复制并核对                                                                     | 重新调用供应商                                  |
| COS 已有、Asset 未登记          | 按 deterministic job/output 唯一性补登记                                                | 生成第二 Asset                                  |
| Asset 已登记、派生失败          | 独立派生恢复，显示 degraded                                                             | 撤销原 Asset 或重生成                           |

## 10. V0–V6 本期开发单元与 C0/C1 安排

生命周期定义沿[当前任务的生命周期](../../coordination.md#当前任务的生命周期)。本节为规划安排，不代表开发就绪、源码已实施或能力已接受；各单元实际开工时再建立独立 `.work` 执行记录。

### V0 迁移账本与契约

- **结果与非目标**：完成[万联异步视频与恢复 PRD](prd.md)与本设计（`design.md`）中的功能账本（F01–F30）、协议矩阵、目标 API/状态/数据/安全契约、参考视频预处理衔接及写入责任；记录旧源码静态事实与目标未验证状态。**非目标**：不写业务代码，不执行真实供应商调用，不把通用媒体处理规划候选视为已接受，不预建 V1–V6 执行记录。
- **C0（决定、授权、依赖、缺口与解决动作）**：核对旧注册入口、schema、capability 和 driver；依赖只读旧工程与 Mio 现行 auth/providers/assets/coordination 规范（不依赖未接受源码候选）；确定基础/相邻边界、目标模块 owner、首切片选择原则、验收 ID 和停止条件；当前缺口为实际运行目录中的首个目标型号与通用媒体处理接受时机，留待 V1/V2/V3 各自 C0 收口。
- **C1（实施顺序、验收与接受条件）**：完善 `prd.md` 与 `design.md`，登记 `documents.json`，运行文档与护栏检查并审阅覆盖、架构、风险和规划充分性；**验收与接受条件**：F01–F30 每项有唯一落点或排除理由，六协议族和全部基础模式均在矩阵中，V1–V6 各自具备完整 C0/C1 与接受条件，两份文档通过护栏检查与独立审阅，经人类对规划范围、风险、架构与顺序明确接受后收口（接受 V0 仅表示规划可交回，不代表 V1–V6 开发就绪或真实供应商已验证）。

### V1 视频模型路由与能力声明

- **结果与非目标**：`src/providers/` 支持 `video.generate`、VideoRouteConfig、视频 driver 枚举、`paramSpec`/capability/`outputSpec`、声明导入、数据库约束和追加式模式验证证据；现行 provider/OneLink 规范随采用更新。**非目标**：不提交真实视频任务，不把旧静态清单批量导入，不从模型名推断 route，不开放未实现模式。
- **C0（决定、授权、依赖、缺口与解决动作）**：依赖已接受 providers 基础与集成负责人对公共 provider 文件的串行写入授权；从当前用户成功目录选择首个候选 raw model ID 并取得协议依据；冻结 submit/query/cancel 路径、状态、参数、默认值、输入上限、查询次数/期限和输出形态；当前缺口为首个型号当前在线协议字段核实，解决动作为 C0 按当前账户目录与协议文档逐项核对后再进入 C1。
- **C1（实施顺序、验收与接受条件）**：依次修改 provider contract/schema/router/store/service 与显式迁移 → 实现严格 route parser → 增加按完整验证元组区分、不可覆盖的证据历史及当前资格派生 → 补全导入、禁用、目录移除、声明版本、未知字段与打包测试，并在 verify 前同步现行规范；**验收与接受条件**：无 route、禁用 route、目录非当前、driver 未实现与 verification 未完成各有明确状态，目录发现不自动建 route，同型号多 mode/参数元组证据可并存且旧版本证据不放行新版本；迁移、契约、确定性测试、三方对账与独立审查齐备并由人类接受（不代表真实生成已验）。

### V2 持久任务内核与 HTTP

- **结果与非目标**：交付 `src/video-generation/` 的 `schema`/`store`/`admission`/`service`/`runner`/`http`，实现 create/get/recover/cancel/list/detail/patch、独立视频表、幂等、快照、配额和单步调度（使用协议替身）。**非目标**：不接全部供应商，不建通用 DAG，不复用图片业务表，不迁旧历史，不开放 Agent 工具。
- **C0（决定、授权、依赖、缺口与解决动作）**：依赖 V1、auth、assets、PostgreSQL 及已接受的最小视频探测合同（或通用媒体处理 M1–M2）；冻结请求 schema、prompt/正文边界、全局素材安全上限、状态与 `reasonCode`、任务租约、每条 route 的 `inputReleasePolicy`、查询期限与预算扩展权限、并发与关闭、凭据快照保留、取消后内部对账与晚到产物政策；缺口为通用媒体处理 M2 是否已接受，解决动作为 C0 核对已接受候选，未就绪时仅在本单元冻结并实现最小视频探测接缝。
- **C1（实施顺序、验收与接受条件）**：先落显式迁移和只读 schema check → 实现 owner/Origin/unknown-field 校验、Asset HEAD 快照与活动引用、同 `requestId` 幂等与配额 → 实现有界单步 submit/query/materialize、`submission_unknown`/`reconciliation_required`、权威对账转换与普通 recover 不重置预算 → 用确定性 fake driver 覆盖全状态与四个输入生命周期窗口；**验收与接受条件**：两实例并发不重复 POST，重启保持 job/input order/活动引用/upstream fact，跨用户不可枚举，取消不虚报，列表/收藏/隐藏不调用供应商，四个输入删除/URL 到期/保留上限窗口均不增加 POST 次数；schema、HTTP、故障矩阵、规范对账与独立审查齐备并经人类接受（不宣称真实协议可用）。

### V3 首个真实协议垂直切片

- **结果与非目标**：一个异步 driver 完成文生与单首帧两种模式，从目标 HTTP 合同与同一准入内核打通真实供应商、query、受控结果接收、probe、COS、Asset、历史与下载闭环；首次取证经受限验证入口发起。**非目标**：不以该型号证明别名、首尾帧、参考模式或其他供应商；不要求上游取消；不开放大参考集合。
- **C0（决定、授权、依赖、缺口与解决动作）**：依赖 V1–V2、当前用户有效目录/Key、私有 COS、可用媒体探测环境与真实调用授权；按当前目录和协议证据在 Seedance 1.5/Vega 1.5、Kling V3、Vidu Q3 中择一，确认低成本短时长参数、合成或已授权首帧素材、调用次数与停止条件，冻结该 route 查询/结果预算及受限验证入口权限（普通入口在证据通过前保持关闭）；缺口为目标账户当前目录及授权确认，解决动作为 C0 实查目录并锁定唯一目标型号。
- **C1（实施顺序、验收与接受条件）**：先实现 driver 的 submit/query codec 与结果解析 → 在任何真实 POST 前完成重复 POST 四窗口故障注入、冻结原凭据/查询身份、输入 owner/活动引用、公网 HTTPS/DNS 连接钉住、禁重定向与代理、流式字节/时限/磁盘上限、私有 staging、真实视频 probe、COS/DB 后段恢复与原子 Asset 登记 → 经受限入口分别执行文生与单首帧最小真实闭环；**验收与接受条件**：首次真实 POST 前全部 P0 门禁具备确定性证据，两种模式分别取得上游 task ID、受控查询次数、真实 probe、唯一 Asset 与重签下载及可并存模式级证据，所有真实失败原样保留；经独立审查与人类接受后仅开放对应精确格子。

### V4 其余基础模式与协议

- **结果与非目标**：按矩阵扩展 `last_frame`、`start_end`、`reference_subjects`/`multi_image`、`full`、`video_ref`，并逐步实现 Seedance/Vega、Kling、Vidu、Veo、HappyHorse、FAL 的实际目标 route；`video_ref`/`full` 参考视频超规预处理接入通用媒体处理 `video.reference_prepare`。**非目标**：不迁编辑、延长、运动控制、数字人、口型、multi-shot/multiframe 或后处理产品；不为统一外观吞掉协议差异。
- **C0（决定、授权、依赖、缺口与解决动作）**：依赖 V3 内核稳定、各协议所需 Asset 类型与媒体探测已接受，以及 `video_ref`/`full` 预处理所需的通用媒体处理 `video.reference_prepare`（M1–M2）接受事实；开工前须按目标模式确认代码实施与有界真实调用授权；每个 route 单独冻结当前目录成员、协议依据、模式输入、参数、默认值、同步/异步、查询、取消、输出和真实测试样本；发现旧声明与当前协议/观察冲突时先更新矩阵并关闭能力，不兼容兜底。
- **C1（实施顺序、验收与接受条件）**：按同一首切片 driver 的 `start_end`/`last_frame` → 主体/多图 → `full`/`video_ref`（含 `video.reference_prepare` 压缩/裁切与已合规零重编码分支）→ 其余 driver 推进，每条 route 先写严格 codec 与替身、再接任务内核、最后按授权做最小真实闭环；**验收与接受条件**：每个完整验证元组（`providerConfigId + credentialVersion + catalogVersion + adaptationVersion + rawModelId + declarationVersion + driver + mode + 参数元组`）具备实现/未实现/真实验证三态，输入顺序与数量精确，不支持参数在 POST 前拒绝；逐格给出真实成功证据、明确关闭事实或经人类确认的范围处置后接受。

### V5 取消、恢复、安全和资源收口

- **结果与非目标**：为 V2–V4 已实现 route 完成取消语义、凭据轮换、提交/查询/物化故障、跨 driver 结果接收复核、配额、关闭、晚到结果和历史审计。**非目标**：不保证供应商退款，不把本地取消冒充上游撤回，不自动清理无法对账的外部任务，不导入旧任务。
- **C0（决定、授权、依赖、缺口与解决动作）**：依赖 V2–V4 实际 driver 与 Asset/Compute 接口；逐 provider 核实 cancel 接口是否存在及真实保证；冻结不支持取消时的低频对账期限、晚到 Asset 隐藏保留策略、unknown 人工入口、凭据快照清理与 staging 清理政策，以及结果最大字节、总时限、磁盘/COS 预算与并发上限；缺口为各上游 cancel 真实语义，解决动作为 C0 逐协议查证文档/实测，不支持或未知一律关闭。
- **C1（实施顺序、验收与接受条件）**：先实现 cancel codec/事实、CAS/租约竞态、凭据轮换/删除与关停恢复，再跨已实现 driver 复核公网接收、staging/原子发布与媒体负向 probe 一致性并完成全套故障注入；**验收与接受条件**：跨 driver 补齐全部 P0/P1 证据，取消各窗口、POST 四窗口与 query/download/COS/DB/派生故障均断言 POST 次数不增加，日志与响应无凭据/签名 URL，资源上限阻断不破坏既有事实；经独立审查与人类接受（不得以 V5 补测替代 V3 首次真实 POST 前的 P0 门禁）。

### V6 全矩阵对账与接受

- **结果与范围 / 非目标**：完成迁移账本、运行 route、源码、测试、公共规范、真实证据和可见 API 的最终三方对账，交付已覆盖的基础视频组合。**非目标**：不自动开放 Agent 工具、旧数据迁移、生产部署或相邻编辑/数字人/后处理能力。
- **C0（决定、授权、依赖、缺口与解决动作）**：依赖 V0–V5 形成干净 Git 候选；开工前须确认 V6 联合回归、真实业务批次调用与交付审查授权；冻结本次候选、环境、真实测试账号/素材/调用预算、目标矩阵与未覆盖项处置；安排未实施本次候选的独立审查者，并确认覆盖 `pnpm check` 的当前有效来源；当前缺口为各协议未覆盖格子的正式范围处置与有效 CI 全量基线核对，解决动作为 C0 冻结未覆盖格处置清单并核实基线后再启动联验。
- **C1（实施顺序、验收与接受条件）**：依次执行受影响自动测试、打包/Profile、插件装载、真实业务批次、`quality-review`、`norms-review`、独立风险/复用审查与三方对账，失败/未知/无权/下线/未验证全部保留原事实；**验收与接受条件**：F01–F24 与协议矩阵逐项对上源码与证据，无第二套认证/provider/Asset/Compute 或生成调度，每条真实证据绑定完整验证元组；经人类明确接受后发布结果，只宣称实际覆盖组合，不使用“全部视频完成”的宽泛表述。

## 11. 代码写入与协作边界

后续实施与计算域 M1–M6 存在公共文件交叉点，写入责任如下：

| 文件/领域                                            | 写入责任                       | 协作方式                                                    |
| ---------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `src/providers/*`、provider schema/contract/router   | 集成负责人                     | V1 串行收口 operation、route 和迁移；其他单元只消费冻结接口 |
| `src/video-generation/*`                             | 视频任务负责人                 | V2–V5 主写；同一文件单写者                                  |
| `src/integrations/onelink/video/*`                   | 按 driver 分配，但公共合同单写 | 协议文件可并行，公共 contracts/router 由集成负责人合并      |
| `src/assets/*`、`src/compute/*`、`contracts/compute` | 资产/Compute 负责人            | 先核对已接受候选，再最小扩展；不在视频目录复制实现          |
| `src/plugin.ts`、`harness.config.json`、公共规范文档 | 集成负责人                     | 最后串行装配，避免并行覆盖                                  |
| driver 替身与纯协议测试                              | 可按协议并行                   | 依赖冻结 VideoRouteConfig，不修改公共合同                   |

若计算域通用媒体处理单元尚在推进，视频代码应在隔离 worktree 或固定依赖提交上实施，严禁覆盖或回退主干既有保护。

## 12. 验收证据和未决处理

### 12.1 真实证据最小字段

每个真实模式记录：

`providerConfigId + credentialVersion + catalogVersion + adaptationVersion + modelKey + rawModelId + operation + driver + routeDeclarationVersion + mode + 参数元组 + 输入 Asset 摘要 + 提交/查询/取消次数 + upstreamTaskId + 输出 probe + resultAssetId + 起止时间 + 候选提交`。

公共报告只保留受控元数据。Key、签名 URL、原始敏感 prompt、真人素材和供应商完整响应留在受限现场，不进入仓库或普通日志。

### 12.2 旧历史迁移的后续分类

若以后授权迁入旧任务，必须独立执行并满足幂等映射：

| 旧事实                       | 导入方式                                           |
| ---------------------------- | -------------------------------------------------- |
| 已完成且媒体可重新取得并核验 | 只导 Asset、来源和只读记录，不创建可 submit 的任务 |
| 有上游 ID 且原身份可恢复     | 导为只 query/materialize，永久禁止 submit          |
| `started/unknown` 且无 ID    | 导为人工对账，永久禁止自动重提                     |
| URL 失效、身份缺失、协议不明 | 只保留审计记录，不宣称可恢复或完成                 |

迁移映射以旧系统身份唯一，重复执行不能产生第二 job 或 Asset。该动作不属于 V0–V6 的基础新任务交付。

### 12.3 当前未决与解决动作

| 未决                                | 影响                                                                            | 解决动作                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 首个真实型号和 route                | V3 C0                                                                           | 用当前用户成功目录与协议依据按本页选择原则确定；无匹配则保持 V3 pending                                           |
| 通用媒体处理（M1–M3）候选是否已接受 | V2/V3 的 probe、V3/V5 的播放派生（`video.derivatives`）与 V4 参考视频预处理衔接 | 开工前核对固定候选和成果；`media.probe` 未接受时先落最小探测接缝，`video_ref` 等待 `video.reference_prepare` 就绪 |
| 各 provider cancel 真实保证         | V5                                                                              | 逐协议文档/运行观察，不支持或未知如实关闭                                                                         |
| 结果接收、staging 和快照保留期限    | V2/V5 资源策略                                                                  | 按现有 Asset/COS 容量、查询期限和故障演练冻结本地上限                                                             |
| 旧历史是否需要迁入                  | 独立后续任务                                                                    | 用户明确提出后按 12.2 分类立项，不影响新任务闭环                                                                  |

这些未决不阻止规划交回，但对应开发单元在解决前不得宣称 C0 ready。业务实现、真实调用和正式接受分别授权和记录；本页不把未来证据写成已完成事实。
