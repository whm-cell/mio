import { sha256Utf8 } from '@mio/foundation/hash';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { MaterialError, groupView, materialView, operationView } from './contracts.ts';
import type {
  GroupRow,
  GroupView,
  OperationView,
  MaterialPrincipal,
  MaterialUpstream,
  OperationKind,
  OperationRow,
} from './contracts.ts';
import type { MaterialStore, MaterialCursor } from './store.ts';
import { AssetError } from '../assets/contracts.ts';
import type { createAssetService } from '../assets/service.ts';
import { decodeMaterialImage } from './decode.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import { MaterialUpstreamError } from '../integrations/onelink/materials.ts';

type Credentials = Pick<ProviderService, 'snapshotAccount' | 'openAccountSnapshot'>;
const hash = (value: unknown) => sha256Utf8(JSON.stringify(value));
const unavailable = () =>
  new MaterialError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MATERIAL_UNAVAILABLE');
const errorCode = (error: unknown) =>
  error instanceof MaterialError || error instanceof ProviderError || error instanceof AssetError
    ? error.code
    : 'UPSTREAM_RESULT_UNKNOWN';

function listCursor(value?: string): MaterialCursor | undefined {
  if (value === undefined) return;
  try {
    if (value.length > 512 || !/^[\w-]+$/.test(value)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!decoded || typeof decoded !== 'object' || !('createdAt' in decoded) || !('id' in decoded))
      throw new Error();
    const row = decoded as MaterialCursor;
    if (
      typeof row.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.createdAt) ||
      new Date(row.createdAt).toISOString() !== row.createdAt.replace(/(\.\d{3})\d{3}Z$/, '$1Z') ||
      typeof row.id !== 'string' ||
      !isUuidV4(row.id)
    )
      throw new Error();
    return row;
  } catch {
    throw new MaterialError(HTTP_STATUS.BAD_REQUEST, 'CURSOR_INVALID');
  }
}
function page<T extends { id: string; created_at: Date; cursor_time?: string }>(
  rows: T[],
  limit: number,
  view: (row: T) => unknown,
) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(view),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.cursor_time ?? last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}
function syncPage(cursor?: string): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]{0,5}$/.test(cursor))
    throw new MaterialError(HTTP_STATUS.BAD_REQUEST, 'CURSOR_INVALID');
  return Number(cursor);
}

