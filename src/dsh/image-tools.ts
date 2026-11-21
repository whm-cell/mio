import { ApplicationError } from '@mio/foundation/errors';
import { sha256Utf8 } from '@mio/foundation/hash';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { IMAGE_DRIVERS } from '../generations/contracts.ts';
import type { ImageRequestParameters } from '../generations/contracts.ts';
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, isPlainJsonRecord, ToolArgsError } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ConversationImageJobOutput,
  ConversationImageJobView,
  ConversationImageToolName,
  ConversationImageTools,
  ConversationRun,
} from '../conversations/contracts.ts';

const CLIENT_OPERATION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const TOOL_IMAGE_OPERATIONS = ['generate', 'edit'] as const;
const IMAGE_JOB_STATES = new Set([
  'accepted',
  'submitted',
  'processing',
  'materializing',
  'completed',
  'partial',
  'materialization_failed',
  'rejected',
  'failed',
  'unknown',
]);
const NON_TERMINAL_IMAGE_JOB_STATES = new Set([
  'accepted',
  'submitted',
  'processing',
  'materializing',
]);

const LIST_MODELS_KEYS = new Set<string>();
const GET_JOB_KEYS = new Set(['jobId']);
const SUBMIT_JOB_KEYS = new Set([
  'modelRef',
  'prompt',
  'async',
  'operation',
  'imageAssetIds',
  'maskAssetId',
  'n',
  'size',
  'aspect_ratio',
  'quality',
  'background',
  'moderation',
  'output_format',
  'output_compression',
  'clientOperationKey',
]);

const imageJobViewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    requestedCount: { type: 'integer', required: true },
    errorCode: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      required: true,
    },
    assetIds: { type: 'array', items: { type: 'string' }, required: true },
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          assetId: { type: 'string', required: true },
        },
      },
      required: true,
    },
  },
} as const;

const imageModelSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    modelRef: { type: 'string', required: true },
    modelId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    vendor: { type: 'string', required: true },
    driver: { type: 'string', enum: IMAGE_DRIVERS, required: true },
    supportedOperations: {
      type: 'array',
      items: { type: 'string', enum: TOOL_IMAGE_OPERATIONS },
      required: true,
    },
    requiresAsync: { type: 'boolean', required: true },
    maxN: { type: 'integer', required: true },
    allowExplicitN: { type: 'boolean', required: true },
    allowedSizes: {
      oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
      required: true,
    },
    defaultSize: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      required: true,
    },
    allowCustomDimensions: { type: 'boolean', required: true },
    allowedAspectRatios: { type: 'array', items: { type: 'string' }, required: true },
    maxReferenceImages: { type: 'integer', required: true },
    allowGenerateReferences: { type: 'boolean', required: true },
    allowMaskPng: { type: 'boolean', required: true },
    allowedQualities: {
      type: 'array',
      items: { type: 'string', enum: ['high', 'medium', 'low', 'auto'] },
      required: true,
    },
    allowedBackgrounds: {
      type: 'array',
      items: { type: 'string', enum: ['transparent', 'opaque', 'auto'] },
      required: true,
    },
    allowedOutputFormats: {
      type: 'array',
      items: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      required: true,
    },
  },
} as const;

function closedParametersTool(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      additionalProperties: false,
    },
  };
}

function assertAllowedArguments(args: unknown, allowedKeys: ReadonlySet<string>): void {
  if (!isPlainJsonRecord(args)) {
    throw new ToolArgsError(['arguments must be a JSON object']);
  }
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      throw new ToolArgsError(['unexpected parameter']);
    }
  }
}

function toSanitizedToolError(error: unknown): never {
  if (error instanceof HarnessError) throw error;
  if (error instanceof ApplicationError) {
    throw new HarnessError(`MIO_IMAGE_TOOL_ERROR: ${error.code}`, error.code);
  }
  throw new HarnessError('MIO_IMAGE_TOOL_ERROR: IMAGE_UNAVAILABLE', 'IMAGE_UNAVAILABLE');
}

