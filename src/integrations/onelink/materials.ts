import { HTTP_STATUS } from '@mio/foundation/http-status';
import { MaterialError } from '../../materials/contracts.ts';
import type { MaterialAuthUpstream } from '../../materials/auth-contracts.ts';
import type { MaterialUpstream, UpstreamMaterial } from '../../materials/contracts.ts';
import { ONELINK_ORIGIN } from './models.ts';
import type { ModelTransport } from './models.ts';

/** An uncertain mutation must never be automatically submitted again. */
export class MaterialUpstreamError extends MaterialError {
  readonly uncertain: boolean;
  readonly request: { action: string; id: string } | undefined;
  constructor(
    status: number,
    code: string,
    uncertain = false,
    request?: { action: string; id: string },
  ) {
    super(status, code);
    this.uncertain = uncertain;
    this.request = request;
  }
}
const groupId = /^group-[0-9]{14}-[a-zA-Z0-9]{5}$/;
const assetId = /^asset-[0-9]{14}-[a-zA-Z0-9]{5}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
function invalid(): never {
  throw new MaterialUpstreamError(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    'UPSTREAM_RESPONSE_INVALID',
    true,
  );
}
function item(value: unknown, expectedGroup: string): UpstreamMaterial {
  if (
    !record(value) ||
    typeof value.Id !== 'string' ||
    !assetId.test(value.Id) ||
    value.GroupId !== expectedGroup ||
    value.AssetType !== 'Image' ||
    typeof value.Status !== 'string' ||
    value.Status.length > 100 ||
    typeof value.Name !== 'string' ||
    !value.Name.isWellFormed() ||
    value.Name.includes('\0') ||
    Array.from(value.Name).length > 100
  )
    return invalid();
  return { id: value.Id, groupId: expectedGroup, name: value.Name, status: value.Status };
}

