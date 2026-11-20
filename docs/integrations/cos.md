# 腾讯云 COS 使用契约

## 适用范围与接入事实

用户资产和计算结果使用项目独立私有桶，服务端通过固定的 `cos-nodejs-sdk-v5 3.0.0` 接入；A 的源码入口为 [COS 适配器](../../src/integrations/cos.ts)，消费者为[素材登记](../apis/materials.md)、[用户资产](../apis/assets.md)与[计算任务](../apis/compute.md)。此能力不启用公开桶，也不复用旧项目的桶或 Root 凭据。实际桶、最小权限、CORS 和真云行为须在目标环境单独验证。

## 必须遵守的约束

- A 的服务端配置为 `MIO_ASSETS_DATABASE_URL`、`MIO_COS_BUCKET`、`MIO_COS_REGION`、`MIO_COS_SECRET_ID` 和 `MIO_COS_SECRET_KEY`。全部未配置时不注册资产入口，部分配置或缺认证时启动失败。凭据仅从受控环境注入，URL 日志与报告只记录脱敏信息。仓库本地 `dev/test` 的 A/B 使用所选私有环境文件中的一套受限 COS 凭据，对应两项服务实际所需的权限并集。独立部署各自注入符合分工的最小权限身份。对象访问范围随部署和实际读写路径验收。
- 服务使用非 Root 凭据。长期受限 `SecretId/SecretKey` 可直接使用。采用临时凭据的环境额外注入 `MIO_COS_SESSION_TOKEN` 并核对其有效期。本地 A/B 使用同一会话令牌。W1/W2 文本流程无需 COS 会话。
- PUT 使用 5 分钟签名和服务端生成的 `mio/staging/<assetId>`；签名绑定声明长度与 Host，HEAD 仍再次核验实际大小与 ETag。浏览器需对应精准 Origin 的 COS CORS；禁止通配公开权限。签名和请求映射以官方 SDK 和真实 COS 验证为准。
- 按冻结的 ETag 条件复制至唯一 `mio/raw/<assetId>/<attemptId>`，发出禁止覆盖头并以抢占身份条件登记。过期抢占可重试，旧执行者不能更改获胜登记；ETag 是 COS 条件标识，不是防碰撞内容证明。复制成功而登记失败可能遗留孤儿，须保留身份供对账，不得把其当已登记资产。
- 上传在 24 小时后过期；服务启动及之后每分钟扫描最多 100 条属于本服务、已过期且不在有效抢占内的 staging，按生成键逐项删除。离线、积压、失败和活跃抢占会延迟清理，失败稍后重试；不扫描桶、不删除未知对象、已登记 raw 或成品。孤儿 raw 不自动删除。
- 下载只对本人已登记资产签发 5 分钟 URL，并要求 attachment 响应；不持久化 URL，普通下载字节不经 A。桶权限、接口和网络规则不能将临时 URL 或对象键当作用户身份。
- 对话视觉输入和检查经资产服务只读本人 ready 的 original/derived 图片，按完整登记键 HEAD，再以 raw ETag 的 `If-Match` 有界流读取并核对实际长度和 SHA-256；每次重读重新核对归属、状态和键。raw ETag 与 staging 复制源 ETag 各自取值，不能互换。读取取消、大小超限时销毁 SDK 流；非 2xx 与长度不符不能作为成功正文。内存预览不修改 COS 原件，不向 DSH 日志写入字节、签名 URL 或对象键。
- 图片素材登记使用相同条件流读取机制，但独立上限为 20 MiB，绝不把视觉 10 MiB 全局放大；按本人 ready 的 immutable raw/受控 derived 键冻结真实 raw ETag、实际长度与 SHA-256，签名前再次 HEAD 核对该冻结值。供应商专用 `materialUrl` 为固定键签发 600 秒 GET，不含 attachment，继续经 `encodeUrlToken` 编码临时 token；不持久保存签名 URL、不改公开桶。当前长效测试凭据与 STS 的真实剩余寿命分别核验；SDK 签名参数测试不证明任意 STS 部署可用。失败/本地或远端素材删除均保留 COS 原件。
- 任务受理前 A HEAD 本人输入资产并冻结实际对象键与 ETag（视频转码仅限本人 `raw` 原件，图片参考图/编辑允许本人 `raw` 原件或已落库图片 `derived` 键 `mio/derived/<jobId>/images/<index>-<fileId>.<format>`）。收到成功结果后，A 仅 HEAD 当前 attempt 的 derived 键，核对长度、ETag 和 SHA-256 元数据，再在 PG 同时登记 owner 结果资产和终态。A 条件读取冻结图片输入、禁止覆盖地写图片 derived。B 条件读取冻结重媒体输入、禁止覆盖地写重媒体 derived，并按[计算协议](../tasks/compute-service/protocol.md)恢复未知上传。A/B 对原件和成品的授权限于读取、写入和校验。HEAD 核验对象元数据，完整内容校验按协议读取字节。
- A 图片结果先保留原始字节到专属持久目录并登记 PG 检查点；COS/PG 对账成功才清理，未知或失败文件保留。图片结果 PUT 携带本地计算的 Content-MD5 供 COS 校验提交内容，成功后由结果采用层执行新对象的一次 HEAD，比较实际 PUT 回执与 HEAD 的 ETag、长度和 SHA-256 元数据，适配器不重复 HEAD。已保存输出和曾尝试对象键的恢复仍按记录身份重新 HEAD；ETag 用作关联标识，不当作 MD5。视频未知上传恢复仍按协议 GET 并流式校验完整内容。
- 资产服务关闭时停止受理新操作和启动新的清理删除，等待在途操作；正常对象调用在本地等待最多 180 秒，关闭时最多再等待 5 秒后停止等待 COS 调用，再收敛操作并关闭 PG 池。SDK 的普通请求不提供取消句柄：本地超时不证明云端请求已取消或进程已退出，晚到复制只能形成未登记对象，晚到清理仅作用于到期 staging；重启后按冻结标识和租约恢复。

## 验证入口与变更影响

`tests/assets/assets.test.ts` 使用隔离真实 PostgreSQL、实际插件 HTTP 和受控对象存储替身；`tests/assets/assets-cos.test.ts` 核对 SDK 签名及调用参数。本机隔离测试桶已做小对象 SDK 签名、条件复制、下载和 A/B 分离身份权限正反例；还经真实插件登录入口和 Chrome 以指定 Origin 直传、登记并下载，并确认另一 Origin 的预检被拒。真实 A/B 本机链路与断线恢复也有开发探针。以上均只适用于所测小样本、测试桶和实际候选，不证明生产权限、生产负载或人类接受；已登记测试原件与成品按清单保留。
