import { createLogger } from '@mio/foundation/logging';
import type { Authentication } from '../auth/service.ts';
import type { ConversationService } from '../conversations/service.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import { createAssetGc } from '../assets/gc.ts';
import {
  collectDeletedAccountAssets,
  deleteAssetAccountRows,
  releaseDeletedAccountHolds,
} from '../assets/account-deletion.ts';
import { deleteGenerationFiles, deleteGenerationRows } from '../generations/account-deletion.ts';
import { deleteComputeAccount } from '../compute/account-deletion.ts';
import { deleteProviderAccount, revokeDeletedAccount } from '../providers/account-deletion.ts';
import { deleteMaterialAccount } from '../materials/account-deletion.ts';
import {
  deleteCreationLogAccount,
  deleteNotificationAccount,
} from '../notifications/account-deletion.ts';
import { createAccountDomainStore } from './domain-store.ts';
import { accountDeletionDomainNames } from './domain-schema.ts';
import type { AccountDomainStore, DeletionSlice } from './domain-store.ts';
import { createAccountDeletionStore } from './store.ts';
import type { CleanupJob } from './store.ts';
import { startAccountDeletion, CleanupFailure } from './scheduler.ts';
import type { CleanupStep } from './scheduler.ts';

const log = createLogger('app', 'account-deletion');
interface RuntimeOptions {
  auth: Authentication;
  authDatabaseURL: string;
  providers?: { databaseURL: string; drain(owner: string): Promise<void> };
  notificationsDatabaseURL?: string;
  materialsDatabaseURL?: string;
  conversations?: () => ConversationService | undefined;
  media?: {
    databaseURL: string;
    objects: AssetObjectStore;
    deleteEnabled: boolean;
    generationDirectory?: string;
    cleanStaging(): Promise<void>;
    drainAssets(owner: string): Promise<void>;
    drainGenerations(owner: string, kinds: readonly ('image' | 'video')[]): Promise<void>;
  };
}

