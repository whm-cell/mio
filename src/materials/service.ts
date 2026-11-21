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
    const { createdAt, id } = decoded;
    if (
      typeof createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) ||
      new Date(createdAt).toISOString() !== createdAt.replace(/(\.\d{3})\d{3}Z$/, '$1Z') ||
      typeof id !== 'string' ||
      !isUuidV4(id)
    )
      throw new Error();
    return { createdAt, id };
  } catch {
    throw new MaterialError(HTTP_STATUS.BAD_REQUEST, 'CURSOR_INVALID');
  }
}
function page<T extends { id: string; cursor_time: string }, View>(
  rows: T[],
  limit: number,
  view: (row: T) => View,
) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(view),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.cursor_time,
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

async function upstreamExists(get: () => Promise<unknown>): Promise<boolean> {
  try {
    await get();
    return true;
  } catch (error) {
    if (error instanceof MaterialUpstreamError && error.code === 'UPSTREAM_RESOURCE_NOT_FOUND')
      return false;
    throw error;
  }
}

/** Each admitted operation submits at most one remote mutation. */
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
    providerConfigId?: string,
  ) => {
    const snapshot = await credentials.snapshotAccount(owner);
    if (providerConfigId !== undefined && snapshot.providerConfigId !== providerConfigId)
      throw new MaterialError(HTTP_STATUS.CONFLICT, 'PROVIDER_UNAVAILABLE');
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
  const removeUpstreamGroup = async (
    owner: string,
    id: string,
    requestId: string,
    revision: number,
    confirmCascade: boolean,
  ) => {
    const inputHash = hash({
      id,
      revision,
      scope: 'upstream',
      ...(confirmCascade ? { confirmCascade } : {}),
    });
    const previous = () => store.previous(owner, 'delete_group_upstream', requestId, inputHash);
    const old = await previous();
    if (old) return operationResult(owner, old);

    let target: Awaited<ReturnType<MaterialStore['precheckGroupDelete']>>;
    let snapshot: Awaited<ReturnType<Credentials['snapshotAccount']>>;
    let key: string;
    let exists: boolean;
    try {
      target = await store.precheckGroupDelete(owner, id, revision, confirmCascade);
      snapshot = await credentials.snapshotAccount(owner);
      if (confirmCascade && target.providerConfigId !== snapshot.providerConfigId)
        throw new MaterialError(HTTP_STATUS.CONFLICT, 'PROVIDER_UNAVAILABLE');
      stop.signal.throwIfAborted();
      key = credentials.openAccountSnapshot(owner, snapshot);
      exists = await upstreamExists(() => upstream.getGroup(key, target.upstreamId, stop.signal));
      if (exists && !confirmCascade)
        throw new MaterialError(HTTP_STATUS.CONFLICT, 'RESOURCE_IN_USE');
    } catch (error) {
      // A concurrent request can be accepted while this request is still in preflight.
      const accepted = await previous();
      if (accepted) return operationResult(owner, accepted);
      throw error;
    }
    const { operation: op, fresh } = await store.beginDelete(
      owner,
      requestId,
      inputHash,
      'group',
      id,
      revision,
      snapshot,
      { upstreamId: target.upstreamId, confirmCascade },
    );
    if (!fresh) return operationResult(owner, op);

    let attempted = false;
    let returned = !exists;
    try {
      stop.signal.throwIfAborted();
      let upstreamRequestId = null;
      if (exists) {
        if (op.protocol_snapshot.confirmCascade !== true)
          throw new MaterialError(HTTP_STATUS.CONFLICT, 'RESOURCE_IN_USE');
        const upstreamId = op.protocol_snapshot.upstreamId!;
        attempted = true;
        const receipt = await upstream.deleteGroup(key, upstreamId, stop.signal);
        returned = true;
        upstreamRequestId = receipt.requestId;
        if (
          !receipt.confirmed &&
          (await upstreamExists(() => upstream.getGroup(key, upstreamId, stop.signal)))
        )
          throw new MaterialError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'UPSTREAM_RESULT_UNKNOWN');
      }
      stop.signal.throwIfAborted();
      await store.finishDelete(owner, op, upstreamRequestId);
    } catch (error) {
      await settleFailure(owner, op, error, returned, attempted);
    }
    return operationResult(owner, op);
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
        const { group, lease } = await store.claimGroup(owner, id, revision);
        try {
          stop.signal.throwIfAborted();
          const key = credentials.openAccountSnapshot(owner, snapshot);
          await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
          await upstream.renameGroup(key, group.upstream_group_id!, name, stop.signal);
          stop.signal.throwIfAborted();
          await store.rename(owner, id, lease, name);
          return groupView(await store.ownedGroup(owner, id));
        } catch (error) {
          await store.releaseGroup(owner, id, lease).catch(() => {});
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
        const { group, lease } = await store.claimGroup(owner, owned.id, owned.revision);
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
          await store.releaseGroup(owner, group.id, lease).catch(() => {});
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
      confirmCascade = false,
    ) {
      return admit(async () => {
        const owner = actor.userId;
        if (confirmCascade && (kind !== 'group' || scope !== 'upstream'))
          throw new MaterialError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        if (scope === 'local') {
          const row = await store.removeLocal(owner, kind, id, revision);
          return kind === 'group'
            ? { group: groupView(row as GroupRow) }
            : {
                material: materialView(row as Awaited<ReturnType<MaterialStore['ownedMaterial']>>),
              };
        }
        if (kind === 'group')
          return removeUpstreamGroup(owner, id, requestId, revision, confirmCascade);
        const inputHash = hash({ id, revision, scope });
        const old = await store.previous(owner, 'delete_material_upstream', requestId, inputHash);
        if (old) return operationResult(owner, old);
        await store.ownedMaterial(owner, id);
        const snapshot = await credentials.snapshotAccount(owner);
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
          const key = credentials.openAccountSnapshot(owner, snapshot);
          const group = await store.ownedGroup(owner, op.target_group_id!);
          await upstream.getGroup(key, group.upstream_group_id!, stop.signal);
          const upstreamId = op.protocol_snapshot.upstreamId!;
          if (
            await upstreamExists(() =>
              upstream.getMaterial(key, upstreamId, group.upstream_group_id!, stop.signal),
            )
          ) {
            attempted = true;
            await upstream.deleteMaterial(key, upstreamId, stop.signal);
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
          await outbound(
            owner,
            async (key, signal) => {
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
              const upstreamId = claim.protocol_snapshot.upstreamId!;
              let exists;
              if (claim.kind === 'delete_group_upstream')
                exists = await upstreamExists(() => upstream.getGroup(key, upstreamId, signal));
              else {
                const group = await store.ownedGroup(owner, claim.target_group_id!);
                await upstream.getGroup(key, group.upstream_group_id!, signal);
                exists = await upstreamExists(() =>
                  upstream.getMaterial(key, upstreamId, group.upstream_group_id!, signal),
                );
              }
              signal.throwIfAborted();
              await store.finishRecovery(
                owner,
                claim,
                !exists,
                exists ? 'UPSTREAM_RESULT_UNKNOWN' : null,
              );
            },
            claim.protocol_snapshot.confirmCascade === true ? claim.provider_config_id : undefined,
          );
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