/** No scheduler or automatic mutation retry. Each admitted request owns one bounded remote action. */
export function createMaterialService(
  store: MaterialStore,
  credentials: Credentials,
  upstream: MaterialUpstream,
  assets?: Pick<ReturnType<typeof createAssetService>, 'readMaterialSource' | 'materialUrl'>,
  beforeClose?: () => Promise<void>,
) {
  let stopping = false;
  let registering = false;
  let closing: Promise<void> | undefined;
  const stop = new AbortController();
  const active = new Set<Promise<unknown>>();
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopping) throw unavailable();
    const action = work();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };
  const outbound = async <T>(
    owner: string,
    work: (key: string, signal: AbortSignal) => Promise<T>,
  ) => {
    const snapshot = await credentials.snapshotAccount(owner);
    stop.signal.throwIfAborted();
    const key = credentials.openAccountSnapshot(owner, snapshot);
    return work(key, stop.signal);
  };
  const settleFailure = async (
    owner: string,
    op: OperationRow,
    error: unknown,
    returned: boolean,
    attempted: boolean,
    knownCreate?: { id: string; requestId: string | null },
  ) => {
    // A database failure after a successful response is just as uncertain as a transport timeout.
    const uncertain =
      returned || (attempted && (!(error instanceof MaterialUpstreamError) || error.uncertain));
    await store
      .failOperation(
        owner,
        op,
        uncertain,
        !attempted && !(error instanceof MaterialError) && !(error instanceof ProviderError)
          ? 'MATERIAL_UNAVAILABLE'
          : errorCode(error),
        knownCreate,
      )
      .catch(() => {});
  };
  const operationResult = async (owner: string, op: OperationRow) => {
    const current = await store.operation(owner, op.id);
    return { operation: operationView(current) };
  };
  return {
    groups(actor: MaterialPrincipal, type: string | undefined, limit: number, cursor?: string) {
      return admit(async () =>
        page(await store.groups(actor.userId, type, limit, listCursor(cursor)), limit, groupView),
      );
    },
    group(actor: MaterialPrincipal, id: string) {
      return admit(async () => groupView(await store.ownedGroup(actor.userId, id)));
    },
    materials(actor: MaterialPrincipal, id: string, limit: number, cursor?: string) {
      return admit(async () =>
        page(
          await store.materials(actor.userId, id, limit, listCursor(cursor)),
          limit,
          materialView,
        ),
      );
    },
    material(actor: MaterialPrincipal, id: string) {
      return admit(async () => materialView(await store.ownedMaterial(actor.userId, id)));
    },
    createGroup(
      actor: MaterialPrincipal,
      requestId: string,
      name: string,
    ): Promise<{ operation: OperationView; group?: GroupView }> {
      return admit(async () => {
        const owner = actor.userId;
        const inputHash = hash({ type: 'aigc', name });
        const old = await store.previous(owner, 'create_group', requestId, inputHash);
        if (old) return operationResult(owner, old);
        const snapshot = await credentials.snapshotAccount(owner);
        const { operation: op, fresh } = await store.beginCreate(
          owner,
          requestId,
          inputHash,
          name,
          snapshot,
        );
        if (!fresh) return operationResult(owner, op);
        let returned = false;
        let attempted = false;
        let remote: Awaited<ReturnType<MaterialUpstream['createGroup']>> | undefined;
        try {
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(owner, snapshot);
          attempted = true;
          remote = await upstream.createGroup(key, name, stop.signal);
          returned = true;
          stop.signal.throwIfAborted();
          await store.finishCreate(owner, op, remote.id, remote.requestId);
        } catch (error) {
          await settleFailure(owner, op, error, returned, attempted, remote);
        }
        const result = await operationResult(owner, op);
        return {
          ...result,
          ...(result.operation.state === 'succeeded'
            ? { group: groupView(await store.ownedGroup(owner, op.target_group_id!)) }
            : {}),
        };
      });
    },
    register(
      actor: MaterialPrincipal,
      groupId: string,
      requestId: string,
      assetId: string,
      name = '',
    ): Promise<{ operation: OperationView; material?: ReturnType<typeof materialView> }> {
      if (stopping) throw unavailable();
      return admit(async () => {
        const owner = actor.userId;
        const inputHash = hash({ groupId, assetId, name });
        const old = await store.previous(owner, 'register_material', requestId, inputHash);
        if (old) return operationResult(owner, old);
        if (!assets) throw new MaterialError(409, 'MATERIAL_REGISTRATION_UNAVAILABLE');
        if (registering) throw new MaterialError(409, 'MATERIAL_BUSY');
        registering = true;
        try {
          const group = await store.ownedGroup(owner, groupId);
          if (
            group.state !== 'ready' ||
            (group.group_type === 'real' && group.auth_status !== 'verified')
          )
            throw new MaterialError(409, 'MATERIAL_GROUP_NOT_READY');
          const snapshot = await credentials.snapshotAccount(owner);
          const source = await assets.readMaterialSource(owner, assetId, stop.signal);
          const dimensions = await decodeMaterialImage(
            source.data,
            source.contentType,
            stop.signal,
          );
          const key = credentials.openAccountSnapshot(owner, snapshot);
          await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
          const url = await assets.materialUrl(owner, source, stop.signal);
          stop.signal.throwIfAborted();
          const frozen = {
            version: 1 as const,
            rawKey: source.rawKey,
            rawEtag: source.rawEtag,
            size: source.size,
            contentType: source.contentType,
            sha256: source.sourceDigest,
            ...dimensions,
          };
          const { operation: op, fresh } = await store.beginRegister(
            owner,
            requestId,
            inputHash,
            group,
            assetId,
            name,
            frozen,
            snapshot,
          );
          if (!fresh) return operationResult(owner, op);
          let remote: Awaited<ReturnType<MaterialUpstream['createMaterial']>> | undefined;
          let attempted = false,
            returned = false;
          try {
            stop.signal.throwIfAborted();
            attempted = true;
            remote = await upstream.createMaterial(
              key,
              group.upstream_group_id!,
              url,
              name,
              stop.signal,
            );
            returned = true;
            stop.signal.throwIfAborted();
            await store.finishRegister(owner, op, remote.id, remote.requestId);
          } catch (error) {
            await settleFailure(owner, op, error, returned, attempted, remote);
          }
          const result = await operationResult(owner, op);
          return {
            ...result,
            ...(result.operation.state === 'succeeded'
              ? { material: materialView(await store.ownedMaterial(owner, op.target_material_id!)) }
              : {}),
          };
        } finally {
          registering = false;
        }
      });
    },
    rename(actor: MaterialPrincipal, id: string, revision: number, name: string) {
      return admit(async () => {
        const owner = actor.userId;
        await store.ownedGroup(owner, id);
        const snapshot = await credentials.snapshotAccount(owner);
        const { group, lease } = await store.claimGroup(owner, id, revision, null);
        try {
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(owner, snapshot);
          await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
          await upstream.renameGroup(key, group.upstream_group_id!, name, stop.signal);
          stop.signal.throwIfAborted();
          await store.rename(owner, id, lease, name);
          return groupView(await store.ownedGroup(owner, id));
        } catch (error) {
          await store.releaseGroup(owner, id, lease, errorCode(error)).catch(() => {});
          throw error;
        }
      });
    },
    sync(actor: MaterialPrincipal, id: string, cursor?: string) {
      return admit(async () => {
        const owner = actor.userId;
        const number = syncPage(cursor);
        await store.ownedGroup(owner, id);
        const snapshot = await credentials.snapshotAccount(owner);
        const { group, lease } = await store.claimGroup(owner, id, undefined, String(number));
        try {
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(owner, snapshot);
          await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
          const batch = await upstream.listMaterials(
            key,
            group.upstream_group_id!,
            number,
            stop.signal,
          );
          stop.signal.throwIfAborted();
          const next = batch.hasMore ? String(number + 1) : null;
          await store.applySync(owner, group, lease, batch.items, next, snapshot.credentialVersion);
          return {
            group: groupView(await store.ownedGroup(owner, id)),
            syncedCount: batch.items.length,
            nextCursor: next,
          };
        } catch (error) {
          await store.releaseGroup(owner, id, lease, errorCode(error)).catch(() => {});
          throw error;
        }
      });
    },
    refresh(actor: MaterialPrincipal, id: string) {
      return admit(async () => {
        const owner = actor.userId;
        let material = await store.ownedMaterial(owner, id);
        const owned = await store.ownedGroup(owner, material.group_id);
        if (!material.upstream_asset_id || ['deleting', 'registering'].includes(material.state))
          throw new MaterialError(HTTP_STATUS.CONFLICT, 'MATERIAL_BUSY');
        const snapshot = await credentials.snapshotAccount(owner);
        const { group, lease } = await store.claimGroup(owner, owned.id, owned.revision, null);
        try {
          material = await store.claimRefresh(owner, id, group.id, lease);
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(owner, snapshot);
          await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
          let item;
          try {
            item = await upstream.getMaterial(
              key,
              material.upstream_asset_id!,
              group.upstream_group_id!,
              stop.signal,
            );
          } catch (error) {
            if (
              !(error instanceof MaterialUpstreamError) ||
              error.code !== 'UPSTREAM_RESOURCE_NOT_FOUND'
            )
              throw error;
            item = null;
          }
          stop.signal.throwIfAborted();
          return materialView(await store.applyRefresh(owner, material, group, lease, item));
        } catch (error) {
          await store.releaseGroup(owner, group.id, lease, errorCode(error)).catch(() => {});
          throw error;
        }
      });
    },
    remove(
      actor: MaterialPrincipal,
      kind: 'group' | 'material',
      id: string,
      requestId: string,
      revision: number,
      scope: 'local' | 'upstream',
    ) {
      return admit(async () => {
        const owner = actor.userId;
        if (scope === 'local') {
          const row = await store.removeLocal(owner, kind, id, revision);
          return kind === 'group'
            ? { group: groupView(row as GroupRow) }
            : {
                material: materialView(row as Awaited<ReturnType<MaterialStore['ownedMaterial']>>),
              };
        }
        const opKind: OperationKind =
          kind === 'group' ? 'delete_group_upstream' : 'delete_material_upstream';
        const inputHash = hash({ id, revision, scope });
        const old = await store.previous(owner, opKind, requestId, inputHash);
        if (old) return operationResult(owner, old);
        const upstreamGroupId =
          kind === 'group' ? await store.precheckGroupDelete(owner, id, revision) : undefined;
        if (kind === 'material') await store.ownedMaterial(owner, id);
        const snapshot = await credentials.snapshotAccount(owner);
        if (upstreamGroupId) {
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(owner, snapshot);
          let absent = false;
          try {
            await upstream.getGroup(key, upstreamGroupId, stop.signal);
          } catch (error) {
            if (
              !(error instanceof MaterialUpstreamError) ||
              error.code !== 'UPSTREAM_RESOURCE_NOT_FOUND'
            )
              throw error;
            absent = true;
          }
          // DeleteAssetGroup cascades remotely and has no atomic empty-group condition.
          if (!absent) throw new MaterialError(HTTP_STATUS.CONFLICT, 'RESOURCE_IN_USE');
        }
        const { operation: op, fresh } = await store.beginDelete(
          owner,
          requestId,
          inputHash,
          kind,
          id,
          revision,
          snapshot,
        );
        if (!fresh) return operationResult(owner, op);
        let returned = false;
        let attempted = false;
        try {
          stop.signal.throwIfAborted();
          if (kind === 'material') {
            const key = credentials.openAccountSnapshot(owner, snapshot);
            const group = await store.ownedGroup(owner, op.target_group_id!);
            await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
            let absent = false;
            try {
              await upstream.getMaterial(
                key,
                op.protocol_snapshot.upstreamId!,
                group.upstream_group_id!,
                stop.signal,
              );
            } catch (error) {
              if (
                !(error instanceof MaterialUpstreamError) ||
                error.code !== 'UPSTREAM_RESOURCE_NOT_FOUND'
              )
                throw error;
              absent = true;
            }
            if (!absent) {
              attempted = true;
              await upstream.deleteMaterial(key, op.protocol_snapshot.upstreamId!, stop.signal);
            }
          }
          returned = true;
          stop.signal.throwIfAborted();
          await store.finishDelete(owner, op);
        } catch (error) {
          await settleFailure(owner, op, error, returned, attempted);
        }
        return operationResult(owner, op);
      });
    },
    operation(actor: MaterialPrincipal, id: string) {
      return admit(async () => {
        const owner = actor.userId;
        const op = await store.operation(owner, id);
        if (
          op.state !== 'unknown' ||
          (op.kind === 'create_group' && !op.protocol_snapshot.upstreamId) ||
          (op.kind === 'register_material' && !op.protocol_snapshot.upstreamId)
        )
          return operationView(op);
        const claim = await store.claimRecovery(owner, id);
        if (!claim) return operationView(op);
        try {
          await outbound(owner, async (key, signal) => {
            if (claim.kind === 'register_material') {
              const group = await store.ownedGroup(owner, claim.target_group_id!);
              if (
                group.state !== 'ready' ||
                group.upstream_group_id !== claim.protocol_snapshot.upstreamGroupId
              )
                throw new MaterialError(409, 'MATERIAL_GROUP_NOT_READY');
              await upstream.getGroup(key, group.upstream_group_id!, signal);
              const item = await upstream.getMaterial(
                key,
                claim.protocol_snapshot.upstreamId!,
                group.upstream_group_id!,
                signal,
              );
              signal.throwIfAborted();
              await store.finishRecovery(owner, claim, true, null, item);
              return;
            }
            if (claim.kind === 'create_group') {
              await upstream.getGroup(key, claim.protocol_snapshot.upstreamId!, signal);
              signal.throwIfAborted();
              await store.finishRecovery(owner, claim, true, null);
              return;
            }
            const group = await store.ownedGroup(owner, claim.target_group_id!);
            if (claim.target_material_id)
              await upstream.getGroup(key, group.upstream_group_id!, signal);
            try {
              if (claim.target_material_id)
                await upstream.getMaterial(
                  key,
                  claim.protocol_snapshot.upstreamId!,
                  group.upstream_group_id!,
                  signal,
                );
              else await upstream.getGroup(key, claim.protocol_snapshot.upstreamId!, signal);
            } catch (error) {
              if (
                !(error instanceof MaterialUpstreamError) ||
                error.code !== 'UPSTREAM_RESOURCE_NOT_FOUND'
              )
                throw error;
              signal.throwIfAborted();
              await store.finishRecovery(owner, claim, true, null);
              return;
            }
            await store.finishRecovery(owner, claim, false, 'UPSTREAM_RESULT_UNKNOWN');
          });
        } catch (error) {
          await store.finishRecovery(owner, claim, false, errorCode(error)).catch(() => {});
        }
        return operationView(await store.operation(owner, id));
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        const failures: unknown[] = [];
        try {
          const consumer = Promise.resolve()
            .then(() => beforeClose?.())
            .catch((error) => {
              failures.push(error);
            });
          await Promise.allSettled([...active, consumer]);
        } finally {
          clearTimeout(deadline);
          try {
            await store.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Material domain cleanup failed');
      })();
      return closing;
    },
  };
}
export type MaterialService = ReturnType<typeof createMaterialService>;
