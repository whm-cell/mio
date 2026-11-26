import { HTTP_STATUS } from '@mio/foundation/http-status';
import { epochMs } from '@mio/foundation/time';
import { NotificationError } from './contracts.ts';
import type {
  Announcement,
  AnnouncementAction,
  AnnouncementActor,
  AnnouncementAudit,
  AnnouncementCard,
  AnnouncementInput,
  AnnouncementValues,
} from './contracts.ts';
import type { NotificationStore } from './store.ts';

function validate(input: AnnouncementInput, current?: Announcement): AnnouncementValues {
  const title = input.title === undefined ? current?.title : input.title;
  const body = input.body === undefined ? current?.body : input.body;
  const enabled = input.enabled === undefined ? (current?.enabled ?? true) : input.enabled;
  const popup = input.popup === undefined ? (current?.popup ?? false) : input.popup;
  const effectiveAt =
    input.effectiveAt === undefined ? (current?.effectiveAt ?? null) : input.effectiveAt;
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    Array.from(title).length > 200 ||
    typeof body !== 'string' ||
    !body.trim() ||
    Array.from(body).length > 16000 ||
    typeof enabled !== 'boolean' ||
    typeof popup !== 'boolean' ||
    (effectiveAt !== null &&
      (typeof effectiveAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          effectiveAt,
        ) ||
        !Number.isFinite(Date.parse(effectiveAt)) ||
        new Date(`${effectiveAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
          effectiveAt.slice(0, 10)))
  )
    throw new NotificationError(HTTP_STATUS.BAD_REQUEST, 'ANNOUNCEMENT_INPUT_INVALID');
  return {
    title,
    body,
    enabled,
    popup,
    effectiveAt: effectiveAt === null ? null : new Date(effectiveAt).toISOString(),
  };
}

export function announcementPagination(url: URL): { page: number; pageSize: number } {
  if (
    [...url.searchParams.keys()].some((key) => !['page', 'pageSize'].includes(key)) ||
    ['page', 'pageSize'].some((key) => url.searchParams.getAll(key).length > 1)
  )
    throw new NotificationError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  const rawPage = url.searchParams.get('page') ?? '1';
  const rawSize = url.searchParams.get('pageSize') ?? '10';
  const page = Number(rawPage),
    pageSize = Number(rawSize);
  if (
    !/^[1-9]\d*$/.test(rawPage) ||
    !/^[1-9]\d*$/.test(rawSize) ||
    page > 1000000 ||
    pageSize > 100
  )
    throw new NotificationError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  return { page, pageSize };
}

function card(item: Announcement, isRead: boolean): AnnouncementCard {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    publishedAt: item.publishedAt!,
    isRead,
  };
}

export function createNotificationService(
  store: NotificationStore,
  audit: AnnouncementAudit,
  now = epochMs,
) {
  let generation = 0;
  let cached: { value: Announcement | null; expires: number } | undefined;
  let fill: { generation: number; promise: Promise<Announcement | null> } | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing)
      return Promise.reject(
        new NotificationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'NOTIFICATIONS_UNAVAILABLE'),
      );
    const task = Promise.resolve().then(operation);
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
    return task;
  };
  const invalidate = () => {
    generation++;
    cached = undefined;
    fill = undefined;
  };
  const metadata = (): Promise<Announcement | null> => {
    if (closing)
      return Promise.reject(
        new NotificationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'NOTIFICATIONS_UNAVAILABLE'),
      );
    if (cached && cached.expires > now()) return Promise.resolve(cached.value);
    if (fill?.generation === generation) return fill.promise;
    const version = generation;
    const started = now();
    const promise = store
      .latestPopupMetadata()
      .then((result) => {
        if (generation !== version) return metadata();
        cached = {
          value: result.value,
          expires: Math.min(started + 4000, result.nextEffectiveAt ?? Infinity),
        };
        return result.value;
      })
      .finally(() => {
        if (fill?.promise === promise) fill = undefined;
      });
    fill = { generation: version, promise };
    return promise;
  };
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } finally {
      invalidate();
    }
  };
  return {
    list: (userId: string, page: number, pageSize: number) =>
      run(async () => {
        const result = await store.list(page, pageSize, userId);
        return { ...result, items: result.items.map((item) => card(item, item.isRead)) };
      }),
    latestPopup: (userId: string): Promise<AnnouncementCard | null> =>
      run(async () => {
        for (;;) {
          const version = generation;
          const item = await metadata();
          if (version !== generation) continue;
          if (!item) return null;
          const read = await store.isRead(userId, item.id);
          if (version !== generation) continue;
          return read ? null : card(item, false);
        }
      }),
    markRead: (userId: string, id: string) => run(() => store.markRead(userId, id)),
    adminList: (page: number, pageSize: number) => run(() => store.list(page, pageSize)),
    adminGet: (id: string) => run(() => store.get(id)),
    create: (actor: AnnouncementActor, input: AnnouncementInput) =>
      run(() => mutate(() => store.create(validate(input), (id) => audit(actor, 'create', id)))),
    change: (
      actor: AnnouncementActor,
      id: string,
      action: Exclude<AnnouncementAction, 'create'>,
      input: AnnouncementInput = {},
    ) =>
      run(() =>
        mutate(() =>
          store.change(
            id,
            action,
            (current) => (action === 'update' ? validate(input, current) : current),
            () => audit(actor, action, id),
          ),
        ),
      ),
    close() {
      invalidate();
      return (closing ??= Promise.allSettled([...active]).then(() => store.close()));
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
