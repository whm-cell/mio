# 任务资料与成果

从[任务目录](./)查找各 PRD 的需求、设计、未采纳提案与已接受成果。每个目录的 `documents.json` 登记该 PRD 的稳定身份和当前位置；新增或交付其他 PRD 不更新本页。

使用 `pnpm work documents` 按需读取资料及成果入口；该只读命令无需 `.work`，支持现有分页与字段选择。使用 `pnpm work read-result <prd> [key]` 读取某项已接受成果。

已有 PRD 的轻量变更由父 PRD 导航至所属 `changes/index.md`；也可用 `pnpm work changes <prd> [key]` 按需读取。目录不表示当前接受状态。

成果位于所属 PRD 的 `complete/records.json` 与 `complete/report.md`，记录完成范围、真实接受和限制。成果存在不代表整份 PRD、当前源码或生产验收已完成。个人进度、待接受草稿与原始证据沿[任务记录](../work-records.md)保留在 `.work`。
