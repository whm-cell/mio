import { HttpError } from '@mio/foundation/errors';

export class NotificationError extends HttpError {}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  status: 'draft' | 'published';
  enabled: boolean;
  popup: boolean;
  effectiveAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementCard {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  isRead: boolean;
}

export type AnnouncementInput = Partial<Record<keyof AnnouncementValues, unknown>>;

export interface AnnouncementValues {
  title: string;
  body: string;
  enabled: boolean;
  popup: boolean;
  effectiveAt: string | null;
}

export interface AnnouncementActor {
  id: string;
  username: string;
}

export type AnnouncementAction = 'create' | 'update' | 'publish' | 'unpublish' | 'delete';

/** An independently committed admin audit intent; failure must prevent the mutation. */
export type AnnouncementAudit = (
  actor: AnnouncementActor,
  action: AnnouncementAction,
  targetId: string,
) => Promise<void>;
