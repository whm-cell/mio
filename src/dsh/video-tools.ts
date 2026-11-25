import { ApplicationError } from '@mio/foundation/errors';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, isPlainJsonRecord } from '@deepseek-ai/dsh-tools';
import {
  VIDEO_JOB_STATES,
  VIDEO_MAX_PROMPT_CODEPOINTS,
  VIDEO_MODES,
} from '../generations/video-contracts.ts';
import type { VideoJobView } from '../generations/video-contracts.ts';
import type {
  ConversationRun,
  ConversationVideoJobOutput,
  ConversationVideoJobView,
  ConversationVideoModelSummary,
  ConversationVideoToolName,
  ConversationVideoTools,
} from '../conversations/contracts.ts';
import {
  assertAllowedArguments,
  closedParametersTool,
  deriveMediaToolRequestId,
  hasAllowedArguments,
  sanitizedMediaToolError,
} from './media-tool-helpers.ts';

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const NON_TERMINAL_STATES = new Set(['accepted', 'submitted', 'processing', 'materializing']);
const LIST_KEYS = new Set<string>();
const GET_KEYS = new Set(['jobId']);
const SUBMIT_KEYS = new Set([
  'modelRef',
  'prompt',
  'ratio',
  'resolution',
  'durationSeconds',
  'generateAudio',
  'watermark',
]);

const modelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    modelRef: { type: 'string', required: true },
    modelId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    vendor: { type: 'string', required: true },
    available: { type: 'boolean', required: true },
    unavailableReason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    supportedModes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          supported: { type: 'boolean', required: true },
        },
      },
      required: true,
    },
  },
} as const;

const videoJobSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    status: { type: 'string', enum: VIDEO_JOB_STATES, required: true },
    mode: { type: 'string', required: true },
    modelRef: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    errorCode: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          assetId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          status: { type: 'string', required: true },
          errorCode: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          width: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          height: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          durationSeconds: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          hasAudio: { oneOf: [{ type: 'boolean' }, { type: 'null' }], required: true },
        },
      },
      required: true,
    },
  },
} as const;

function codepointCount(value: string): number {
  let count = 0;
  for (let offset = 0; offset < value.length; count++) {
    offset += value.codePointAt(offset)! > 0xffff ? 2 : 1;
  }
  return count;
}

