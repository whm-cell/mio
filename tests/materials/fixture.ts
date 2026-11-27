import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, onTestFinished, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { materialAuthSchemaSQL } from '../../src/materials/auth-schema.ts';
import { MaterialAuthStore } from '../../src/materials/auth-store.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { createMaterialStore, MaterialStore } from '../../src/materials/store.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';
import type { createAssetService } from '../../src/assets/service.ts';
import type { ModelTransport } from '../../src/integrations/onelink/models.ts';

export function envelope(
  action: string,
  result: unknown = {},
  status = 200,
  code?: string,
): Response {
  return Response.json(
    {
      ResponseMetadata: {
        Action: action,
        Version: '2024-01-01',
        Service: 'ark',
        RequestId: randomUUID(),
        ...(code ? { Error: { Code: code } } : {}),
      },
      ...(code ? {} : { Result: result }),
    },
    { status },
  );
}
export async function materialFixture(
  assets?: Pick<ReturnType<typeof createAssetService>, 'readMaterialSource' | 'materialUrl'>,
  authentication = false,
) {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(providerSchemaSQL);
  await pool.query(materialSchemaSQL);
  if (authentication) await pool.query(materialAuthSchemaSQL);
  const config = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'materials-test',
  };
  const providerStore = await createProviderStore(config);
  const provider = createProviderService(providerStore, config, async () => {
    throw new Error('MODEL_NETWORK_FORBIDDEN');
  });
  const actor = { userId: randomUUID(), sessionId: 'synthetic' };
  await provider.save(actor, 0, 'synthetic-material-private-key');
  const groups = new Map<string, string>();
  const items = new Map<
    string,
    { Id: string; GroupId: string; Name: string; AssetType: 'Image'; Status: string }
  >();
  const deleteRemoteGroup = (id: string) => {
    groups.delete(id);
    for (const [itemId, item] of items) if (item.GroupId === id) items.delete(itemId);
  };
  let sequence = 0;
  let override:
    ((action: string, body: Record<string, unknown>) => Promise<Response | undefined>) | undefined;
  const transport = vi.fn<ModelTransport>(async (input, init) => {
    const action = new URL(String(input)).searchParams.get('Action')!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const special = await override?.(action, body);
    if (special) return special;
    const id = String(body.Id);
    if (action === 'CreateAssetGroup') {
      const id = `group-${String(++sequence).padStart(14, '0')}-abcde`;
      groups.set(id, String(body.Name));
      return envelope(action, { Id: id });
    }
    if (action === 'CreateAsset') {
      const Id = `asset-${String(++sequence).padStart(14, '0')}-abcde`;
      items.set(Id, {
        Id,
        GroupId: String(body.GroupId),
        Name: String(body.Name ?? ''),
        AssetType: 'Image',
        Status: 'Processing',
      });
      return envelope(action, { Id });
    }
    if (action === 'GetAssetGroup')
      return groups.has(id)
        ? envelope(action, { Id: id, Name: groups.get(id) })
        : envelope(action, {}, 404, 'ResourceNotFound');
    if (action === 'UpdateAssetGroup') {
      groups.set(id, String(body.Name));
      return envelope(action, { Id: id });
    }
    if (action === 'DeleteAssetGroup') {
      deleteRemoteGroup(id);
      return envelope(action, { Id: id });
    }
    if (action === 'ListAssets') {
      const ids = (body.Filter as { GroupIds: string[] }).GroupIds;
      const selected = [...items.values()].filter((item) => ids.includes(item.GroupId));
      const page = Number(body.PageNumber);
      return envelope(action, {
        Items: selected.slice((page - 1) * 100, page * 100),
        PageNumber: page,
        PageSize: 100,
        TotalCount: selected.length,
      });
    }
    if (action === 'GetAsset')
      return items.has(id)
        ? envelope(action, items.get(id))
        : envelope(action, {}, 404, 'ResourceNotFound');
    if (action === 'DeleteAsset') {
      items.delete(id);
      return envelope(action, {});
    }
    throw new Error(`FORBIDDEN_ACTION_${action}`);
  });
  const store = await createMaterialStore(database.url, authentication);
  const service = createMaterialService(store, provider, createMaterialUpstream(transport), assets);
  const create = async (name = 'Example') => {
    const result = await service.createGroup(actor, randomUUID(), name);
    if (!('group' in result)) throw new Error(`Group failed: ${result.operation.errorCode}`);
    const group = result.group!;
    const row = await store.ownedGroup(actor.userId, group.groupId);
    return { ...group, upstreamId: row.upstream_group_id! };
  };
  const add = (groupId: string, number = 1, status = 'Active') => {
    const Id = `asset-${String(number).padStart(14, '0')}-abcde`;
    items.set(Id, {
      Id,
      GroupId: groupId,
      Name: `Item ${number}`,
      AssetType: 'Image',
      Status: status,
    });
    return Id;
  };
  return {
    database,
    pool,
    provider,
    providerStore,
    actor,
    groups,
    items,
    deleteRemoteGroup,
    store,
    service,
    transport,
    create,
    add,
    override(value: typeof override) {
      override = value;
    },
    async close() {
      await service.close();
      await provider.close();
      await pool.end();
      await database.close();
    },
  };
}
export type MaterialFixture = Awaited<ReturnType<typeof materialFixture>>;

export function peer(f: MaterialFixture, role: string) {
  const name = `${f.database.applicationName}_${role}`;
  const url = new URL(f.database.url);
  url.searchParams.set('application_name', name);
  const pool = new Pool({ connectionString: url.toString(), max: 1, statement_timeout: 3000 });
  const store = new MaterialStore(pool, new MaterialAuthStore(pool), false);
  onTestFinished(() => store.close());
  return { name, pool, store };
}

export async function blockedBy(f: MaterialFixture, name: string, blocker: number) {
  return vi.waitFor(
    async () => {
      const rows = (
        await f.pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))',
          [name, blocker],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      return rows[0]!.pid;
    },
    { timeout: 2500, interval: 10 },
  );
}
