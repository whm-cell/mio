import type { AccountDomainStore } from '../account-deletion/domain-store.ts';

/** Local ownership only. Third-party resource deletion retains its independent authorization. */
export function deleteMaterialAccount(store: AccountDomainStore, userId: string) {
  return store.batch(userId, 'materials', async (client) => {
    const auth = await client.query<{ present: boolean }>(
      "SELECT to_regclass('mio_material_auth_sessions') IS NOT NULL AS present",
    );
    let authRemaining = 0;
    if (auth.rows[0]!.present) {
      await client.query(
        'DELETE FROM mio_material_auth_sessions WHERE id IN (SELECT id FROM mio_material_auth_sessions WHERE owner_id=$1 LIMIT 100)',
        [userId],
      );
      authRemaining = (
        await client.query<{ remaining: number }>(
          'SELECT count(*)::integer AS remaining FROM mio_material_auth_sessions WHERE owner_id=$1',
          [userId],
        )
      ).rows[0]!.remaining;
    }
    await client.query(
      'DELETE FROM mio_material_operations WHERE id IN (SELECT id FROM mio_material_operations WHERE owner_id=$1 LIMIT 100)',
      [userId],
    );
    await client.query(
      `DELETE FROM mio_materials m WHERE m.id IN (SELECT id FROM mio_materials WHERE owner_id=$1
      AND NOT EXISTS(SELECT 1 FROM mio_material_operations o WHERE o.target_material_id=mio_materials.id) LIMIT 100)`,
      [userId],
    );
    if (authRemaining === 0)
      await client.query(
        `DELETE FROM mio_material_groups g WHERE g.id IN (SELECT id FROM mio_material_groups WHERE owner_id=$1
      AND NOT EXISTS(SELECT 1 FROM mio_materials m WHERE m.group_id=mio_material_groups.id)
      AND NOT EXISTS(SELECT 1 FROM mio_material_operations o WHERE o.target_group_id=mio_material_groups.id)
      LIMIT 100)`,
        [userId],
      );
    const result = await client.query<{ remaining: number }>(
      `SELECT (
      (SELECT count(*) FROM mio_material_groups WHERE owner_id=$1)+
      (SELECT count(*) FROM mio_materials WHERE owner_id=$1)+
      (SELECT count(*) FROM mio_material_operations WHERE owner_id=$1))::integer AS remaining`,
      [userId],
    );
    return result.rows[0]!.remaining + authRemaining;
  });
}
