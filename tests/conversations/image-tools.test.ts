import { ApplicationError } from '@mio/foundation/errors';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { expect, it, vi } from 'vitest';
import type {
  ConversationImageJobView,
  ConversationImageTools,
  ConversationRun,
} from '../../src/conversations/contracts.ts';
import { registerConversationImageTools } from '../../src/dsh/image-tools.ts';

const run: ConversationRun = {
  userId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
  dshSessionId: 'session-1',
  requestId: 'turn-1',
  snapshot: {} as ConversationRun['snapshot'],
  observe: async () => {},
};

function fixture() {
  const job: ConversationImageJobView = {
    jobId: '00000000-0000-4000-8000-000000000003',
    status: 'accepted',
    requestedCount: 1,
    errorCode: null,
    assetIds: [],
    outputs: [],
  };
  const createImage = vi.fn<ConversationImageTools['createImage']>().mockResolvedValue(job);
  const listModels = vi.fn<ConversationImageTools['listModels']>().mockResolvedValue([]);
  const definitions = new Map<string, ToolDefinition>();
  const context = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition);
      },
    },
  } as unknown as Context;
  registerConversationImageTools(context, run, {
    listModels,
    createImage,
    getImage: async () => job,
  });
  return { definitions, createImage, listModels };
}

function execution(callId: string): Parameters<ToolDefinition['execute']>[1] {
  return { callId, signal: new AbortController().signal } as Parameters<
    ToolDefinition['execute']
  >[1];
}

it('preserves historical image request IDs for call identity and explicit operation identity', async () => {
  const { definitions, createImage } = fixture();
  const submit = definitions.get('submit_image_job')!;
  const args = { modelRef: 'onelink:model:fixture', prompt: 'A landscape.' };
  await submit.execute(args, execution('call-1'));
  await submit.execute({ ...args, clientOperationKey: 'stable-edit' }, execution('call-2'));
  await submit.execute({ ...args, clientOperationKey: 'stable-edit' }, execution('call-3'));
  expect(createImage.mock.calls.map(([, requestId]) => requestId)).toEqual([
    'f2352c1d-fe83-4f57-9bdb-3d7a9b60c464',
    '819ba618-1087-461c-b9f4-60cc9dd5cfef',
    '819ba618-1087-461c-b9f4-60cc9dd5cfef',
  ]);
  expect(createImage.mock.calls.map(([actor]) => actor)).toEqual(
    Array(3).fill({ userId: run.userId }),
  );
});

it('keeps image errors at the established public code boundary', async () => {
  const { definitions, listModels } = fixture();
  const list = definitions.get('list_image_models')!;
  listModels.mockRejectedValueOnce(new Error('internal provider detail'));
  await expect(list.execute({}, execution('call-1'))).rejects.toMatchObject({
    code: 'IMAGE_UNAVAILABLE',
    message: 'MIO_IMAGE_TOOL_ERROR: IMAGE_UNAVAILABLE',
  });
  listModels.mockRejectedValueOnce(new ApplicationError('IMAGE_INPUT_INVALID', 'private detail'));
  await expect(list.execute({}, execution('call-2'))).rejects.toMatchObject({
    code: 'IMAGE_INPUT_INVALID',
    message: 'MIO_IMAGE_TOOL_ERROR: IMAGE_INPUT_INVALID',
  });
});
