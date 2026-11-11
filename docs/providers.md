# 用户万联配置与动态模型目录

每个登录用户持有一个逻辑 `onelink` 配置；身份沿[认证底座](auth.md)，接口正文见[供应商 HTTP](apis/providers.md)，出站见[万联集成](integrations/onelink.md)。[万联 PRD](tasks/onelink-integration/prd.md)维护需求与安排，实际接受范围和限制见其[成果入口](tasks/onelink-integration/complete/report.md)。目录、协议实现、真实观察和业务接受分别判定。

## 配置与迁移

仅完整设置以下三项才启用本域；不回退认证数据库、登录 secret 或他人 Key：

| 变量                          | 含义                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `MIO_PROVIDERS_DATABASE_URL`  | 本域 PostgreSQL URL；独立持池，可与认证或对话同库           |
| `MIO_PROVIDERS_MASTER_KEY`    | 部署注入、独立于认证 secret 的 32 字节随机密钥，标准 base64 |
| `MIO_PROVIDERS_MASTER_KEY_ID` | 1–64 个字母、数字、下划线或连字符                           |

`pnpm providers:migrate` 展示 SQL；`pnpm providers:migrate --apply` 在一个事务内升级并检查。停止旧实例并按库责任备份后执行，启动只读检查，不自动迁移或联网。不兼容结构、约束冲突及迁移失败须核对原数据；失败事务不留下半套可运行结构，不承诺自动降级。

四表为 configs、models、model_adaptations、model_preferences，均以 `mio_provider_` 为前缀。配置保存 owner、当前密文、凭据版本、最近成功目录和最近尝试；模型保存精确 raw ID、稳定 UUID、来源与成员状态；适配保存已实现 profile、独立声明版本、来源和实际验证；偏好以配置/模型/usage 为键，并用部分唯一索引限制每用途一个默认。models 的配置/raw ID 唯一比较使用 C collation，偏好与适配通过复合外键核对配置归属。

旧表升级只承接同凭据、connected、models-only 且完整合法的旧 discovery；成功空列表仍有目录版本。旧失败或其他凭据的观察不补成成功。旧偏好生成稳定映射或 historical 行，无发现来源的行不填发现时间/目录版本。原文不可解析的引用保留为 `legacy_ref` 与 `LEGACY_MODEL_REF_INVALID`，不猜模型。映射冲突回滚，要求核对备份中的原偏好。

迁移默认读取同库已有的对话及回执绑定，只为 owner/配置匹配的旧引用补 historical 行，不改原绑定、digest、回执或 JSONL。对话位于另一数据库时，显式提供 `MIO_CONVERSATIONS_DATABASE_URL` 并运行 `pnpm providers:migrate --apply --with-conversations`；该连接只读引用，供应商写入仍在本域事务，无跨库外键。升级前冻结这些源记录并备份；本地测试不构成生产迁移验收。

旧 92 项数据原样保存在[测试参考](../tests/fixtures/onelink-legacy-snapshot.ts)，不为任何用户 seed 成员或适配。生产代码和构建不依赖该文件；构建先清理生成的 dist，防止已移出模块残留在包中。

## 凭据与资源

Key 仅由凭据写入口接收。AES-256-GCM 使用随机 12 字节 nonce、16 字节 tag，AAD 绑定格式、owner、配置、credentialVersion 和主密钥 ID。元数据查询只返回 hasKey 和固定 mask，不解密。明文、密文、源异常均不得进入 HTTP、日志、Session 或工具参数。

轮换原位替换密文、递增 credentialVersion，保留启停、水印、模型身份、适配和偏好/default 目标；旧成员成为 historical，旧成功目录保留历史版本但不授予新凭据资格。新版本必须显式成功发现。当前只保存当前密文，不提供历史 Key 平台。重启须注入同一主密钥和 ID；缺失在配置阶段拒绝，错误密钥/篡改在解密时拒绝，不回退。

