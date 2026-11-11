# 已接受开发成果

PRD：[当前需求](../prd.md)。完成范围、接受结论、验证摘要与限制见[成果记录](records.json)，也可用 work read-result 按成果键读取。这里只导航已接受结果，不表示整份 PRD、当前源码或生产验收完成；不保存可恢复代码或详细证据。

## compute-jobs

**A 侧计算任务与可靠投递、结果登记**

[src/compute/service.ts](../../../../src/compute/service.ts) · [src/compute/store.ts](../../../../src/compute/store.ts) · [docs/apis/compute.md](../../../apis/compute.md)

## compute-local-artifacts

**A/B 仓库外独立运行产物与迁移**

[scripts/service/build.ts](../../../../scripts/service/build.ts) · [scripts/service/prepare-profile.ts](../../../../scripts/service/prepare-profile.ts) · [docs/tasks/compute-service/design.md](../design.md)

## compute-worker

**可恢复的独立视频转码 Worker**

[docs/tasks/compute-service/design.md](../design.md) · [docs/tasks/compute-service/protocol.md](../protocol.md) · [docs/tasks/compute-service/prd.md](../prd.md)

## private-user-assets

**登录用户私有视频资产与 COS 直传**

[src/assets/service.ts](../../../../src/assets/service.ts) · [src/assets/http.ts](../../../../src/assets/http.ts) · [docs/apis/assets.md](../../../apis/assets.md)

```mio-prd-results
{
  "version": 5,
  "prd": "docs/tasks/compute-service/prd.md",
  "records": {
    "path": "docs/tasks/compute-service/complete/records.json",
    "sha256": "fe91c74e0fbe3e5248adb25c53fe73be3a15a174db23f4e8c3584074c044ac9a"
  }
}
```
