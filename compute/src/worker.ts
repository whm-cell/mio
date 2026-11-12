import { epochMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import type {
  ComputeCommandV1,
  ComputeFailureCodeV1,
  ComputeOutputV1,
  ComputeResultV1,
  ComputeUnknownCodeV1,
} from '@mio/compute-contracts';
import { isJournalFailure } from './adapters/journal.ts';
import type { Journal } from './adapters/journal.ts';
import {
  MediaError,
  fileDigest,
  paths,
  processGone,
  processIdentity,
  removeFiles,
  requireSpace,
  transcode,
} from './adapters/media.ts';
import type { ObjectStore } from './adapters/cos.ts';
import type { Broker } from './adapters/rabbitmq.ts';
import type { Attempt, Phase } from './types.ts';

const ATTEMPT_MS = 60 * 60 * 1000;
const log = createLogger('worker', 'worker');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ResultState =
  | { state: 'running' }
  | { state: 'failed'; errorCode: ComputeFailureCodeV1 }
  | { state: 'unknown'; errorCode: ComputeUnknownCodeV1 }
  | { state: 'succeeded'; output: ComputeOutputV1 };

export class Worker {
  readonly #journal: Journal;
  readonly #store: Pick<ObjectStore, 'download' | 'head' | 'verify' | 'upload'>;
  readonly #broker: Pick<Broker, 'publish'>;
  readonly #directory: string;
  #busy = false;
  #activeAttemptId: string | null = null;
  #cursor = '';
  #stopped = false;
  readonly #stopController = new AbortController();

  constructor(
    journal: Journal,
    store: Pick<ObjectStore, 'download' | 'head' | 'verify' | 'upload'>,
    broker: Pick<Broker, 'publish'>,
    directory: string,
  ) {
    this.#journal = journal;
    this.#store = store;
    this.#broker = broker;
    this.#directory = directory;
  }

  stop(): void {
    this.#stopped = true;
    this.#stopController.abort();
  }

  async waitIdle(): Promise<void> {
    while (this.#busy) await sleep(50);
  }

  admissionReady(): boolean {
    if (this.#stopped || this.#busy || this.#journal.hasUnknownProcess()) return false;
    try {
      requireSpace(this.#directory);
      return true;
    } catch (error) {
      if (error instanceof MediaError && error.code === 'DISK_FULL') return false;
      throw error;
    }
  }

  needsMaintenance(): boolean {
    if (this.#stopped) return false;
    if (!this.#busy && !this.admissionReady()) return true;
    const first = this.#journal.recoverableAfter('');
    if (!first) return false;
    if (first.command.attemptId !== this.#activeAttemptId) return true;
    return this.#journal.recoverableAfter(first.command.attemptId) !== null;
  }

  #event(command: ComputeCommandV1, state: ResultState): ComputeResultV1 {
    return {
      version: 1,
      type: 'transcode.result',
      messageId: createId(),
      commandId: command.messageId,
      jobId: command.jobId,
      attemptId: command.attemptId,
      attempt: command.attempt,
      ...state,
    };
  }

  async #flush(attemptId: string): Promise<void> {
    for (
      let event = this.#journal.pendingEvent(attemptId);
      event;
      event = this.#journal.pendingEvent(attemptId)
    ) {
      await this.#broker.publish(event.message);
      this.#journal.confirm(event.message.messageId);
    }
  }

  #requireConfirmedOutcome(attemptId: string): void {
    const attempt = this.#journal.get(attemptId);
    if (!attempt) throw new Error('ATTEMPT_MISSING');
    const expected =
      attempt.phase === 'succeeded'
        ? 'succeeded'
        : attempt.phase === 'failed'
          ? 'failed'
          : ['unknown_process', 'unknown_upload', 'unknown_mismatch'].includes(attempt.phase)
            ? 'unknown'
            : null;
    const last = this.#journal.lastEvent(attemptId);
    if (
      !expected ||
      !last ||
      !last.confirmed ||
      this.#journal.pendingEvent(attemptId) ||
      last.message.state !== expected
    )
      throw new Error('JOURNAL_OUTCOME_UNCONFIRMED');
  }

  async #emit(attempt: Attempt, phase: Phase, state: ResultState): Promise<void> {
    const prior = this.#journal.lastEvent(attempt.command.attemptId)?.message;
    if (
      prior?.state === state.state &&
      (state.state !== 'unknown' ||
        (prior.state === 'unknown' && prior.errorCode === state.errorCode)) &&
      (state.state !== 'failed' ||
        (prior.state === 'failed' && prior.errorCode === state.errorCode))
    ) {
      this.#journal.transition(attempt.command.attemptId, phase);
    } else {
      this.#journal.transition(
        attempt.command.attemptId,
        phase,
        this.#event(attempt.command, state),
      );
    }
    await this.#flush(attempt.command.attemptId);
  }

  async #finishUpload(attempt: Attempt, signal: AbortSignal): Promise<void> {
    const { command, outputSize: size, outputSha256: sha256 } = attempt;
    if (!size || !sha256) {
      await this.#emit(attempt, 'unknown_mismatch', {
        state: 'unknown',
        errorCode: 'OUTPUT_MISMATCH',
      });
      return;
    }
    const key = `mio/derived/${command.jobId}/${command.attemptId}/result.mp4`;
    let state: ResultState;
    let phase: Phase;
    try {
      let object = await this.#store.head(key, signal);
      if (object) {
        const local = await fileDigest(paths(this.#directory, command.attemptId).output, signal);
        if (
          local.size !== size ||
          local.sha256 !== sha256 ||
          object.sizeBytes !== size ||
          object.sha256 !== sha256 ||
          !(await this.#store.verify(key, size, sha256, signal))
        )
          throw new Error('OUTPUT_MISMATCH');
      }
      if (!object) {
        this.#journal.transition(command.attemptId, 'uploading');
        await this.#store.upload(key, this.#directory, command.attemptId, size, sha256, signal);
        object = await this.#store.head(key, signal);
        if (!object) throw new Error('UPLOAD_UNKNOWN');
        if (object.sizeBytes !== size || object.sha256 !== sha256)
          throw new Error('OUTPUT_MISMATCH');
      }
      phase = 'succeeded';
      state = { state: 'succeeded', output: { key, sizeBytes: size, sha256, etag: object.etag } };
    } catch (error) {
      if (isJournalFailure(error)) throw error;
      if (
        (error as Error).message === 'OUTPUT_MISMATCH' ||
        (error as Error).message === 'OBJECT_TOO_LARGE' ||
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        phase = 'unknown_mismatch';
        state = { state: 'unknown', errorCode: 'OUTPUT_MISMATCH' };
      } else {
        phase = 'unknown_upload';
        state = { state: 'unknown', errorCode: 'UPLOAD_UNKNOWN' };
      }
    }
    await this.#emit(attempt, phase, state);
  }

  async #recover(attempt: Attempt): Promise<void> {
    if (['succeeded', 'failed', 'received'].includes(attempt.phase)) {
      await this.#flush(attempt.command.attemptId);
      return;
    }
    if (['launching', 'running', 'unknown_process'].includes(attempt.phase)) {
      await this.#emit(attempt, 'unknown_process', {
        state: 'unknown',
        errorCode: 'PROCESS_UNKNOWN',
      });
      if (processGone(attempt.pid, attempt.processIdentity)) {
        await this.#emit(attempt, 'failed', { state: 'failed', errorCode: 'WORKER_INTERRUPTED' });
      }
      return;
    }
    await this.#finishUpload(
      attempt,
      AbortSignal.any([AbortSignal.timeout(ATTEMPT_MS), this.#stopController.signal]),
    );
  }

  async reconcileOne(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    try {
      await this.#reconcileNext();
    } finally {
      this.#busy = false;
    }
  }

  async #reconcileNext(): Promise<void> {
    let attempt = this.#journal.recoverableAfter(this.#cursor);
    if (!attempt) {
      this.#cursor = '';
      attempt = this.#journal.recoverableAfter('');
    }
    if (!attempt) return;
    this.#cursor = attempt.command.attemptId;
    await this.#recover(attempt);
    const current = this.#journal.get(attempt.command.attemptId);
    if (current && !current.cleaned && ['succeeded', 'failed'].includes(current.phase)) {
      this.#requireConfirmedOutcome(current.command.attemptId);
      removeFiles(this.#directory, current.command.attemptId);
      this.#journal.markCleaned(current.command.attemptId);
    }
  }

  async handle(command: ComputeCommandV1, ack: () => void): Promise<void> {
    if (!this.admissionReady()) throw new Error('WORKER_NOT_READY');
    const attemptLog = log.child({
      jobId: command.jobId,
      attemptId: command.attemptId,
      messageId: command.messageId,
    });
    attemptLog.info('COMMAND_RECEIVED');
    this.#busy = true;
    this.#activeAttemptId = command.attemptId;
    try {
      let attempt = this.#journal.get(command.attemptId);
      if (attempt) attempt = this.#journal.accept(command);
      if (!attempt) attempt = this.#journal.accept(command);
      if (
        [
          'launching',
          'running',
          'unknown_process',
          'output_ready',
          'uploading',
          'unknown_upload',
          'unknown_mismatch',
        ].includes(attempt.phase)
      ) {
        await this.#recover(attempt);
      } else if (attempt.phase === 'received') {
        await this.#run(attempt);
      }
      await this.#flush(command.attemptId);
      this.#requireConfirmedOutcome(command.attemptId);
      const final = this.#journal.get(command.attemptId);
      if (final && !final.cleaned && ['succeeded', 'failed'].includes(final.phase)) {
        removeFiles(this.#directory, command.attemptId);
        this.#journal.markCleaned(command.attemptId);
      }
      ack();
      this.#journal.markAckDispatched(command.attemptId);
      attemptLog.info('COMMAND_ACK_DISPATCHED');
    } finally {
      this.#activeAttemptId = null;
      this.#busy = false;
    }
  }

  async #run(attempt: Attempt): Promise<void> {
    const { command } = attempt;
    if (!this.#journal.lastEvent(command.attemptId))
      await this.#emit(attempt, 'received', { state: 'running' });
    else await this.#flush(command.attemptId);
    const remaining = ATTEMPT_MS - (epochMs() - attempt.startedAt);
    if (remaining <= 0) {
      await this.#emit(attempt, 'failed', { state: 'failed', errorCode: 'EXECUTION_TIMEOUT' });
      return;
    }
    const diskController = new AbortController();
    const diskTimer = setInterval(() => {
      try {
        requireSpace(this.#directory);
      } catch {
        diskController.abort();
      }
    }, 5000);
    const signal = AbortSignal.any([
      AbortSignal.timeout(remaining),
      this.#stopController.signal,
      diskController.signal,
    ]);
    let launched = false;
    let spawned = false;
    try {
      removeFiles(this.#directory, command.attemptId);
      await this.#store.download(command, this.#directory, signal);
      const identity = processIdentity();
      if (!identity) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
      this.#journal.transition(command.attemptId, 'launching');
      const output = await transcode(this.#directory, command.attemptId, signal, (pid) => {
        spawned = true;
        this.#journal.recordPid(command.attemptId, pid, identity);
        launched = true;
      });
      this.#journal.recordOutput(command.attemptId, output.size, output.sha256);
      const ready = this.#journal.get(command.attemptId);
      if (!ready) throw new Error('ATTEMPT_MISSING');
      await this.#finishUpload(ready, signal);
    } catch (error) {
      if (isJournalFailure(error)) throw error;
      const current = this.#journal.get(command.attemptId);
      if (!current) throw error;
      if (current.phase === 'launching' && spawned && !launched) {
        await this.#emit(current, 'unknown_process', {
          state: 'unknown',
          errorCode: 'PROCESS_UNKNOWN',
        });
        return;
      }
      if (
        ['output_ready', 'uploading', 'unknown_upload', 'unknown_mismatch', 'succeeded'].includes(
          current.phase,
        )
      )
        throw error;
      if (current.phase === 'running' && !(error instanceof MediaError)) throw error;
      let code: ComputeFailureCodeV1 = 'STORAGE_FAILURE';
      if (this.#stopController.signal.aborted) code = 'WORKER_INTERRUPTED';
      else if (diskController.signal.aborted) code = 'STORAGE_FAILURE';
      else if (signal.aborted) code = 'EXECUTION_TIMEOUT';
      else if (error instanceof MediaError)
        code = error.code === 'DISK_FULL' ? 'STORAGE_FAILURE' : error.code;
      else if (
        (error as { statusCode?: number }).statusCode === 412 ||
        (error as Error).message === 'INPUT_SIZE_MISMATCH'
      )
        code = 'INPUT_CHANGED';
      else if ((error as Error).message === 'INPUT_TOO_LARGE') code = 'INPUT_TOO_LARGE';
      await this.#emit(current, 'failed', { state: 'failed', errorCode: code });
    } finally {
      clearInterval(diskTimer);
    }
  }
}
