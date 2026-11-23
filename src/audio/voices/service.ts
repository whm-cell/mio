import { modelReference } from '../../providers/catalog.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { VoiceError, VOICE_SOURCES } from './contracts.ts';
import type { VoiceFilters, VoiceRow } from './contracts.ts';
import type { VoiceStore } from './store.ts';

function view(row: VoiceRow) {
  return {
    voiceRef: row.id,
    source: row.source,
    name: row.name,
    descriptions: row.descriptions,
    favorite: row.favorite,
    available: row.available,
    generationAvailable: row.available && row.generation_available === true,
    previewAssetId: row.preview_asset_id ?? null,
    registrationModelRef: row.registration_model_key
      ? modelReference(row.registration_model_key)
      : null,
    language: null,
    accent: null,
    gender: null,
    age: null,
    tags: [],
    createdAt: row.created_at,
  };
}
function filters(input: URLSearchParams): VoiceFilters {
  const keys = ['search', 'source', 'favorite', 'limit', 'cursor'];
  if ([...input.keys()].some((key) => !keys.includes(key) || input.getAll(key).length > 1))
    throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  const search = input.get('search') ?? '';
  const source = input.get('source');
  const favorite = input.get('favorite');
  const limit = input.get('limit');
  if (
    !search.isWellFormed() ||
    Array.from(search).length > 100 ||
    /[\x00-\x1f\x7f]/.test(search) ||
    (source !== null && !VOICE_SOURCES.includes(source as never)) ||
    (favorite !== null && favorite !== 'true' && favorite !== 'false') ||
    (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100))
  )
    throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  let before: VoiceFilters['before'] = null;
  const cursor = input.get('cursor');
  if (cursor !== null) {
    try {
      if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 2 ||
        typeof decoded[0] !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded[0]) ||
        decoded[0].startsWith('0000') ||
        !Number.isFinite(Date.parse(decoded[0])) ||
        new Date(decoded[0]).toISOString() !== `${decoded[0].slice(0, 23)}Z` ||
        Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor ||
        !isUuidV4(decoded[1])
      )
        throw new Error();
      before = { time: decoded[0], id: decoded[1] };
    } catch {
      throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
    }
  }
  return {
    search,
    source: source as VoiceFilters['source'],
    favorite: favorite === null ? null : favorite === 'true',
    limit: limit === null ? 30 : Number(limit),
    before,
  };
}

/** Local reads and explicit refresh share the provider's identity and lifetime. */
export function createVoiceService(store: VoiceStore) {
  const stop = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const admit = <T>(action: () => Promise<T>) => {
    if (stop.signal.aborted)
      throw new VoiceError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VOICE_UNAVAILABLE');
    const pending = action();
    active.add(pending);
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    );
    return pending;
  };
  const get = async (owner: string, id: string) => {
    if (!isUuidV4(id)) throw new VoiceError(HTTP_STATUS.NOT_FOUND, 'VOICE_NOT_FOUND');
    return view(await store.owned(owner, id));
  };
  return {
    list(owner: string, input: URLSearchParams) {
      return admit(async () => {
        const selected = filters(input);
        const result = await store.list(owner, selected);
        const rows = result.items.slice(0, selected.limit);
        const last = rows.at(-1);
        return {
          catalog: result.catalog,
          total: result.total,
          items: rows.map(view),
          nextCursor:
            result.items.length > selected.limit && last
              ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString('base64url')
              : null,
        };
      });
    },
    get(owner: string, id: string) {
      return admit(() => get(owner, id));
    },
    favorite(owner: string, id: string, value: boolean) {
      return admit(async () => {
        if (!isUuidV4(id)) throw new VoiceError(HTTP_STATUS.NOT_FOUND, 'VOICE_NOT_FOUND');
        if (typeof value !== 'boolean')
          throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        await store.favorite(owner, id, value);
        return get(owner, id);
      });
    },
    refresh(owner: string) {
      return admit(async () => {
        const count = await store.localCount(owner);
        return {
          status: count > 0 ? ('connected' as const) : ('empty' as const),
          source: 'local' as const,
          count,
        };
      });
    },
    close() {
      if (!closing) {
        stop.abort();
        closing = Promise.allSettled([...active]).then(() => {});
      }
      return closing;
    },
  };
}
