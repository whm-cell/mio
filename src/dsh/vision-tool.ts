import type { Context } from '@deepseek-ai/cordis';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, isPlainJsonRecord, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { AssetError } from '../assets/contracts.ts';
import { ConversationError } from '../conversations/contracts.ts';
import type {
  ConversationImageReference,
  ConversationRun,
  ConversationVision,
} from '../conversations/contracts.ts';

/** Grant is owned by the live turn; the caller cannot choose its principal. */
export function registerVisionTool(
  ctx: Context,
  run: ConversationRun,
  vision: ConversationVision,
): void {
  const tool = defineTool({
    name: 'inspect_image_asset',
    description: 'Inspect a ready image asset owned by the current user.',
    parameters: {
      assetId: { type: 'string', required: true, description: 'Mio image asset UUID v4.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assetId: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: {
                type: 'string',
                enum: ['image/png', 'image/jpeg', 'image/webp'],
                required: true,
              },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as { assetId: string; image: ConversationImageReference };
        return [
          { type: 'text', text: `Image asset ${result.assetId}.` },
          {
            type: 'image',
            attachment: { ...result.image, attachmentId: AttachmentId(result.image.attachmentId) },
          },
        ];
      },
    },
    execute: async (args, exec) => {
      if (!isPlainJsonRecord(args) || Object.keys(args).some((key) => key !== 'assetId'))
        throw new ToolArgsError(['unexpected parameter']);
      if (typeof args.assetId !== 'string' || !isUuidV4(args.assetId))
        throw new HarnessError('Invalid image asset ID', 'IMAGE_INPUT_INVALID');
      exec.signal.throwIfAborted();
      try {
        const image = await vision.prepare(run.userId, args.assetId, exec.signal);
        exec.signal.throwIfAborted();
        return { assetId: args.assetId, image };
      } catch (error) {
        exec.signal.throwIfAborted();
        if (error instanceof AssetError || error instanceof ConversationError)
          throw new HarnessError(`Image asset is unavailable: ${error.code}`, error.code);
        throw new HarnessError('Image asset is unavailable', 'IMAGE_UNAVAILABLE');
      }
    },
  });
  ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } });
}
