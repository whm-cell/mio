# 素材库 HTTP 契约

[API 导航](index.md)；需求与分期见[素材库 PRD](../tasks/onelink-material-library/prd.md)。当前采纳 Unit 1 管理、同步、读取与删除，以及 Unit 2 图片核验/登记候选；Unit 3 真人认证会话为实现候选；视频仍按后续单元推进。

## 本域共同约定

显式设置 `MIO_MATERIALS_ENABLED=true`，配置认证、供应商和 `MIO_ASSETS_DATABASE_URL`，先迁移 assets，再执行 `pnpm materials:migrate --apply`（本地 `pnpm migrate:dev materials --apply`）。素材域独立持池；仅素材管理且所有 COS 字段缺省时不注册资产 HTTP；任一 COS 字段出现则沿既有资产完整配置校验，部分配置失败。启动只读检查三表和确切全局上游唯一索引，缺结构失败，不自动迁移或联网。未启用时不注册本域。真人认证额外显式设置 `MIO_MATERIALS_PUBLIC_BASE_URL` 为可达 HTTPS origin（可含非默认 HTTPS 端口，不能有用户信息、路径、query 或 fragment）；缺省时素材管理/图片登记照常使用，不注册认证端点。不得从请求 Host 或既有生产认证域推导。执行当前 `materials:migrate` 显式增量建立 auth_sessions 表及审计列；启用公开认证时启动只读核验该表的列、owner/requestId 唯一约束、owner/group 复合 FK 及到期清理索引。已有会话表时，素材服务的到期清理也覆盖关闭认证入口的运行环境。

身份仅来自登录 Cookie，资源按 owner 查询；服务 Bearer 不授予用户身份。写入要求允许的精确 Origin 和 `application/json`，GET 提供 Origin 时也须匹配；OPTIONS 无需登录但须允许 Origin。JSON 为对象、8192 字节、10 秒，拒绝额外字段且读完复核会话。响应均 `no-store`、`X-Request-Id`；错误 `{error:{code,message,requestId}}`。常见错误为 400 BODY_INVALID/QUERY_INVALID/CURSOR_INVALID、401 UNAUTHORIZED、403 ORIGIN_DENIED/ORIGIN_REQUIRED/PROVIDER_RESOURCE_FORBIDDEN、404 NOT_FOUND/MATERIAL_NOT_FOUND、405 METHOD_NOT_ALLOWED、408 BODY_TIMEOUT、413 BODY_TOO_LARGE、415 JSON_REQUIRED、409 REVISION_CONFLICT/IDEMPOTENCY_CONFLICT/MATERIAL_BUSY/MATERIAL_GROUP_NOT_READY/RESOURCE_IN_USE/PROVIDER_UNAVAILABLE/UPSTREAM_RESOURCE_COLLISION、429 MATERIAL_QUERY_LIMITED（`Retry-After: 4`）、503 MATERIAL_UNAVAILABLE/UPSTREAM_RESULT_UNKNOWN/UPSTREAM_RESPONSE_INVALID/UPSTREAM_REJECTED/UPSTREAM_RATE_LIMITED。不返回密钥、密文、上游 ID、签名 URL 或供应商原始响应。

`GroupView={groupId,type,name,authStatus,state,revision,materialCount,lastSyncedAt,lastSyncStatus,lastSyncErrorCode}`；type 为 real/aigc，authStatus 为 verified/not_applicable，state 为 creating/ready/unknown/deleting/deleted/failed，lastSyncStatus 为 running/succeeded/failed/null。`MaterialView={materialId,groupId,sourceAssetId,assetType,name,state,revision,lastSyncedAt,errorCode,pollAfterMs}`，assetType 为 image，state 为 registering/processing/active/rejected/unknown/deleting/deleted/failed；remote-only 来源 sourceAssetId 为 null，当前无预览 URL，processing 的 pollAfterMs 为 4000，其他为 0。`OperationView={operationId,kind,state,resultLocalId,errorCode,pollAfterMs}`，kind 只允许 create_group/register_material/delete_material_upstream/delete_group_upstream，state 为 creating/deleting/succeeded/failed/unknown，creating/deleting 的 pollAfterMs 为 3000，其他为 0。unknown 建组或图片登记已保存确切上游 ID 时可通过原 operation 精确复核恢复；无 ID 须人工核对，不能换 requestId 自动重发。

