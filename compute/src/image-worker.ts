import { createHash, randomUUID } from 'node:crypto';
import {
  IMAGE_PROFILE_RULES,
  imageOutputIndex,
  imageOutputKey,
  imageQueryCredentialBinding,
  canonicalImageInput,
  type ImageAssetRef,
  type ImageErrorCode,
  type ImageInput,
  type ImageProfile,
  type ImageQueryCommandV1,
} from '@mio/compute-contracts';
import type { Journal } from './adapters/journal.ts';
import {
  createImageProtocol,
  createKlingAsyncImageTransport,
  createViduAsyncImageTransport,
} from './images.ts';
import type { AsyncImageTransport, ImageObservation, ReadImage } from './images.ts';
import { openImageCredential } from './image-credentials.ts';
import type { ImageCredentialEnvelope } from './image-credentials.ts';

export interface ImageCommand {
  messageId: string;
  type?: 'image.request';
  jobId: string;
  ownerId: string;
  expiresAt: number;
  profile: ImageProfile;
  input: ImageInput;
  credential: ImageCredentialEnvelope;
}
export type ImageQueryCommand = ImageQueryCommandV1;
export interface ImageObject {
  key: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
  contentType: string;
}
export type ImageOutcome =
  | { state: 'completed' | 'partial'; outputs: ImageObject[] }
  | { state: 'unknown' | 'rejected'; errorCode: ImageErrorCode }
  | { state: 'submitted' | 'processing'; upstreamTaskId: string; queryAttempt: number }
  | {
      state: 'failed';
      errorCode: ImageErrorCode;
      upstreamTaskId?: string;
      queryAttempt?: number;
    }
  | { state: 'materializing' | 'materialization_failed'; outputs: ImageObject[] };
type Materialize = (
  jobId: string,
  index: number,
  base64: string,
  format: string,
  fileId: string,
  signal?: AbortSignal,
) => Promise<ImageObject>;
interface SavedImages {
  commandId: string;
  format: string;
  expectedCount: number;
  images: ({ base64: string; format?: 'png' | 'jpeg' | 'webp' } | null)[];
  outputs: ImageObject[];
  resultsByIndex?: Record<string, ImageObject>;
  invalidIndices?: number[];
  pendingFileIds?: Record<string, string>;
  attemptedFileIds?: Record<string, string[]>;
  attempts?: number;
  lastRecoverySequence?: number;
  observation?: ImageObservation;
}
interface SavedCompletion {
  commandId: string;
  expectedCount: number;
  outputs: ImageObject[];
  attemptedFileIds?: Record<string, string[]>;
  observation?: ImageObservation;
}

function completed(saved: SavedCompletion): ImageOutcome {
  return {
    state: saved.outputs.length < saved.expectedCount ? 'partial' : 'completed',
    outputs: saved.outputs,
  };
}

function defaultAsyncImageTransport(
  profile: ImageProfile,
  transport: typeof fetch,
  read: ReadImage,
): AsyncImageTransport | undefined {
  switch (profile) {
    case 'vidu-image-v1':
      return createViduAsyncImageTransport(transport, read);
    case 'kling-image-v1':
      return createKlingAsyncImageTransport(transport);
    case 'gpt-images-v1':
    case 'seedream-4-images-v1':
      return undefined;
    default: {
      const exhaustive: never = profile;
      void exhaustive;
      return undefined;
    }
  }
}

function defaultSavedImageFormat(
  profile: ImageProfile,
  outputFormat: ImageInput['output_format'],
): 'png' | 'jpeg' | 'webp' {
  return IMAGE_PROFILE_RULES[profile]?.fixedOutputFormat ?? outputFormat ?? 'png';
}

