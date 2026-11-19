# 已接受开发成果

PRD：[当前需求](../prd.md)。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。

## conversation-kernel

**受控 DSH 内核、多轮与原生持久化边界**

[src/dsh/kernel.ts](../../../../src/dsh/kernel.ts) · [src/dsh/policy.ts](../../../../src/dsh/policy.ts) · [src/plugin.ts](../../../../src/plugin.ts) · [docs/integrations/dsh.md](../../../integrations/dsh.md) · [tests/foundation/kernel.test.ts](../../../../tests/foundation/kernel.test.ts)

## conversation-platform-prompt

**对话平台人设与受控系统提示词（miioo AI 漫剧助手）**

[src/conversations/prompt.ts](../../../../src/conversations/prompt.ts) · [src/plugin.ts](../../../../src/plugin.ts) · [src/dsh/conversations.ts](../../../../src/dsh/conversations.ts) · [docs/conversations.md](../../../conversations.md) · [docs/integrations/dsh.md](../../../integrations/dsh.md) · [docs/tasks/conversation-service/changes/conversation-platform-prompt/change.md](../changes/conversation-platform-prompt/change.md) · [tests/conversations/prompt.test.ts](../../../../tests/conversations/prompt.test.ts) · [tests/conversations/conversations-engine.test.ts](../../../../tests/conversations/conversations-engine.test.ts) · [tests/conversations/conversations-profile.test.ts](../../../../tests/conversations/conversations-profile.test.ts)

## conversation-service

**用户归属的本地对话 API 与真实默认文本闭环**

[src/conversations/http.ts](../../../../src/conversations/http.ts) · [src/conversations/service.ts](../../../../src/conversations/service.ts) · [src/conversations/store.ts](../../../../src/conversations/store.ts) · [src/dsh/conversations.ts](../../../../src/dsh/conversations.ts) · [docs/apis/conversations.md](../../../apis/conversations.md) · [tests/conversations/conversations-live.ts](../../../../tests/conversations/conversations-live.ts)

```mio-prd-results
{
  "version": 5,
  "prd": "docs/tasks/conversation-service/prd.md",
  "records": {
    "path": "docs/tasks/conversation-service/complete/records.json"
  }
}
```