本地 PG 是组归属唯一权威，严禁枚举上游共享组池或按名称认领。非空 `(provider_type,upstream_group_id)` 与 `(provider_type,upstream_asset_id)` 全局唯一，墓碑保留唯一身份。只对本人已知组执行组内同步；凭据轮换保留归属和历史，新出站使用 owner 当前启用且非 rejected 的账号级凭据，不依赖目录或模型。资源 403 不拒绝整个 provider，也不删除资源；精确 HTTP 404/ResourceNotFound 与 403 分开处理。

## POST /api/v1/materials/groups

身份：当前登录用户。

输入：`{requestId,type:"aigc",name}`；requestId 为小写 UUID v4，名称为 1–100 个 Unicode 字符、非全空白且无控制字符。真人组只由后续认证流程生成。

成功：201 `{group:GroupView,operation:OperationView}`；同请求既有操作或未取得确定成功时为 `{operation:OperationView}`，确定成功 201，其他 202。202 仅表示已持久记录，必须检查 operation.state；failed 不代表远端成功。

错误：同 owner/操作/requestId 异输入 409 IDEMPOTENCY_CONFLICT；未启用账号凭据 409 PROVIDER_UNAVAILABLE。已持久操作后的远端拒绝记录 failed，超时、非法响应、全局 ID 碰撞或成功响应后数据库失败记录 unknown，通过操作视图查询。其余见共同约定。

副作用：先在同一短事务中登记 creating 组及不可逆操作，再调用固定 CreateAssetGroup 一次；按原租约提交组映射和操作终态，不自动重试外部创建。重复同输入只读回本人原操作。

## GET /api/v1/materials/groups

身份：当前登录用户。

输入：可选 `type=real|aigc`、不透明 `cursor`、`limit`（默认 20、1–100），参数不得重复。

成功：200 `{items:GroupView[],nextCursor:string|null}`，按 createdAt/id 降序；本地已删除组不出现，分页游标保留数据库微秒精度。

错误：参数或游标非法 400；其余见共同约定。

副作用：只读本地 PG 与素材计数，不解密、不联网，不逐卡同步。

## GET /api/v1/materials/groups/{id}

身份：组所有者。

输入：本地小写 UUID v4，无查询参数。

成功：200 GroupView。

错误：他人或已删除组统一 404 MATERIAL_NOT_FOUND；其余见共同约定。

副作用：只读本人本地组和素材计数，不解密或联网。

## PATCH /api/v1/materials/groups/{id}

身份：组所有者。

输入：`{revision,name}`；revision 为当前正整数，名称限制同建组。

成功：200 已同步远端确认的 GroupView，revision 增加。

错误：旧 revision 409 REVISION_CONFLICT；在途租约 409 MATERIAL_BUSY；超时/未知结果明确失败，不返回假成功；其余见共同约定。

副作用：原子认领组 revision/租约，事务外通过 GetAssetGroup 核验权限，再调用 UpdateAssetGroup，租约仍有效且组仍 ready 时落本地名称。失败保留既有名称及最近错误；迟到响应不能覆盖新状态。无异步 operationId。

## POST /api/v1/materials/groups/{id}/sync

身份：组所有者。

输入：`{cursor?:string}`；首次省略，后续使用返回的十进制 1 基页码字符串。

成功：200 `{group:GroupView,syncedCount,nextCursor:string|null}`，每次最多 100 项；摘要直接包含最近同步状态。

错误：越组响应或非法信封 503 UPSTREAM_RESPONSE_INVALID；ID 与他人/其他组冲突 409 UPSTREAM_RESOURCE_COLLISION；租约过期/替代 409 MATERIAL_OPERATION_SUPERSEDED；其余见共同约定。

副作用：组租约内事务外核验 GetAssetGroup 并调用一页 ListAssets，强制非空 `Filter.GroupIds:[id]`、PageNumber/PageSize、每调用 20 秒及响应 2 MiB 上限。每项 GroupId 二次核验，实体与摘要在同一事务重验租约后提交；单页缺失不删除，本地墓碑与未收束删除不复活。无异步 operationId。

