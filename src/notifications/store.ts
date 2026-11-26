import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createId } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { Pool } from 'pg';
import { NotificationError } from './contracts.ts';
import type { Announcement, AnnouncementAction, AnnouncementValues } from './contracts.ts';
import { checkNotificationSchema } from './schema.ts';

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  status: 'draft' | 'published';
  enabled: boolean;
  popup: boolean;
  effective_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const visible =
  "a.status='published' AND a.enabled AND (a.effective_at IS NULL OR a.effective_at<=statement_timestamp())";

function announcement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    enabled: row.enabled,
    popup: row.popup,
    effectiveAt: row.effective_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class NotificationStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async list(page: number, pageSize: number, userId?: string) {
    const rows = await this.pool.query<AnnouncementRow & { is_read: boolean }>(
      `SELECT a.*, ${userId === undefined ? 'false' : 'EXISTS(SELECT 1 FROM mio_announcement_reads r WHERE r.user_id=$3 AND r.announcement_id=a.id)'} AS is_read
       FROM mio_announcements a ${userId === undefined ? '' : `WHERE ${visible}`}
       ORDER BY a.published_at DESC NULLS LAST,a.id DESC LIMIT $1 OFFSET $2`,
      [pageSize + 1, (page - 1) * pageSize, ...(userId === undefined ? [] : [userId])],
    );
    return {
      items: rows.rows
        .slice(0, pageSize)
        .map((row) => ({ ...announcement(row), isRead: row.is_read })),
      page,
      pageSize,
      hasMore: rows.rows.length > pageSize,
    };
  }

  async get(id: string): Promise<Announcement> {
    const row = (
      await this.pool.query<AnnouncementRow>('SELECT * FROM mio_announcements WHERE id=$1', [id])
    ).rows[0];
    if (!row) throw new NotificationError(HTTP_STATUS.NOT_FOUND, 'ANNOUNCEMENT_NOT_FOUND');
    return announcement(row);
  }

  async latestPopupMetadata() {
    const row = (
      await this.pool.query<AnnouncementRow & { next_effective_at: Date | null }>(
        `SELECT a.*, (SELECT min(effective_at) FROM mio_announcements
        WHERE status='published' AND enabled AND popup AND effective_at>statement_timestamp()) AS next_effective_at
       FROM (VALUES(1)) seed(n) LEFT JOIN LATERAL
       (SELECT * FROM mio_announcements a WHERE ${visible} AND a.popup
        ORDER BY a.published_at DESC,a.id DESC LIMIT 1) a ON true`,
      )
    ).rows[0]!;
    return {
      value: row.id ? announcement(row) : null,
      nextEffectiveAt: row.next_effective_at?.getTime() ?? null,
    };
  }

  async isRead(userId: string, id: string): Promise<boolean> {
    return Boolean(
      (
        await this.pool.query(
          'SELECT 1 FROM mio_announcement_reads WHERE user_id=$1 AND announcement_id=$2',
          [userId, id],
        )
      ).rowCount,
    );
  }

  async markRead(userId: string, id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // SHARE serializes with disable/unpublish/delete; a blocked SELECT rechecks visibility.
      const target = await client.query(
        `SELECT a.id FROM mio_announcements a WHERE a.id=$1 AND ${visible} FOR SHARE`,
        [id],
      );
      if (!target.rowCount)
        throw new NotificationError(HTTP_STATUS.NOT_FOUND, 'ANNOUNCEMENT_NOT_FOUND');
      await client.query(
        'INSERT INTO mio_announcement_reads(user_id,announcement_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [userId, id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    values: AnnouncementValues,
    audit: (id: string) => Promise<void>,
  ): Promise<Announcement> {
    const id = createId();
    await audit(id);
    const row = (
      await this.pool.query<AnnouncementRow>(
        `INSERT INTO mio_announcements(id,title,body,enabled,popup,effective_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, values.title, values.body, values.enabled, values.popup, values.effectiveAt],
      )
    ).rows[0]!;
    return announcement(row);
  }

  async change(
    id: string,
    action: Exclude<AnnouncementAction, 'create'>,
    values: (current: Announcement) => AnnouncementValues,
    audit: () => Promise<void>,
  ): Promise<Announcement | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query<AnnouncementRow>(
          'SELECT * FROM mio_announcements WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotificationError(HTTP_STATUS.NOT_FOUND, 'ANNOUNCEMENT_NOT_FOUND');
      const next = values(announcement(row));
      await audit();
      let saved: Announcement | null = null;
      if (action === 'delete')
        await client.query('DELETE FROM mio_announcements WHERE id=$1', [id]);
      else {
        const update =
          action === 'update'
            ? 'title=$2,body=$3,enabled=$4,popup=$5,effective_at=$6'
            : action === 'publish'
              ? "status='published',published_at=COALESCE(published_at,clock_timestamp())"
              : "status='draft',published_at=NULL";
        const result = await client.query<AnnouncementRow>(
          `UPDATE mio_announcements SET ${update},updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          action === 'update'
            ? [id, next.title, next.body, next.enabled, next.popup, next.effectiveAt]
            : [id],
        );
        saved = announcement(result.rows[0]!);
      }
      await client.query('COMMIT');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export async function createNotificationStore(databaseURL: string): Promise<NotificationStore> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-notifications',
  });
  pool.on('error', () =>
    createLogger('app', 'notifications-store').error('NOTIFICATIONS_DATABASE_CONNECTION_ERROR'),
  );
  try {
    await checkNotificationSchema(pool);
    return new NotificationStore(pool);
  } catch {
    await pool.end();
    throw new Error(
      'NOTIFICATIONS_SCHEMA: run notifications:migrate --apply after inspecting the schema',
    );
  }
}
