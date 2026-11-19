# 已接受开发成果

PRD：[当前需求](../prd.md)。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。

## auth-http-shared-primitives

**auth 与基础 HTTP 公共能力抽取**

[src/http-response.ts](../../../../src/http-response.ts) · [src/auth/config.ts](../../../../src/auth/config.ts) · [src/auth/http.ts](../../../../src/auth/http.ts) · [src/http.ts](../../../../src/http.ts) · [docs/apis/index.md](../../../apis/index.md) · [tests/auth/auth.test.ts](../../../../tests/auth/auth.test.ts)

## auth-registration-foundation

**邮箱密码注册、持久会话与可信身份底座**

[src/auth/service.ts](../../../../src/auth/service.ts) · [src/auth/http.ts](../../../../src/auth/http.ts) · [src/plugin.ts](../../../../src/plugin.ts) · [scripts/service/migrate-auth.ts](../../../../scripts/service/migrate-auth.ts) · [docs/auth.md](../../../auth.md) · [docs/apis/auth.md](../../../apis/auth.md) · [tests/auth/auth.test.ts](../../../../tests/auth/auth.test.ts)

## phone-wechat-auth

**手机号验证码、微信登录与本人首次绑定**

[src/auth/phone.ts](../../../../src/auth/phone.ts) · [src/auth/phone-store.ts](../../../../src/auth/phone-store.ts) · [src/auth/wechat.ts](../../../../src/auth/wechat.ts) · [src/integrations/tencent-sms.ts](../../../../src/integrations/tencent-sms.ts) · [src/integrations/wechat.ts](../../../../src/integrations/wechat.ts) · [docs/apis/auth.md](../../../apis/auth.md) · [docs/tasks/ai-drama-foundation/changes/phone-wechat-auth/change.md](../changes/phone-wechat-auth/change.md) · [docs/tasks/ai-drama-foundation/pending/auth-extension.md](../pending/auth-extension.md)

## wechat-qr-polling

**匿名微信 QR polling 登录与内嵌 WxLogin 同源回调跳板**

[src/auth/wechat-qr.ts](../../../../src/auth/wechat-qr.ts) · [src/auth/wechat-qr-store.ts](../../../../src/auth/wechat-qr-store.ts) · [src/auth/wechat.ts](../../../../src/auth/wechat.ts) · [src/auth/http.ts](../../../../src/auth/http.ts) · [src/auth/wechat-input.ts](../../../../src/auth/wechat-input.ts) · [src/auth/config.ts](../../../../src/auth/config.ts) · [docs/apis/auth.md](../../../apis/auth.md) · [docs/auth.md](../../../auth.md) · [docs/integrations/wechat.md](../../../integrations/wechat.md) · [docs/tasks/ai-drama-foundation/changes/wechat-qr-polling/change.md](../changes/wechat-qr-polling/change.md) · [tests/auth/wechat.test.ts](../../../../tests/auth/wechat.test.ts)

```mio-prd-results
{
  "version": 5,
  "prd": "docs/prd-ai-drama-foundation.md",
  "records": {
    "path": "docs/tasks/ai-drama-foundation/complete/records.json"
  }
}
```
