import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { expect, it, onTestFinished } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { materialSchemaSQL, checkMaterialSchema } from '../../src/materials/schema.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import { readMaterialConfig } from '../../src/materials/config.ts';

async function fixture() {
  const db = await authDatabase();
  const pool = new Pool({ connectionString: db.url });
  onTestFinished(async () => {
    await pool.end();
    await db.close();
  });
  return { db, pool };
}
it('opts in explicitly and fails invalid settings without an auth/provider/database fallback', () => {
  expect(readMaterialConfig({})).toBeUndefined();
  expect(() => readMaterialConfig({ MIO_MATERIALS_ENABLED: 'false' })).toThrow('MATERIAL_CONFIG');
  expect(() => readMaterialConfig({ MIO_MATERIALS_ENABLED: 'true' })).toThrow('MATERIAL_CONFIG');
  expect(
    readMaterialConfig({
      MIO_MATERIALS_ENABLED: 'true',
      MIO_ASSETS_DATABASE_URL: 'postgresql://fixture/materials',
    }),
  ).toEqual({ databaseURL: 'postgresql://fixture/materials' });
});
it('previews without writes, migrates explicitly and idempotently without modifying existing assets', async () => {
  const { db, pool } = await fixture();
  await pool.query(assetSchemaSQL);
  const id = randomUUID();
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,expires_at) VALUES($1,'owner','x.png','image/png',1,$2,'pending',now()+interval '1 day')",
    [id, `mio/staging/${id}`],
  );
  const before = (await pool.query('SELECT * FROM mio_assets WHERE id=$1', [id])).rows;
  const migrate = (apply: boolean) =>
    spawnSync(
      process.execPath,
      ['scripts/service/migrate-materials.ts', ...(apply ? ['--apply'] : [])],
      {
        env: { PATH: process.env.PATH, MIO_ASSETS_DATABASE_URL: db.url },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
  const preview = migrate(false);
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout).toContain('CREATE TABLE IF NOT EXISTS mio_material_groups');
  expect(
    (await pool.query("SELECT to_regclass('mio_material_groups') AS value")).rows[0].value,
  ).toBeNull();
  for (let i = 0; i < 2; i++) {
    const result = migrate(true);
    expect(result.status, result.stderr).toBe(0);
  }
  await checkMaterialSchema(pool);
  expect((await pool.query('SELECT * FROM mio_assets WHERE id=$1', [id])).rows).toEqual(before);
  const tables = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'mio_material%' ORDER BY tablename",
    )
  ).rows;
  expect(tables.map((row) => row.tablename)).toEqual([
    'mio_material_auth_sessions',
    'mio_material_groups',
    'mio_material_operations',
    'mio_materials',
  ]);
});
it.each(['owner-column', 'extra-column', 'wrong-predicate', 'not-unique'])(
  'rejects weakened same-name global uniqueness without repairing or writing startup schema: %s',
  async (kind) => {
    const { db, pool } = await fixture();
    await pool.query(assetSchemaSQL);
    await pool.query(materialSchemaSQL);
    await pool.query('DROP INDEX mio_material_groups_upstream_unique');
    const columns =
      kind === 'owner-column'
        ? 'owner_id,provider_type,upstream_group_id'
        : kind === 'extra-column'
          ? 'provider_type,upstream_group_id,name'
          : 'provider_type,upstream_group_id';
    await pool.query(
      `CREATE ${kind === 'not-unique' ? '' : 'UNIQUE'} INDEX mio_material_groups_upstream_unique ON mio_material_groups(${columns}) WHERE upstream_group_id IS NOT NULL${kind === 'wrong-predicate' ? " AND state='ready'" : ''}`,
    );
    await expect(checkMaterialSchema(pool)).rejects.toThrow('exact global upstream uniqueness');
    await expect(createMaterialStore(db.url)).rejects.toThrow('MATERIAL_SCHEMA');
    const before = (
      await pool.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='mio_material_groups_upstream_unique'",
      )
    ).rows;
    await pool.query(materialSchemaSQL);
    await expect(checkMaterialSchema(pool)).rejects.toThrow('exact global upstream uniqueness');
    expect(
      (
        await pool.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='mio_material_groups_upstream_unique'",
        )
      ).rows,
    ).toEqual(before);
  },
);
it('checks the material global index as well as the group index', async () => {
  const { pool } = await fixture();
  await pool.query(assetSchemaSQL);
  await pool.query(materialSchemaSQL);
  await pool.query('DROP INDEX mio_materials_upstream_unique');
  await pool.query(
    'CREATE UNIQUE INDEX mio_materials_upstream_unique ON mio_materials(owner_id,provider_type,upstream_asset_id) WHERE upstream_asset_id IS NOT NULL',
  );
  await expect(checkMaterialSchema(pool)).rejects.toThrow('exact global upstream uniqueness');
});
