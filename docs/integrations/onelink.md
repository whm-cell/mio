# OneLinkAI 集成契约

## 适用范围与接入事实

实际消费者为[用户万联配置](../providers.md)、[目录客户端](../../src/integrations/onelink/models.ts)及[文本传输](../../src/integrations/onelink/chat.ts)/[DSH 适配](../../src/dsh/onelink.ts)。GPT、受限 Seedream 4.0 与协议中立 Vidu `vidu-image-v1` 图片能力均复用同一用户的 OneLink 凭据；W1/W2 文本仍独立于图片和 COS 现场条件。Vidu 当前适配仅对当前目录已发现且显式声明 `image.generate` + async 的成员生效，并原样发送其精确 modelId。OneLink 文档示例使用 `viduq2`，仅作协议参考，不据此生成目录成员；本次真实验证目标为当前目录中的 `image-vidu-q2`，不能外推其他型号。真实运行结果和接受按 profile 分别记录。视频、语音、音乐及素材执行器仍未装配。范围见[万联 PRD](../tasks/onelink-integration/prd.md)。公开[模型目录文档](https://docs.onelinkai.cloud/8882392m0)、[Vidu 系列接入说明](https://docs.onelinkai.cloud/8653257m0)与[文本接入说明](https://docs.onelinkai.cloud/8882610m0)只作协议、字段和映射参考，不建立成员清单；成员与数量仍只取当前用户 Key 成功 GET `/v1/models`。旧源码身份仅在[测试参考](../../tests/providers/fixtures/onelink-legacy-snapshot.ts)保存，不参与生产或构建。

## 必须遵守的约束

- 目标固定为 `https://api.onelinkai.cloud/v1/models`，方法 GET，认证为 Bearer；用户不能提交任意 URL、代理或认证头。不跟随重定向，不自动重试。
- 仅当前用户显式动作解密当前 Key；读取元数据、启动和保存不探测。发现只拉取并校验目录，不执行模型生成或工具调用；Mio 不维护费用逻辑。
- 整个请求/响应体读取期限 10 秒，正文最多 2 MiB，最多 5000 条，单项最多 16 KiB，ID 非空且最多 256 字节、无控制字符。完整校验 data 数组和分页未完成标志；精确重复且全部元数据一致才去重，冲突拒绝整份响应。保留 id 和受限 object/created/owned_by/description，缺值未知；不按名称、前缀或描述推导分类/协议。大小写、点号和套餐后缀保留。
- 认证失败、限流、上游失败、超时、取消、响应格式/体积错误分别返回服务定义的脱敏分类。响应原文、源异常和 Key 不透传；原文及 JSON 解码后的 ID/保存字段均拒绝回显 Key，不能通过 Unicode 转义绕过。关闭取消本域在途请求并等待收敛。
- Vidu 图片异步只使用 `POST https://api.onelinkai.cloud/vidu/ent/v2/reference2image` 与 `GET https://api.onelinkai.cloud/vidu/ent/v2/tasks/{task_id}/creations`，Bearer 鉴权；创建只发送已声明的 model/prompt/images/resolution，查询只使用持久的已知 task_id。临时结果 URL 可来自任意公网域名，但须为 HTTPS、无用户信息和非默认端口；worker 使用 `ipaddr.js` 2.5.0 分类目标地址，在 `undici` 8.11.2 的实际连接 DNS lookup 中排除非公网地址并保持原 hostname 的 TLS 校验，直接 IP 同样校验，避免检查后再次解析。结果使用同包 fetch/Agent，不跟随重定向、不转发 Authorization，沿用 fetch 的响应编码处理；限时下载后按实际 PNG/JPEG/WebP 文件签名确定格式，不以响应 Content-Type 或 URL 扩展名作为格式依据，再经完整解码与完整性核对进入私有 COS/Asset。不把 credits、COS key、ETag、Asset ID 或凭据透传。
- 当前用户 Key 显式刷新得到的完整成功目录是成员和数量权威；目录移除阻止新请求，但不是“供应商全局下线”的结论。编排先取得该目录快照，再以 `sourceKind=protocol-reference` 的官方协议/文档依据或 `sourceKind=runtime-observation` 的对应运行观察补充已发现成员的适配；两者都不能创建、补齐或替代目录成员。目录快照、旧 92 项和静态模型清单不是适配来源；没有当前成功目录就停止并保持 pending。成功快照、模型数量、失败尝试、认证阻断和最新开始序号按[供应商规范](../providers.md)持久化，历史 92 项只作迁移参考。工具仍沿[DSH 全拒绝策略](dsh.md)。

## 使用经验与适用条件

聊天只允许固定 origin 的 POST `/v1/chat/completions` 与 `/v1/messages`；后者兼容固定 Anthropic SDK 精确的 `?beta=true` 查询，不放行其他路径/查询。两协议统一 Bearer，SDK x-api-key 被移除，无 ambient/native credential 回退。重定向为 error；SDK及Mio自动 retry 均为0，Anthropic strict-tool 自动降级重发也关闭。鉴权、端点、并发快照不通过共享环境变量切换。正常响应保留公开 PiAi 编码语义；非2xx错误体在进入SDK前替换为固定诊断，观察只取白名单status/requestId/usage/finish/failureCode，不透传原响应/异常。已知HTTP 401/403、408/504、429分别映射鉴权、超时、限流，其他失败不猜测额度或可用性。取消/超时和观察持久化失败分别记录实际状态。

Mio 输出上限1024、30秒HTTP/idle是本地政策，未知 supplier context/最大输出不从 SDK 默认大容量推导。普通 check 使用协议替身；独立 conversations-live 经正式用户入口执行真实文本，失败记录实际白名单观察。各协议保留确定性回归，真实验证目标与开发安排沿[万联 PRD](../tasks/onelink-integration/prd.md)，实际接受范围与限制见其[成果入口](../tasks/onelink-integration/complete/report.md)。一个目标通过不证明其他目标，未发现或无对应成功观察的目标仍未验证。

旧地址归一化允许其他 host 原样通过，不能作为允许列表复用；旧 TLS 补链、回退和重试没有作为当前必需能力搬入。旧预设及其冲突仅是迁移参考。其余非文本协议路径、错误和生成重试在后续真实消费者出现时另行采纳，不从目录成功推导 Messages、图片、MiniMax 或素材线路可用。

## 验证入口与变更影响

[确定性协议/权限测试](../../tests/providers/providers.test.ts)覆盖固定地址、限界、错误与关闭；[独立 live 入口](../../tests/providers/providers-live.ts)经实际用户 HTTP 和正式打包 Profile 执行目录发现。普通检查不读取 Key 文件或自动联网。改变目标、鉴权、响应解析、凭据范围或新增协议/副作用时，同步业务/API 规范、对应负向验证和此契约；真实结果与静态、打包通过分别报告。
