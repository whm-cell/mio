# 测试目录索引

按本次目标从下列能力目录进入。测试选择、共享影响、环境和证据复用统一见[工程测试导航](../docs/engineering/testing.md#按变更定位测试)，本页只说明文件归属。

| 目录                             | 职责                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| [harness/](harness/)             | 工程护栏、任务资料、读取、验证及交付；专用夹具在 `harness/fixtures/`          |
| [foundation/](foundation/)       | 共享运行时原语、HTTP 身份复验、插件装载、Profile 准备与 DSH 内核              |
| [auth/](auth/)                   | 认证与 Redis 限流消费者                                                       |
| [providers/](providers/)         | 供应商配置、目录、刷新、迁移；领域参考数据在 `providers/fixtures/`            |
| [onelink/](onelink/)             | OneLink 适配、传输、生命周期及专用模型夹具                                    |
| [conversations/](conversations/) | 对话 HTTP、执行引擎、Profile 与模型夹具                                       |
| [assets/](assets/)               | 素材归属、HTTP 与 COS                                                         |
| [compute/](compute/)             | A 服务与共享计算协议；B Worker 测试保留在 [compute/tests/](../compute/tests/) |
| [integrations/](integrations/)   | Redis 公共资源与 RabbitMQ 生命周期                                            |
| [environment/](environment/)     | 本地环境、broker 拓扑及配置盘点                                               |
| [packaging/](packaging/)         | 工作区外可携带产物与迁移探针                                                  |
| [support/](support/)             | 多能力共用的测试数据库、打包 Profile、内核运行时和 Redis 进程／代理夹具       |

[providers-setup.ts](providers-setup.ts)仍是 [Vitest 配置](../vitest.config.ts)指定的全局 setup，保留根路径以避免迁移扩大其影响。专用夹具留在所属能力，跨能力共用实现放 `support/`；这些辅助文件不会因没有 `.test.ts` 后缀而失去影响。

各能力中的 `*-live.ts`、`live-*-probe.ts` 及 `packaging/` 探针保留显式入口；实际环境和授权条件沿工程测试导航及领域契约，不因目录整理自动执行。
