import { createHash, randomUUID } from 'node:crypto';
import {
  imageOutputIndex,
  imageOutputKey,
  type ImageErrorCode,
  type ImageInput,
  type ImageProfile,
} from '@mio/compute-contracts';
import type { Journal } from './adapters/journal.ts';
import { createImageProtocol } from './images.ts';
import type { ImageObservation } from './images.ts';
import { openImageCredential } from './image-credentials.ts';
import type { ImageCredentialEnvelope } from './image-credentials.ts';

export interface ImageCommand {
  messageId: string;
  jobId: string;
  ownerId: string;
  expiresAt: number;
  profile: ImageProfile;
  input: ImageInput;
  credential: ImageCredentialEnvelope;
}
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
  images: ({ base64: string } | null)[];
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
      const fileId = randomUUID();
      saved.pendingFileIds[index] = fileId;
      (saved.attemptedFileIds[index] ??= []).push(fileId);
      // Persist the attempted physical identity before any COS request. If
      // the request becomes ambiguous, operators retain the orphan identity
      // for later read-only reconciliation; automatic recovery never writes
      // that key again.
      journal.imagePhase(jobId, 'materializing', JSON.stringify(saved));
      try {
        const output = await materialize(jobId, index, image.base64, saved.format, fileId, signal);
        if (
          output.key !== imageOutputKey(jobId, index, fileId, saved.format) ||
          output.contentType !== `image/${saved.format}` ||
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

/** The operator can only resume stored bytes, never invoke the paid transport. */
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

/** Journal commit precedes the one paid POST; re-entry only resumes durable outputs. */
export function createImageWorker(
  journal: Journal,
  keyId: string,
  privateKey: string,
  materialize: Materialize,
  transport: typeof fetch = fetch,
) {
  const active = new Set<string>();
  return async (command: ImageCommand, signal?: AbortSignal): Promise<ImageOutcome> => {
    const binding = JSON.stringify([
      command.jobId,
      command.ownerId,
      command.expiresAt,
      command.profile,
      Object.fromEntries(Object.entries(command.input).sort(([a], [b]) => a.localeCompare(b))),
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
        const result = await createImageProtocol(command.profile, 'generate', transport).submit(
          command.input,
          apiKey,
          signal,
        );
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
          format:
            command.profile === 'seedream-4-images-v1'
              ? 'jpeg'
              : (command.input.output_format ?? 'png'),
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
      saved.format ??=
        command.profile === 'seedream-4-images-v1'
          ? 'jpeg'
          : (command.input.output_format ?? 'png');
      saved.expectedCount ??= command.input.n ?? 1;
      if (saved.commandId !== command.messageId) throw new Error('IMAGE_COMMAND_CONFLICT');
      return await materializeSaved(journal, command.jobId, saved, materialize, signal);
    } finally {
      active.delete(command.jobId);
    }
  };
}
