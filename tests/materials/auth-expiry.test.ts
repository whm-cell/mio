import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, onTestFinished } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { materialAuthSchemaSQL } from '../../src/materials/auth-schema.ts';
import { MaterialAuthStore } from '../../src/materials/auth-store.ts';

async function fixture(due: number) {
  const db = await authDatabase();
  const pool = new Pool({ connectionString: db.url, statement_timeout: 2000 });
  onTestFinished(async () => {
    await pool.end();
    await db.close();
  });
  await pool.query(assetSchemaSQL);
  await pool.query(materialSchemaSQL);
  await pool.query(materialAuthSchemaSQL);
  await pool.query(
    "INSERT INTO mio_material_auth_sessions(id,owner_id,provider_type,provider_config_id,credential_version,request_id,input_hash,state,protocol_snapshot,return_target,created_at,expires_at,cipher_format,master_key_id,nonce,ciphertext,auth_tag,token_digest) SELECT gen_random_uuid(),'owner','onelink',gen_random_uuid(),1,gen_random_uuid(),repeat('a',64),'pending','{\"version\":1}','materials',t.created,t.created+interval '20 minutes',1,'synthetic-key',decode(repeat('00',12),'hex'),decode('01','hex'),decode(repeat('00',16),'hex'),repeat('a',64) FROM generate_series(1,$1::integer+1) g CROSS JOIN LATERAL (SELECT statement_timestamp()+CASE WHEN g<=$1 THEN interval '-21 minutes' ELSE interval '0' END AS created) t",
    [due],
  );
  return { pool, store: new MaterialAuthStore(pool) };
}

it('expires only the requested overdue session and keeps all unexpired secrets', async () => {
  const { pool, store } = await fixture(2);
  const id = (
    await pool.query<{ id: string }>(
      'SELECT id FROM mio_material_auth_sessions ORDER BY expires_at,id LIMIT 1',
    )
  ).rows[0]!.id;
  await store.expire(id);
  const rows = (await pool.query('SELECT * FROM mio_material_auth_sessions ORDER BY expires_at,id'))
    .rows;
  expect(rows.filter((row) => row.state === 'expired')).toHaveLength(1);
  expect(rows.find((row) => row.id === id)).toMatchObject({
    state: 'expired',
    cipher_format: null,
    master_key_id: null,
    nonce: null,
    ciphertext: null,
    auth_tag: null,
    lease_id: null,
    lease_until: null,
    error_code: 'AUTH_EXPIRED',
  });
  expect(rows.filter((row) => row.id !== id).every((row) => row.ciphertext !== null)).toBe(true);
  await store.expire(randomUUID());
  for (const invalid of ['', "' OR true --"])
    await expect(store.expire(invalid)).rejects.toMatchObject({ code: '22P02' });
  expect(
    (await pool.query("SELECT count(*) FROM mio_material_auth_sessions WHERE state='expired'"))
      .rows[0].count,
  ).toBe('1');
});

it('lets concurrent bounded sweepers progress past a locked first page without touching future sessions', async () => {
  const { pool, store } = await fixture(201);
  const locker = await pool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query(
      'SELECT id FROM mio_material_auth_sessions ORDER BY expires_at,id LIMIT 100 FOR UPDATE',
    );
    await Promise.all([store.expire(), store.expire()]);
    expect(
      (
        await pool.query(
          "SELECT count(*) FILTER(WHERE state='expired') AS expired,count(*) FILTER(WHERE state='pending' AND expires_at<=statement_timestamp()) AS held,count(*) FILTER(WHERE expires_at>statement_timestamp() AND ciphertext IS NOT NULL) AS future FROM mio_material_auth_sessions",
        )
      ).rows[0],
    ).toEqual({ expired: '101', held: '100', future: '1' });
    await locker.query('COMMIT');
    await store.expire();
    expect(
      (
        await pool.query(
          "SELECT count(*) FILTER(WHERE state='expired' AND num_nonnulls(cipher_format,master_key_id,nonce,ciphertext,auth_tag,lease_id,lease_until)=0) AS expired,count(*) FILTER(WHERE state='pending' AND ciphertext IS NOT NULL) AS future FROM mio_material_auth_sessions",
        )
      ).rows[0],
    ).toEqual({ expired: '201', future: '1' });
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
  }
});
