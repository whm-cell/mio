import type { AccountDomainStore } from '../account-deletion/domain-store.ts';

/** Public announcements stay intact; only this immutable user's private receipts are removed. */
export function deleteNotificationAccount(store: AccountDomainStore, userId: string) {
  return store.batch(userId, 'notifications', async (client) => {
    await client.query(
      `DELETE FROM mio_announcement_reads WHERE ctid IN
      (SELECT ctid FROM mio_announcement_reads WHERE user_id=$1 LIMIT 100)`,
      [userId],
    );
    const result = await client.query<{ remaining: number }>(
      'SELECT count(*)::integer AS remaining FROM mio_announcement_reads WHERE user_id=$1',
      [userId],
    );
    return result.rows[0]!.remaining;
  });
}

export function deleteCreationLogAccount(store: AccountDomainStore, userId: string) {
  return store.batch(userId, 'creation-logs', async (client) => {
    await client.query(
      'DELETE FROM mio_creation_logs WHERE id IN (SELECT id FROM mio_creation_logs WHERE owner_id=$1 LIMIT 100)',
      [userId],
    );
    return Number(
      (
        await client.query<{ count: string }>(
          'SELECT count(*) FROM mio_creation_logs WHERE owner_id=$1',
          [userId],
        )
      ).rows[0]!.count,
    );
  });
}
