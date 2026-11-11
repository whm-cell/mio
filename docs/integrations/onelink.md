# OneLinkAI 集成契约

## 适用范围与接入事实

实际消费者为[用户万联配置](../providers.md)、[目录客户端](../../src/integrations/onelink/models.ts)及[文本传输](../../src/integrations/onelink/chat.ts)/[DSH 适配](../../src/dsh/onelink.ts)。图片、视频、语音、音乐及素材执行器仍未装配；范围见[万联 PRD](../tasks/onelink-integration/prd.md)。协议依据为[模型目录文档](https://docs.onelinkai.cloud/8882392m0)与[文本接入说明](https://docs.onelinkai.cloud/8882612m0)，旧源码身份仅在[测试参考](../../tests/fixtures/onelink-legacy-snapshot.ts)保存，不参与生产或构建。

## 必须遵守的约束

- 目标固定为 `https://api.onelinkai.cloud/v1/models`，方法 GET，认证为 Bearer；用户不能提交任意 URL、代理或认证头。不跟随重定向，不自动重试。
- 仅当前用户显式动作解密当前 Key；读取元数据、启动和保存不探测。发现没有生成、收费 POST 或工具授权副作用。
- 整个请求/响应体读取期限 10 秒，正文最多 2 MiB，最多 5000 条，单项最多 16 KiB，ID 非空且最多 256 字节、无控制字符。完整校验 data 数组和分页未完成标志；精确重复且全部元数据一致才去重，冲突拒绝整份响应。保留 id 和受限 object/created/owned_by/description，缺值未知；不按名称、前缀或描述推导分类/协议。大小写、点号和套餐后缀保留。
- 认证失败、限流、上游失败、超时、取消、响应格式/体积错误分别返回服务定义的脱敏分类。响应原文、源异常和 Key 不透传；原文及 JSON 解码后的 ID/保存字段均拒绝回显 Key，不能通过 Unicode 转义绕过。关闭取消本域在途请求并等待结算。
- 当前凭据完整成功目录是成员权威；目录移除阻止新请求，但不是“供应商全局下线”的结论。协议/能力仍由独立有来源声明与已实现代码决定，不能从成员身份推导能力。成功快照、失败尝试、认证阻断和最新开始序号按[供应商规范](../providers.md)持久化。工具仍沿[DSH 全拒绝策略](dsh.md)。

## 使用经验与适用条件

聊天只允许固定 origin 的 POST `/v1/chat/completions` 与 `/v1/messages`；后者兼容固定 Anthropic SDK 精确的 `?beta=true` 查询，不放行其他路径/查询。两协议统一 Bearer，SDK x-api-key 被移除，无 ambient/native credential 回退。重定向为 error；SDK及Mio自动 retry 均为0，Anthropic strict-tool 自动降级重发也关闭。鉴权、端点、并发快照不通过共享环境变量切换。正常响应保留公开 PiAi 编码语义；非2xx错误体在进入SDK前替换为固定诊断，观察只取白名单status/requestId/usage/finish/failureCode，不透传原响应/异常。已知HTTP 401/403、402、408/504、429分别映射鉴权、额度不足、超时、限流，其他失败不猜测额度或可用性。取消/超时和观察持久化失败不推断未扣费。

Mio 输出上限1024、30秒HTTP/idle是本地政策，未知 supplier context/最大输出不从 SDK 默认大容量推导。普通 check 使用协议替身；独立 conversations-live 经正式用户入口执行真实文本，失败记录实际白名单观察。各协议保留确定性回归，真实验证目标与开发安排沿[万联 PRD](../tasks/onelink-integration/prd.md)，实际接受范围与限制见其[成果入口](../tasks/onelink-integration/complete/report.md)。一个目标通过不证明其他目标，未发现或无对应成功观察的目标仍未验证。

旧地址归一化允许其他 host 原样通过，不能作为允许列表复用；旧 TLS 补链、回退和重试没有作为当前必需能力搬入。旧预设及其冲突仅是迁移参考。其余非文本协议路径、错误和生成重试在后续真实消费者出现时另行采纳，不从目录成功推导 Messages、图片、MiniMax 或素材线路可用。

## 验证入口与变更影响

[确定性协议/权限测试](../../tests/providers.test.ts)覆盖固定地址、限界、错误与关闭；[独立 live 入口](../../tests/providers-live.ts)经实际用户 HTTP 和正式打包 Profile 执行目录发现。普通检查不读取 Key 文件或自动联网。改变目标、鉴权、响应解析、凭据范围或新增协议/副作用时，同步业务/API 规范、对应负向验证和此契约；真实结果与静态、打包通过分别报告。
