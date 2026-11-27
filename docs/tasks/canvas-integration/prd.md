# Mio 画布接口承接 PRD

**状态**　待评审。本文规划 `miioo` 自由画布接入 Mio 的产品行为、接口与验收。鉴于 Mio 的图片、视频、音频、通用媒体计算与无会话提示词底座均已落地或完成规划，**第 1–4 期与第 8 期（核心视频/音频节点执行及确定性编辑）共同构成支撑前端四大主节点（`text / image / video / audio`）端到端运行的完整主干**；第 5、7 期按依赖独立排期，第 6 期保留编号说明旧画布专属目录方案退役与统一资产库的分工衔接。各期新增接口均为候选，当前仅交付规划。开发授权、候选验证和业务接受沿项目的[当前任务的生命周期](../../coordination.md#当前任务的生命周期)与[规划交付要求](../../coordination.md#规划交付要求)分别记录。核对基线为仓库提交 `3441367`；实施前须以目标基线复核。[任务资料入口](../index.md) · [统一资产库 PRD](../unified-asset-library/prd.md) · [提示词底座 PRD](../prompt-runtime/prd.md) · [漫剧工作流 PRD](../drama-workflow/prd.md)

## 用户目标与首个里程碑

登录用户创建一个画布项目，在其中管理多张画布，连接文本、图片、视频和音频节点（或选用已有资产与 Seedance 认证素材），执行原位生成或媒体二次编辑，并明确选择各节点的当前输出版本。关闭页面重开后，布局、当前输出选择、连线上游变更提示（`upstreamUpdated`）与在途任务均可完整恢复，且能查明每次执行冻结了哪些上游输入。协同编辑、整图自动连跑调度不在本期范围。

**第 3 期的首个渐进业务验收点**为“手写文本 → 图片节点生成 → 选中第 2 张结果 → 刷新 → 下游再次引用所选图片”；随后第 4 期打通单轮无状态文本节点，第 8 期合入视频/音频原位执行与确定性媒体编辑，完成自由画布全节点闭环。

| 期次                   | 用户得到的结果                                                                                     | 直接依赖                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1 项目与文档           | 创建画布项目和多张画布，编辑布局、连线与分组，乐观锁保存与重开                                     | Mio 认证                                                             |
| 2 资产与节点输出       | 从生成历史、我的资产或认证素材库选材，保存手工文本、切换结果、重开批量解析                         | 画布 1、统一资产库 U1/U2、素材库                                     |
| 3 图片节点执行         | 文本/参考图生图、图片裁剪/翻转与路由编辑、选择候选、关页恢复、`upstreamUpdated` 感知               | 画布 2、图片生成服务、统一资产库 U1                                  |
| 4 文本节点执行         | 单轮无状态执行文本节点并将正文连入下游节点                                                         | 画布 2/3 执行模型、提示词底座 P1–P2                                  |
| 5 历史、复制与排序     | 画布同源生成历史抽屉、项目/画布副本复制、多画布拖拽排序、衔接 U4「添加到新画布」                   | 画布 1–3、统一资产库 U1/U4                                           |
| 6 旧目录方案退役       | 旧画布专属目录退役，个人目录整理与浏览器流式 ZIP 下载由统一资产库 U2/U4 统一承接                   | 不安排独立画布开发单元，随统一资产库 U2/U3/U4 联验                   |
| 7 分享与文件交换       | 公开只读分享脱敏快照、受控访问分享内媒体、登录访客一键克隆到本人画布、本地 `.miioo.json` 导出/合并 | 画布 1/2/5                                                           |
| 8 视频、音频和扩展编辑 | 视频与配音节点原位生成、认证素材视频联动、画布大视频 HLS 派生、任意秒选帧与视频裁剪新建下游节点    | 画布 3 执行底座、视频生成、音频服务、通用媒体计算、素材库、资产库 U1 |

## 已有能力与接入依据

需求输入为 `miioo` 正式前端画布源码与旧后端线上行为核查，资产四菜单、生成历史、个人库、回收站、显式引用保护与清单流式下载严格以[统一资产库 PRD](../unified-asset-library/prd.md) 为准：

| 领域               | Mio 已就绪可直接复用的事实                                                                                                                                                                                                   | 画布域唯一负责的部分                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 账号、项目与文档   | 登录 Cookie 鉴权（[认证契约](../../apis/auth.md)）；画布与漫剧项目物理分表隔离                                                                                                                                               | 维护画布项目（不含漫剧 `visualStyle` 字段）与多画布 `xyflow` 文档（禁止落盘任何媒体 URL，节点互斥引用 `assetId` 或 `materialId`）          |
| 资产、解析与素材库 | 私有 COS 直传确认（[资产契约](../../apis/assets.md)）；U1–U4 显式引用保护、`POST /assets/resolve`（支持 `assetIds`、`materialIds`、派生地址与 `transcript`）及流式下载；认证素材库（[素材契约](../../apis/materials.md)）    | 单点调用统一资产库引用增释与 U1 生成历史登记原语（分离 `displayPrompt` 与 `providerPrompt`），不自建重复历史去重表或兼容网盘               |
| 文本、生图与音视频 | 无会话文本内核 `executeTextPrompt`（[提示词底座 PRD](../prompt-runtime/prd.md)）；图片（`POST /compute/images`）、视频（`POST /compute/videos` + `video-capabilities`）与配音（`POST /audio/jobs`）均已落地                  | 冻结直接上游节点 `{nodeId, resultId, outputVersion}`，持久化画布执行意图，映射结果至当前节点新批次或新建下游结果节点                       |
| 通用媒体计算       | `POST /compute/media` 已验收 `video.derivatives`（`ordinary` 与 `canvas` 双档 + 私有 HLS `/compute/media/{id}/hls`）、`video.trim`、`frames.extract`（`timestamps`）与 `audio.waveform`（[计算契约](../../apis/compute.md)） | 在画布视频上传绑定、画布生视频完成及 U4 导入视频时幂等触发 `profile="canvas"` 派生；复用 `video.trim` 与 `frames.extract` 承接画布视频编辑 |

## 跨期接口约定

下表业务路径均省略 `/api/v1`（`/api/auth/` 为完整路径）。私有接口使用登录 Cookie，写请求要求允许的精确 Origin 与 JSON 正文，错误体统一为 `{error:{code,message,requestId}}`。

- **幂等与乐观锁**：所有创建、保存、结果登记、执行、复制、排序均携带客户端 UUIDv4 `requestId`（先执行同键幂等重放核对，异参返 `409 REQUEST_CONFLICT`，再执行 `baseRevision` / `expectedOutputVersion` 乐观锁校验，冲突返 `409`）。
- **严格去 URL 文档与批次历史**：画布文档仅持久化节点布局、参数、分组、有序连线及引用 ID，**服务端严格拒绝任何包含媒体 URL / `blob:` / `data:` 的字段，且同一节点位置 `assetId` 与认证素材 `materialId` 严格二选一互斥**。每个节点维护单调递增 `outputVersion`、`currentResultId` 与有序批次 `batches`；单纯追加后台生成历史不强改用户已切换的 `currentResultId`。新建画布直接采用原生节点结果模型，存量旧节点由[旧后端数据迁移 PRD](../legacy-migration/prd.md) M6 离线转换，**运行时不提供 `migrate-legacy` 兼容接口**。
- **上游冻结与 `upstreamUpdated` 只读投影**：执行受理时在短事务内冻结直接上游节点的 `usedInputs: [{ nodeId, resultId, outputVersion }]`；`GET /canvases/{id}` 的节点摘要与 `GET /canvases/{id}/nodes/{nodeId}/results` 的批次记录直接返回 `usedInputs` 与节点当前 `outputVersion`，供前端本地精确计算“上游已更新”提示，无需额外轮询子接口。
- **双层提示词分离与统一资产库单点委派**：画布多模态生成与编辑统一将用户可见 `displayPrompt`（二次编辑固定为 `null`，配音保留 `transcript`）传给统一资产库 U1 登记生成历史（一次四图对应四条同源历史与一个含四输出的节点批次；删单条历史仅隐藏历史，节点四输出保留），将服务端转义组装后的 `providerPrompt` 严格限制在下游模型请求内。画布项目与画布的 `DELETE` 固定只做**封存归档**（停止新执行、继续持有全部有效媒体引用）；仅删除媒体节点或清空独立输入槽并成功 `PATCH` 保存才逐位置释放对应画布引用。[删除与引用矩阵](../unified-asset-library/prd.md#6-删除与引用矩阵) · [回收站与物理清理](../unified-asset-library/prd.md#7-回收站与物理媒体清理)

## 第 1 期 · 项目、多画布与保存

**C0**　保留前端“活动画布项目至少保留一张活动画布”的不变量；画布项目表与漫剧项目表物理分离，**不包含 `visualStyle` 字段**（对齐前端画布项目无视觉风格校验）。按实测复杂节点图上限（如最多 2,400 个记录、4,800 条连线、单文档 `2 MiB`）为 `PATCH /canvases/{id}` 单独配置请求体读取上限（超限返回 `413`）。[文档序列化](https://github.com/miioo-aigc/miioo/blob/1c1b36339afb1f0db026d0809a3c688d285200c2/frontend/src/components/canvas/CanvasDocument.js#L253) · [请求读取器](../../../src/http-request.ts)

| 接口                                                                                            | 输入、返回与副作用                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 `POST /canvas-projects`、`GET /canvas-projects`                                            | 传 `requestId` 与名称，单事务建立画布项目与首张画布（`画布1`），返回 `projectId, firstCanvasId`；列表按本人、搜索词与游标分页         |
| 新增 `GET /canvas-projects/{id}`、`PATCH /canvas-projects/{id}`、`DELETE /canvas-projects/{id}` | 查询元信息与默认入口画布；改名或整体封存归档（归档后已受理执行仍可按原身份查询）                                                      |
| 新增 `POST /canvases`、`GET /canvases?projectId=…`                                              | 在本人画布项目下新建画布或按顺序/分页列出画布摘要                                                                                     |
| 新增 `GET /canvases/{id}`、`PATCH /canvases/{id}`、`DELETE /canvases/{id}`                      | 详情返回 `id, projectId, title, revision, document, nodeStates`；`PATCH` 带 `requestId, baseRevision`；拒绝归档项目内最后一张活动画布 |
| 复用 Mio 登录、`GET /api/auth/get-session`、`GET /me`                                           | 基于登录 Cookie 识别身份与会话刷新                                                                                                    |

**C1 与前端**　对接 `CanvasProjects.js`、`api/canvas.js` 与 `CanvasSaveSession.js` 保存队列（将 `client_save_id / base_revision` 收敛为 `requestId / baseRevision`）。服务端在入口单次校验节点 ID 唯一、父分组存在且无环、连线端点属于本画布且与节点槽位一致、全树无非法 URL 字段。

**验收**　创建响应丢失同键重试只建一个项目与首张画布；多画布编辑移动、分组、缩放重开一致；双标签页并发保存命中 `409`；并发归档不会删空最后一张活动画布；超文档上限返回 `413`；跨账号严格不可访问。

## 第 2 期 · 私有资产、手工文本与当前输出

**C0 与排期**　对接统一资产库 [U1](../unified-asset-library/prd.md#u1--身份契约统一历史与引用保护底座)、[U2](../unified-asset-library/prd.md#u2--我的资产文件库搜索与专用本地上传) 与[素材库](../../apis/materials.md)：支持在画布节点上选用本人 `assetId`（来自活动生成历史、活动我的资产或画布直传）**或本人有效 `materialId`（Seedance 真人/虚拟认证素材，与 `assetId` 互斥）**。重开画布时通过 `POST /api/v1/assets/resolve`（传入 `canvasId`、`assetIds` 与可选 `materialIds`，单批最多 200 项）一次换取原件/派生/HLS 预览地址、宽高时长、音频 `transcript` 与认证素材预览，严禁暴露上游 `supplier_asset_id`。画布内上传视频登记为节点结果时，若尚无画布档派生则幂等触发 `video.derivatives (profile="canvas")`。[跨模块联合验收](../unified-asset-library/prd.md#跨模块联合验收)

| 接口与归属                                                                                                                      | 输入、返回与画布责任                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 复用 `POST /assets/uploads`、`POST /assets/{id}/complete`、`GET /assets/{id}`                                                   | 浏览器直传私有 COS 确认原件；画布直传不产生生成历史、不自动入我的资产                                                                                        |
| 对接 U1 `GET /asset-history`、`POST /assets/resolve`，U2 `GET /personal-library/nodes`、`search` 及 `GET /materials/groups/...` | 选材校验活动来源授权（仅存于回收站或已失效认证素材禁止新选）；重开按 `canvasId` 与已存持久绑定重签短期地址（含 `transcript` 与认证素材预览）                 |
| 新增 `GET /canvases/{id}/nodes/{nodeId}/results`、`POST /canvases/{id}/nodes/{nodeId}/results`                                  | `GET` 返回批次（含 `usedInputs`）、当前结果与 `outputVersion`；`POST` 传 `requestId, expectedOutputVersion` 登记手工文本、本人 `assetId` 或有效 `materialId` |
| 新增 `PUT /canvases/{id}/nodes/{nodeId}/current-result`                                                                         | 传 `requestId, expectedOutputVersion, resultId` 切换当前输出（保留全部历史批次及其持久文件引用）                                                             |

**C1 与前端**　`CanvasAssetPickerPanel.jsx` 对接「生成历史」「我的资产」「Seedance 认证素材库」三源选材；`CanvasAssetResolver.js` 按 `canvasId` 统一批量解析 `assetIds` 与 `materialIds`，并在音频节点启用私有 COS `GET` CORS 读取绘制本地 WebAudio 波形。删除媒体节点或替换独立输入槽并成功 `PATCH` 保存后，才逐位置释放对应业务引用。

**验收**　完成与统一资产库 U1/U2 联合验收及 U3 [清空与到期后的引用验收](../unified-asset-library/prd.md#清空与到期后的引用验收)（含个人库副本最后解除、同画布多节点及保留版本逐位置释放）；验证绑定了 `materialId` 的节点在删掉源生成历史并清空回收站后重开画布仍能正常显示预览且不泄露 `supplier_asset_id`。

## 第 3 期 · 图片节点执行与恢复

**C0**　对接 `POST /compute/images`，覆盖文生图、多参考图生图（`image.generate`）、路由已支持的局部重绘/图像编辑（`image.edit`，含 PNG 蒙版 `maskAssetId`）以及**客户端几何裁剪/翻转保存**（浏览器 `<canvas>` 产出 PNG 经私有 COS 直传确认后，提交本人 `sourceAssetId` 登记为该图片节点新批次结果并写入一条 `displayPrompt = null` 的新生成历史）。模型侧未验证协议的 `outpaint` 仅在路由显式开放 `allowOutpaintGeometry: true` 时启用，前端按路由能力隐藏不支持的编辑按钮。[图片 PRD](../onelink-image-generation/prd.md)

| 接口                                                                                | 输入、返回与副作用                                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 `POST /canvases/{id}/executions`                                               | 接收 `requestId, nodeId, baseRevision, expectedOutputVersion, operation, modelRef?, parameters`；冻结 `usedInputs` 受理执行或登记已校验的裁剪/翻转衍生图片结果 |
| 新增 `GET /canvases/{id}/executions`、`GET /canvases/{id}/executions/{executionId}` | 查询执行状态、冻结的 `usedInputs`、已登记的 `{ index, resultId, assetId }`、错误码及 `canCancel / canRecover`                                                  |
| 新增 `POST /canvases/{id}/executions/{executionId}/recover`                         | 对可恢复执行限次查询或从已落盘检查点恢复物化登记；无上游身份的 `unknown` 保持不重发                                                                            |
| 复用 `GET /providers/onelink/models?category=image` 与图片生成服务                  | 路由能力元数据唯一驱动前端参数与编辑按钮显隐                                                                                                                   |

**C1 与前端**　移除前端 `UseCanvasImageGeneration.js` 对旧 `/api/sessions` 与 `/api/creation/*` 的耦合，切换为“保存 → 受理 `executions` → 轮询恢复”。同型图片生成与图片编辑结果写回当前图片节点新批次（一次四图对应四条同源生成历史与一个含四输出的节点批次）；上游节点切换输出版本后，下游节点根据批次记录的 `usedInputs` 立即展示 `upstreamUpdated` 标记。

**验收**　跑通“文本节点 → 生四图 → 选第 2 张 → 下游参考生图”；核对修改上游节点版本后下游准确显示 `upstreamUpdated`；验证客户端裁剪/翻转与局部重绘保存后原结果保留且新结果写入 `displayPrompt = null` 的新生成历史；验证部分成功保留原序号与 `unknown` 零重发。

## 第 4 期 · 文本节点执行

**C0**　画布属于可视化 DAG 数据流而非多轮聊天窗口，文本节点执行**固定采用单轮无状态模式**：每次点击按连接顺序读取直接上游节点的已选正文（未另填提示词时按有序正文拼接，另填提示词时把指令与上游素材分离传入），直接复用[提示词底座 PRD](../prompt-runtime/prd.md)（P1–P2）的防注入隔离信封（`formatDataBlock`）、轻量预算估算（`estimateTokens`）与无会话 BYOK 调用内核（`executeTextPrompt`），**不创建多轮对话会话、不读写 `DSH_HOME` 会话文件、零生图工具权限**（多轮迭代通过串联下游文本节点完成）。实施前 C0 仅确认切换画布或离页时后台继续生成与取消按钮的交互细节。

| 接口                                                                                | 输入、返回与副作用                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展 `POST /canvases/{id}/executions`（`text.generate`）                            | 冻结上游已选文本与 `usedInputs`；**文本结果不进入统一媒体生成历史**；按 `executionId` 关联无会话 BYOK 执行记录、取消信号、`ModelObservation` 与正文结算 |
| 新增 `POST /canvases/{id}/executions/{executionId}/cancel`                          | 对在途可取消执行发出协作式取消信号（出站前取消零观测，出站后落盘 `aborted` 观测，非主动中断收敛为 `unknown`）                                           |
| 复用 `GET /providers/onelink/models?category=chat` 与提示词底座 `executeTextPrompt` | 复用冻结 `ChatRuntimeSnapshot`、默认关闭 `reasoningEffort`、无条件剥离 `thinking` 块，仅将纯净 `text` 正文写入节点批次                                  |

**C1 与前端**　替换 `CanvasTextSubmissions.js` 与 `UseCanvasTextGeneration.js` 的旧提交与 `migrate-legacy` 逻辑；若被删节点存在在途文本执行，保存文档时自动触发协作式取消。

**验收**　双文本节点并发提交互不串味，关页重进恢复原正文；显式取消区分已取消与先完成；将生成文本连入图片/视频/配音节点后核对下游收到的文本字节完全一致，且图片任务与统一媒体生成历史增量均为零。

## 扩展分期

第 8 期与第 1–4 期共同支撑完整四节点画布创作主干；第 5、7 期按排期独立开发；第 6 期仅作旧目录退役说明。

### 第 5 期 · 历史面板、本人复制与排序

- **接口与行为**：新增 `GET /canvases/{id}/generation-history`（直连统一资产库 U1 画布上下文同源历史视图，共享 `historyId` 与删除状态；删除委托 U1 `POST /asset-history/deletions`，进 30 天回收站且绝不清空画布节点输出）。将历史媒体拖入当前或本人另一张画布仅登记节点结果与持久引用，不新增生成历史。新增 `POST /canvas-projects/{id}/copies`、`POST /canvases/{id}/copies`（返回 `operationId` 异步复制已保存结构与当前合法输出，不复制底层物理文件、不新增生成历史）与 `PUT /canvas-projects/{id}/canvas-order`（带版本条件保存同项目活动画布排序）。跨模块「添加到新画布」（`POST /api/v1/canvas-project-imports`）由统一资产库 [U4](../unified-asset-library/prd.md#u4--添加到新画布与下载清单签名) 单事务同步创建。
- **验收**：画布抽屉与全局生成历史双向同步删除/恢复且节点四图输出不变；跨画布复用历史结果不产生新历史；项目/画布复制幂等且跨账号隔离；乱序旧版本排序返回 `409`。

### 第 6 期 · 旧资产目录方案退役

旧画布专属集合（`canvas-asset-library`）退役，个人 10 层目录树、移动/复制、全库文件名搜索与浏览器直连私有 COS 流式 ZIP 下载统一由[统一资产库 PRD](../unified-asset-library/prd.md) U2/U4 提供；跨画布与归档项目的引用保护随 U3 联合验收。

### 第 7 期 · 公开分享、授权复制与本地文件

- **接口与行为**：新增 `GET/PUT /canvases/{id}/share` 管理分享开关与令牌；匿名接口 `GET /canvas-shares/{token}` 返回严格脱敏的只读快照（剥离作者隐私信息、历史非当前批次、执行输入快照与凭据，通过前端 `CanvasSharePrivacy` 脱敏断言），`GET /canvas-shares/{token}/assets/{assetId}` 仅签发该分享当前可见媒体的短期只读地址；登录用户调用 `POST /canvas-shares/{token}/imports` 异步克隆到本人画布项目（建立接收者独立合法资产引用，不双计底层物理对象）。浏览器本地 `.miioo.json` 导出与合并导入复用第 1、2 期上传与保存入口。
- **验收**：匿名访客仅能访问当前已分享版本的可见媒体，关闭或轮换令牌后立即停止签发新地址；克隆幂等且撤销源分享后按既定归属规则核对接收者可读性。

### 第 8 期 · 视频、音频、认证素材与扩展编辑

- **C0 与核心边界**：
  1. **视频与音频节点原位生成**：扩展 `POST /canvases/{id}/executions` 支持 `video.generate`（对接 `POST /compute/videos` 与 `video-capabilities/{modelRef}`，覆盖文生、首尾帧、多参及上游节点传入的 `assetId` / 认证 `materialId` / 配音参考音频）与 `audio.generate`（对接 `POST /audio/jobs`，支持上游文本连线作为口播台词并在结果中持久化 `transcript`）。
  2. **二次媒体编辑的节点拓扑规则（对齐前端交互）**：与同型图片编辑原位写回本节点不同，画布上的**视频任意秒选帧（`video.extract_frame`，复用 `compute/media` `frames.extract` `mode="timestamps"`）与视频时间段裁剪（`video.trim`）支持在保留源视频节点不变的同时，原子绑定至目标新建下游图片/视频节点（或指定目标节点结果）**，并记一条 `displayPrompt = null` 的新生成历史。对视频底座已暂缓的“视频去字幕”与“视频超清”不设 `501` 假接口，前端按能力发现隐藏按钮。
  3. **画布大视频 HLS 派生**：当画布视频生成物化完成时（连同第 2 期上传绑定、U4 导入视频），幂等触发 `video.derivatives (profile="canvas")` 生成 6 秒分片私有 HLS（经 `/api/v1/compute/media/{id}/hls` 鉴权消费，属内部附属派生物、不入生成历史）。
  4. **认证素材执行校验**：上游节点传入 `materialId` 参与视频执行时，由服务端实时校验本人归属与有效认证态后映射上游引用（预选后失效返回明确重认证错误，普通网络错误绝不误判为认证失效；删除认证素材不影响已生成画布视频）。
- **验收**：跑通 `文本 + 图片/认证素材 + 配音节点 → 视频节点` 连线生成、配音 `transcript` 透传、大视频画布档 HLS 播放、视频任意秒选帧自动产出下游图片节点与 `video.trim` 产出下游视频节点，核对 U1 生成历史、持久引用及认证素材安全隔离全部符合预期。

## 验收环境与首发决策

业务联调使用正式前端入口（`VITE_CANVAS_DEV_MOCK=false`），覆盖双账号隔离与单账号双标签页并发保存；异常、冲突、部分成功与 `unknown` 恢复在常驻隔离回归环境用可控替身验证；图片、视频、音频、文本、媒体计算与私有 COS 闭环在常驻 `mio_dev` 环境执行有界最小规格实测。[常驻环境与回归边界](../../local-environments.md) · [验证与接受](../../coordination.md#验证与接受)

## 开发反防御硬约束（供画布各期编码实现严格遵守）

- **边界单次解析（Parse, Don't Validate）**：画布文档 Schema（节点唯一性、父组无环、连线与槽位一致性、禁用一切 URL/`blob:`/`data:` 字段、单位置 `assetId` 与 `materialId` 互斥）及请求参数仅在 `src/canvas/http.ts` 与文档解析入口完成**唯一一次**校验并转为只读强类型；图片/视频/音频路由参数上限唯一由下游各生成服务准入层校验，画布服务层严禁重复抄写模型参数校验逻辑。
- **只读快照下传（禁 N+1 重查／禁深拷贝／禁重复去重表）**：外层按 owner 鉴权加载的画布快照、节点状态与事务句柄通过只读参数显式传递，禁止在循环内按节点逐条重查数据库，无原地修改需求时严禁使用 `structuredClone` 或 `JSON.parse(JSON.stringify(...))` 深拷贝整份 `2 MiB` 画布文档；资产引用保护与生成历史防重/墓碑唯一委托统一资产库服务层单点执行。
- **快速失败与精确状态码（Fail Fast，复用 `@mio/foundation/http-status`）**：严禁引入未定义的 `422`；入参格式非法、包含禁用 URL 字段或扁平数组含重复 ID 统一返 `400`；非本人或已入 GC 认领态资产统一返 `404`；`requestId` 异参、`baseRevision` 过期、`expectedOutputVersion` 不符或归档最后一张活动画布统一返 `409`。严禁使用宽泛 `try/catch` 吞错，严禁用 `||` 覆盖合法的 `0`（如 `outputVersion: 0`、`index: 0`、`timestampSeconds: 0`）。
- **零旧包袱兼容与零假桩接口**：严禁在 Mio 新画布接口中兼容旧后端 `creation_session_id`、`migrate-legacy`、`snake_case` 别名、文本节点多轮 `ConversationService` 回退分支，或为尚未立项的模型编辑预埋 `501` 空壳路由。
