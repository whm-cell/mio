import { createId } from '@mio/foundation/identifiers';
import {
  AUDIO_INSPECT_PROFILE,
  AUDIO_INSPECTION_LIMITS,
  parseAudioInspectCommandV1,
} from '@mio/compute-contracts';
import type {
  AudioInspection,
  AudioInspectionInput,
  AudioInspectCommandV1,
  AudioInspectResultV1,
} from '@mio/compute-contracts';
import type { ComputeConfig } from '../compute/config.ts';
import { ComputeBroker } from '../integrations/rabbitmq.ts';
import { AudioError } from './contracts.ts';

export type { AudioInspection, AudioInspectionInput } from '@mio/compute-contracts';

export class AudioMediaError extends AudioError {
  constructor(code: string) {
    super(503, code);
  }
}

type Pending = {
  command: AudioInspectCommandV1;
  resolve: (value: AudioInspectResultV1) => void;
  unavailable: () => void;
};

/** Each instance registers its own stream cursor before publishing inspections. */
export function createAudioMediaClient(config: ComputeConfig) {
  const pending = new Map<string, Pending>();
  const lifetime = new AbortController();
  let broker: ComputeBroker | undefined;
  let connecting: Promise<ComputeBroker> | undefined;
  let closing: Promise<void> | undefined;

  async function receive(result: AudioInspectResultV1): Promise<void> {
    const item = pending.get(result.inspectionId);
    if (item && result.jobId === item.command.jobId && result.commandId === item.command.messageId)
      item.resolve(result);
  }

  async function connect(): Promise<ComputeBroker> {
    if (lifetime.signal.aborted) throw new AudioMediaError('AUDIO_INSPECTION_UNAVAILABLE');
    if (broker) return broker;
    connecting ??= (async () => {
      const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]);
      const instance = await ComputeBroker.connect(
        config.brokerURL,
        config.brokerUser,
        config.expectedResultUser,
        startup,
        config.workerUsers,
      );
      let connected = true;
      const disconnected = () => {
        connected = false;
        if (broker === instance) {
          broker = undefined;
          for (const item of pending.values()) item.unavailable();
        }
        void instance.close().catch(() => {});
      };
      instance.onClose(disconnected);
      try {
        await instance.consumeAudio(receive, disconnected, startup);
        startup.throwIfAborted();
        if (!connected) throw new AudioMediaError('AUDIO_INSPECTION_UNAVAILABLE');
        broker = instance;
        return instance;
      } catch (error) {
        await instance.close().catch(() => {});
        throw error;
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  return {
    async inspect(
      input: AudioInspectionInput,
      cancellation?: AbortSignal,
    ): Promise<AudioInspection> {
      const { jobId, purpose, ...object } = input;
      const command = parseAudioInspectCommandV1({
        version: 1,
        type: 'audio.inspect.request',
        profile: AUDIO_INSPECT_PROFILE,
        messageId: createId(),
        inspectionId: createId(),
        jobId,
        purpose,
        input: object,
      });
      const signals = [lifetime.signal, AbortSignal.timeout(180_000)];
      if (cancellation) signals.push(cancellation);
      const signal = AbortSignal.any(signals);
      const cancellationError = () =>
        new AudioMediaError(
          lifetime.signal.aborted ? 'AUDIO_INSPECTION_UNAVAILABLE' : 'AUDIO_INSPECTION_TIMEOUT',
        );
      if (signal.aborted) throw cancellationError();

      const response = Promise.withResolvers<AudioInspectResultV1>();
      const interrupted = Promise.withResolvers<never>();
      const abort = () => interrupted.reject(cancellationError());
      signal.addEventListener('abort', abort, { once: true });
      try {
        const sending = (async () => {
          const instance = await connect();
          if (signal.aborted) throw cancellationError();
          if (broker !== instance) throw new AudioMediaError('AUDIO_INSPECTION_UNAVAILABLE');
          pending.set(command.inspectionId, {
            command,
            resolve: response.resolve,
            unavailable: () =>
              interrupted.reject(new AudioMediaError('AUDIO_INSPECTION_UNAVAILABLE')),
          });
          await instance.publishAudio(command);
        })().catch((error: unknown) => {
          if (error instanceof AudioMediaError) throw error;
          throw new AudioMediaError('AUDIO_INSPECTION_UNAVAILABLE');
        });
        await Promise.race([sending, interrupted.promise]);
        const result = await Promise.race([response.promise, interrupted.promise]);
        if (result.state === 'failed') throw new AudioMediaError(result.errorCode);

        const inspection = result.inspection;
        const limits = AUDIO_INSPECTION_LIMITS[purpose];
        if (
          inspection.sizeBytes !== object.sizeBytes ||
          (object.sha256 !== undefined && inspection.sha256 !== object.sha256)
        )
          throw new AudioMediaError('AUDIO_INPUT_CHANGED');
        if (
          inspection.durationMs < limits.minDurationMs ||
          inspection.durationMs > limits.maxDurationMs
        )
          throw new AudioMediaError('AUDIO_DURATION_INVALID');
        if (
          (purpose === 'sample' && inspection.format === 'flac') ||
          (purpose === 'output' && inspection.format === 'm4a')
        )
          throw new AudioMediaError('AUDIO_INPUT_INVALID');
        return inspection;
      } finally {
        pending.delete(command.inspectionId);
        signal.removeEventListener('abort', abort);
      }
    },

    close(): Promise<void> {
      lifetime.abort();
      closing ??= (async () => {
        await connecting?.catch(() => {});
        const instance = broker;
        broker = undefined;
        await instance?.close();
      })();
      return closing;
    },
  };
}
