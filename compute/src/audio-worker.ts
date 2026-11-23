import type {
  AudioInspectCommandV1,
  AudioInspectFailure,
  AudioInspectResultV1,
  AudioInspection,
} from '@mio/compute-contracts';
import { createId } from '@mio/foundation/identifiers';
import type { ObjectStore } from './adapters/cos.ts';
import { inspectAudio, MediaError, removeFiles, requireSpace } from './adapters/media.ts';
import type { Broker } from './adapters/rabbitmq.ts';

function failureCode(error: unknown, signal: AbortSignal): AudioInspectFailure {
  if (signal.aborted) return 'AUDIO_INSPECTION_TIMEOUT';
  if (error instanceof MediaError) {
    switch (error.code) {
      case 'EXECUTION_TIMEOUT':
        return 'AUDIO_INSPECTION_TIMEOUT';
      case 'INPUT_CHANGED':
        return 'AUDIO_INPUT_CHANGED';
      case 'INPUT_TOO_LONG':
        return 'AUDIO_DURATION_INVALID';
      case 'INPUT_INVALID':
        return 'AUDIO_INPUT_INVALID';
      default:
        return 'AUDIO_STORAGE_UNAVAILABLE';
    }
  }
  const failure = error as { statusCode?: number; message?: string } | null;
  if (
    failure?.statusCode === 412 ||
    failure?.statusCode === 404 ||
    failure?.message === 'INPUT_SIZE_MISMATCH' ||
    failure?.message === 'INPUT_TOO_LARGE'
  )
    return 'AUDIO_INPUT_CHANGED';
  return 'AUDIO_STORAGE_UNAVAILABLE';
}

export class AudioWorker {
  private readonly store: Pick<ObjectStore, 'download' | 'head'>;
  private readonly broker: Pick<Broker, 'publishAudio'>;
  private readonly directory: string;
  private readonly scratch: string;
  private readonly stop: AbortSignal;

  constructor(
    store: Pick<ObjectStore, 'download' | 'head'>,
    broker: Pick<Broker, 'publishAudio'>,
    directory: string,
    scratch: string,
    stop: AbortSignal,
  ) {
    this.store = store;
    this.broker = broker;
    this.directory = directory;
    this.scratch = scratch;
    this.stop = stop;
  }

  private async inspect(
    command: AudioInspectCommandV1,
    signal: AbortSignal,
  ): Promise<AudioInspection> {
    const { inspectionId, input } = command;
    try {
      removeFiles(this.scratch, inspectionId);
      requireSpace(this.directory, input.sizeBytes);
      const head = await this.store.head(input.key, signal);
      if (
        !head ||
        head.etag !== input.etag ||
        head.sizeBytes !== input.sizeBytes ||
        (input.sha256 !== undefined && head.sha256 !== null && head.sha256 !== input.sha256)
      )
        throw new MediaError('INPUT_CHANGED');
      await this.store.download({ input, attemptId: inspectionId }, this.scratch, signal);
      return await inspectAudio(this.scratch, command, head.sha256, signal);
    } finally {
      removeFiles(this.scratch, inspectionId);
    }
  }

  async handle(command: AudioInspectCommandV1, ack: () => void): Promise<void> {
    this.stop.throwIfAborted();
    const signal = AbortSignal.any([this.stop, AbortSignal.timeout(150_000)]);
    const base = {
      version: 1 as const,
      type: 'audio.inspect.result' as const,
      messageId: createId(),
      commandId: command.messageId,
      inspectionId: command.inspectionId,
      jobId: command.jobId,
    };
    let result: AudioInspectResultV1;
    try {
      const inspection = await this.inspect(command, signal);
      result = { ...base, state: 'succeeded', inspection };
    } catch (error) {
      result = { ...base, state: 'failed', errorCode: failureCode(error, signal) };
    }
    // Interruption leaves the read-only command available for redelivery.
    this.stop.throwIfAborted();
    await this.broker.publishAudio(result);
    ack();
  }
}