## POST /api/v1/materials/groups/{id}/materials

身份：当前登录用户，且为 ready 组与 ready 原件所有者；真人组须 verified，AIGC 组为 not_applicable。当前账号凭据须启用且未 rejected，无模型或目录依赖。

输入：`{requestId,assetId,name?}`；requestId/assetId 为小写 UUID v4，仅接受本人已完成 assets complete 的 ready 原件或支持的已登记 derived 图片；不接受 URL、上游 ID、owner、桶或对象键。可选名称为 1–100 个 Unicode 字符且无控制字符，省略时保留空展示名。

成功：201 `{material:MaterialView,operation:OperationView}`；CreateAsset 返回仅表示登记成功，素材先 processing，按 pollAfterMs 查询/刷新后才可为 active/rejected/unknown。已有操作读回 `{operation}`，未确认成功为 202；同 owner/requestId 同输入不重复创建，异输入 409 IDEMPOTENCY_CONFLICT。

错误：读取前已有登记占槽 409 MATERIAL_BUSY，不排队、不读取第二份原件；未配置资产读取 409 MATERIAL_REGISTRATION_UNAVAILABLE；原件不存在/非本人或非 ready 为 404 ASSET_NOT_FOUND；单文件超限/类型非法 400 ASSET_INPUT_INVALID，内容损坏/尺寸比或像素预算非法 400 MATERIAL_IMAGE_INVALID；ETag/长度变化 409 ASSET_SOURCE_CHANGED/ASSET_SIZE_MISMATCH；其余同共同约定。PNG 按当前解码器主图核验；带 APNG 扩展仍作为普通 PNG 提交完整原件，不新增专门支持、拒绝或静态化，不承诺所有动画帧已验证；最终审核由上游处理。

副作用：先按 owner/requestId/input 查询既有操作；仅新登记在图片读取前同步认领单服务槽，覆盖读取、真实解码和出站/提交；单原件最多 20 MiB，不缩窄资产 1 GiB 或放宽视觉 10 MiB。冻结 rawKey/raw ETag，If-Match 有界读取并核对实际字节和 SHA-256，使用纯 sharp 真实解码校验每帧宽高 300–6000、宽高比 0.4–2.5、可解码多页累计最多 36M 像素，单解码通过原生输出管线执行 15 秒处理预算，并在原生调用前后检查服务取消，待本次原生工作收束后释放登记槽；WebP 使用 frame pageHeight，不把 stacked height 当单帧高度。签名前复核本人 ready 与 raw HEAD 一致，签发固定 raw 的 600 秒 GET（无 attachment，保留 STS 编码），不持久保存 URL。短事务保存素材 registering、受控原件摘要与原操作意图，再单次 CreateAsset，按组/操作租约提交 processing/操作终态；原件与 COS 不被删除。已知返回 ID 的提交失败只记原操作受限身份，经当前 owner 的精确 GetAsset/组核验恢复真实状态；无 ID 保持 unknown/manual，绝不自动重发。

## GET /api/v1/materials/groups/{id}/materials

身份：组所有者。

输入：可选不透明 cursor 和 limit（默认 20、1–100）；参数不得重复。

成功：200 `{items:MaterialView[],nextCursor:string|null}`，按 createdAt/id 降序且排除本地墓碑。

错误：他人或已删除组统一 404 MATERIAL_NOT_FOUND；其余见共同约定。

副作用：只读本地本人组与素材，不解密或联网。

## GET /api/v1/materials/items/{id}

身份：素材所有者。

输入：本地小写 UUID v4，无查询参数。

成功：200 MaterialView；remote-only 素材 sourceAssetId 为 null，当前不签发其远端图片预览。

错误：他人或已删除素材统一 404 MATERIAL_NOT_FOUND；其余见共同约定。

副作用：只读本地本人素材，不解密或联网。

## POST /api/v1/materials/items/{id}/refresh

身份：素材所有者。

输入：正文 `{}`，无查询参数。

成功：200 MaterialView；未知上游状态映射 unknown，不自动当 active；仅精确 GetAsset 404/ResourceNotFound 且 GetAssetGroup 权限核验成功后可返回 deleted。

