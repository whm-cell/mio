import { MEDIA_VERSION } from '@mio/compute-contracts';
import { createId } from '@mio/foundation/identifiers';
import { epochMs } from '@mio/foundation/time';
import {
  MEDIA_CORE_OPERATIONS,
  mediaObjectPrefix,
  mediaResourceClass,
  parseMediaCommand,
  parseMediaControl,
  parseMediaManifest,
  parseMediaResult,
} from '@mio/compute-contracts';
import type {
  MediaCommand,
  MediaControl,
  MediaFile,
  MediaResult,
  MediaFailureCode,
} from '@mio/compute-contracts';
import type { ObjectStore } from './adapters/cos.ts';
import type { Journal } from './adapters/journal.ts';
import { isJournalFailure } from './adapters/journal.ts';
import type { MediaAttempt, MediaJournal, MediaPhase } from './adapters/media-journal.ts';
import { MediaFiles } from './adapters/media-files.ts';
import { MediaProcessAdapter, mediaProcessGone } from './adapters/media-process.ts';
import type { MediaExecutor, LocalMediaFile } from './media-execution.ts';
import type { ResourceSlots } from './resource-slots.ts';

export type MediaStore = Pick<
  ObjectStore,
  'downloadMedia' | 'uploadMedia' | 'headMedia' | 'verifyMedia'
>;
export interface MediaPublisher {
  publishMedia(result: MediaResult): Promise<void>;
}
const MEDIA_EXECUTION_BUDGET_MS = 60 * 60 * 1000;
const terminal = (phase: MediaPhase) => ['succeeded', 'failed', 'cancelled'].includes(phase);
const failures: MediaFailureCode[] = [
  'INPUT_INVALID',
  'INPUT_CHANGED',
  'INPUT_TOO_LARGE',
  'INPUT_TOO_LONG',
  'OUTPUT_INVALID',
  'CAPABILITY_UNAVAILABLE',
  'EXECUTION_FAILED',
  'EXECUTION_TIMEOUT',
  'STORAGE_FAILURE',
  'WORKER_INTERRUPTED',
  'DISK_FULL',
];
type Outcome = MediaResult extends infer R
  ? R extends MediaResult
    ? Omit<R, 'version' | 'type' | 'messageId' | 'commandId' | 'jobId' | 'attemptId' | 'attempt'>
    : never
  : never;

/** An orphan can still consume CPU after a restart; reserve its slot before other runtimes start. */
export function reserveMediaProcesses(journal: MediaJournal, slots: ResourceSlots): void {
  for (const attempt of journal.unfinished()) {
    const resource = mediaResourceClass(attempt.command.operation),
      id = attempt.command.attemptId;
    slots.setHold(
      resource,
      id,
      Object.values(attempt.steps).some(
        (step) =>
          ['intent', 'running'].includes(step.state) &&
          !mediaProcessGone(step.pid, step.processIdentity),
      ),
    );
  }
}

