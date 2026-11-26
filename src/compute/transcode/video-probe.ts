import {
  VIDEO_PROBE_ADMISSION_MS,
  VIDEO_PROBE_EXECUTION_MS,
  VIDEO_PROBE_REPLY_MS,
} from '@mio/compute-contracts';
import type {
  VideoProbeCommandV1,
  VideoProbeMetadataV1,
  VideoProbeResultV1,
} from '@mio/compute-contracts';
import { epochMs } from '@mio/foundation/time';
import { VideoProbePublishUnconfirmed } from '../../integrations/rabbitmq.ts';

/** Read-only inspections can be repeated after restart; generation POSTs cannot. */
export function createVideoProbeCoordinator() {
  const pending = new Map<
    string,
    {
      command: VideoProbeCommandV1;
      resolve(value: VideoProbeMetadataV1): void;
      reject(reason: Error): void;
    }
  >();
  return {
    async receive(result: VideoProbeResultV1): Promise<void> {
      const entry = pending.get(result.commandId);
      if (!entry) return;
      const command = entry.command;
      if (
        result.jobId !== command.jobId ||
        result.outputIndex !== command.outputIndex ||
        result.attemptId !== command.attemptId ||
        result.attempt !== command.attempt ||
        result.source.stagingKey !== command.source.stagingKey ||
        result.source.etag !== command.source.etag ||
        result.source.sha256 !== command.source.sha256 ||
        result.source.sizeBytes !== command.source.sizeBytes
      )
        throw Object.assign(new Error('VIDEO_PROBE_RESULT_MISMATCH'), { permanent: true });
      if (result.state === 'succeeded') entry.resolve(result.media);
      else entry.reject(new Error('VIDEO_' + result.errorCode));
    },
    async run(
      command: VideoProbeCommandV1,
      publish: (command: VideoProbeCommandV1, admitBy: number) => Promise<void>,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if (pending.size >= 8 || pending.has(command.messageId)) throw new Error('VIDEO_PROBE_BUSY');
      const { promise, resolve, reject } = Promise.withResolvers<VideoProbeMetadataV1>();
      const abort = () => reject(new Error('VIDEO_PROBE_ABORTED'));
      signal.addEventListener('abort', abort, { once: true });
      const admitBy = epochMs() + VIDEO_PROBE_ADMISSION_MS;
      const timer = setTimeout(
        () => reject(new Error('VIDEO_PROBE_TIMEOUT')),
        VIDEO_PROBE_ADMISSION_MS + VIDEO_PROBE_EXECUTION_MS + VIDEO_PROBE_REPLY_MS,
      );
      timer.unref();
      pending.set(command.messageId, { command, resolve, reject });
      try {
        void publish(command, admitBy).catch((error: unknown) => {
          if (!(error instanceof VideoProbePublishUnconfirmed))
            reject(new Error('VIDEO_PROBE_PUBLISH_FAILED', { cause: error }));
        });
        return await promise;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        pending.delete(command.messageId);
      }
    },
    close() {
      for (const entry of pending.values()) entry.reject(new Error('VIDEO_PROBE_STOPPED'));
    },
  };
}
