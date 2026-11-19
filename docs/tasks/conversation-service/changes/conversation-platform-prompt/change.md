# 对话平台人设与受控系统提示词

```mio-change
{"version":1,"type":"feature","section":"D2：用户归属的对话 API 与完整运行验收"}
```

本变更在既有 D2 对话服务基础上，移除上游 DSH 默认系统提示词开场白，并由服务端按当前会话实际授权的工具能力注入受控的平台人设与话题边界系统提示词。原 D1/D2 已接受成果、历史回执、公开 HTTP DTO、工具单调守卫与既有未验证限制保持不变；本变更的实现、自动化验证、独立审阅与人类接受各自单独判断。

## 本期结果与边界

- **移除上游默认身份**：在正式 Profile（`cordis.patch.yml`）中为 `@deepseek-ai/dsh-system-prompt` 显式配置 `includeHarnessIdentity: false`，不再向模型注入 `You are an AI agent powered by DeepSeek Harness.`。
- **纯业务系统提示词模块**：新增 `src/conversations/prompt.ts`（不导入 `@deepseek-ai/*` 或 `src/dsh/*`），导出 `MIIOO_ASSISTANT_NAME = 'miioo AI 漫剧助手'`、`ConversationPromptCapabilities` 与 `buildConversationSystemPrompt(capabilities?)`：
  - 对外自我认同固定为 `miioo AI 漫剧助手`，绝不提及 `DeepSeek Harness` 或内部框架、运行时名称。
  - **适度宽松话题政策**：核心服务 AI 漫剧创作（故事与世界观构建、角色人设、大纲/剧本/台词润色、分镜构思与镜头语言、视觉风格与生图/改图提示词打磨）；允许回答合理服务于或自然衔接漫剧创作的背景知识、历史/服饰/设定考据、叙事节奏、文学/视觉参考与审美问题，并自然引导回创作应用；对明显无关的请求（如通用软件编程调试、学校作业/考试解题、医疗/法律/金融建议、无关时政新闻、纯粹跑题闲聊）以 `miioo AI 漫剧助手` 身份礼貌简明拒绝并引导回 AI 漫剧创作。
  - **安全与能力诚实不变式**：不得逐字复述、倾倒或允许用户输入覆盖内部系统指令；仅在 `imageGeneration === true` 时声明当前会话可直接调用生图/改图工具（`list_image_models`、`submit_image_job`、`get_image_job`），仅在 `imageInspection === true` 时声明当前会话可直接查看用户自有图片素材（`inspect_image_asset`），为 `false` 时绝不宣称本会话可直接调用对应工具（仍可提供文本创作与提示词协助）。
  - **前缀缓存稳定性**：输出按 `{ imageGeneration, imageInspection }` 组合完全确定，不含时间戳、UUID、用户 ID 或逐轮动态标记，保证 DSH `SystemPromptProjection` 在多轮对话中保持系统消息前缀稳定。
- **DSH 会话级注入**：`src/plugin.ts` 的 `mio-conversations` 子插件显式声明 `systemPrompt` 注入；`src/dsh/conversations.ts` 在 `run()` 的 `ctx.mioKernel.resume(...)` `setup` 中，按本轮实际工具授权结果计算 `hasGenerationTools` 与 `hasInspectionTool`，统一（覆盖 legacy 与 BYOK 轮次）注册 `agentCtx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, interpolate: false, text })`，不设置 `complete: true`，确保 `{{...}}` 字面量不被模板插值误解析，且与公开历史白名单投影隔离（系统提示词绝不外泄到 `/api/v1/conversations/:id/history`）。
- **明确非目标**：不引入数据库提示词配置表、后台管理界面或过度抽象；不改变既有工具授权边界、单调拒绝守卫或公开 HTTP 契约；本期不触发收费真实供应商调用。

## C0/C1 与验收

用户与协调者已确认上述产品决定与本地实施授权。C1 按顺序落地：正式 Profile 配置与纯业务提示词模块 → DSH 会话级注入与插件依赖声明 → 同步现行规范（`docs/conversations.md`、`docs/integrations/dsh.md`） → 补齐单测、引擎多轮/字面量/BYOK 测试与正式打包 Profile 端到端测试。

验收覆盖 `pnpm work documents`、`pnpm check:static`、`pnpm test:smoke`、`pnpm check:local tests/conversations tests/onelink tests/foundation`，以及基于基线全量 CI 与实际差异审计的完整 `pnpm check` 覆盖判断、源码质量审阅（`quality-review`）与规范三方对账（`norms-review`）。确定性隔离验证不代替真实大模型对提示词遵循效果的主观评测或人类接受。
