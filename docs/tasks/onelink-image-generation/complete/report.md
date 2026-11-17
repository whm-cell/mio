# 已接受开发成果

PRD：[当前需求](../prd.md)。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。

## async-image-slice

**异步图片提交、查询与重启恢复**

[src/compute/service.ts](../../../../src/compute/service.ts) · [src/compute/store.ts](../../../../src/compute/store.ts) · [src/providers/catalog.ts](../../../../src/providers/catalog.ts) · [tests/compute/live-image-loop.ts](../../../../tests/compute/live-image-loop.ts) · [docs/tasks/compute-service/protocol.md](../../compute-service/protocol.md) · [docs/apis/compute.md](../../../apis/compute.md) · [docs/integrations/onelink.md](../../../integrations/onelink.md)

## kling-async-image-slice

**OneLink Kling 异步文生图（kling-image-v1）提交、有界查询与重启恢复**

[src/compute/service.ts](../../../../src/compute/service.ts) · [src/providers/catalog.ts](../../../../src/providers/catalog.ts) · [src/providers/schema.ts](../../../../src/providers/schema.ts) · [tests/compute/images-http.test.ts](../../../../tests/compute/images-http.test.ts) · [tests/compute/live-image-loop.ts](../../../../tests/compute/live-image-loop.ts) · [tests/compute/live-image-audit.ts](../../../../tests/compute/live-image-audit.ts) · [docs/integrations/onelink.md](../../../integrations/onelink.md) · [docs/apis/compute.md](../../../apis/compute.md) · [docs/apis/providers.md](../../../apis/providers.md) · [docs/tasks/compute-service/protocol.md](../../compute-service/protocol.md)

## reference-outpaint-slice

**OneLink GPT 多参考输入与 capability-gated outpaint**

[docs/apis/compute.md](../../../apis/compute.md) · [docs/apis/providers.md](../../../apis/providers.md) · [docs/providers.md](../../../providers.md) · [docs/tasks/onelink-image-generation/prd.md](../prd.md) · [docs/tasks/onelink-image-generation/design.md](../design.md) · [docs/tasks/compute-service/protocol.md](../../compute-service/protocol.md)

## seedream-sync-slice

**Seedream 4.0 真实同步生图闭环与场景化图片 Live 验收入口**

[src/compute/service.ts](../../../../src/compute/service.ts) · [src/providers/catalog.ts](../../../../src/providers/catalog.ts) · [tests/compute/live-image-audit.ts](../../../../tests/compute/live-image-audit.ts) · [tests/compute/live-image-loop.ts](../../../../tests/compute/live-image-loop.ts) · [docs/tasks/onelink-image-generation/prd.md](../prd.md) · [docs/apis/compute.md](../../../apis/compute.md) · [docs/integrations/onelink.md](../../../integrations/onelink.md)

```mio-prd-results
{
  "version": 5,
  "prd": "docs/tasks/onelink-image-generation/prd.md",
  "records": {
    "path": "docs/tasks/onelink-image-generation/complete/records.json"
  }
}
```