错误：已有查询在途 409 MATERIAL_BUSY；持久冷却内 429 MATERIAL_QUERY_LIMITED/Retry-After:4；403 保留本地资源与 provider 状态；其余见共同约定。

副作用：组租约去重，素材 next_query_at 在出站前持久设置 4 秒冷却，失败与重启不清除；只查询当前已知组/素材，每个请求至多各一次 Get，不创建远端资源。按组租约及素材 revision 同事务提交状态，迟到响应不复活墓碑。

## POST /api/v1/materials/items/{id}/delete

身份：素材所有者。

输入：`{requestId,revision,scope:"local"|"upstream"}`；requestId 为小写 UUID v4、revision 为当前正整数。

成功：local 为 200 `{material:MaterialView}`（state=deleted）；upstream 为 `{operation:OperationView}`，succeeded 200，其余 202，须检查操作 state。

错误：旧 revision 409 REVISION_CONFLICT；在途登记/删除/组租约或未收束操作 409 MATERIAL_BUSY；同远端删除 requestId 异输入 409 IDEMPOTENCY_CONFLICT；其余见共同约定。

副作用：local 仅留本地墓碑、不联网；upstream 先写操作和 deleting 事实，再核验单资源权限及调用 DeleteAsset，一次不自动重发；确定成功后同事务提交墓碑与操作终态，超时保持 unknown。两种 scope 均不删除 COS。

## POST /api/v1/materials/groups/{id}/delete

身份：组所有者。

输入：`{requestId,revision,scope:"local"|"upstream",confirmCascade?:boolean}`，requestId 和 revision 限制同素材删除。仅组的 `scope:"upstream"` 可提交 `confirmCascade`，缺失或 `false` 表示未确认。其他动作提交该字段或提交非布尔值返回 400 BODY_INVALID。

成功：local 为 200 `{group:GroupView}`（state=deleted）。upstream 返回 `{operation:OperationView}`，succeeded 为 200，其余为 202。已受理的同 requestId、组、revision 和确认意图返回原操作。`resultLocalId` 在成功后为目标组 ID。

错误：未确认的 upstream 在本地有未删除成员或远端组仍存在时返回 409 RESOURCE_IN_USE，local 在本地有未删除成员时同样拒绝。在途操作、租约、组状态及 revision 校验对确认删除同样适用。首次组查询、组权限或凭据错误直接返回对应错误。同一远端删除 requestId 改组、revision 或确认意图返回 409 IDEMPOTENCY_CONFLICT。其他见共同约定。

副作用：local 仅留本地墓碑。upstream 以本地映射的原组 ID 做精确 `GetAssetGroup`。未确认请求须通过本地空组检查，且该查询精确返回 HTTP 404 `ResourceNotFound`，才受理并落本地组墓碑。精确不存在回执须符合固定信封且缺省 Result 或带空 Result。明确提交 `confirmCascade:true` 授权永久删除指定远端组及供应商执行时的全部成员，包括本地未同步、已本地移除及确认后并发新增的成员。已确认删除复核本人组、账号配置绑定与当前 Key 权限，在出站前持久化操作意图、目标、凭据版本和输入摘要。若组仍存在，仅对目标发一次 `DeleteAssetGroup`。回执 `Result.Id` 须与目标相符，回执 `Result:{}` 则仅在精确查询目标确认不存在后收束。超时、身份不符、协议不明或本地提交失败都保留 unknown。确认成功后，在一个事务中更新目标组、本地已知成员墓碑与操作终态。现有墓碑及历史、其他组和 COS 原件保留。撤销真人授权须经第三方平台单独办理。

## GET /api/v1/materials/operations/{id}

身份：操作所有者。

输入：本地小写 UUID v4，无查询参数。

成功：200 OperationView；expired creating/deleting 租约转 unknown，同事务保留实体未知事实。unknown create 在已保存确切上游 ID 时由当前 owner 凭据执行单资源 GetAssetGroup，确认存在后按原操作输入/双租约在同一事务补映射并收束 succeeded；无 ID 则需人工核对远端残留，不全池查找或重发。

错误：他人操作统一 404 MATERIAL_NOT_FOUND；其余见共同约定。