[存储](../src/providers/store.ts)自持最多 5 个连接、连接/查询等待各 5 秒。所有变更在配置行锁下串行；初建 owner 唯一约束及客户端 expectedRevision 防并发覆盖。刷新开始和完成、配置/偏好及适配声明更新递增 revision。关闭取消并等待发现，先收敛对话运行再关闭本域池；即使对话清理失败也释放本域并保留错误。共同资源约束沿[PostgreSQL](integrations/postgres.md)。

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

## 受控适配声明与实际验证

目录成员、供应商 metadata/classification、服务实现、用户偏好和实际验证分开返回。当前官方 /v1/models 结构只承诺描述性字段，不足以证明逐模型协议；名称前缀、owned_by、description 均不用于推断。当前解析器不会虚构自动关联；未来出现可核实的结构化协议字段时，须先核对供应商契约再增加识别。

元数据不足的模型立即显示 ADAPTER_PENDING。部署可用下列入口为**当前已发现成员**选择已实现的 `chat/openai-chat` 或 `chat/anthropic-messages`：

```sh
pnpm providers:adapt <owner-id> <expected-revision> <declaration.json>
```

文件最多 8192 字节，形如：

```json
{
  "modelRef": "onelink:model:<directory-returned-uuid>",
  "operation": "chat",
  "profile": "openai-chat",
  "source": "已核对的协议文档或实际观察依据",
  "sourceVersion": "依据版本",
  "classification": "chat"
}
```

classification 可省略；可选 `metadata.contextWindow` 只能是有来源的正整数。未知上下文/价格/工具/媒体能力不补值。来源明确是部署声明，不冒充供应商元数据。入口不创造成员、不接收代码/URL/Key/verified，不开放普通用户管理 API。每次声明更新递增独立版本并使验证待核对，分类变化保留身份/偏好。

验证只来自对应成功运行观察，绑定 credential/catalog/adaptation 版本及 operation/profile。刷新、轮换或声明变化使当前验证失效但保留旧观察引用；旧运行晚完成不能覆盖新版本验证，原请求观察仍保留。实际调用允许已实现但未实测项用于授权验证，不能提前展示已验证。

### 模型扩展边界

新精确 ID 经成功目录发现后可关联已有且实际兼容的 profile，不新增生产型号名单。声明仅接受字符串形式的已实现 profile；未知或非字符串值拒绝。运行适配层显式选择路由、codec、端点及兼容项，未知值不落入 OpenAI 默认路径。参数差异或新协议须有实际依据，在适配边界补实现、必要准入/存储约束及回归；配置不创造能力，也不重建稳定身份、账号或会话。

各协议分别保留确定性回归与真实观察，某个模型或协议通过不推导其他目标已验证；实际核验目标、未验条件与接受范围见[万联 PRD](tasks/onelink-integration/prd.md#对话验收衔接)及其成果。

## 文本消费与验证入口

selectChat 一致读取本人配置、目录、适配、偏好，不解密。fresh resolveChat 核对同一逻辑身份并冻结稳定模型键、raw ID、凭据/目录/声明版本及 operation/profile，再解密到请求内存。已有 requestId 先返回原回执，当前资格变化不重发；在途运行不换版本。详情见[对话规范](conversations.md)。

[HTTP/加密测试](../tests/providers.test.ts)、[刷新测试](../tests/providers-refresh.test.ts)、[迁移测试](../tests/providers-migration.test.ts)、[打包 Profile](../tests/providers-profile.test.ts)与[目录参考测试](../tests/providers-catalog.test.ts)各自提供实际观察。普通检查使用隔离 PG 和协议替身，不读取私有 Key 或自动调用供应商；宿主 provider 配置由[测试 setup](../tests/providers-setup.ts)隔离。

显式 live 入口 `node tests/providers-live.ts <authorized-private-key-file>` 经隔离账号、公开 HTTP、正式 Profile 保存本人 Key、发现目录、部署声明测试默认，并重启再发现；只输出受控元数据。真实目录成功不等于聊天、全部模型、媒体或生产验收。源异常、代理配置、原响应和 Key 不打印。