function sanitizeVideoJob(job: VideoJobView): ConversationVideoJobView {
  return {
    jobId: job.id,
    status: job.state,
    mode: job.mode,
    modelRef: job.modelRef,
    createdAt: job.createdAt,
    errorCode: job.error?.code ?? null,
    outputs: job.outputs.map((output) => ({
      index: output.index,
      assetId: output.assetId,
      status: output.status,
      errorCode: output.errorCode,
      width: output.width,
      height: output.height,
      durationSeconds: output.durationSeconds,
      hasAudio: output.hasAudio,
    })),
  };
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/** Validate the compact public card before exposing persisted DSH metadata. */
export function parseVideoJobPresentationMeta(
  meta: unknown,
): { tool: ConversationVideoToolName; job: ConversationVideoJobView } | null {
  if (!isPlainJsonRecord(meta) || Object.keys(meta).length !== 3 || meta.kind !== 'mio.video-job')
    return null;
  if (meta.tool !== 'submit_video_job' && meta.tool !== 'get_video_job') return null;
  const raw = meta.job;
  if (
    !isPlainJsonRecord(raw) ||
    Object.keys(raw).length !== 7 ||
    typeof raw.jobId !== 'string' ||
    !isUuidV4(raw.jobId) ||
    typeof raw.status !== 'string' ||
    !VIDEO_JOB_STATES.some((state) => state === raw.status) ||
    typeof raw.mode !== 'string' ||
    !VIDEO_MODES.some((mode) => mode === raw.mode) ||
    typeof raw.modelRef !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    (raw.errorCode !== null &&
      (typeof raw.errorCode !== 'string' || !ERROR_CODE_PATTERN.test(raw.errorCode))) ||
    !Array.isArray(raw.outputs) ||
    raw.outputs.length > 16
  )
    return null;
  const outputs: ConversationVideoJobOutput[] = [];
  for (const output of raw.outputs) {
    if (
      !isPlainJsonRecord(output) ||
      Object.keys(output).length !== 8 ||
      typeof output.index !== 'number' ||
      !Number.isInteger(output.index) ||
      output.index < 0 ||
      output.index > 15 ||
      (output.assetId !== null &&
        (typeof output.assetId !== 'string' || !isUuidV4(output.assetId))) ||
      typeof output.status !== 'string' ||
      (output.errorCode !== null &&
        (typeof output.errorCode !== 'string' || !ERROR_CODE_PATTERN.test(output.errorCode))) ||
      (output.width !== null &&
        (typeof output.width !== 'number' ||
          !Number.isSafeInteger(output.width) ||
          output.width < 1)) ||
      (output.height !== null &&
        (typeof output.height !== 'number' ||
          !Number.isSafeInteger(output.height) ||
          output.height < 1)) ||
      !isNullableNumber(output.durationSeconds) ||
      (output.hasAudio !== null && typeof output.hasAudio !== 'boolean')
    )
      return null;
    outputs.push({
      index: output.index,
      assetId: output.assetId,
      status: output.status,
      errorCode: output.errorCode,
      width: output.width,
      height: output.height,
      durationSeconds: output.durationSeconds,
      hasAudio: output.hasAudio,
    });
  }
  return {
    tool: meta.tool,
    job: {
      jobId: raw.jobId,
      status: raw.status as ConversationVideoJobView['status'],
      mode: raw.mode as ConversationVideoJobView['mode'],
      modelRef: raw.modelRef,
      createdAt: raw.createdAt,
      errorCode: raw.errorCode,
      outputs,
    },
  };
}

export function registerConversationVideoTools(
  agentCtx: Context,
  run: ConversationRun,
  bridge: ConversationVideoTools,
): void {
  const actor = Object.freeze({ userId: run.userId });
  const submittedPendingJobs = new Set<string>();
  const polledPendingJobs = new Set<string>();
  const inFlightPollByJobId = new Map<string, Promise<void>>();

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'list_video_models',
        description:
          'List the current user video models and exact runnable modes. Only models reported available may be submitted; never infer support from a model name.',
        parameters: {},
        isConcurrencySafe: (args) => hasAllowedArguments(args, LIST_KEYS),
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              models: { type: 'array', items: modelSchema, required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, LIST_KEYS);
          exec.signal.throwIfAborted();
          try {
            const models = await bridge.listModels(actor);
            return {
              models: models.map((model: ConversationVideoModelSummary) => ({
                ...model,
                supportedModes: model.supportedModes
                  .filter(
                    (entry) =>
                      typeof entry.mode === 'string' && typeof entry.supported === 'boolean',
                  )
                  .map(({ mode, supported }) => ({ mode, supported })),
              })),
            };
          } catch (error) {
            return sanitizedMediaToolError(error, 'video');
          }
        },
      }),
    ),
  );

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'submit_video_job',
        description:
          'Submit one text-to-video job for the current user. Check list_video_models first and use only an available model. After the job handle is returned, report its ID and state and finish this turn; never poll it in the same turn.',
        parameters: {
          modelRef: {
            type: 'string',
            required: true,
            description: 'Exact modelRef from list_video_models.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: 'Final video prompt, at most 5000 Unicode code points.',
          },
          ratio: { type: 'string' },
          resolution: { type: 'string' },
          durationSeconds: { type: 'number' },
          generateAudio: { type: 'boolean' },
          watermark: { type: 'boolean' },
        },
        output: {
          schema: videoJobSchema,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          presentationMeta: (_args, value) => ({
            kind: 'mio.video-job',
            tool: 'submit_video_job',
            job: value,
          }),
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, SUBMIT_KEYS);
          if (
            typeof args.modelRef !== 'string' ||
            !/^onelink:model:[a-z0-9-]{1,256}$/.test(args.modelRef) ||
            typeof args.prompt !== 'string' ||
            !args.prompt.isWellFormed() ||
            !args.prompt.trim() ||
            codepointCount(args.prompt) > VIDEO_MAX_PROMPT_CODEPOINTS ||
            (args.ratio !== undefined && typeof args.ratio !== 'string') ||
            (args.resolution !== undefined && typeof args.resolution !== 'string') ||
            (args.durationSeconds !== undefined &&
              (typeof args.durationSeconds !== 'number' ||
                !Number.isFinite(args.durationSeconds) ||
                args.durationSeconds <= 0)) ||
            (args.generateAudio !== undefined && typeof args.generateAudio !== 'boolean') ||
            (args.watermark !== undefined && typeof args.watermark !== 'boolean')
          )
            throw new HarnessError(
              'MIO_VIDEO_TOOL_ERROR: VIDEO_INPUT_INVALID',
              'VIDEO_INPUT_INVALID',
            );
          exec.signal.throwIfAborted();
          try {
            const capabilities = await bridge.capabilities(actor, args.modelRef);
            if (!capabilities.available) throw new ApplicationError('VIDEO_UNAVAILABLE');
            if (
              !capabilities.modes.some((entry) => entry.mode === 'text_to_video' && entry.supported)
            )
              throw new ApplicationError('VIDEO_MODE_UNSUPPORTED');
            const request = {
              requestId: deriveMediaToolRequestId('video', run, exec.callId),
              modelRef: args.modelRef,
              expectedCapabilitiesVersion: capabilities.capabilitiesVersion,
              parameters: {
                mode: 'text_to_video' as const,
                prompt: args.prompt,
                ...(args.ratio !== undefined ? { ratio: args.ratio } : {}),
                ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
                ...(args.durationSeconds !== undefined
                  ? { durationSeconds: args.durationSeconds }
                  : {}),
                ...(args.generateAudio !== undefined ? { generateAudio: args.generateAudio } : {}),
                ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
              },
            };
            const job = sanitizeVideoJob(await bridge.createVideo(actor, request));
            if (NON_TERMINAL_STATES.has(job.status)) submittedPendingJobs.add(job.jobId);
            return job;
          } catch (error) {
            return sanitizedMediaToolError(error, 'video');
          }
        },
      }),
    ),
  );

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'recover_video_job',
        description:
          'When the user requests recovery, resume saving a previous owner-scoped video job from its existing result. Never resubmits generation. Report the returned state and finish this turn.',
        parameters: {
          jobId: {
            type: 'string',
            required: true,
            description: 'The previous Mio video job UUID.',
          },
        },
        isConcurrencySafe: () => false,
        output: {
          schema: videoJobSchema,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          presentationMeta: (_args, value) => ({
            kind: 'mio.video-job',
            tool: 'get_video_job',
            job: value,
          }),
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, GET_KEYS);
          if (typeof args.jobId !== 'string' || !isUuidV4(args.jobId))
            throw new HarnessError('MIO_VIDEO_TOOL_ERROR: JOB_NOT_FOUND', 'JOB_NOT_FOUND');
          exec.signal.throwIfAborted();
          try {
            const job = sanitizeVideoJob(await bridge.recoverVideo(actor, args.jobId));
            if (NON_TERMINAL_STATES.has(job.status)) polledPendingJobs.add(job.jobId);
            return job;
          } catch (error) {
            return sanitizedMediaToolError(error, 'video');
          }
        },
      }),
    ),
  );

  agentCtx.tools.register(
    closedParametersTool(
      defineTool({
        name: 'get_video_job',
        description:
          'Query a previous owner-scoped Mio video job by jobId. If non-terminal, report its current state and finish this turn; never busy-poll.',
        parameters: {
          jobId: {
            type: 'string',
            required: true,
            description: 'Mio video job UUID returned by submit_video_job.',
          },
        },
        isConcurrencySafe: (args) => hasAllowedArguments(args, GET_KEYS),
        output: {
          schema: videoJobSchema,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          presentationMeta: (_args, value) => ({
            kind: 'mio.video-job',
            tool: 'get_video_job',
            job: value,
          }),
        },
        execute: async (args, exec) => {
          assertAllowedArguments(args, GET_KEYS);
          if (typeof args.jobId !== 'string' || !isUuidV4(args.jobId))
            throw new HarnessError('MIO_VIDEO_TOOL_ERROR: JOB_NOT_FOUND', 'JOB_NOT_FOUND');
          exec.signal.throwIfAborted();
          while (inFlightPollByJobId.has(args.jobId)) {
            await inFlightPollByJobId.get(args.jobId);
            exec.signal.throwIfAborted();
          }
          if (submittedPendingJobs.has(args.jobId) || polledPendingJobs.has(args.jobId))
            throw new HarnessError(
              'MIO_VIDEO_TOOL_ERROR: VIDEO_JOB_POLL_DEFERRED',
              'VIDEO_JOB_POLL_DEFERRED',
            );
          let release!: () => void;
          const inFlight = new Promise<void>((resolve) => {
            release = resolve;
          });
          inFlightPollByJobId.set(args.jobId, inFlight);
          try {
            const job = sanitizeVideoJob(await bridge.getVideo(actor, args.jobId));
            if (NON_TERMINAL_STATES.has(job.status)) polledPendingJobs.add(job.jobId);
            return job;
          } catch (error) {
            return sanitizedMediaToolError(error, 'video');
          } finally {
            if (inFlightPollByJobId.get(args.jobId) === inFlight)
              inFlightPollByJobId.delete(args.jobId);
            release();
          }
        },
      }),
    ),
  );
}