/** Lifecycle and durable side effects only; operation plans enter through MediaExecutor. */
export class MediaWorker {
  readonly #store: MediaStore;
  readonly #publisher: MediaPublisher;
  readonly #journal: MediaJournal;
  readonly #directory: string;
  readonly #executor: MediaExecutor;
  readonly #stop: AbortSignal;
  readonly #slots: ResourceSlots;
  readonly #active = new Map<string, AbortController>();
  readonly #publishing = new Map<string, Promise<void>>();
  readonly #background = new Map<string, Promise<void>>();
  readonly #failed: (error: unknown) => void;
  #backgroundError: unknown;
  #closing = false;
  #healthy = true;
  constructor(
    store: MediaStore,
    publisher: MediaPublisher,
    journal: Pick<Journal, 'media'>,
    directory: string,
    executor: MediaExecutor,
    stop: AbortSignal,
    slots: ResourceSlots,
    failed: (error: unknown) => void = () => {},
  ) {
    this.#store = store;
    this.#publisher = publisher;
    this.#journal = journal.media;
    this.#directory = directory;
    this.#executor = executor;
    this.#stop = stop;
    this.#slots = slots;
    this.#failed = failed;
  }
  #event(attempt: MediaAttempt, outcome: Outcome): MediaResult {
    const command = attempt.command;
    return parseMediaResult({
      version: MEDIA_VERSION,
      type: 'media.result',
      messageId: createId(),
      commandId: command.messageId,
      jobId: command.jobId,
      attemptId: command.attemptId,
      attempt: command.attempt,
      ...outcome,
    });
  }
  #transition(attempt: MediaAttempt, phase: MediaPhase, outcome: Outcome): void {
    if (
      phase === 'reconciling' &&
      outcome.state === 'reconciling' &&
      attempt.phase === phase &&
      attempt.unknownCode === outcome.errorCode
    )
      return;
    this.#journal.transition(attempt, phase, this.#event(attempt, outcome));
    const resource = mediaResourceClass(attempt.command.operation),
      id = attempt.command.attemptId;
    this.#slots.setHold(
      resource,
      id,
      phase === 'reconciling' &&
        outcome.state === 'reconciling' &&
        outcome.errorCode === 'PROCESS_UNKNOWN',
    );
  }
  #flush(id: string): Promise<void> {
    const pending = this.#publishing.get(id);
    if (pending) return pending.then(() => this.#flush(id));
    const operation = (async () => {
      for (let event = this.#journal.pending(id); event; event = this.#journal.pending(id)) {
        await this.#publisher.publishMedia(event);
        this.#journal.confirm(event.messageId);
      }
    })().finally(() => {
      if (this.#publishing.get(id) === operation) this.#publishing.delete(id);
    });
    this.#publishing.set(id, operation);
    return operation;
  }
  async handle(command: MediaCommand, ack: () => void): Promise<void> {
    command = parseMediaCommand(command);
    if (!this.#healthy || this.#closing || this.#stop.aborted) throw new Error('WORKER_NOT_READY');
    await this.#background.get(command.attemptId);
    if (this.#active.has(command.attemptId)) throw new Error('WORKER_NOT_READY');
    const controller = new AbortController();
    this.#active.set(command.attemptId, controller);
    let release: (() => void) | undefined;
    try {
      const existing = this.#journal.get(command.attemptId);
      const attempt = this.#journal.accept(command);
      if (!terminal(attempt.phase) && existing && attempt.phase !== 'received') {
        await this.#recover(attempt);
      } else if (!terminal(attempt.phase) && this.#journal.cancelled(command.attemptId)) {
        this.#transition(attempt, 'cancelled', { state: 'cancelled' });
      } else if (!terminal(attempt.phase) && !MEDIA_CORE_OPERATIONS.includes(command.operation)) {
        this.#transition(attempt, 'failed', {
          state: 'failed',
          errorCode: 'CAPABILITY_UNAVAILABLE',
        });
      } else if (!terminal(attempt.phase)) {
        try {
          release = await this.#slots.wait(
            mediaResourceClass(command.operation),
            AbortSignal.any([this.#stop, controller.signal]),
          );
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          this.#settleError(attempt, error);
        }
        if (!terminal(attempt.phase)) {
          attempt.startedAt = epochMs();
          await this.#execute(attempt, controller);
        }
      }
      await this.#flush(command.attemptId);
      ack();
      attempt.ackDispatched = true;
      this.#journal.save(attempt);
      await this.#cleanup(attempt);
    } catch (error) {
      if (isJournalFailure(error)) this.#healthy = false;
      throw error;
    } finally {
      this.#active.delete(command.attemptId);
      release?.();
    }
  }
  async control(value: MediaControl, ack: () => void): Promise<void> {
    const control = parseMediaControl(value);
    try {
      if (!this.#healthy) throw new Error('WORKER_NOT_READY');
      const attempt = this.#journal.get(control.attemptId);
      if (attempt && attempt.command.jobId !== control.jobId) throw new Error('ATTEMPT_CONFLICT');
      if (control.action === 'cancel') {
        this.#journal.cancel(control);
        this.#active.get(control.attemptId)?.abort(new Error('MEDIA_CANCELLED'));
      }
      // Existing journal facts are the durable recovery intent. A crash after ACK is
      // recovered by the startup scan; no fresh attempt or external side effect is created.
      ack();
      if (attempt) this.#scheduleRecovery(control.attemptId);
    } catch (error) {
      if (isJournalFailure(error)) this.#healthy = false;
      throw error;
    }
  }
  #scheduleRecovery(id: string): void {
    if (this.#closing || this.#active.has(id) || this.#background.has(id)) return;
    const pending = this.#recoverOwned(id)
      .catch((error: unknown) => {
        this.#backgroundError ??= error;
        if (isJournalFailure(error)) this.#healthy = false;
        this.#failed(error);
      })
      .finally(() => this.#background.delete(id));
    this.#background.set(id, pending);
  }
  /** End admission and drain every ACKed recovery before releasing journal/broker ownership. */
  async close(): Promise<void> {
    this.#closing = true;
    for (const controller of this.#active.values()) controller.abort(new Error('WORKER_STOPPED'));
    await Promise.all(this.#background.values());
    if (this.#backgroundError) throw this.#backgroundError;
  }
  async recover(): Promise<void> {
    await Promise.all(this.#background.values());
    if (this.#backgroundError) throw this.#backgroundError;
    // Snapshot only pre-existing attempts. Concurrent live attempts must never be recovered.
    const attempts = this.#journal.recoverable();
    try {
      for (const attempt of attempts) await this.#recoverOwned(attempt.command.attemptId);
    } catch (error) {
      if (isJournalFailure(error)) this.#healthy = false;
      throw error;
    }
  }
  /** Only known terminal copies are eligible; unknown attempts are never swept. */
  async cleanupExpired(): Promise<void> {
    try {
      for (const attempt of this.#journal.cleanupCandidates())
        await this.#recoverOwned(attempt.command.attemptId);
    } catch (error) {
      if (isJournalFailure(error)) this.#healthy = false;
      throw error;
    }
  }
  async #recoverOwned(id: string): Promise<void> {
    if (this.#active.has(id)) return;
    const attempt = this.#journal.get(id);
    if (!attempt) return;
    this.#active.set(id, new AbortController());
    try {
      await this.#recover(attempt);
    } finally {
      this.#active.delete(id);
    }
  }
  async #recover(attempt: MediaAttempt): Promise<void> {
    const id = attempt.command.attemptId;
    const signal = AbortSignal.any([
      this.#stop,
      this.#active.get(id)!.signal,
      AbortSignal.timeout(MEDIA_EXECUTION_BUDGET_MS),
    ]);
    if (terminal(attempt.phase)) {
      this.#slots.setHold(mediaResourceClass(attempt.command.operation), id, false);
      await this.#flush(id);
      await this.#cleanup(attempt);
      return;
    }
    // A disconnected delivery may be durable while still waiting for a slot.
    if (attempt.phase === 'received' && !this.#journal.cancelled(id)) return;
    const uncertain = Object.values(attempt.steps).filter((step) =>
      ['intent', 'running'].includes(step.state),
    );
    const resource = mediaResourceClass(attempt.command.operation);
    const hasUnknownProcess = uncertain.some(
      (step) => !mediaProcessGone(step.pid, step.processIdentity),
    );
    this.#slots.setHold(resource, id, hasUnknownProcess);
    if (hasUnknownProcess) {
      this.#transition(attempt, 'reconciling', {
        state: 'reconciling',
        errorCode: 'PROCESS_UNKNOWN',
      });
    } else if (Object.values(attempt.uploads).some((upload) => upload.state === 'intent')) {
      await this.#recoverOutputs(attempt, signal);
    } else if (this.#journal.cancelled(id))
      this.#transition(attempt, 'cancelled', { state: 'cancelled' });
    else if (
      attempt.result &&
      (['output_ready', 'uploading'].includes(attempt.phase) ||
        attempt.unknownCode === 'UPLOAD_UNKNOWN')
    ) {
      await this.#recoverOutputs(attempt, signal);
    } else if (uncertain.length > 0 || attempt.phase !== 'reconciling')
      this.#transition(attempt, 'failed', { state: 'failed', errorCode: 'WORKER_INTERRUPTED' });
    await this.#flush(id);
    await this.#cleanup(attempt);
  }
  async #recoverOutputs(attempt: MediaAttempt, signal: AbortSignal): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await this.#slots.waitForOutputRecovery(
        mediaResourceClass(attempt.command.operation),
        signal,
      );
      for (const upload of Object.values(attempt.uploads)) {
        if (upload.state !== 'intent') continue;
        upload.object = await this.#verifyObject(upload.key, upload.file, upload.digest, signal);
        signal.throwIfAborted();
        upload.state = 'confirmed';
        this.#journal.save(attempt);
      }
      if (this.#journal.cancelled(attempt.command.attemptId))
        this.#transition(attempt, 'cancelled', { state: 'cancelled' });
      else await this.#finish(attempt, signal);
    } catch (error) {
      if (this.#stop.aborted) throw error;
      this.#settleError(attempt, error);
    } finally {
      release?.();
    }
  }
  async #cleanup(attempt: MediaAttempt, superseded = false): Promise<void> {
    if (!terminal(attempt.phase) || this.#journal.pending(attempt.command.attemptId)) return;
    if (attempt.phase === 'failed' && attempt.failedAt === undefined) {
      // Older journal entries have no failure timestamp: start a conservative retention window.
      attempt.failedAt = epochMs();
      this.#journal.save(attempt);
    }
    if (
      attempt.phase === 'failed' &&
      !superseded &&
      attempt.command.attempt < 3 &&
      epochMs() - attempt.failedAt! < 24 * 60 * 60 * 1000
    )
      return;
    if (
      Object.values(attempt.steps).some(
        (step) =>
          ['intent', 'running'].includes(step.state) &&
          !mediaProcessGone(step.pid, step.processIdentity),
      )
    )
      return;
    if (!attempt.cleaned) {
      await new MediaFiles(this.#directory, attempt.command.attemptId).clean();
      attempt.cleaned = true;
      this.#journal.save(attempt);
    }
    if (
      attempt.phase === 'succeeded' ||
      attempt.phase === 'cancelled' ||
      attempt.command.attempt === 3
    )
      for (const prior of this.#journal.predecessors(attempt.command))
        await this.#cleanup(prior, true);
  }
  async #execute(attempt: MediaAttempt, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([
      controller.signal,
      this.#stop,
      AbortSignal.timeout(Math.max(1, MEDIA_EXECUTION_BUDGET_MS - (epochMs() - attempt.startedAt))),
    ]);
    try {
      if (this.#journal.cancelled(attempt.command.attemptId)) {
        this.#transition(attempt, 'cancelled', { state: 'cancelled' });
        return;
      }
      const files = new MediaFiles(this.#directory, attempt.command.attemptId);
      if (attempt.phase === 'received') await this.#reuseCheckpoints(attempt, files, signal);
      attempt.phase = 'downloading';
      this.#journal.save(attempt);
      for (const [index, input] of attempt.command.inputs.entries()) {
        const name = `input-${index}`;
        const prior = attempt.inputs[name];
        if (!prior) await this.#store.downloadMedia(input, files, name, signal);
        const digest = await files.digest(name, signal);
        if (digest.size !== input.sizeBytes) throw new Error('INPUT_CHANGED');
        if (prior && (prior.size !== digest.size || prior.sha256 !== digest.sha256))
          throw new Error('OUTPUT_MISMATCH');
        attempt.inputs[name] = digest;
        this.#journal.save(attempt);
      }
      this.#transition(attempt, 'executing', { state: 'running', stage: 'execute', progress: 0 });
      let lastProgress = 0,
        lastStage = '';
      const progress = (stage: string, fraction: number) => {
        if (epochMs() - lastProgress < 2000 && stage === lastStage && fraction !== 1) return;
        lastProgress = epochMs();
        lastStage = stage;
        this.#transition(attempt, 'executing', { state: 'running', stage, progress: fraction });
        void this.#flush(attempt.command.attemptId).catch((error) => {
          if (isJournalFailure(error)) {
            this.#healthy = false;
            controller.abort(error);
          }
        });
      };
      const process = new MediaProcessAdapter(files, this.#journal, attempt, signal, progress);
      attempt.result = await this.#executor(attempt.command, {
        run: (step) => process.run(step),
      });
      signal.throwIfAborted();
      attempt.phase = 'output_ready';
      this.#journal.save(attempt);
      await this.#finish(attempt, signal);
    } catch (error) {
      if (isJournalFailure(error)) throw error;
      if (this.#stop.aborted && !this.#journal.cancelled(attempt.command.attemptId)) throw error;
      this.#settleError(
        attempt,
        controller.signal.aborted
          ? controller.signal.reason
          : signal.aborted
            ? new Error('EXECUTION_TIMEOUT')
            : error,
      );
    }
  }
  async #reuseCheckpoints(
    attempt: MediaAttempt,
    files: MediaFiles,
    signal: AbortSignal,
  ): Promise<void> {
    const prior = this.#journal.checkpointSource(attempt.command);
    if (!prior) return;
    if (
      Object.values(prior.steps).some(
        (step) =>
          ['intent', 'running'].includes(step.state) &&
          !mediaProcessGone(step.pid, step.processIdentity),
      )
    )
      throw new Error('PROCESS_UNKNOWN');
    const source = new MediaFiles(this.#directory, prior.command.attemptId);
    for (const [name, digest] of Object.entries(prior.inputs)) {
      await files.reuse(source, name, digest, signal);
      attempt.inputs[name] = digest;
      this.#journal.save(attempt);
    }
    for (const [id, checkpoint] of Object.entries(prior.steps)) {
      if (checkpoint.state !== 'complete' || !checkpoint.result) continue;
      for (const [name, digest] of Object.entries(checkpoint.outputs))
        await files.reuse(source, name, digest, signal);
      attempt.steps[id] = {
        ...structuredClone(checkpoint),
        reusedFromAttemptId: prior.command.attemptId,
      };
      this.#journal.save(attempt);
    }
  }
  #settleError(attempt: MediaAttempt, error: unknown): void {
    if (isJournalFailure(error)) {
      this.#healthy = false;
      throw error;
    }
    const code =
      (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'
        ? 'DISK_FULL'
        : error instanceof Error
          ? error.message
          : '';
    const processUnknown = Object.values(attempt.steps).some(
      (step) =>
        ['intent', 'running'].includes(step.state) &&
        !mediaProcessGone(step.pid, step.processIdentity),
    );
    if (
      processUnknown ||
      code === 'PROCESS_UNKNOWN' ||
      code === 'OUTPUT_MISMATCH' ||
      code === 'UPLOAD_UNKNOWN' ||
      Object.values(attempt.uploads).some((upload) => upload.state === 'intent')
    ) {
      this.#transition(attempt, 'reconciling', {
        state: 'reconciling',
        errorCode:
          code === 'OUTPUT_MISMATCH'
            ? 'OUTPUT_MISMATCH'
            : code === 'PROCESS_UNKNOWN' || processUnknown
              ? 'PROCESS_UNKNOWN'
              : 'UPLOAD_UNKNOWN',
      });
    } else if (this.#journal.cancelled(attempt.command.attemptId))
      this.#transition(attempt, 'cancelled', { state: 'cancelled' });
    else
      this.#transition(attempt, 'failed', {
        state: 'failed',
        errorCode: failures.includes(code as MediaFailureCode)
          ? (code as MediaFailureCode)
          : 'EXECUTION_FAILED',
      });
  }
  async #verifyObject(
    key: string,
    file: LocalMediaFile,
    digest: { size: number; sha256: string },
    signal: AbortSignal,
  ): Promise<MediaFile> {
    const object = await this.#store.headMedia(key, signal);
    if (!object) throw new Error('UPLOAD_UNKNOWN');
    if (
      object.sizeBytes !== digest.size ||
      object.sha256 !== digest.sha256 ||
      !(await this.#store.verifyMedia(key, object.etag, digest.size, digest.sha256, signal))
    )
      throw new Error('OUTPUT_MISMATCH');
    return { ...file, key, sizeBytes: digest.size, sha256: digest.sha256, etag: object.etag };
  }
  async #upload(
    attempt: MediaAttempt,
    files: MediaFiles,
    file: LocalMediaFile,
    signal: AbortSignal,
  ): Promise<MediaFile> {
    signal.throwIfAborted();
    const key = mediaObjectPrefix(attempt.command.jobId, attempt.command.attemptId) + file.name;
    const actual = await files.digest(file.name, signal);
    const prior = attempt.uploads[file.name];
    if (prior) {
      if (prior.state === 'rejected') throw new Error('EXECUTION_FAILED');
      if (
        prior.key !== key ||
        prior.digest.size !== actual.size ||
        prior.digest.sha256 !== actual.sha256
      )
        throw new Error('OUTPUT_MISMATCH');
      return this.#verifyObject(key, file, actual, signal);
    }
    const existing = await this.#store.headMedia(key, signal);
    attempt.uploads[file.name] = { file, key, digest: actual, state: 'intent', object: null };
    this.#journal.save(attempt);
    if (!existing) {
      try {
        await this.#store.uploadMedia(key, files, file.name, actual, file.contentType, signal);
      } catch (error) {
        if (error instanceof Error && error.message === 'STORAGE_WRITE_REJECTED') {
          attempt.uploads[file.name]!.state = 'rejected';
          this.#journal.save(attempt);
          throw new Error('EXECUTION_FAILED', { cause: error });
        }
        throw error;
      }
    }
    const object = await this.#verifyObject(key, file, actual, signal);
    attempt.uploads[file.name]!.state = 'confirmed';
    attempt.uploads[file.name]!.object = object;
    this.#journal.save(attempt);
    return object;
  }
  async #finish(attempt: MediaAttempt, signal: AbortSignal): Promise<void> {
    if (!attempt.result) throw new Error('OUTPUT_MISMATCH');
    const files = new MediaFiles(this.#directory, attempt.command.attemptId);
    const command = attempt.command,
      prefix = mediaObjectPrefix(command.jobId, command.attemptId);
    // Validate the entire output inventory before the first external side effect.
    parseMediaManifest({
      version: MEDIA_VERSION,
      jobId: command.jobId,
      attemptId: command.attemptId,
      profile: command.profile,
      operation: command.operation,
      data: attempt.result.data,
      files: attempt.result.files.map((file) => ({
        ...file,
        key: prefix + file.name,
        sizeBytes: 1,
        etag: 'pending',
        sha256: '0'.repeat(64),
      })),
    });
    for (const step of Object.values(attempt.steps))
      for (const [name, digest] of Object.entries(step.outputs)) {
        const actual = await files.digest(name, signal);
        if (actual.size !== digest.size || actual.sha256 !== digest.sha256)
          throw new Error('OUTPUT_MISMATCH');
      }
    attempt.phase = 'uploading';
    this.#journal.save(attempt);
    const uploaded: MediaFile[] = [];
    for (const file of attempt.result.files) {
      if (this.#journal.cancelled(command.attemptId)) throw new Error('MEDIA_CANCELLED');
      uploaded.push(await this.#upload(attempt, files, file, signal));
    }
    const manifest = parseMediaManifest({
      version: MEDIA_VERSION,
      jobId: command.jobId,
      attemptId: command.attemptId,
      profile: command.profile,
      operation: command.operation,
      files: uploaded,
      data: attempt.result.data,
    });
    await files.write('manifest.json', JSON.stringify(manifest));
    if (this.#journal.cancelled(command.attemptId)) throw new Error('MEDIA_CANCELLED');
    const object = await this.#upload(
      attempt,
      files,
      { name: 'manifest.json', role: 'data', contentType: 'application/json' },
      signal,
    );
    const { key, sizeBytes, sha256, etag } = object;
    if (this.#journal.cancelled(command.attemptId))
      this.#transition(attempt, 'cancelled', { state: 'cancelled' });
    else
      this.#transition(attempt, 'succeeded', {
        state: 'succeeded',
        manifest: { key, sizeBytes, sha256, etag },
      });
  }
}
