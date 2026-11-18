# 生图工具防同轮忙轮询与 Seedream 4.5 路由能力校准

```mio-change
{"version":1,"type":"fix","section":"1.1 O7 已采纳契约与本期开发单元"}
```

本轻量变更在已接受的 Unit 1（[已有成果](../../complete/report.md)）与原厂路由目录（[原厂路由成果](../../../onelink-vendor-routing/complete/report.md)）基线上，修复两项实证偏差：校准 `doubao-seedream-4.5` 路由输出格式能力声明（固定输出 `jpeg`、不支持 `output_format`），以及在单轮 `agentCtx.tools` 作用域硬拦截对未完成生图任务的同轮／重复忙轮询（`IMAGE_JOB_POLL_DEFERRED`）。既有已接受成果与限制保持独立，新候选须重新验证并取得人类接受。

## 本期范围与设计边界

### 1. `doubao-seedream-4.5` 路由能力校准

1. **测试夹具与契约对齐**：更新 [万联路由夹具](../../../../../tests/providers/fixtures/onelink-routes-fixture.ts) 中 `doubao-seedream-4.5`（`image.generate`）声明：`allowedOutputFormats: []`、`outputSpec: { fixedOutputFormat: 'jpeg' }`、`sourceKind: 'runtime-observation'`、`source: 'docs/tasks/onelink-image-generation/complete/report.md'`。严格保持 `doubao-seedream-5.0-lite` 的 `allowedOutputFormats: ['jpeg', 'png']` 不变。
2. **需求文档修正**：修正 [万联原厂路由 PRD](../../../onelink-vendor-routing/prd.md#13-同厂商内部端点与参数分化要求数据库存规格--代码写纯原厂驱动) 对 Seedream 4.5 与 `5.0*` 的合并表述，明确 `doubao-seedream-4.5` 固定输出 `jpeg`（不支持 `output_format`），`doubao-seedream-5.0*` 支持 `png`/`jpeg`。
3. **常驻开发库同步**：通过受控 `pnpm providers:route --stdin`（[路由导入脚本](../../../../../scripts/service/import-provider-route.ts)）更新常驻 `mio_dev` 的 `public.mio_provider_model_routes`，并核对 `doubao-seedream-4.0` 为 `[]`、`doubao-seedream-4.5` 为 `allowedOutputFormats: []` 且 `fixedOutputFormat: "jpeg"`、`doubao-seedream-5.0-lite` 仍为 `["jpeg", "png"]`。

### 2. 对话生图工具同轮防忙轮询（`DESIGN-OVER-001`）

1. **公开契约零漂移**：保持 `imageJobViewSchema`、`presentationMeta`（`kind: 'mio.image-job'`）及 `output.render` 纯 `JSON.stringify(value)` 不变；不修改单轮 12 次总调用、4 次图片提交及 `MAX_TURN_STEPS = 8` 硬熔断预算。
2. **工具英文提示与单轮闭包硬拦截**：更新 [生图工具适配](../../../../../src/dsh/image-tools.ts) 中 `submit_image_job` 与 `get_image_job` 的英文 `description`，明确后台异步执行、拿到 `jobId` 后立即回报用户并结束当前轮次、禁止同轮轮询。在 `registerConversationImageTools` 单轮闭包维护 `NON_TERMINAL_IMAGE_JOB_STATES = new Set(['accepted', 'submitted', 'processing', 'materializing'])`、`submittedPendingJobIds` 与 `polledPendingJobIds`（及按 `jobId` 对同批并发 `get_image_job` 排队核对以防 `isConcurrencySafe` 并发绕过单轮集合检查）：
   - `submit_image_job` 创建返回非终态任务时将 `job.jobId` 记入 `submittedPendingJobIds`；
   - `get_image_job` 校验参数与 `isUuidV4(args.jobId)` 后，若命中 `submittedPendingJobIds` 或 `polledPendingJobIds`，立即抛 `HarnessError('MIO_IMAGE_TOOL_ERROR: IMAGE_JOB_POLL_DEFERRED: image job runs asynchronously in the background; do not poll get_image_job in the same turn. Report the jobId to the user and finish this turn.', 'IMAGE_JOB_POLL_DEFERRED')`；否则调用 `bridge.getImage`，若返回非终态则记入 `polledPendingJobIds` 并正常返回 `sanitizeJobView(job)`。
   - 失败的 `get_image_job` 不产生 `mio.image-job` 卡片进入 SSE 或 `GET /history`；跨轮对前序 `jobId` 的首次查询正常放行。

## 规范同步与验证

同步更新[本地对话服务规范](../../../../conversations.md)与[DSH 对话内核接入规范](../../../../integrations/dsh.md)，并在[对话生图端到端回归](../../../../../tests/conversations/conversation-image-tools.test.ts)移除 `call_ref_seed45` 中失真的 `output_format: 'png'`，补充 `doubao-seedream-4.5` 传 `output_format: 'png'` 本地准入拒收（`IMAGE_INPUT_INVALID` 且 `0` 上游 POST）、同轮 `submit_image_job -> get_image_job` 拦截与正常 `completed` 收尾、以及跨轮首查成功而同轮二次重复轮询拦截的隔离回归。

隔离验证与受影响检查、独立审查、`quality-review`、v2 `norms-review` 与真实人类接受分别判定；本变更卡登记不代表自动获得人类接受。
