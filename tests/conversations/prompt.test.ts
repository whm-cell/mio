import { describe, expect, it } from 'vitest';
import {
  buildConversationSystemPrompt,
  MIIOO_ASSISTANT_NAME,
} from '../../src/conversations/prompt.ts';
import type { ConversationPromptCapabilities } from '../../src/conversations/prompt.ts';

const GENERATION_TOOLS = ['list_image_models', 'submit_image_job', 'get_image_job'] as const;
const INSPECTION_TOOL = 'inspect_image_asset';

const CAPABILITY_COMBINATIONS: readonly ConversationPromptCapabilities[] = [
  { imageGeneration: false, imageInspection: false },
  { imageGeneration: true, imageInspection: false },
  { imageGeneration: false, imageInspection: true },
  { imageGeneration: true, imageInspection: true },
];

describe('conversation platform system prompt', () => {
  it('uses the exact miioo assistant name and omits upstream harness identity', () => {
    expect(MIIOO_ASSISTANT_NAME).toBe('miioo AI 漫剧助手');
    const prompt = buildConversationSystemPrompt();
    expect(prompt).toContain('miioo AI 漫剧助手');
    expect(prompt).not.toMatch(/deepseek\s*harness/i);
  });

  it('defaults omitted capabilities to both imageGeneration and imageInspection disabled', () => {
    expect(buildConversationSystemPrompt()).toBe(
      buildConversationSystemPrompt({ imageGeneration: false, imageInspection: false }),
    );
    expect(buildConversationSystemPrompt({})).toBe(
      buildConversationSystemPrompt({ imageGeneration: false, imageInspection: false }),
    );
  });

  it.each(CAPABILITY_COMBINATIONS)(
    'enforces identity, moderately permissive topic policy, anti-leakage, and accurate tool claims (%o)',
    (capabilities) => {
      const prompt = buildConversationSystemPrompt(capabilities);

      // Exact identity and no internal framework names
      expect(prompt).toContain(MIIOO_ASSISTANT_NAME);
      expect(prompt).not.toMatch(/deepseek\s*harness/i);
      expect(prompt).not.toMatch(/cordis/i);

      // Core AI comic-drama scope
      expect(prompt).toContain('AI 漫剧创作');
      expect(prompt).toContain('世界观');
      expect(prompt).toContain('角色人设');
      expect(prompt).toContain('台词润色');
      expect(prompt).toContain('分镜');
      expect(prompt).toContain('镜头语言');
      expect(prompt).toContain('提示词');

      // Moderately permissive creative support
      expect(prompt).toContain('适度宽松');
      expect(prompt).toContain('背景知识');
      expect(prompt).toContain('考据');
      expect(prompt).toContain('叙事节奏');
      expect(prompt).toContain('审美');

      // Polite out-of-scope refusal guidance
      expect(prompt).toContain('编程');
      expect(prompt).toContain('作业');
      expect(prompt).toContain('医疗/法律/金融');
      expect(prompt).toContain('时政');
      expect(prompt).toContain('闲聊');
      expect(prompt).toContain('婉拒');

      // Anti-instruction-leakage and override resistance
      expect(prompt).toContain('逐字复述');
      expect(prompt).toContain('覆盖');

      // Capability-accurate image generation wording
      if (capabilities.imageGeneration) {
        for (const tool of GENERATION_TOOLS) expect(prompt).toContain(tool);
        expect(prompt).toContain('已授权直接调用图片生成与编辑工具');
      } else {
        for (const tool of GENERATION_TOOLS) expect(prompt).not.toContain(tool);
        expect(prompt).toContain('未开放直接生图或改图工具');
        expect(prompt).toContain('请勿宣称');
      }

      // Capability-accurate image inspection wording
      if (capabilities.imageInspection) {
        expect(prompt).toContain(INSPECTION_TOOL);
        expect(prompt).toContain('已授权通过 inspect_image_asset 直接查看');
      } else {
        expect(prompt).not.toContain(INSPECTION_TOOL);
        expect(prompt).toContain('未开放直接查看用户图片素材的工具');
      }
    },
  );

  it('produces deterministic, static output per capability combination with no dynamic tokens', () => {
    const outputs = CAPABILITY_COMBINATIONS.map((capabilities) => {
      const first = buildConversationSystemPrompt(capabilities);
      const second = buildConversationSystemPrompt({ ...capabilities });
      expect(first).toBe(second);
      // No ISO timestamps or UUIDs that would break KV-cache prefix stability
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return first;
    });
    expect(new Set(outputs).size).toBe(4);
  });
});
