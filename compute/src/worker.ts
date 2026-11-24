import { epochMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import type {
  ComputeCommandV1,
  ComputeFailureCodeV1,
  ComputeOutputV1,
  ComputeResultV1,
  ComputeUnknownCodeV1,
  WorkerExecutionIdentity,
  WorkerExecutionPhase,
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
import { ResourceSlots } from './resource-slots.ts';
import type { Attempt, Phase } from './types.ts';

const ATTEMPT_MS = 60 * 60 * 1000;
const log = createLogger('worker', 'worker');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function identity(command: ComputeCommandV1): WorkerExecutionIdentity {
  return {
    executionId: createId(),
    protocol: 'transcode.v1',
    jobId: command.jobId,
    attemptId: command.attemptId,
    inspectionId: null,
    resource: 'encode',
    slots: 1,
  };
}

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
  readonly #slots: ResourceSlots;
  readonly #deliveries = new Map<string, Promise<void>>();
  readonly #executionIds = new Map<string, string>();
  readonly #ownedProcesses = new Set<string>();
  #maintenance: Promise<void> | undefined;
  #maintenanceAttempt: string | undefined;
  #cursor = '';
  #stopped = false;
  readonly #stopController = new AbortController();

  constructor(
    journal: Journal,
    store: Pick<ObjectStore, 'download' | 'head' | 'verify' | 'upload'>,
    broker: Pick<Broker, 'publish'>,
    directory: string,
    slots = new ResourceSlots(),
  ) {
    this.#journal = journal;
    this.#store = store;
    this.#broker = broker;
    this.#directory = directory;
    this.#slots = slots;
    this.#syncProcessHold();
  }

  stop(): void {
    this.#stopped = true;
    this.#stopController.abort();
  }

  async waitIdle(): Promise<void> {
    while (this.#deliveries.size || this.#maintenance) await sleep(50);
  }

  #syncProcessHold(): void {
    this.#slots.setHold(
      'encode',
      'transcode',
      this.#journal.hasUnknownProcess(this.#ownedProcesses),
    );
  }

  admissionReady(): boolean {
    if (this.#stopped || this.#deliveries.size || this.#maintenance) return false;
    this.#syncProcessHold();
    if (!this.#slots.available('encode')) return false;
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
    if (!this.#deliveries.size && !this.admissionReady()) return true;
    return this.#nextIdleAttempt('') !== null;
  }

  #nextIdleAttempt(cursor: string): Attempt | null {
    for (
      let attempt = this.#journal.recoverableAfter(cursor);
      attempt;
      attempt = this.#journal.recoverableAfter(attempt.command.attemptId)
    ) {
      if (!this.#deliveries.has(attempt.command.attemptId)) return attempt;
    }
    return null;
  }

  #phase(attemptId: string, phase: WorkerExecutionPhase): void {
    const id = this.#executionIds.get(attemptId);
    if (id) this.#slots.phase(id, phase);
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
    this.#phase(attempt.command.attemptId, 'uploading');
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

  reconcileOne(): Promise<void> {
    if (this.#maintenance) return this.#maintenance;
    if (this.#stopped) return Promise.resolve();
    const flight = this.#reconcileNext().finally(() => {
      this.#maintenance = undefined;
      this.#maintenanceAttempt = undefined;
    });
    this.#maintenance = flight;
    return flight;
  }

  async #reconcileNext(): Promise<void> {
    const attempt = this.#nextIdleAttempt(this.#cursor) ?? this.#nextIdleAttempt('');
    if (!attempt) return;
    const id = attempt.command.attemptId;
    this.#cursor = id;
    const recoveringOutput = [
      'output_ready',
      'uploading',
      'unknown_upload',
      'unknown_mismatch',
    ].includes(attempt.phase);
    // Known output recovery may proceed under an uncertain process HOLD without starting FFmpeg.
    const execution = identity(attempt.command);
    const release = recoveringOutput
      ? this.#slots.acquireOutputRecovery('encode', execution)
      : null;
    if (recoveringOutput && !release) return;
    this.#maintenanceAttempt = id;
    if (release) this.#executionIds.set(id, execution.executionId);
    try {
      await this.#recover(attempt);
      this.#cleanup(id);
    } finally {
      this.#executionIds.delete(id);
      this.#releaseSlot(release);
    }
  }

  #cleanup(attemptId: string): void {
    const current = this.#journal.get(attemptId);
    if (current && !current.cleaned && ['succeeded', 'failed'].includes(current.phase)) {
      this.#requireConfirmedOutcome(current.command.attemptId);
      removeFiles(this.#directory, current.command.attemptId);
      this.#journal.markCleaned(current.command.attemptId);
    }
  }

  #releaseSlot(release: (() => void) | null): void {
    try {
      this.#syncProcessHold();
    } catch (error) {
      this.#slots.setHold('encode', 'transcode', true);
      throw error;
    } finally {
      release?.();
    }
  }

  async handle(command: ComputeCommandV1, ack: () => void, buffered = false): Promise<void> {
    const id = command.attemptId;
    const previous = this.#deliveries.get(id);
    if (previous && buffered) {
      await previous;
      this.#journal.accept(command);
      ack();
      return;
    }
    if (this.#stopped || (!buffered && !this.admissionReady())) throw new Error('WORKER_NOT_READY');
    const task = this.#executeDelivery(command, ack, buffered);
    this.#deliveries.set(id, task);
    try {
      await task;
    } finally {
      this.#deliveries.delete(id);
    }
  }

  async #executeDelivery(
    command: ComputeCommandV1,
    ack: () => void,
    buffered: boolean,
  ): Promise<void> {
    const id = command.attemptId;
    if (this.#maintenanceAttempt === id) await this.#maintenance;
    this.#syncProcessHold();
    const execution = identity(command);
    const previous = buffered ? this.#journal.get(id) : null;
    const recoverOutput =
      previous &&
      ['output_ready', 'uploading', 'unknown_upload', 'unknown_mismatch'].includes(previous.phase);
    const statusOnly =
      previous && ['launching', 'running', 'unknown_process'].includes(previous.phase);
    // Querying an earlier process requires no capacity and cannot wait on its own HOLD.
    const release = statusOnly
      ? null
      : buffered
        ? recoverOutput
          ? await this.#slots.waitForOutputRecovery(
              'encode',
              this.#stopController.signal,
              execution,
            )
          : await this.#slots.wait('encode', this.#stopController.signal, execution)
        : this.#slots.acquire('encode', execution);
    if (!release && !statusOnly) throw new Error('WORKER_NOT_READY');
    if (release) this.#executionIds.set(id, execution.executionId);
    const attemptLog = log.child({
      jobId: command.jobId,
      attemptId: command.attemptId,
      messageId: command.messageId,
    });
    attemptLog.info('COMMAND_RECEIVED');
    try {
      this.#stopController.signal.throwIfAborted();
      if (!statusOnly) requireSpace(this.#directory);
      const attempt = this.#journal.accept(command);
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
      this.#phase(command.attemptId, 'finalizing');
      this.#cleanup(command.attemptId);
      ack();
      this.#journal.markAckDispatched(command.attemptId);
      attemptLog.info('COMMAND_ACK_DISPATCHED');
    } finally {
      this.#executionIds.delete(id);
      this.#releaseSlot(release);
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
      this.#phase(command.attemptId, 'downloading');
      await this.#store.download(command, this.#directory, signal);
      const identity = processIdentity();
      if (!identity) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
      this.#journal.transition(command.attemptId, 'launching');
      this.#ownedProcesses.add(command.attemptId);
      this.#phase(command.attemptId, 'processing');
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
      this.#ownedProcesses.delete(command.attemptId);
      clearInterval(diskTimer);
    }
  }
}
