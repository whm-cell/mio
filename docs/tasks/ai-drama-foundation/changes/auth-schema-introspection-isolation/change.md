# 认证元数据探测的 schema 隔离

```mio-change
{"version":1,"type":"adjustment","section":"架构前提与未决项"}
```

2026-11-19 已确认修复认证元数据扫描与无关隔离 schema 并发删除的竞争。保留 Better Auth 1.7.18 和 pg 8.23.1；直接声明已锁定的 Kysely 0.29.8，不修改第三方安装源码。

## 范围与实施安排

C0 已确定公开 PostgresDialect.createIntrospector 扩展及有效 search_path 范围；C1 为认证增加小型 introspector，在 SQL 内用 current_schemas(false) 限定表、列和 schema，并以 pg_depend 的 OID 关联 serial／identity 序列。去除按 schema 名查询权限和重新按表名查序列的危险解析，不能只在查询后过滤数组。

启动 getMigrations、显式迁移与首次 runtime adapter 结构检查共用 authOptions；迁移目标仍为首 schema，运行时按有效路径解析实际表。保留真实元数据、内部迁移表选项、缺表／列／必需索引和额外无默认必填列检查，显式 transaction:true 保持注册事务及原 Pool 所有权。不得以关闭结构检查、串行全套回归或提高超时消除竞争。

## 验收与规范

在隔离回归库内并发创建／删除带 serial 表的无关 schema，同时执行两个认证实例的启动与实际认证读写；核对启动和首次 runtime SQL、多项 search_path、元数据保持、迁移幂等、结构负例与失败释放。首次 runtime 负例使用新实例避免库内既有检查缓存；索引负例属于启动／迁移，不宣称运行时持续巡检。继续覆盖注册回滚、唯一性、打包 Profile 和受影响回归，当前完整检查覆盖单独核对。

接入与生命周期由[认证配置与迁移](../../../../auth.md#配置与迁移)及[PostgreSQL 契约](../../../../integrations/postgres.md)维护。本变更随同一资源安全维护任务核验，不改写原[认证成果](../../complete/report.md#auth-registration-foundation)，不生成新的业务接受结果。