副作用：本地读取并收敛到期操作；CreateAssetGroup/CreateAsset 已返回合法 ID 但提交失败时，fallback 将 ID/RequestId 仅保留于受限操作快照/审计；fallback 也不可用时披露人工核对。已知建组/素材登记或远端删除的 unknown 由 5 秒持久冷却、操作/组双租约认领，最多执行本次必要的 GetAssetGroup/GetAsset 复核。已知建组确认存在才同事务发布 ready/succeeded；已知素材登记经当前组和 GetAsset 核验后按真实上游状态发布素材并收束 succeeded（跨 owner 全局冲突拒绝且不读回他人）。远端删除须精确查询原资源收到 HTTP 404 `ResourceNotFound` 才收束 deleted/succeeded。组操作按受理时的确认意图处理成员墓碑，历史未确认操作继续依赖本地空组检查。建组 403/404、删除仍存在或状态未知继续 unknown。恢复只查询原资源。

## POST /api/v1/materials/auth-sessions

身份：当前登录 Cookie 用户，要求精确允许 Origin 与 JSON；未配置公开认证 origin 时返回 404。

输入：`{requestId,source:"materials",returnTarget:"materials"}`；小写 UUID v4，拒绝额外字段、任意 URL/owner/上游身份。相同本人 requestId/输入读回原会话，异输入 409 IDEMPOTENCY_CONFLICT。

成功：201 AuthSessionView（pending/completed），未取得确定就绪为 202 原视图；`AuthSessionView={sessionId,state,expiresAt,pollAfterMs,errorCode,launchUrl?,groupId?}`，state 为 creating/pending/verifying/completed/failed/expired/unknown，非终态 pollAfterMs 3000。pending 或 unknown 且仍有已验证上游创建证明密文时返回本系统 HTTPS launchUrl；无 token 的 unknown 不提供重建/launch 权限。

错误：配置未启用 404；供应商拒绝 409 PROVIDER_UNAVAILABLE；其余见共同约定。创建已发后超时/PG 失败保留 unknown，无自动第二次 Create；若有效返回证明已获得，fallback 保存原会话可恢复密文，fallback 同样失败或未得 token 则人工核对，不伪造恢复。

副作用：先持久 creating 意图与 owner/凭据版本/固定协议/20 分钟期限，再单次 CreateVisualValidateSession。会话独立于 operations 表；H5Link 与 BytedToken 用 provider 同部署主密钥 AES-256-GCM 五元组加密，AAD 固定材料会话用途+owner/session/keyId，与旧凭据用途隔离；另保留 SHA-256 token_digest。经校验的上游 RequestId 仅在会话表用于单次动作审计，会话仍以本地 id 和原 token 摘要关联。返回/日志不含远端 URL、token、密文或 PII，不创建真人组直到服务端复核通过。

## GET /api/v1/materials/auth-sessions/{id}

身份：会话所有者，Cookie/Origin 同本域共同约定。

输入：本地小写 UUID v4，无查询参数。

成功：200 AuthSessionView；completed 返回本地 groupId；有密文 unknown 仍可重新打开原 launchUrl，无密文 unknown 显示需核对。模型/目录能力不参与视图读取。

错误：他人会话统一 404 MATERIAL_NOT_FOUND；其余见共同约定。

副作用：只读本地事实并收敛到期/失效 creating/verifying 租约，不解密、不联网。逻辑有效期固定创建后 20 分钟，访问到期即转 expired 并清五元组；素材服务启动及健康运行时每 30 秒最多清理 100 条到期记录。停机期间的后台清理顺延至服务恢复。completed 保留脱敏结果/映射与 replay 所需 digest，完成事务立即清密文。

## POST /api/v1/materials/auth-sessions/{id}/refresh

身份：会话所有者 Cookie；要求本域原有精确 Origin/JSON。此端点不属于公开手机路径，不通过临时隧道转发。

输入：正文严格 `{}`，本地小写 UUID v4，无 query。不得提交 token、上游会话或 GroupId。

成功：200 AuthSessionView。手机回跳查询超时/断线，或回调页已关闭时，owner 可用原 sessionId 显式复核，不依赖再打开 H5 必定触发回跳；使用存储的原 token 与 owner 当前账号凭据，同一 verify 路径成功后原子完成。completed 重复返回原结果，不查询或创建远端会话。

