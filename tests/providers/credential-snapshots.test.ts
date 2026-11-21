import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { AccountCredentialSnapshot } from '../../src/providers/contracts.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';
import { findFixtureRoute } from './fixtures/onelink-routes-fixture.ts';

// Fixed synthetic v1 envelopes captured with the pre-refactor credentials.ts at 4d84ca5.
const ownerId = '1c111be2-4a47-4906-b85a-f14f051d3f11';
const apiKey = 'synthetic-snapshot-fixture-key';
const previous: AccountCredentialSnapshot = {
  providerConfigId: 'd1a50cb0-5d1a-4d21-a943-56e9a72cbc3b',
  credentialVersion: 7,
  credential: {
    cipherFormat: 1,
    masterKeyId: 'credential-snapshot-v1-fixture',
    nonce: 'I2KEJZGCWRjywoiA',
    ciphertext: 'jmhJE7KpePenfyir7jGtB+CeJb78pO39hjaigE4o',
    authTag: 'PBOR6YUY5uevnqamvUZesg==',
  },
};
const materialCredential: AccountCredentialSnapshot['credential'] = {
  cipherFormat: 1,
  masterKeyId: previous.credential.masterKeyId,
  nonce: 'ZnFOGTNni9umfDax',
  ciphertext:
    'qZy2enVhVHm9jLi2+oZUr9/7MUEUrqwXA8gNN2rKKzO8DlxX1T8pczA2fj/RGrsFjU8mZmdviGDiu3sQHYWdyNX/lAoGpM9OvBnV0GViXL1A4aN05mc3bzQ=',
  authTag: '5NhgZK1PE4DYsOdDyn1puQ==',
};

it('reads historical v1 image and account snapshots and keeps their credential binding', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  let service: ReturnType<typeof createProviderService> | undefined;
  try {
    await pool.query(providerSchemaSQL);
    const { cipherFormat, masterKeyId, nonce, ciphertext, authTag } = previous.credential;
    await pool.query(
      `INSERT INTO mio_provider_configs(id,owner_id,revision,credential_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag)
       VALUES($1,$2,1,$3,$4,$5,decode($6,'base64'),decode($7,'base64'),decode($8,'base64'))`,
      [
        previous.providerConfigId,
        ownerId,
        previous.credentialVersion,
        cipherFormat,
        masterKeyId,
        nonce,
        ciphertext,
        authTag,
      ],
    );
    const config = { databaseURL: database.url, masterKey: Buffer.alloc(32, 0x53), masterKeyId };
    const store = await createProviderStore(config);
    const modelId = 'image-vidu-q2';
    const transport = vi.fn(async () => Response.json({ data: [{ id: modelId }] }));
    const provider = createProviderService(store, config, transport);
    service = provider;
    const actor = { userId: ownerId, sessionId: 'fixture' };
    expect(await provider.snapshotAccount(ownerId)).toEqual(previous);
    expect(transport).not.toHaveBeenCalled();
    await store.importRoutes([findFixtureRoute(modelId, 'image.generate')]);
    await provider.discover(actor);
    const modelRef = (await provider.catalog(actor)).items[0]!.modelRef;
    const image = await provider.snapshotImage(actor, modelRef);
    expect(image).toMatchObject(previous);
    expect(image).not.toHaveProperty('apiKey');

    for (const open of [
      provider.openAccountSnapshot,
      (owner: string, snapshot: AccountCredentialSnapshot) =>
        provider.openImageSnapshot(owner, { ...image, ...snapshot }),
    ]) {
      expect(open(ownerId, JSON.parse(JSON.stringify(previous)))).toBe(apiKey);
      expect(() => open('another-owner', previous)).toThrow('PROVIDER_CREDENTIAL_UNAVAILABLE');
      for (const invalid of [
        { ...previous, providerConfigId: '19f564b6-29f9-4073-a622-542acd1a8116' },
        { ...previous, credentialVersion: previous.credentialVersion + 1 },
        { ...previous, credential: { ...previous.credential, cipherFormat: 2 } },
        { ...previous, credential: { ...previous.credential, masterKeyId: 'different-key-id' } },
        {
          ...previous,
          credential: { ...previous.credential, authTag: 'AAAAAAAAAAAAAAAAAAAAAA==' },
        },
        { ...previous, credential: materialCredential },
      ]) {
        expect(() => open(ownerId, invalid)).toThrow('PROVIDER_CREDENTIAL_UNAVAILABLE');
      }
    }

    // Both fixtures use the same key and owner, and the session ID equals the provider ID.
    expect(
      provider.openMaterialAuth(ownerId, previous.providerConfigId, {
        cipher_format: materialCredential.cipherFormat,
        master_key_id: materialCredential.masterKeyId,
        nonce: Buffer.from(materialCredential.nonce, 'base64'),
        ciphertext: Buffer.from(materialCredential.ciphertext, 'base64'),
        auth_tag: Buffer.from(materialCredential.authTag, 'base64'),
      }),
    ).toEqual({
      launchUrl: 'https://fixture.invalid/launch',
      token: 'synthetic-material-fixture-token',
    });
    const stored = (await store.current(ownerId))!;
    expect(() => provider.openMaterialAuth(ownerId, previous.providerConfigId, stored)).toThrow(
      'MATERIAL_AUTH_SECRET_UNAVAILABLE',
    );

    const wrongKey = createProviderService(store, { ...config, masterKey: Buffer.alloc(32, 0x54) });
    expect(() => wrongKey.openAccountSnapshot(ownerId, previous)).toThrow(
      'PROVIDER_CREDENTIAL_UNAVAILABLE',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    await service?.close();
    await pool.end();
    await database.close();
  }
});
