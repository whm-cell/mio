# 系统公告配置与存储

设置 `MIO_NOTIFICATIONS_DATABASE_URL` 启用公告域，同时需要完整的认证配置。该 URL 由部署端注入，可与其他域指向不同数据库；不自动退回认证库或供应商库。公告查询只接受经认证库实时核实的用户 Cookie，不缓存会话，不续期。启用管理员写入还需要现有管理后台及供应商配置，沿用独立的 `mio.admin_session`。用户接口见[公告 HTTP](apis/notifications.md)，管理接口见[管理 HTTP](apis/admin.md#get-apiv1adminannouncements)。

升级前按部署方式备份公告数据库，向迁移进程提供同一个 `MIO_NOTIFICATIONS_DATABASE_URL`，先运行 `pnpm notifications:migrate` 审阅 SQL，再运行 `pnpm notifications:migrate --apply`。命令不会自动加载 `.env`；环境由调用者显式注入。预览不要求数据库连接，也不写入；应用只在公告库内的事务建立缺少的表及索引，保留已有内容与回执，可重复执行。结构不兼容则回滚本次 DDL 并报错，需人工检查，不能通过删库重新迁移消除失败。启动仅执行只读结构检查；缺迁移或关键结构不符时拒绝启动，不自行改表。

`mio_announcements` 保存草稿、发布状态、启用、弹窗开关、生效时间和内容。`mio_announcement_reads` 以 `(user_id, announcement_id)` 为主键；公告删除级联删除本域回执，用户和管理员均不建跨库外键。公告存储独占最多 4 个连接，连接、语句及查询等待分别有 5 秒上限；空闲连接错误只记脱敏码，启动失败和插件卸载均关闭自己持有的池。[PostgreSQL 公共契约](integrations/postgres.md)

管理写入先经现有管理员鉴权，再用管理员域独立提交 `mio_admin_audit_logs` 操作意图，记录真实管理员 ID、用户名、公告 ID 和 `announcement.create/update/publish/unpublish/delete`。审计失败阻止公告写入；公告库失败时审计保留为尝试记录，摘要明确不表示成功。两个数据库没有共享事务或原子提交承诺。编辑、发布、撤回及删除在公告行锁内串行化；已读在同域短事务持共享行锁复核可见性，避免与删除／停用交错产生孤立回执。

最新弹窗元数据使用 4 秒进程缓存；并发冷请求共享一次查询。缓存同时在下一条已发布弹窗的未来生效时间到期，不把未来公告提前暴露或延迟至完整 TTL。管理员同实例写入结束即失效缓存，旧在途填充不能回写；其他实例最多按 TTL 收敛。已热无弹窗查询在公告域执行 0 条 SQL；已热有弹窗仅查一次本人回执主键，最新公告已读便返回空。认证库的身份查询另计。列表和标记已读直接查询公告库，均按数据库现状判断。

回归入口为 `pnpm test tests/notifications tests/admin tests/foundation tests/harness`，只使用 `mio_regression_test` 随机 schema 与协议替身，不读取开发业务凭据或调用外部服务。隔离测试通过与真实 Web 客户端业务接受分别判断。

## 注销清理

账号永久注销只删除旧 userId 私有公告已读回执，不删除公告正文。创作消息在所属媒体库逐批清除，关闭栅栏与发布事务同库，已受理旧音频 outbox 迟到补投在关闭后直接丢弃、不写回消息或新的去重回执。正常用户的消息保留策略与原固定 TTL 不变，不增加生产者确认回收握手。见[永久注销](auth.md#永久注销与清理)。