function sanitizeJobView(job: ConversationImageJobView) {
  return {
    jobId: job.jobId,
    status: job.status,
    requestedCount: job.requestedCount,
    errorCode: job.errorCode,
    assetIds: [...job.assetIds],
    outputs: job.outputs.map((item) => ({ index: item.index, assetId: item.assetId })),
  };
}

/** Deterministic lowercase UUID v4 derived from trusted turn identity and operation key. */
function deriveConversationImageRequestId(
  userId: string,
  conversationId: string,
  turnRequestId: string,
  operationKey: string,
): string {
  const hex = sha256Utf8(
    `mio:conv-image:v1:${userId}:${conversationId}:${turnRequestId}:${operationKey}`,
  );
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** Strict whitelist validation before projecting persisted/live tool metadata outside DSH. */
export function parseImageJobPresentationMeta(
  meta: unknown,
): { tool: ConversationImageToolName; job: ConversationImageJobView } | null {
  if (!isPlainJsonRecord(meta) || Object.keys(meta).length !== 3) return null;
  if (meta.kind !== 'mio.image-job') return null;
  if (meta.tool !== 'submit_image_job' && meta.tool !== 'get_image_job') return null;
  const rawJob = meta.job;
  if (!isPlainJsonRecord(rawJob) || Object.keys(rawJob).length !== 6) return null;
  if (typeof rawJob.jobId !== 'string' || !isUuidV4(rawJob.jobId)) return null;
  if (typeof rawJob.status !== 'string' || !IMAGE_JOB_STATES.has(rawJob.status)) return null;
  if (
    typeof rawJob.requestedCount !== 'number' ||
    !Number.isInteger(rawJob.requestedCount) ||
    rawJob.requestedCount < 1 ||
    rawJob.requestedCount > 16
  ) {
    return null;
  }
  if (
    rawJob.errorCode !== null &&
    (typeof rawJob.errorCode !== 'string' || !ERROR_CODE_PATTERN.test(rawJob.errorCode))
  ) {
    return null;
  }
  if (
    !Array.isArray(rawJob.assetIds) ||
    rawJob.assetIds.length > 16 ||
    !rawJob.assetIds.every((id): id is string => typeof id === 'string' && isUuidV4(id))
  ) {
    return null;
  }
  if (!Array.isArray(rawJob.outputs) || rawJob.outputs.length !== rawJob.assetIds.length) {
    return null;
  }
  const outputs: ConversationImageJobOutput[] = [];
  let prevIndex = -1;
  for (const item of rawJob.outputs) {
    if (
      !isPlainJsonRecord(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.index !== 'number' ||
      !Number.isInteger(item.index) ||
      item.index <= prevIndex ||
      item.index > 15 ||
      typeof item.assetId !== 'string' ||
      !isUuidV4(item.assetId) ||
      item.assetId !== rawJob.assetIds[outputs.length]
    ) {
      return null;
    }
    prevIndex = item.index;
    outputs.push({ index: item.index, assetId: item.assetId });
  }
  return {
    tool: meta.tool,
    job: {
      jobId: rawJob.jobId,
      status: rawJob.status,
      requestedCount: rawJob.requestedCount,
      errorCode: rawJob.errorCode,
      assetIds: [...rawJob.assetIds],
      outputs,
    },
  };
}

/** Register the three intent-level image tools strictly on the live conversation Agent scope. */
export function registerConversationImageTools(
  agentCtx: Context,
  run: ConversationRun,
  bridge: ConversationImageTools,
): void {
  const actor = Object.freeze({ userId: run.userId });
  const submittedPendingJobIds = new Set<string>();
  const polledPendingJobIds = new Set<string>();
  // get_image_job allows parallel calls across distinct jobIds, so serialize same-jobId checks within a step.
  const inFlightPollByJobId = new Map<string, Promise<void>>();

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'list_image_models',
        description:
          'List runnable image generation/editing models in the current user catalog with their route capability constraints.',
        parameters: {},
        isConcurrencySafe: (args) =>
          isPlainJsonRecord(args) && Object.keys(args).every((key) => LIST_MODELS_KEYS.has(key)),
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              models: {
                type: 'array',
                items: imageModelSummarySchema,
                required: true,
              },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, LIST_MODELS_KEYS);
          exec.signal.throwIfAborted();
          try {
            const models = await bridge.listModels(actor);
            return {
              models: models.map((model) => ({
                ...model,
                supportedOperations: TOOL_IMAGE_OPERATIONS.filter((operation) =>
                  model.supportedOperations.includes(operation),
                ),
              })),
            };
          } catch (error) {
            return toSanitizedToolError(error);
          }
        },
      }),
    ),
  );

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'submit_image_job',
        description:
          'Submit an intent-level image generation or reference-image edit job for the current user. The job runs asynchronously in the background and returns a Mio job handle immediately; once you receive the jobId, report the jobId and current status to the user and finish this turn immediately. NEVER call get_image_job to poll or wait for completion in the same turn.',
        parameters: {
          modelRef: {
            type: 'string',
            required: true,
            description: 'Stable modelRef from list_image_models.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: 'Image generation or editing prompt.',
          },
          async: {
            type: 'boolean',
            description:
              'Optional async flag; automatically set to true when the selected route requires async.',
          },
          operation: {
            type: 'string',
            enum: TOOL_IMAGE_OPERATIONS,
            description: 'Optional generate or edit mode supported by the selected model route.',
          },
          imageAssetIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered owner-scoped input/reference image asset UUIDs.',
          },
          maskAssetId: {
            type: 'string',
            description: 'Optional owner-scoped PNG mask asset UUID when allowMaskPng is true.',
          },
          n: {
            type: 'integer',
            description: 'Number of output images within the model route maxN.',
          },
          size: {
            type: 'string',
            description: 'Requested resolution or dimensions allowed by the model route.',
          },
          aspect_ratio: {
            type: 'string',
            description:
              'Requested aspect ratio allowed by the route. For OpenAI image editing, use size.',
          },
          quality: {
            type: 'string',
            enum: ['high', 'medium', 'low', 'auto'],
          },
          background: {
            type: 'string',
            enum: ['transparent', 'opaque', 'auto'],
          },
          moderation: {
            type: 'string',
            enum: ['low', 'auto'],
          },
          output_format: {
            type: 'string',
            enum: ['png', 'jpeg', 'webp'],
          },
          output_compression: {
            type: 'integer',
          },
          clientOperationKey: {
            type: 'string',
            description:
              'Optional idempotency key (1..64 alphanumeric/underscore/hyphen characters) within this turn.',
          },
        },
        output: {
          schema: imageJobViewSchema,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          presentationMeta: (_args, value) => ({
            kind: 'mio.image-job',
            tool: 'submit_image_job',
            job: value,
          }),
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, SUBMIT_JOB_KEYS);
          if (!args.modelRef || Buffer.byteLength(args.modelRef, 'utf8') > 512) {
            throw new HarnessError(
              'MIO_IMAGE_TOOL_ERROR: IMAGE_INPUT_INVALID',
              'IMAGE_INPUT_INVALID',
            );
          }
          if (!args.prompt.trim() || args.prompt.length > 32_000) {
            throw new HarnessError(
              'MIO_IMAGE_TOOL_ERROR: IMAGE_INPUT_INVALID',
              'IMAGE_INPUT_INVALID',
            );
          }
          if (
            args.clientOperationKey !== undefined &&
            !CLIENT_OPERATION_KEY_PATTERN.test(args.clientOperationKey)
          ) {
            throw new HarnessError(
              'MIO_IMAGE_TOOL_ERROR: IMAGE_INPUT_INVALID',
              'IMAGE_INPUT_INVALID',
            );
          }
          if (
            args.imageAssetIds !== undefined &&
            (args.imageAssetIds.length < 1 || args.imageAssetIds.length > 16)
          ) {
            throw new HarnessError(
              'MIO_IMAGE_TOOL_ERROR: IMAGE_INPUT_INVALID',
              'IMAGE_INPUT_INVALID',
            );
          }
          exec.signal.throwIfAborted();
          try {
            const parameters: ImageRequestParameters = {
              prompt: args.prompt,
              ...(args.async !== undefined ? { async: args.async } : {}),
              ...(args.operation !== undefined ? { operation: args.operation } : {}),
              ...(args.imageAssetIds !== undefined
                ? { imageAssetIds: [...args.imageAssetIds] }
                : {}),
              ...(args.maskAssetId !== undefined ? { maskAssetId: args.maskAssetId } : {}),
              ...(args.n !== undefined ? { n: args.n } : {}),
              ...(args.size !== undefined ? { size: args.size } : {}),
              ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
              ...(args.quality !== undefined ? { quality: args.quality } : {}),
              ...(args.background !== undefined ? { background: args.background } : {}),
              ...(args.moderation !== undefined ? { moderation: args.moderation } : {}),
              ...(args.output_format !== undefined ? { output_format: args.output_format } : {}),
              ...(args.output_compression !== undefined
                ? { output_compression: args.output_compression }
                : {}),
            };
            const requestId = deriveConversationImageRequestId(
              run.userId,
              run.conversationId,
              run.requestId,
              args.clientOperationKey ?? exec.callId,
            );
            const job = await bridge.createImage(
              actor,
              requestId,
              args.modelRef,
              parameters,
              exec.signal,
            );
            if (NON_TERMINAL_IMAGE_JOB_STATES.has(job.status)) {
              submittedPendingJobIds.add(job.jobId);
            } else {
              submittedPendingJobIds.delete(job.jobId);
            }
            return sanitizeJobView(job);
          } catch (error) {
            return toSanitizedToolError(error);
          }
        },
      }),
    ),
  );

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'get_image_job',
        description:
          'Query the current status and completed output asset IDs of an owner-scoped Mio image job created in a previous turn. NEVER busy-poll in the same turn: if it returns a non-terminal status (accepted, submitted, processing, materializing), tell the user the job is still generating and finish this turn immediately without calling get_image_job again.',
        parameters: {
          jobId: {
            type: 'string',
            required: true,
            description: 'Mio image job UUID v4 returned by submit_image_job.',
          },
        },
        isConcurrencySafe: (args) =>
          isPlainJsonRecord(args) && Object.keys(args).every((key) => GET_JOB_KEYS.has(key)),
        output: {
          schema: imageJobViewSchema,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          presentationMeta: (_args, value) => ({
            kind: 'mio.image-job',
            tool: 'get_image_job',
            job: value,
          }),
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, GET_JOB_KEYS);
          if (!isUuidV4(args.jobId)) {
            throw new HarnessError(
              'MIO_IMAGE_TOOL_ERROR: IMAGE_JOB_ID_INVALID',
              'IMAGE_JOB_ID_INVALID',
            );
          }
          exec.signal.throwIfAborted();
          while (inFlightPollByJobId.has(args.jobId)) {
            await inFlightPollByJobId.get(args.jobId);
            exec.signal.throwIfAborted();
          }
          if (submittedPendingJobIds.has(args.jobId) || polledPendingJobIds.has(args.jobId)) {
            throw new HarnessError(
              'MIO_IMAGE_TOOL_ERROR: IMAGE_JOB_POLL_DEFERRED: image job runs asynchronously in the background; do not poll get_image_job in the same turn. Report the jobId to the user and finish this turn.',
              'IMAGE_JOB_POLL_DEFERRED',
            );
          }
          let releaseInFlight!: () => void;
          const inFlight = new Promise<void>((resolve) => {
            releaseInFlight = resolve;
          });
          inFlightPollByJobId.set(args.jobId, inFlight);
          try {
            const job = await bridge.getImage(actor, args.jobId);
            if (NON_TERMINAL_IMAGE_JOB_STATES.has(job.status)) {
              polledPendingJobIds.add(job.jobId);
            }
            return sanitizeJobView(job);
          } catch (error) {
            return toSanitizedToolError(error);
          } finally {
            inFlightPollByJobId.delete(args.jobId);
            releaseInFlight();
          }
        },
      }),
    ),
  );
}
