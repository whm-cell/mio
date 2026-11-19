import { epochMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import type { ProviderService } from '../providers/service.ts';
import { imageReferencesWithinBudget, validateImageInputByRoute } from './contracts.ts';
import type { ImageAssetRef } from './contracts.ts';
import {
  createRoutedImageProtocol,
  defaultRouteAsyncTransport,
} from '../integrations/onelink/router.ts';
import { matchesImageSignature } from '../integrations/onelink/shared/index.ts';
import type { AsyncImageTransport, ReadImage } from '../integrations/onelink/shared/index.ts';
import { withPublicHttps } from '../integrations/onelink/public-https.ts';
import { createImageDecoder } from './decode.ts';
import type { GenerationExecution, GenerationObjects } from './execution.ts';
import type { GenerationStore } from './store.ts';
import type { GenerationFiles } from './files.ts';
import { materializeGeneration } from './materialize.ts';

const log = createLogger('app', 'generation-executor');

export interface GenerationTransports {
  transport?: typeof fetch;
  asyncTransport?: AsyncImageTransport;
  download?: typeof withPublicHttps;
}

export function createGenerationRunner(
  store: GenerationStore,
  files: GenerationFiles,
  objects: GenerationObjects,
  provider: () => ProviderService | undefined,
  stop: AbortSignal,
  transports: GenerationTransports = {},
) {
  const decode = createImageDecoder();
  const materialize = async (row: GenerationExecution) => {
    const stored = await files.load(
      row.id,
      row.command.messageId,
      row.command.input.n ?? 1,
      row.checkpoint,
    );
    if (!stored) {
      await store.terminal(row, 'materialization_failed', null);
      return;
    }
    if (!(await store.checkpoint(row, stored.ref))) return;
    if (
      (await materializeGeneration(row, stored.checkpoint, store, files, objects, decode, stop)) ===
      'completed'
    )
      await verify(row);
  };
  const returned = async (
    row: GenerationExecution,
    images: ({ base64: string; format?: 'png' | 'jpeg' | 'webp' } | null)[],
  ) => {
    let stored;
    try {
      stored = await files.receive(
        row.id,
        row.command.messageId,
        row.command.input.n ?? 1,
        images,
        row.command.route.outputSpec.fixedOutputFormat ?? row.command.input.output_format ?? 'png',
      );
    } catch (error) {
      if (files.storageFailed) await store.storageFailure(row);
      throw error;
    }
    if (files.storageFailed) await store.storageFailure(row);
    if (!(await store.checkpoint(row, stored.ref))) return;
    if (
      (await materializeGeneration(row, stored.checkpoint, store, files, objects, decode, stop)) ===
      'completed'
    )
      await verify(row);
  };
  const verify = async (row: GenerationExecution) => {
    const admitted = row.admitted;
    if (
      typeof admitted.providerConfigId !== 'string' ||
      typeof admitted.modelKey !== 'string' ||
      typeof admitted.credentialVersion !== 'number' ||
      typeof admitted.catalogVersion !== 'number' ||
      typeof admitted.adaptationVersion !== 'number' ||
      typeof admitted.profile !== 'string'
    )
      return;
    await provider()
      ?.recordVerification(
        { userId: row.owner_id },
        {
          providerConfigId: admitted.providerConfigId,
          modelKey: admitted.modelKey,
          credentialVersion: admitted.credentialVersion,
          catalogVersion: admitted.catalogVersion,
          adaptationVersion: admitted.adaptationVersion,
          operation: 'image.generate',
          profile: admitted.profile,
        },
        'image:' + row.id,
      )
      .catch(() => log.error('PROVIDER_VERIFICATION_UNAVAILABLE'));
  };
  const protocol = (row: GenerationExecution, read: ReadImage, transport: typeof fetch) => {
    const route = row.command.route;
    const download = transports.download ?? withPublicHttps;
    return createRoutedImageProtocol(
      route,
      row.command.input.operation ?? 'generate',
      transport,
      read,
      transports.asyncTransport ?? defaultRouteAsyncTransport(route, transport, read, download),
      download,
    );
  };
  const read = (): ReadImage => {
    const cached = new Map<string, Uint8Array>();
    return async (ref: ImageAssetRef, signal: AbortSignal) => {
      const bytes = cached.get(ref.assetId);
      if (bytes) return bytes;
      if (!objects.readImage) throw new Error('IMAGE_INPUT_UNAVAILABLE');
      const value = await objects.readImage(ref.key, ref.etag, ref.sizeBytes, signal);
      cached.set(ref.assetId, value);
      return value;
    };
  };
  const submit = async (row: GenerationExecution) => {
    const input = row.command.input;
    if (!validateImageInputByRoute(input, row.command.route)) {
      await store.terminal(row, 'rejected', 'IMAGE_INPUT_INVALID');
      return;
    }
    if (!imageReferencesWithinBudget(input)) {
      await store.terminal(row, 'rejected', 'IMAGE_REFERENCE_LIMIT');
      return;
    }
    const providers = provider();
    if (!row.snapshot || !providers || row.command.expiresAt <= epochMs()) {
      await store.terminal(row, 'rejected', 'IMAGE_CREDENTIAL_UNAVAILABLE');
      return;
    }
    const reader = read();
    const bounded = AbortSignal.any([stop, AbortSignal.timeout(180_000)]);
    const refs = input.images ?? (input.image ? [input.image] : []);
    const sources = input.mask ? [...refs, input.mask] : refs;
    for (const ref of sources) {
      if (!matchesImageSignature(await reader(ref, bounded), ref.contentType)) {
        await store.terminal(row, 'rejected', 'IMAGE_INPUT_INVALID');
        return;
      }
    }
    if (row.command.expiresAt <= epochMs() || stop.aborted) {
      await store.terminal(row, 'rejected', 'IMAGE_CREDENTIAL_UNAVAILABLE');
      return;
    }
    let key: string;
    try {
      key = providers.openImageSnapshot(row.owner_id, row.snapshot);
    } catch {
      await store.terminal(row, 'rejected', 'IMAGE_CREDENTIAL_UNAVAILABLE');
      return;
    }
    if (!(await store.submitting(row))) return;
    let sent = false;
    const transport: typeof fetch = async (url, options) => {
      if (row.command.expiresAt <= epochMs() || stop.aborted) throw new Error('IMAGE_DEADLINE');
      sent = true;
      return (transports.transport ?? fetch)(url, options);
    };
    const driver = protocol(row, reader, transport);
    const result = input.async
      ? await driver.submitAsync(input, key, bounded)
      : await driver.submit(input, key, bounded, reader);
    if (result.state === 'returned') await returned(row, result.images);
    else if (result.state === 'submitted') await store.submitted(row, result.upstreamTaskId);
    else if (!sent && (row.command.expiresAt <= epochMs() || stop.aborted))
      await store.terminal(row, 'rejected', 'IMAGE_CREDENTIAL_UNAVAILABLE');
    else await store.terminal(row, result.state, result.code);
  };
  const query = async (claimed: GenerationExecution) => {
    // A successful response can reach durable storage before its PG checkpoint.
    // Recover it before spending another query or rejecting an expired budget.
    if (await files.load(claimed.id, claimed.command.messageId, claimed.command.input.n ?? 1)) {
      await materialize(claimed);
      return;
    }
    const row = await store.beginQuery(claimed);
    if (!row) {
      await store.terminal(claimed, 'failed', 'IMAGE_QUERY_LIMIT');
      return;
    }
    let key: string;
    try {
      const providers = provider();
      if (!providers) throw new Error('IMAGE_CREDENTIAL_UNAVAILABLE');
      key = await providers.resolveImageTaskCredential(row.owner_id);
    } catch {
      await store.terminal(row, 'failed', 'IMAGE_CREDENTIAL_UNAVAILABLE');
      return;
    }
    if (stop.aborted) {
      await store.release(row);
      return;
    }
    if (!(await store.queryInTime(row))) {
      await store.terminal(row, 'failed', 'IMAGE_QUERY_LIMIT');
      return;
    }
    const deadline = Math.min(row.command.expiresAt, row.async_deadline!.getTime());
    const bounded = AbortSignal.any([stop, AbortSignal.timeout(Math.max(1, deadline - epochMs()))]);
    const transport: typeof fetch = async (url, options) => {
      if (stop.aborted || epochMs() >= deadline) throw new Error('IMAGE_QUERY_LIMIT');
      return (transports.transport ?? fetch)(url, options);
    };
    const result = await protocol(row, read(), transport).queryAsync(
      row.command.input,
      key,
      row.upstream_task_id!,
      row.query_attempt,
      bounded,
    );
    if (result.state === 'returned') await returned(row, result.images);
    else if (stop.aborted) await store.release(row);
    else if (result.state === 'processing') await store.processing(row);
    else
      await store.terminal(
        row,
        'failed',
        epochMs() >= deadline ? 'IMAGE_QUERY_LIMIT' : result.code,
      );
  };
  return async (row: GenerationExecution): Promise<void> => {
    try {
      stop.throwIfAborted();
      if (row.phase === 'ready') await submit(row);
      else if (row.phase === 'waiting') await query(row);
      else if (row.phase === 'materializing') await materialize(row);
      else if (row.phase === 'submitting') {
        const stored = await files.load(row.id, row.command.messageId, row.command.input.n ?? 1);
        if (stored) await materialize(row);
        else await store.terminal(row, 'unknown', 'IMAGE_SUBMISSION_UNKNOWN');
      }
    } finally {
      if (files.storageFailed) await store.storageFailure(row);
    }
  };
}