// A transport or response stream that ignores abort must still release the request waiter.
function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MaterialUpstreamError(503, 'UPSTREAM_RESULT_UNKNOWN', true));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fixed OpenAPI actions only: a shared supplier pool must never be enumerated. */
function materialCall(transport: ModelTransport) {
  return async (
    action: string,
    key: string,
    input: Record<string, unknown>,
    cancellation: AbortSignal,
  ) => {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(20_000)]);
    try {
      signal.throwIfAborted();
      const response = await bounded(
        () =>
          transport(`${ONELINK_ORIGIN}/volc/openapi?Action=${action}&Version=2024-01-01`, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              authorization: `Bearer ${key}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(input),
          }),
        signal,
      );
      const reader = response.body?.getReader();
      if (!reader) return invalid();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await bounded(() => reader.read(), signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) return invalid();
          parts.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      const raw = Buffer.concat(parts).toString('utf8');
      if (raw.includes(key)) return invalid();
      const body: unknown = JSON.parse(raw);
      if (JSON.stringify(body).includes(key)) return invalid();
      if (!record(body) || !record(body.ResponseMetadata)) return invalid();
      const metadata = body.ResponseMetadata;
      if (
        metadata.Action !== action ||
        metadata.Version !== '2024-01-01' ||
        metadata.Service !== 'ark'
      )
        return invalid();
      const requestId =
        typeof metadata.RequestId === 'string' &&
        metadata.RequestId.length <= 256 &&
        !/[\x00-\x1f\x7f]/.test(metadata.RequestId)
          ? metadata.RequestId
          : null;
      const groupDelete = action === 'DeleteAssetGroup';
      const groupLookup = action === 'GetAssetGroup';
      if ((groupDelete || groupLookup) && response.ok && 'Error' in metadata) return invalid();
      if (!response.ok || metadata.Error) {
        const error = record(metadata.Error) ? metadata.Error : undefined;
        const code =
          typeof error?.Code === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(error.Code)
            ? error.Code
            : undefined;
        const exactAbsence = response.status === 404 && code === 'ResourceNotFound';
        if (
          (groupDelete || (groupLookup && exactAbsence)) &&
          'Result' in body &&
          (!record(body.Result) || Object.keys(body.Result).length !== 0)
        )
          return invalid();
        if (groupDelete && !code) return invalid();
        const request = requestId && code ? { action, id: requestId } : undefined;
        if (response.status === 403)
          throw new MaterialUpstreamError(
            HTTP_STATUS.FORBIDDEN,
            'PROVIDER_RESOURCE_FORBIDDEN',
            false,
            request,
          );
        if (exactAbsence)
          throw new MaterialUpstreamError(
            HTTP_STATUS.NOT_FOUND,
            'UPSTREAM_RESOURCE_NOT_FOUND',
            false,
            request,
          );
        if (groupDelete && response.status === 408)
          throw new MaterialUpstreamError(
            HTTP_STATUS.SERVICE_UNAVAILABLE,
            'UPSTREAM_RESULT_UNKNOWN',
            true,
            request,
          );
        throw new MaterialUpstreamError(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          response.status === 429
            ? 'UPSTREAM_RATE_LIMITED'
            : response.status === 401
              ? 'PROVIDER_UNAVAILABLE'
              : 'UPSTREAM_REJECTED',
          response.status >= 500,
          request,
        );
      }
      if (!record(body.Result)) return invalid();
      return { result: body.Result, requestId };
    } catch (error) {
      if (error instanceof MaterialUpstreamError) throw error;
      throw new MaterialUpstreamError(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        cancellation.aborted ? 'UPSTREAM_CANCELLED' : 'UPSTREAM_RESULT_UNKNOWN',
        true,
      );
    }
  };
}
export function createMaterialUpstream(transport: ModelTransport = fetch): MaterialUpstream {
  const call = materialCall(transport);
  return {
    async createGroup(key, name, signal) {
      const value = await call('CreateAssetGroup', key, { Name: name, GroupType: 'AIGC' }, signal);
      if (typeof value.result.Id !== 'string' || !groupId.test(value.result.Id)) return invalid();
      return { id: value.result.Id, requestId: value.requestId };
    },
    async createMaterial(key, id, url, name, signal) {
      if (!groupId.test(id)) return invalid();
      const value = await call(
        'CreateAsset',
        key,
        { GroupId: id, URL: url, AssetType: 'Image', Name: name },
        signal,
      );
      if (typeof value.result.Id !== 'string' || !assetId.test(value.result.Id)) return invalid();
      return { id: value.result.Id, requestId: value.requestId };
    },
    async getGroup(key, id, signal) {
      const value = await call('GetAssetGroup', key, { Id: id }, signal);
      if (value.result.Id !== id) return invalid();
    },
    async renameGroup(key, id, name, signal) {
      const value = await call('UpdateAssetGroup', key, { Id: id, Name: name }, signal);
      if (value.result.Id !== id) return invalid();
    },
    async deleteGroup(key, id, signal) {
      if (!groupId.test(id)) return invalid();
      const { result, requestId } = await call('DeleteAssetGroup', key, { Id: id }, signal);
      if (result.Id === id) return { confirmed: true, requestId };
      if (Object.keys(result).length === 0) return { confirmed: false, requestId };
      return invalid();
    },
    async listMaterials(key, id, page, signal) {
      if (!groupId.test(id) || !Number.isSafeInteger(page) || page < 1) return invalid();
      const { result } = await call(
        'ListAssets',
        key,
        { Filter: { GroupIds: [id] }, PageNumber: page, PageSize: 100 },
        signal,
      );
      if (
        !Array.isArray(result.Items) ||
        result.Items.length > 100 ||
        result.PageNumber !== page ||
        !Number.isSafeInteger(result.PageSize) ||
        Number(result.PageSize) < 1 ||
        Number(result.PageSize) > 100 ||
        !Number.isSafeInteger(result.TotalCount) ||
        Number(result.TotalCount) < 0
      )
        return invalid();
      const items = result.Items.map((value) => item(value, id));
      if (new Set(items.map((value) => value.id)).size !== items.length) return invalid();
      return { items, hasMore: page * Number(result.PageSize) < Number(result.TotalCount) };
    },
    async getMaterial(key, id, expectedGroup, signal) {
      const { result } = await call('GetAsset', key, { Id: id }, signal);
      const value = item(result, expectedGroup);
      if (value.id !== id) return invalid();
      return value;
    },
    async deleteMaterial(key, id, signal) {
      await call('DeleteAsset', key, { Id: id }, signal);
    },
  };
}

/** Only the observed auth actions; no client supplied action or resource pool discovery. */
export function createMaterialAuthUpstream(
  transport: ModelTransport = fetch,
): MaterialAuthUpstream {
  const call = materialCall(transport);
  return {
    async create(key, callback, signal) {
      const value = await call(
        'CreateVisualValidateSession',
        key,
        { CallbackURL: callback },
        signal,
      );
      const { H5Link, BytedToken, CallbackURL } = value.result;
      if (
        typeof H5Link !== 'string' ||
        H5Link.length > 4096 ||
        typeof BytedToken !== 'string' ||
        BytedToken.length < 16 ||
        BytedToken.length > 512 ||
        /[\x00-\x20\x7f]/.test(BytedToken) ||
        typeof CallbackURL !== 'string'
      )
        return invalid();
      let launch: URL, returned: URL;
      try {
        launch = new URL(H5Link);
        returned = new URL(CallbackURL);
      } catch {
        return invalid();
      }
      if (
        launch.origin !== 'https://ark.volcengine.com' ||
        launch.pathname !== '/region:cn-beijing/mobile/livenees-face-manage/authorization' ||
        launch.username ||
        launch.password ||
        launch.hash ||
        returned.origin !== ONELINK_ORIGIN ||
        returned.pathname !== '/volc/callback' ||
        returned.username ||
        returned.password ||
        returned.hash ||
        [...returned.searchParams.keys()].some(
          (name) =>
            !['redirect_url', 'supplier'].includes(name) ||
            returned.searchParams.getAll(name).length !== 1,
        ) ||
        returned.searchParams.getAll('redirect_url').length !== 1 ||
        returned.searchParams.get('redirect_url') !== callback
      )
        return invalid();
      return { launchUrl: H5Link, token: BytedToken, requestId: value.requestId };
    },
    async result(key, token, signal) {
      const value = await call('GetVisualValidateResult', key, { BytedToken: token }, signal);
      if (typeof value.result.GroupId !== 'string' || !groupId.test(value.result.GroupId))
        return invalid();
      return { groupId: value.result.GroupId, requestId: value.requestId };
    },
    async verifiedGroup(key, id, signal) {
      const value = await call('GetAssetGroup', key, { Id: id }, signal);
      if (value.result.Id !== id || value.result.GroupType !== 'LivenessFace') return invalid();
      return value.requestId;
    },
  };
}