async function materializeSaved(
  journal: Journal,
  jobId: string,
  saved: SavedImages,
  materialize: Materialize,
  signal?: AbortSignal,
): Promise<ImageOutcome> {
  if ((saved.attempts ?? 0) >= 3)
    return { state: 'materialization_failed', outputs: saved.outputs };
  // Older in-flight rows stored a contiguous prefix. New rows retain each output's source index.
  saved.resultsByIndex ??= Object.fromEntries(
    saved.outputs.map((output, index) => [index, output]),
  );
  saved.invalidIndices ??= [];
  saved.pendingFileIds ??= {};
  saved.attemptedFileIds ??= {};
  saved.attempts = (saved.attempts ?? 0) + 1;
  journal.imagePhase(jobId, 'materializing', JSON.stringify(saved));
  let failed = false;
  for (let index = 0; index < saved.images.length; index++) {
    if (saved.resultsByIndex[index] || saved.invalidIndices.includes(index)) continue;
    const image = saved.images[index];
    if (!image) saved.invalidIndices.push(index);
    else {
      const format = image.format ?? saved.format;
      const fileId = randomUUID();
      saved.pendingFileIds[index] = fileId;
      (saved.attemptedFileIds[index] ??= []).push(fileId);
      // Persist the attempted physical identity before any COS request. If
      // the request becomes ambiguous, operators retain the orphan identity
      // for later read-only reconciliation; automatic recovery never writes
      // that key again.
      journal.imagePhase(jobId, 'materializing', JSON.stringify(saved));
      try {
        const output = await materialize(jobId, index, image.base64, format, fileId, signal);
        if (
          output.key !== imageOutputKey(jobId, index, fileId, format) ||
          output.contentType !== `image/${format}` ||
          imageOutputIndex(jobId, output.key, output.contentType) !== index
        )
          throw new Error('IMAGE_OUTPUT_INVALID');
        saved.resultsByIndex[index] = output;
        delete saved.pendingFileIds[index];
      } catch (error) {
        if (error instanceof Error && error.message === 'IMAGE_OUTPUT_INVALID') {
          saved.invalidIndices.push(index);
          delete saved.pendingFileIds[index];
        } else failed = true;
      }
    }
    saved.outputs = Object.entries(saved.resultsByIndex)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => value);
    journal.imagePhase(jobId, 'materializing', JSON.stringify(saved));
  }
  if (failed) {
    return {
      state: saved.attempts >= 3 ? 'materialization_failed' : 'materializing',
      outputs: saved.outputs,
    };
  }
  const result = {
    commandId: saved.commandId,
    expectedCount: saved.expectedCount,
    outputs: saved.outputs,
    ...(saved.attemptedFileIds ? { attemptedFileIds: saved.attemptedFileIds } : {}),
    ...(saved.observation ? { observation: saved.observation } : {}),
  };
  journal.imagePhase(jobId, 'completed', JSON.stringify(result));
  return completed(result);
}

/** The operator can only resume stored bytes, never invoke the supplier transport. */
export async function recoverImageMaterialization(
  journal: Journal,
  jobId: string,
  commandId: string,
  sequence: number,
  materialize: Materialize,
  signal?: AbortSignal,
): Promise<{ commandId: string; outcome: ImageOutcome }> {
  const row = journal.image(jobId);
  if (!row?.payload) throw new Error('IMAGE_RESOLUTION_INVALID');
  const saved = JSON.parse(row.payload) as SavedImages;
  if (
    saved.commandId !== commandId ||
    !Number.isInteger(saved.expectedCount) ||
    !Array.isArray(saved.outputs)
  )
    throw new Error('IMAGE_RESOLUTION_INVALID');
  if (row.phase === 'completed') return { commandId: saved.commandId, outcome: completed(saved) };
  if (
    row.phase !== 'materializing' ||
    !Array.isArray(saved.images) ||
    !saved.format ||
    !Number.isInteger(saved.attempts) ||
    (saved.attempts ?? 0) < 3
  )
    throw new Error('IMAGE_RESOLUTION_INVALID');
  if (sequence <= (saved.lastRecoverySequence ?? 0))
    return { commandId, outcome: { state: 'materialization_failed', outputs: saved.outputs } };
  // One explicit operator invocation permits one bounded attempt, not another automatic batch.
  saved.attempts = 2;
  saved.lastRecoverySequence = sequence;
  return {
    commandId: saved.commandId,
    outcome: await materializeSaved(journal, jobId, saved, materialize, signal),
  };
}

