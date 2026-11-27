import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { AccountDomainStore } from '../../src/account-deletion/domain-store.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { deleteMaterialAccount } from '../../src/materials/account-deletion.ts';
import { materialAuthSchemaSQL } from '../../src/materials/auth-schema.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { authDatabase } from '../support/auth-database.ts';

it.each([false, true])(
  'drains more than one page of material auth sessions before domain completion (grouped=%s)',
  async (grouped) => {
    const database = await authDatabase();
    const pool = new Pool({ connectionString: database.url });
    const store = new AccountDomainStore(pool);
    try {
      await pool.query(assetSchemaSQL + materialSchemaSQL + materialAuthSchemaSQL);
      const provider = randomUUID(),
        group = randomUUID(),
        otherGroup = randomUUID();
      if (grouped)
        await pool.query(
          `INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,group_type,name,auth_status,state)
        VALUES($1,'old','onelink',$3,'onelink-volc-ark','real','old','verified','ready'),
        ($2,'other','onelink',$3,'onelink-volc-ark','real','other','verified','ready')`,
          [group, otherGroup, provider],
        );
      for (const [owner, count, groupId] of [
        ['old', 101, group],
        ['other', 1, otherGroup],
      ] as const)
        await pool.query(
          `INSERT INTO mio_material_auth_sessions(id,owner_id,provider_type,provider_config_id,credential_version,request_id,input_hash,state,protocol_snapshot,return_target,group_id,expires_at)
        SELECT gen_random_uuid(),$1,'onelink',$2,1,gen_random_uuid(),repeat('a',64),
          CASE WHEN $3 THEN 'completed' WHEN n%2=0 THEN 'failed' ELSE 'expired' END,
          '{"version":1}','materials',$4,now()+interval '20 minutes' FROM generate_series(1,$5) n`,
          [owner, provider, grouped, grouped ? groupId : null, count],
        );
      await store.closeAccount('old', new Date());
      await expect(deleteMaterialAccount(store, 'old')).resolves.toEqual({
        done: false,
        remaining: grouped ? 2 : 1,
      });
      expect(
        (await pool.query("SELECT id FROM mio_material_auth_sessions WHERE owner_id='old'"))
          .rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT remaining,completed_at FROM mio_account_cleanup_receipts WHERE user_id='old' AND domain='materials'",
          )
        ).rows[0],
      ).toEqual({ remaining: grouped ? 2 : 1, completed_at: null });
      if (grouped)
        expect(
          (await pool.query("SELECT id FROM mio_material_groups WHERE owner_id='old'")).rowCount,
        ).toBe(1);
      await expect(deleteMaterialAccount(store, 'old')).resolves.toEqual({
        done: true,
        remaining: 0,
      });
      expect(
        (await pool.query("SELECT id FROM mio_material_auth_sessions WHERE owner_id='old'"))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT remaining,completed_at FROM mio_account_cleanup_receipts WHERE user_id='old' AND domain='materials'",
          )
        ).rows[0],
      ).toMatchObject({ remaining: 0, completed_at: expect.any(Date) });
      expect((await pool.query('SELECT owner_id FROM mio_material_auth_sessions')).rows).toEqual([
        { owner_id: 'other' },
      ]);
      expect((await pool.query('SELECT owner_id FROM mio_material_groups')).rows).toEqual(
        grouped ? [{ owner_id: 'other' }] : [],
      );
    } finally {
      await store.close();
      await database.close();
    }
  },
);
