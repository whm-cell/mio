# 已接受开发成果

PRD：[当前需求](../prd.md)。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。

## conversation-kernel

**受控 DSH 内核、多轮与原生持久化边界**

[src/dsh/kernel.ts](../../../../src/dsh/kernel.ts) · [src/dsh/policy.ts](../../../../src/dsh/policy.ts) · [src/plugin.ts](../../../../src/plugin.ts) · [docs/integrations/dsh.md](../../../integrations/dsh.md) · [tests/kernel.test.ts](../../../../tests/kernel.test.ts)

## conversation-service

**用户归属的本地对话 API 与真实默认文本闭环**

[src/conversations/http.ts](../../../../src/conversations/http.ts) · [src/conversations/service.ts](../../../../src/conversations/service.ts) · [src/conversations/store.ts](../../../../src/conversations/store.ts) · [src/dsh/conversations.ts](../../../../src/dsh/conversations.ts) · [docs/apis/conversations.md](../../../apis/conversations.md) · [tests/conversations-live.ts](../../../../tests/conversations-live.ts)

```mio-prd-results
{
  "version": 5,
  "prd": "docs/tasks/conversation-service/prd.md",
  "records": {
    "path": "docs/tasks/conversation-service/complete/records.json",
    "sha256": "350c68a2eab3b063de0dcdecaf6f799b12ad382973b629b7477ea69f2675b774"
  }
}
```