错误：他人会话统一 404 MATERIAL_NOT_FOUND，且不解密/联网；原 token 未取得的 unknown 为 409 AUTH_RECOVERY_UNAVAILABLE，明确需人工核对；到期 410 AUTH_EXPIRED；共享 3 秒冷却/8 次终生验证 claim/60 秒租约，在途、冷却或预算耗尽 429 AUTH_QUERY_LIMITED/Retry-After:3。缺证保持 unknown，不发第二次 Create。

副作用：显式 owner 恢复可以受控解密并执行必要单资源 GetResult/GetGroup；与公开 complete 复用同一原会话、digest/租约/预算/硬截止/事务终态，公开回调仍须先证明 supplied token digest。GET 状态继续只读本地，无隐式出站；私有恢复不扩大公开 allowlist。

## GET /api/v1/materials/auth-sessions/{id}/launch

身份：无桌面 Cookie/Origin 的公开手机入口，仅精确此路径和 GET；其他素材接口不继承公开放行。

输入：高熵小写 UUID v4，无查询参数，无 returnUrl/Host 推导。

成功：302 至创建时校验过的 `https://ark.volcengine.com/region:cn-beijing/mobile/livenees-face-manage/authorization` 原 H5Link；no-store/no-referrer/CSP，Location 是本次必要手机 launch 权限，不进入日志或公开结果。

错误：不存在 404、expired 410 AUTH_EXPIRED、无可用创建证明/状态 409 AUTH_NOT_READY、解密失败 503 MATERIAL_AUTH_SECRET_UNAVAILABLE、公开处理器最多 4 个在途，超出即 429 AUTH_QUERY_LIMITED/Retry-After:3，不进入 PG；非 GET 405。方法和 query 的失败不触发上游。

副作用：按原会话状态/到期检查后受控解密一次供重定向，不调用远端创建；禁止任意 host/path/open redirect，校验与凭据目的不同的密文不能解开。

## GET /api/v1/materials/auth-sessions/{id}/complete

身份：公开手机 GET 回跳，仅精确此路径；当前无 HMAC 协议，不信任 resultCode 本身。

输入：仅读取必传单值 `bytedToken`（16–512 非控制/空白字符）和可选单值 `resultCode`（1–10 位十进制数字），任一重复即拒绝。含查询串的请求路径不超过 8192 字符。忽略供应商随手机回跳附带的其他参数，包括客户端附带的身份、目标、GroupId 或状态。

成功：200 脱敏固定 HTML；服务端将 supplied token 的 SHA-256 与原会话 digest 常量时间比较，再持久认领会话、用存储的原 token 与 owner 当前启用凭据单次 GetVisualValidateResult，要求合法 GroupId 并经单资源 GetAssetGroup 确认为 LivenessFace，方在同 PG 事务原子新建本人 verified 真人组、完成会话并立即清五元组。completed 合法重放返回原成功，不再查询或造组；固定返回链接 `/materials`。

错误：错误/跨会话 token 400 AUTH_PROOF_INVALID；请求路径超长、支持字段重复或 resultCode 格式无效 400 AUTH_QUERY_INVALID；未完成会话收到非 `10000` 的 resultCode 返回 400 AUTH_RESULT_UNCONFIRMED，保留原会话和查询预算；到期 410。公开槽上限 4、同会话 3 秒持久冷却/60 秒租约、会话生存期最多 8 次验证 claim；在途/冷却/预算耗尽 429 AUTH_QUERY_LIMITED/Retry-After:3，unknown 不被伪造为 failed。403/404/未知响应/组类型不符/跨 owner 上游 ID 碰撞保留 unknown 与脱敏错误，不拒绝整个 provider、不绑定他人组。

副作用：验证出站/结果写入按原会话身份、owner、token digest、clock_timestamp 租约和到期 CAS；迟到结果不能覆盖新终态，实体与完成/清密文在同事务提交。会话审计保留查询结果、核验组各自最近一次经校验的上游 RequestId，覆盖仍有有效会话认领的失败回退。Create 与 callback 不双写 operations；无 token 的 unknown 不自动重建。错误 HTML 与日志不回显 query/token/远端原文，所有响应 no-store/no-referrer。业务验收须核对本人在公开 HTTPS 上从授权页到回跳、落库的完整链路。