/** Domain pools, file owners and object I/O meet only here, through explicit callbacks. */
export async function createAccountDeletionRuntime(options: RuntimeOptions) {
  const jobs = await createAccountDeletionStore(options.authDatabaseURL);
  const stores: AccountDomainStore[] = [];
  let media: AccountDomainStore | undefined,
    providers: AccountDomainStore | undefined,
    notifications: AccountDomainStore | undefined,
    materials: AccountDomainStore | undefined;
  try {
    const opened = await Promise.allSettled([
      options.media && createAccountDomainStore(options.media.databaseURL, 'media'),
      options.providers && createAccountDomainStore(options.providers.databaseURL, 'providers'),
      options.notificationsDatabaseURL &&
        createAccountDomainStore(options.notificationsDatabaseURL, 'notifications'),
      options.materialsDatabaseURL &&
        createAccountDomainStore(options.materialsDatabaseURL, 'materials'),
    ]);
    for (const item of opened)
      if (item.status === 'fulfilled' && item.value) stores.push(item.value);
    const failed = opened.find((item) => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    [media, providers, notifications, materials] = opened.map((item) =>
      item.status === 'fulfilled' ? item.value || undefined : undefined,
    );
    const tables = new Set(
      media
        ? (
            await media.read<{ name: string }>(`SELECT tablename AS name FROM pg_tables
      WHERE schemaname=ANY(current_schemas(false))`)
          ).map((row) => row.name)
        : [],
    );
    const hasGenerations = tables.has('mio_image_jobs') || tables.has('mio_video_jobs');
    const hasCompute = tables.has('mio_compute_jobs') || tables.has('mio_media_jobs');
    const hasCreation = tables.has('mio_creation_logs');
    const gc =
      media && options.media
        ? createAssetGc(media, options.media.objects, options.media.deleteEnabled)
        : undefined;
    if (!materials && media && tables.has('mio_material_groups')) {
      materials = await createAccountDomainStore(options.media!.databaseURL, 'materials');
      stores.push(materials);
    }
    const domains = accountDeletionDomainNames(
      [
        ...(providers ? ['providers'] : []),
        ...(notifications ? ['notifications'] : []),
        ...(materials ? ['materials'] : []),
        ...(options.conversations ? ['conversations'] : []),
      ],
      tables,
    );
    const stop = new AbortController();
    const urgent = async (owner: string, finalizedAt: Date): Promise<DeletionSlice> => {
      const phases: { name: string; run(): Promise<DeletionSlice> }[] = [];
      if (providers)
        phases.push({
          name: 'providers',
          run: () => revokeDeletedAccount(providers!, owner, finalizedAt),
        });
      if (options.conversations)
        phases.push({
          name: 'conversations',
          async run() {
            const service = options.conversations!();
            if (!service) throw new Error('LOCAL_SESSION_VOLUME_NOT_OWNED');
            return service.cancelDeletedAccount(owner, finalizedAt);
          },
        });
      for (const [name, store] of [
        ['media', media],
        ['notifications', notifications],
        ['materials', materials],
      ] as const)
        if (store)
          phases.push({
            name,
            async run() {
              await store.closeAccount(owner, finalizedAt);
              let remaining = 0;
              if (name === 'media' && hasGenerations)
                remaining = await store.transaction(owner, async (client) => {
                  for (const kind of ['image', 'video']) {
                    const ids = (
                      await client.query<{ id: string }>(
                        `SELECT id FROM mio_${kind}_jobs WHERE owner_id=$1
                AND (admitted<>'{}'::jsonb OR route_snapshot IS NOT NULL) ORDER BY id LIMIT 100`,
                        [owner],
                      )
                    ).rows.map((row) => row.id);
                    await client.query(
                      `UPDATE mio_${kind}_jobs SET admitted='{}',route_snapshot=NULL WHERE id=ANY($1::uuid[])`,
                      [ids],
                    );
                    await client.query(
                      `UPDATE mio_${kind}_executions SET snapshot='{}' WHERE job_id=ANY($1::uuid[])`,
                      [ids],
                    );
                  }
                  return (
                    await client.query<{ remaining: number }>(
                      `SELECT ((SELECT count(*) FROM mio_image_jobs WHERE owner_id=$1
              AND (admitted<>'{}'::jsonb OR route_snapshot IS NOT NULL))+(SELECT count(*) FROM mio_video_jobs WHERE owner_id=$1
              AND (admitted<>'{}'::jsonb OR route_snapshot IS NOT NULL)))::integer AS remaining`,
                      [owner],
                    )
                  ).rows[0]!.remaining;
                });
              return { done: remaining === 0, remaining };
            },
          });
      const results = await Promise.allSettled(phases.map((phase) => phase.run()));
      let remaining = 0;
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected')
          throw new CleanupFailure(phases[index]!.name, 'ACCOUNT_CLEANUP_PHASE_FAILED');
        remaining += result.value.remaining;
      }
      return { done: remaining === 0, remaining };
    };
    const archive = async (owner: string, finalizedAt: Date, signal: AbortSignal) => {
      if (!options.media?.objects.archiveAccountDeletion)
        throw new CleanupFailure('archive', 'ACCOUNT_ARCHIVE_UNAVAILABLE');
      await options.media.objects.archiveAccountDeletion(
        { userId: owner, finalizedAt: finalizedAt.toISOString() },
        signal,
      );
      return { done: true, remaining: 0 };
    };
    const steps: CleanupStep[] = [
      { name: 'immediate', run: (job) => urgent(job.user_id, job.finalized_at) },
    ];
    if (providers)
      steps.push({
        name: 'providers',
        run: (job) =>
          deleteProviderAccount(providers!, job.user_id, gc, () =>
            options.providers!.drain(job.user_id),
          ),
      });
    if (options.conversations)
      steps.push({
        name: 'conversations',
        async run(job, signal) {
          const service = options.conversations!();
          if (!service) throw new Error('LOCAL_SESSION_VOLUME_NOT_OWNED');
          return service.deleteAccountBatch(job.user_id, signal);
        },
      });
    if (materials)
      steps.push({
        name: 'materials',
        run: (job) => deleteMaterialAccount(materials!, job.user_id),
      });
    if (notifications)
      steps.push({
        name: 'notifications',
        run: (job) => deleteNotificationAccount(notifications!, job.user_id),
      });
    if (media && gc && hasGenerations)
      steps.push({
        name: 'generations',
        async run(job, signal) {
          const ids = await deleteGenerationFiles(
            media!,
            gc,
            job.user_id,
            options.media?.generationDirectory,
            signal,
            (kinds) => options.media!.drainGenerations(job.user_id, kinds),
          );
          return deleteGenerationRows(media!, job.user_id, ids);
        },
      });
    if (media && gc && hasCompute)
      steps.push({
        name: 'compute',
        run: (job, signal) =>
          deleteComputeAccount(media!, gc, job.user_id, options.media!.objects, signal),
      });
    if (media && hasCreation)
      steps.push({
        name: 'creation-logs',
        run: (job) => deleteCreationLogAccount(media!, job.user_id),
      });
    steps.push({ name: 'auth', run: (job) => options.auth.cleanupDeletedAccount(job.user_id) });
    if (media && gc) {
      steps.push({
        name: 'asset-holds',
        run: (job) => releaseDeletedAccountHolds(media!, job.user_id),
      });
      steps.push({
        name: 'physical-gc',
        run: (job, signal) =>
          collectDeletedAccountAssets(
            media!,
            gc,
            job.user_id,
            job.finalized_at,
            signal,
            options.media!.cleanStaging,
            () => options.media!.drainAssets(job.user_id),
          ),
      });
      steps.push({ name: 'assets', run: (job) => deleteAssetAccountRows(media!, job.user_id) });
    }
    const finalScan = async (job: CleanupJob, signal: AbortSignal) => {
      if (job.required_domains.some((domain) => !domains.includes(domain)))
        throw new CleanupFailure('final-scan', 'ACCOUNT_CLEANUP_DOMAIN_MISSING');
      await options.media?.objects.archiveAccountDeletion?.(
        { userId: job.user_id, finalizedAt: job.finalized_at.toISOString() },
        signal,
      );
      let remaining = 0;
      if (media && gc) {
        const physical = await gc.collect(job.user_id, signal);
        remaining += physical.remaining;
        remaining += Number(
          (
            await media.read<{ count: string }>(
              'SELECT count(*) FROM mio_assets WHERE owner_id=$1',
              [job.user_id],
            )
          )[0]!.count,
        );
        remaining += Number(
          (
            await media.read<{ count: string }>(
              'SELECT count(*) FROM mio_asset_holders WHERE owner_id=$1',
              [job.user_id],
            )
          )[0]!.count,
        );
      }
      for (const store of stores) {
        remaining += Number(
          (
            await store.read<{ count: string }>(
              `SELECT count(*) FROM mio_account_cleanup_receipts
          WHERE user_id=$1 AND (completed_at IS NULL OR remaining<>0)`,
              [job.user_id],
            )
          )[0]!.count,
        );
      }
      return { done: remaining === 0, remaining };
    };
    steps.push({
      name: 'archive',
      run: (job, signal) => archive(job.user_id, job.finalized_at, signal),
    });
    steps.push({ name: 'final-scan', run: finalScan });
    const scheduler = startAccountDeletion(jobs, steps);
    const waking = new Map<string, Promise<unknown>>();
    let collecting: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const collect = () => {
      if (stop.signal.aborted || collecting || !media || !gc || !gc.deleteEnabled) return;
      collecting = (async () => {
        const owners = await media.read<{
          owner_id: string;
        }>(`SELECT r.owner_id FROM mio_asset_gc_requests r
          JOIN mio_asset_gc_objects g ON g.object_key=r.object_key WHERE g.next_attempt_at<=clock_timestamp() AND (g.state='pending'
          OR (g.state='deleting' AND g.lease_until<=clock_timestamp())) GROUP BY r.owner_id
          ORDER BY min(r.requested_at),r.owner_id LIMIT 10`);
        for (const owner of owners) {
          if (stop.signal.aborted) break;
          try {
            await gc.collect(
              owner.owner_id,
              AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
            );
          } catch {
            log.warn('ACCOUNT_ASSET_GC_PENDING');
          }
        }
      })()
        .catch(() => log.warn('ACCOUNT_ASSET_GC_PENDING'))
        .finally(() => {
          collecting = undefined;
        });
    };
    const timer = setInterval(collect, 1000);
    timer.unref();
    collect();
    return {
      domains,
      gc,
      wake(owner: string, finalizedAt: Date) {
        if (stop.signal.aborted) return;
        if (!waking.has(owner)) {
          const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]);
          const pending = Promise.allSettled([
            urgent(owner, finalizedAt),
            archive(owner, finalizedAt, signal),
          ]).finally(() => waking.delete(owner));
          waking.set(owner, pending);
        }
        scheduler.wake();
      },
      round: scheduler.round,
      monitor: scheduler.monitor,
      close() {
        return (closing ??= (async () => {
          stop.abort();
          clearInterval(timer);
          await Promise.allSettled([...waking.values(), collecting, scheduler.close()]);
          await Promise.all(stores.map((store) => store.close()));
        })());
      },
    };
  } catch (error) {
    await Promise.allSettled([jobs.close(), ...stores.map((store) => store.close())]);
    throw error;
  }
}
export type AccountDeletionRuntime = Awaited<ReturnType<typeof createAccountDeletionRuntime>>;
