import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { NotificationError } from '../notifications/contracts.ts';
import { announcementPagination } from '../notifications/service.ts';
import type { NotificationService } from '../notifications/service.ts';
import type { AdminPrincipal } from './contracts.ts';

export function announcementMethods(path: string): readonly string[] | undefined {
  if (path === '/announcements') return ['GET', 'POST'];
  const match = /^\/announcements\/([^/]+)(?:\/(publish|unpublish))?$/.exec(path);
  if (!match?.[1] || !isUuidV4(match[1])) return undefined;
  return match[2] ? ['POST'] : ['GET', 'PATCH', 'DELETE'];
}

export async function handleAnnouncementRequest(
  service: NotificationService | undefined,
  ctx: {
    url: URL;
    method: string;
    requireAdmin: () => Promise<AdminPrincipal>;
    readAuthJson: (
      keys: readonly string[],
      maxBytes?: number,
    ) => Promise<{ principal: AdminPrincipal; body: Record<string, unknown> }>;
  },
): Promise<unknown> {
  // Authentication precedes configuration disclosure, including reads and bodyless DELETE.
  const principal = await ctx.requireAdmin();
  if (!service)
    throw new NotificationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'NOTIFICATIONS_UNAVAILABLE');
  const parts = ctx.url.pathname.split('/').slice(5);
  const id = parts[0];
  if (ctx.method === 'GET' && !id) {
    const { page, pageSize } = announcementPagination(ctx.url);
    return service.adminList(page, pageSize);
  }
  if (ctx.url.search) throw new NotificationError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  if (ctx.method === 'GET') return { announcement: await service.adminGet(id!) };
  if (ctx.method === 'DELETE') {
    await service.change(principal.admin, id!, 'delete');
    return { ok: true };
  }
  const editing = ctx.method === 'PATCH' || !id;
  const { principal: current, body } = await ctx.readAuthJson(
    editing ? ['title', 'body', 'enabled', 'popup', 'effectiveAt'] : [],
    65536,
  );
  if (!id) return { announcement: await service.create(current.admin, body) };
  if (editing && !Object.keys(body).length)
    throw new NotificationError(HTTP_STATUS.BAD_REQUEST, 'ANNOUNCEMENT_INPUT_INVALID');
  return {
    announcement: await service.change(
      current.admin,
      id,
      editing ? 'update' : parts[1] === 'publish' ? 'publish' : 'unpublish',
      body,
    ),
  };
}