/** Journal commit precedes the one supplier POST; re-entry only resumes durable outputs. */
export function createImageWorker(
  journal: Journal,
  keyId: string,
  privateKey: string,
  materialize: Materialize,
  transport: typeof fetch = fetch,
  readImage?: ReadImage,
  asyncTransport?: AsyncImageTransport,
) {
  const active = new Set<string>();
  return async (
    command: ImageCommand | ImageQueryCommand,
    signal?: AbortSignal,
  ): Promise<ImageOutcome> => {
    const binding = JSON.stringify([
      command.jobId,
      command.ownerId,
      command.expiresAt,
      command.profile,
      canonicalImageInput(command.input),
    ]);
    const identity = createHash('sha256')
      .update(binding)
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(command.credential).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      )
      .digest('hex');
    if (active.has(command.jobId)) throw new Error('IMAGE_BUSY');
    active.add(command.jobId);
    try {
      const current = journal.image(command.jobId);
      if (current && current.identity !== identity) throw new Error('IMAGE_COMMAND_CONFLICT');
      const inputBytes = new Map<string, Uint8Array>();
      const read = async (ref: ImageAssetRef, inputSignal: AbortSignal) => {
        const existing = inputBytes.get(ref.assetId);
        if (existing) return existing;
        if (!readImage) throw new Error('IMAGE_INPUT_UNAVAILABLE');
        const bytes = await readImage(ref, inputSignal);
        inputBytes.set(ref.assetId, bytes);
        return bytes;
      };
      if (command.type === 'image.query') {
        if (!current) throw new Error('IMAGE_QUERY_UNKNOWN');
        if (current.phase === 'completed') {
          const saved = JSON.parse(current.payload ?? '{}') as SavedCompletion;
          return completed(saved);
        }
        if (current.phase === 'failed') {
          let payload: { code?: ImageErrorCode; upstreamTaskId?: string; queryAttempt?: number };
          try {
            payload = JSON.parse(current.payload ?? '{}') as typeof payload;
          } catch {
            payload = { code: current.payload as ImageErrorCode };
          }
          if (payload.upstreamTaskId !== command.upstreamTaskId || !payload.queryAttempt)
            throw new Error('IMAGE_QUERY_UNKNOWN');
          if (command.queryAttempt <= payload.queryAttempt)
            return {
              state: 'failed',
              errorCode: payload.code ?? 'IMAGE_QUERY_FAILED',
              upstreamTaskId: payload.upstreamTaskId,
              queryAttempt: payload.queryAttempt,
            };
        }
        if (current.phase === 'materializing' || current.phase === 'returned') {
          const saved = JSON.parse(current.payload ?? '{}') as SavedImages;
          return await materializeSaved(journal, command.jobId, saved, materialize, signal);
        }
        if (current.phase === 'processing') {
          const saved = JSON.parse(current.payload ?? '{}') as {
            upstreamTaskId?: string;
            queryAttempt?: number;
          };
          if (saved.upstreamTaskId !== command.upstreamTaskId || !saved.queryAttempt)
            throw new Error('IMAGE_QUERY_UNKNOWN');
          if (command.queryAttempt <= saved.queryAttempt)
            return {
              state: 'processing',
              upstreamTaskId: command.upstreamTaskId,
              queryAttempt: saved.queryAttempt,
            };
        }
        if (current.phase === 'submitted') {
          const saved = JSON.parse(current.payload ?? '{}') as {
            commandId?: string;
            upstreamTaskId?: string;
          };
          if (
            saved.commandId !== command.commandId ||
            saved.upstreamTaskId !== command.upstreamTaskId
          )
            throw new Error('IMAGE_QUERY_UNKNOWN');
        } else if (current.phase !== 'processing' && current.phase !== 'failed') {
          throw new Error('IMAGE_QUERY_UNKNOWN');
        }
        const activeAsyncTransport =
          asyncTransport ?? defaultAsyncImageTransport(command.profile, transport, read);
        if (!activeAsyncTransport) {
          journal.imagePhase(
            command.jobId,
            'failed',
            JSON.stringify({
              code: 'IMAGE_QUERY_FAILED',
              upstreamTaskId: command.upstreamTaskId,
              queryAttempt: command.queryAttempt,
            }),
          );
          return {
            state: 'failed',
            errorCode: 'IMAGE_QUERY_FAILED',
            upstreamTaskId: command.upstreamTaskId,
            queryAttempt: command.queryAttempt,
          };
        }
        if (
          !keyId ||
          !privateKey ||
          !command.queryCredential ||
          !Number.isSafeInteger(command.queryDeadline) ||
          !command.queryDeadline ||
          command.queryDeadline > command.expiresAt
        ) {
          journal.imagePhase(
            command.jobId,
            'failed',
            JSON.stringify({
              code: 'IMAGE_CREDENTIAL_UNAVAILABLE',
              upstreamTaskId: command.upstreamTaskId,
              queryAttempt: command.queryAttempt,
            }),
          );
          return {
            state: 'failed',
            errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
            upstreamTaskId: command.upstreamTaskId,
            queryAttempt: command.queryAttempt,
          };
        }
        if (command.queryDeadline <= Date.now() || command.expiresAt <= Date.now()) {
          journal.imagePhase(
            command.jobId,
            'failed',
            JSON.stringify({
              code: 'IMAGE_QUERY_LIMIT',
              upstreamTaskId: command.upstreamTaskId,
              queryAttempt: command.queryAttempt,
            }),
          );
          return {
            state: 'failed',
            errorCode: 'IMAGE_QUERY_LIMIT',
            upstreamTaskId: command.upstreamTaskId,
            queryAttempt: command.queryAttempt,
          };
        }
        let apiKey: string;
        try {
          apiKey = openImageCredential(
            command.queryCredential,
            imageQueryCredentialBinding(command),
            keyId,
            privateKey,
          );
        } catch {
          journal.imagePhase(
            command.jobId,
            'failed',
            JSON.stringify({
              code: 'IMAGE_CREDENTIAL_UNAVAILABLE',
              upstreamTaskId: command.upstreamTaskId,
              queryAttempt: command.queryAttempt,
            }),
          );
          return {
            state: 'failed',
            errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
            upstreamTaskId: command.upstreamTaskId,
            queryAttempt: command.queryAttempt,
          };
        }
        const result = await createImageProtocol(
          command.profile,
          command.operation,
          transport,
          read,
          activeAsyncTransport,
        ).queryAsync(command.input, apiKey, command.upstreamTaskId, command.queryAttempt, signal);
        if (result.state === 'processing') {
          journal.imagePhase(
            command.jobId,
            'processing',
            JSON.stringify({
              commandId: command.commandId,
              upstreamTaskId: result.upstreamTaskId,
              queryAttempt: command.queryAttempt,
            }),
          );
          return {
            state: 'processing',
            upstreamTaskId: result.upstreamTaskId,
            queryAttempt: command.queryAttempt,
          };
        }
        if (result.state !== 'returned') {
          journal.imagePhase(
            command.jobId,
            'failed',
            JSON.stringify({
              code: result.code,
              upstreamTaskId: command.upstreamTaskId,
              queryAttempt: command.queryAttempt,
            }),
          );
          return {
            state: 'failed',
            errorCode: result.code,
            upstreamTaskId: command.upstreamTaskId,
            queryAttempt: command.queryAttempt,
          };
        }
        const saved: SavedImages = {
          commandId: command.commandId,
          format: defaultSavedImageFormat(command.profile, command.input.output_format),
          expectedCount: command.input.n ?? 1,
          images: result.images,
          outputs: [],
        };
        journal.imagePhase(command.jobId, 'returned', JSON.stringify(saved));
        return await materializeSaved(journal, command.jobId, saved, materialize, signal);
      }
      if (
        !current &&
        command.input.async !== true &&
        ['edit', 'outpaint'].includes(command.input.operation ?? 'generate')
      ) {
        try {
          const inputSignal = signal ?? AbortSignal.timeout(180_000);
          const refs = command.input.images ?? (command.input.image ? [command.input.image] : []);
          for (const ref of refs) await read(ref, inputSignal);
          if (command.input.mask) await read(command.input.mask, inputSignal);
        } catch {
          // No journal row exists yet, so a COS read failure is safe to retry before
          // the worker can submit the upstream edit request.
          throw new Error('IMAGE_INPUT_UNAVAILABLE');
        }
      }
      const first = journal.beginImage(command.jobId, identity);
      if (first) {
        if (!keyId || !privateKey || command.expiresAt <= Date.now()) {
          const errorCode =
            !keyId || !privateKey ? 'IMAGE_HANDLER_UNAVAILABLE' : 'IMAGE_CREDENTIAL_UNAVAILABLE';
          journal.imagePhase(command.jobId, 'rejected', errorCode);
          return { state: 'rejected', errorCode };
        }
        let apiKey: string;
        try {
          apiKey = openImageCredential(command.credential, binding, keyId, privateKey);
        } catch {
          journal.imagePhase(command.jobId, 'rejected', 'IMAGE_CREDENTIAL_UNAVAILABLE');
          return { state: 'rejected', errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE' };
        }
        const protocol = createImageProtocol(
          command.profile,
          command.input.operation ?? 'generate',
          transport,
          read,
          asyncTransport ?? defaultAsyncImageTransport(command.profile, transport, read),
        );
        if (command.input.async === true) {
          const result = await protocol.submitAsync(command.input, apiKey, signal);
          if (result.state === 'submitted') {
            journal.imagePhase(
              command.jobId,
              'submitted',
              JSON.stringify({
                commandId: command.messageId,
                upstreamTaskId: result.upstreamTaskId,
                queryAttempt: 0,
              }),
            );
            return {
              state: 'submitted',
              upstreamTaskId: result.upstreamTaskId,
              queryAttempt: 0,
            };
          }
          if (result.state === 'unknown') {
            journal.imagePhase(
              command.jobId,
              'unknown',
              result.observation
                ? JSON.stringify({ code: result.code, observation: result.observation })
                : result.code,
            );
            return { state: 'unknown', errorCode: result.code };
          }
          journal.imagePhase(command.jobId, 'rejected', result.code);
          return { state: 'rejected', errorCode: result.code };
        }
        const result = await protocol.submit(command.input, apiKey, signal, read);
        if (result.state !== 'returned') {
          journal.imagePhase(
            command.jobId,
            result.state,
            result.observation
              ? JSON.stringify({ code: result.code, observation: result.observation })
              : result.code,
          );
          return { state: result.state, errorCode: result.code };
        }
        const saved: SavedImages = {
          commandId: command.messageId,
          format: defaultSavedImageFormat(command.profile, command.input.output_format),
          expectedCount: command.input.n ?? 1,
          images: result.images,
          outputs: [],
          ...(result.observation ? { observation: result.observation } : {}),
        };
        journal.imagePhase(command.jobId, 'returned', JSON.stringify(saved));
      }
      const row = journal.image(command.jobId)!;
      if (row.phase === 'submitting') {
        journal.imagePhase(command.jobId, 'unknown', 'IMAGE_SUBMISSION_UNKNOWN');
        return { state: 'unknown', errorCode: 'IMAGE_SUBMISSION_UNKNOWN' };
      }
      if (row.phase === 'unknown')
        return { state: 'unknown', errorCode: 'IMAGE_SUBMISSION_UNKNOWN' };
      if (row.phase === 'submitted' || row.phase === 'processing') {
        const saved = JSON.parse(row.payload ?? '{}') as {
          upstreamTaskId?: string;
          queryAttempt?: number;
        };
        if (typeof saved.upstreamTaskId !== 'string' || !Number.isSafeInteger(saved.queryAttempt))
          throw new Error('IMAGE_RESOLUTION_INVALID');
        return {
          state: row.phase,
          upstreamTaskId: saved.upstreamTaskId,
          queryAttempt: saved.queryAttempt!,
        };
      }
      if (row.phase === 'failed') {
        let payload: { code?: ImageErrorCode; upstreamTaskId?: string; queryAttempt?: number };
        try {
          payload = JSON.parse(row.payload ?? '{}') as typeof payload;
        } catch {
          payload = { code: row.payload as ImageErrorCode };
        }
        return {
          state: 'failed',
          errorCode: payload.code ?? 'IMAGE_QUERY_FAILED',
          ...(payload.upstreamTaskId ? { upstreamTaskId: payload.upstreamTaskId } : {}),
          ...(payload.queryAttempt !== undefined ? { queryAttempt: payload.queryAttempt } : {}),
        };
      }
      if (row.phase === 'rejected')
        return {
          state: 'rejected',
          errorCode: (row.payload?.startsWith('{')
            ? JSON.parse(row.payload).code
            : (row.payload ?? 'IMAGE_REJECTED')) as ImageErrorCode,
        };
      if (row.phase === 'completed') {
        const saved = JSON.parse(row.payload!) as SavedCompletion | ImageObject[];
        if (Array.isArray(saved))
          return completed({
            commandId: command.messageId,
            expectedCount: command.input.n ?? 1,
            outputs: saved,
          });
        if (saved.commandId !== command.messageId) throw new Error('IMAGE_COMMAND_CONFLICT');
        return completed(saved);
      }
      const saved = JSON.parse(row.payload!) as SavedImages;
      // Unreleased older journal rows did not retain the publication identity.
      saved.commandId ??= command.messageId;
      saved.format ??= defaultSavedImageFormat(command.profile, command.input.output_format);
      saved.expectedCount ??= command.input.n ?? 1;
      if (saved.commandId !== command.messageId) throw new Error('IMAGE_COMMAND_CONFLICT');
      return await materializeSaved(journal, command.jobId, saved, materialize, signal);
    } finally {
      active.delete(command.jobId);
    }
  };
}
