# 已接受开发成果

PRD：[当前需求](../prd.md)。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。

## admin-onelink-sso

**万联 OneLink SSO 管理端配置、运行期热开关与客户端注册**

[src/integrations/onelink/sso.ts](../../../../src/integrations/onelink/sso.ts) · [src/admin/service.ts](../../../../src/admin/service.ts) · [src/admin/http.ts](../../../../src/admin/http.ts) · [src/plugin.ts](../../../../src/plugin.ts) · [docs/apis/admin.md](../../../apis/admin.md) · [docs/integrations/onelink-sso.md](../../../integrations/onelink-sso.md)

## onelink-auth-callback

**万联 OneLink 授权发起、AES-256-GCM 跳转、回调解析与待处理候选存储**

[src/integrations/onelink/sso.ts](../../../../src/integrations/onelink/sso.ts) · [src/auth/onelink-store.ts](../../../../src/auth/onelink-store.ts) · [src/auth/onelink.ts](../../../../src/auth/onelink.ts) · [src/auth/http.ts](../../../../src/auth/http.ts) · [docs/auth.md](../../../auth.md) · [docs/apis/auth.md](../../../apis/auth.md)

```mio-prd-results
{
  "version": 5,
  "prd": "docs/tasks/onelink-login/prd.md",
  "records": {
    "path": "docs/tasks/onelink-login/complete/records.json"
  }
}
```
