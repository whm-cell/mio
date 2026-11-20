# 素材库 HTTP 契约

[API 导航](index.md)；需求与分期见[素材库 PRD](../tasks/onelink-material-library/prd.md)。当前采纳 Unit 1 管理、同步、读取与删除，以及 Unit 2 图片核验/登记候选；真人认证和视频消费仍按后续单元推进。

## 本域共同约定

显式设置 `MIO_MATERIALS_ENABLED=true`，配置认证、供应商和 `MIO_ASSETS_DATABASE_URL`，先迁移 assets，再执行 `pnpm materials:migrate --apply`（本地 `pnpm migrate:dev materials --apply`）。素材域独立持池；仅素材管理且所有 COS 字段缺省时不注册资产 HTTP；任一 COS 字段出现则沿既有资产完整配置校验，部分配置失败。启动只读检查三表和确切全局上游唯一索引，缺结构失败，不自动迁移或联网。未启用时不注册本域。

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

副作用：先按 owner/requestId/input 查询既有操作；仅新登记在图片读取前同步认领单服务槽，覆盖读取、真实解码和出站/提交；单原件最多 20 MiB，不缩窄资产 1 GiB 或放宽视觉 10 MiB。冻结 rawKey/raw ETag，If-Match 有界读取并核对实际字节和 SHA-256，使用纯 sharp 真实解码校验每帧宽高 300–6000、宽高比 0.4–2.5、可解码多页累计最多 36M 像素，单解码 15 秒处理预算；WebP 使用 frame pageHeight，不把 stacked height 当单帧高度。签名前复核本人 ready 与 raw HEAD 一致，签发固定 raw 的 600 秒 GET（无 attachment，保留 STS 编码），不持久保存 URL。短事务保存素材 registering、受控原件摘要与原操作意图，再单次 CreateAsset，按组/操作租约提交 processing/操作终态；原件与 COS 不被删除。已知返回 ID 的提交失败只记原操作受限身份，经当前 owner 的精确 GetAsset/组核验恢复真实状态；无 ID 保持 unknown/manual，绝不自动重发。

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

输入：`{requestId,revision,scope:"local"|"upstream"}`，字段限制同素材删除。

成功：local 为 200 `{group:GroupView}`（state=deleted）；upstream 为 `{operation:OperationView}`，succeeded 200，其余 202。

错误：有未删除素材 409 RESOURCE_IN_USE；在途创建/操作/组租约 409 MATERIAL_BUSY；其他同素材删除与共同约定。

副作用：local 仅留本地墓碑；upstream 在持久意图后核验单资源权限并调用 DeleteAssetGroup，成功时同事务提交实体与操作终态。无隐式级联，不删除 COS，不把删组解释成撤销真人授权。

## GET /api/v1/materials/operations/{id}

身份：操作所有者。

输入：本地小写 UUID v4，无查询参数。

成功：200 OperationView；expired creating/deleting 租约转 unknown，同事务保留实体未知事实。unknown create 在已保存确切上游 ID 时由当前 owner 凭据执行单资源 GetAssetGroup，确认存在后按原操作输入/双租约在同一事务补映射并收束 succeeded；无 ID 则需人工核对远端残留，不全池查找或重发。

错误：他人操作统一 404 MATERIAL_NOT_FOUND；其余见共同约定。

副作用：本地读取并收敛到期操作；CreateAssetGroup/CreateAsset 已返回合法 ID 但提交失败时，fallback 将 ID/RequestId 仅保留于受限操作快照/审计；fallback 也不可用时披露人工核对。已知建组/素材登记或远端删除的 unknown 由 5 秒持久冷却、操作/组双租约认领，最多执行本次必要的 GetAssetGroup/GetAsset 复核，已知建组确认存在才同事务发布 ready/succeeded；已知素材登记经当前组和 GetAsset 核验后按真实上游状态发布素材并收束 succeeded（跨 owner 全局冲突拒绝且不读回他人）；远端删除精确 404 才收束 deleted/succeeded。建组 403/404、删除仍存在或未知继续 unknown；不重发 Delete，不枚举共享池。
