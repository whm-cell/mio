import { createId } from '@mio/foundation/identifiers';
import { imageOutputKey } from './contracts.ts';
import type { GenerationFiles } from './files.ts';
import type { GenerationStore } from './store.ts';
import type {
  GeneratedObject,
  GenerationExecution,
  GenerationObjects,
  ImageCheckpoint,
  SavedImage,
} from './execution.ts';

function matches(
  actual: Awaited<ReturnType<GenerationObjects['head']>> | undefined,
  image: SavedImage,
  etag?: string,
): boolean {
  return (
    actual?.size === image.sizeBytes &&
    actual.sha256 === image.sha256 &&
    Boolean(actual.etag) &&
    (etag === undefined || actual.etag === etag)
  );
}

async function findAttempt(
  objects: GenerationObjects,
  checkpoint: ImageCheckpoint,
  image: SavedImage,
): Promise<GeneratedObject | undefined> {
  for (const key of checkpoint.attemptedKeys[image.index] ?? []) {
    try {
      const head = await objects.head(key);
      if (!head) continue;
      if (!matches(head, image)) throw new Error('IMAGE_OUTPUT_MISMATCH');
      return {
        key,
        sizeBytes: image.sizeBytes,
        sha256: image.sha256,
        etag: head.etag,
        contentType: 'image/' + image.format,
      };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
  }
  return undefined;
}

async function materializeImage(
  objects: GenerationObjects,
  files: GenerationFiles,
  checkpoint: ImageCheckpoint,
  image: SavedImage,
  decode: (bytes: Uint8Array, format: string) => Promise<void>,
  signal: AbortSignal,
): Promise<GeneratedObject> {
  const saved = checkpoint.outputs[image.index];
  if (saved) {
    if (!matches(await objects.head(saved.key), image, saved.etag))
      throw new Error('IMAGE_OUTPUT_MISMATCH');
    return saved;
  }
  const bytes = await files.read(checkpoint.jobId, image);
  await decode(bytes, image.format);
  signal.throwIfAborted();
  const existing = await findAttempt(objects, checkpoint, image);
  if (existing) return existing;
  if (!objects.putImage) throw new Error('IMAGE_STORAGE_UNAVAILABLE');
  const key = imageOutputKey(checkpoint.jobId, image.index, createId(), image.format);
  (checkpoint.attemptedKeys[image.index] ??= []).push(key);
  await files.save(checkpoint);
  signal.throwIfAborted();
  const uploaded = await objects.putImage(key, bytes, image.format, image.sha256, signal);
  if (
    uploaded.key !== key ||
    uploaded.sizeBytes !== image.sizeBytes ||
    uploaded.sha256 !== image.sha256 ||
    uploaded.contentType !== 'image/' + image.format ||
    !matches(await objects.head(key), image, uploaded.etag)
  )
    throw new Error('IMAGE_OUTPUT_MISMATCH');
  return uploaded;
}

export async function materializeGeneration(
  row: GenerationExecution,
  checkpoint: ImageCheckpoint,
  store: GenerationStore,
  files: GenerationFiles,
  objects: GenerationObjects,
  decode: (bytes: Uint8Array, format: string) => Promise<void>,
  signal: AbortSignal,
): Promise<'completed' | 'other'> {
  if (row.active_recovery_seq > checkpoint.lastRecoverySequence) {
    checkpoint.lastRecoverySequence = row.active_recovery_seq;
    checkpoint.attempts = Math.min(checkpoint.attempts, 2);
  }
  const permitted = checkpoint.attempts < 3;
  if (permitted) checkpoint.attempts++;
  await files.save(checkpoint);
  const verifiedOutputs: [index: number, output: GeneratedObject][] = [];
  let failed = !checkpoint.receivedAll;
  for (const image of checkpoint.images) {
    if (checkpoint.invalidIndices.includes(image.index)) continue;
    if (!permitted && !checkpoint.outputs[image.index]) {
      failed = true;
      continue;
    }
    try {
      const output = await materializeImage(objects, files, checkpoint, image, decode, signal);
      checkpoint.outputs[image.index] = output;
      verifiedOutputs.push([image.index, output]);
    } catch (error) {
      if (error instanceof Error && error.message === 'IMAGE_OUTPUT_INVALID')
        checkpoint.invalidIndices.push(image.index);
      else failed = true;
    }
    await files.save(checkpoint);
  }
  const outputs = verifiedOutputs.sort(([a], [b]) => a - b).map(([, output]) => output);
  const state = failed
    ? checkpoint.attempts >= 3
      ? 'materialization_failed'
      : 'materializing'
    : outputs.length === checkpoint.expectedCount
      ? 'completed'
      : 'partial';
  const ref = await files.save(checkpoint);
  const committed = await store.acceptOutputs(row, outputs, state, ref);
  if (committed && state === 'completed') {
    const ambiguous = Object.values(checkpoint.attemptedKeys).some((keys) => keys.length > 1);
    if (!ambiguous) await files.clean(checkpoint);
    return 'completed';
  }
  return 'other';
}
