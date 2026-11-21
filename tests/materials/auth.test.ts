import { randomUUID, randomBytes } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import { materialAuthFixture } from './auth-fixture.ts';
import { envelope } from './fixture.ts';
import { createMaterialAuthService } from '../../src/materials/auth-service.ts';
import { createMaterialAuthUpstream } from '../../src/integrations/onelink/materials.ts';
import {
  encryptMaterialAuth,
  decryptMaterialAuth,
  encryptCredential,
  decryptCredential,
} from '../../src/providers/credentials.ts';
import { readMaterialAuthConfig } from '../../src/materials/config.ts';
import { checkMaterialAuthSchema } from '../../src/materials/auth-schema.ts';
async function fixture() {
  const f = await materialAuthFixture();
  onTestFinished(() => f.close());
  return f;
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  const token = [...f.tokens.keys()].at(-1)!;
  return { result, token, row: await f.store.authentication.get(result.sessionId, f.actor.userId) };
}

it('isolates session GCM purpose, owner, ID, key ID and ciphertext from existing credential envelopes', () => {
  const config = {
    databaseURL: 'postgresql://fixture/providers',
    masterKey: randomBytes(32),
    masterKeyId: 'auth-test',
  };
  const owner = 'owner',
    id = randomUUID(),
    payload = {
      launchUrl:
        'https://ark.volcengine.com/region:cn-beijing/mobile/livenees-face-manage/authorization?launch=secret',
      token: 'synthetic-private-token',
    };
  const sealed = encryptMaterialAuth(payload, owner, id, config);
  expect(decryptMaterialAuth(sealed, owner, id, config)).toEqual(payload);
  for (const [who, which, key] of [
    ['other', id, config],
    [owner, randomUUID(), config],
    [owner, id, { ...config, masterKeyId: 'other' }],
  ] as const)
    expect(() => decryptMaterialAuth(sealed, who, which, key)).toThrow(
      'MATERIAL_AUTH_SECRET_UNAVAILABLE',
    );
  const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
  tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;
  expect(() => decryptMaterialAuth(tampered, owner, id, config)).toThrow();
  const binding = { ownerId: owner, providerId: id, credentialVersion: 1 };
  const credential = encryptCredential('credential-private-key', binding, config);
  expect(() => decryptMaterialAuth(credential, owner, id, config)).toThrow();
  expect(() => decryptCredential(sealed, binding, config)).toThrow();
  expect(decryptCredential(credential, binding, config)).toBe('credential-private-key');
});
it('opts in separately with explicit HTTPS origin and allows an exact nondefault HTTPS port', () => {
  expect(readMaterialAuthConfig({ MIO_MATERIALS_ENABLED: 'true' })).toBeUndefined();
  expect(
    readMaterialAuthConfig({
      MIO_MATERIALS_ENABLED: 'true',
      MIO_MATERIALS_PUBLIC_BASE_URL: 'https://materials.example.test:8443',
    }),
  ).toEqual({ publicOrigin: 'https://materials.example.test:8443' });
  for (const value of [
    'http://materials.example.test',
    'https://materials.example.test/path',
    'https://materials.example.test?x=1',
    'https://user@materials.example.test',
    'https://localhost',
  ])
    expect(() =>
      readMaterialAuthConfig({
        MIO_MATERIALS_ENABLED: 'true',
        MIO_MATERIALS_PUBLIC_BASE_URL: value,
      }),
    ).toThrow('MATERIAL_AUTH_CONFIG');
  expect(() =>
    readMaterialAuthConfig({ MIO_MATERIALS_PUBLIC_BASE_URL: 'https://materials.example.test' }),
  ).toThrow();
});
it('persists creation intent before one remote call, stores only encrypted launch/token and returns local views without decryption', async () => {
  const f = await fixture();
  let intent = false;
  f.authOverride(async (action) => {
    if (action === 'CreateVisualValidateSession') {
      intent = Boolean(
        (
          await f.pool.query(
            "SELECT 1 FROM mio_material_auth_sessions WHERE owner_id=$1 AND state='creating'",
            [f.actor.userId],
          )
        ).rowCount,
      );
    }
    return;
  });
  const request = randomUUID();
  const view = await f.authentication.create(f.actor, request, 'materials', 'materials');
  expect(view).toMatchObject({
    state: 'pending',
    launchUrl: `${f.origin}/api/v1/materials/auth-sessions/${view.sessionId}/launch`,
    pollAfterMs: 3000,
  });
  expect(intent).toBe(true);
  const row = await f.store.authentication.get(view.sessionId, f.actor.userId);
  expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(20 * 60_000);
  expect(row.ciphertext).toBeInstanceOf(Buffer);
  expect(row.token_digest).toMatch(/^[a-f0-9]{64}$/);
  const secret = [...f.tokens.keys()][0]!;
  expect(row.ciphertext!.toString()).not.toContain(secret);
  expect(JSON.stringify(view)).not.toMatch(/synthetic|H5Link|BytedToken|ciphertext/);
  const open = vi.spyOn(f.provider, 'openMaterialAuth');
  const calls = f.authTransport.mock.calls.length;
  const blocker = await f.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE mio_material_auth_sessions IN SHARE MODE');
    expect(await f.authentication.get(f.actor, view.sessionId)).toEqual(view);
    expect(await f.authentication.create(f.actor, request, 'materials', 'materials')).toEqual(view);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  expect(open).not.toHaveBeenCalled();
  expect(f.authTransport).toHaveBeenCalledTimes(calls);
  expect(
    f.authTransport.mock.calls.filter(([url]) =>
      String(url).includes('Action=CreateVisualValidateSession'),
    ),
  ).toHaveLength(1);
  await expect(
    f.authentication.get({ userId: 'other', sessionId: 'other' }, view.sessionId),
  ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  expect((await f.pool.query('SELECT count(*) FROM mio_material_operations')).rows[0].count).toBe(
    '0',
  );
});
it('rejects another valid session token and negative claims without terminating the legitimate session or spending query budget', async () => {
  const f = await fixture(),
    a = await pending(f),
    b = await pending(f);
  const calls = f.authTransport.mock.calls.length;
  await expect(
    f.authentication.complete(a.result.sessionId, b.token, '10000'),
  ).rejects.toMatchObject({ code: 'AUTH_PROOF_INVALID' });
  await expect(f.authentication.complete(a.result.sessionId, a.token, '0')).rejects.toMatchObject({
    code: 'AUTH_RESULT_UNCONFIRMED',
  });
  expect((await f.store.authentication.get(a.result.sessionId)).state).toBe('pending');
  expect((await f.store.authentication.get(a.result.sessionId)).query_count).toBe(0);
  expect(f.authTransport).toHaveBeenCalledTimes(calls);
});
it('verifies result and real group atomically, clears secrets immediately and returns completed replay without a second group or remote query', async () => {
  const f = await fixture(),
    p = await pending(f);
  const result = await f.authentication.complete(p.result.sessionId, p.token, '10000');
  expect(result).toMatchObject({ state: 'completed', groupId: expect.any(String) });
  const row = await f.store.authentication.get(p.result.sessionId);
  expect([row.cipher_format, row.master_key_id, row.nonce, row.ciphertext, row.auth_tag]).toEqual([
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(row.token_digest).not.toBeNull();
  expect(row).toMatchObject({
    upstream_create_request_id: expect.any(String),
    upstream_result_request_id: expect.any(String),
    upstream_group_request_id: expect.any(String),
  });
  expect(
    new Set([
      row.upstream_create_request_id,
      row.upstream_result_request_id,
      row.upstream_group_request_id,
    ]).size,
  ).toBe(3);
  expect(JSON.stringify(result)).not.toContain(row.upstream_result_request_id);
  expect(await f.store.ownedGroup(f.actor.userId, result.groupId!)).toMatchObject({
    group_type: 'real',
    auth_status: 'verified',
    source_session_id: row.id,
  });
  const calls = f.authTransport.mock.calls.length;
  expect(await f.authentication.complete(row.id, p.token, '10000')).toEqual(result);
  expect(f.authTransport).toHaveBeenCalledTimes(calls);
  expect(
    (
      await f.pool.query('SELECT count(*) FROM mio_material_groups WHERE source_session_id=$1', [
        row.id,
      ])
    ).rows[0].count,
  ).toBe('1');
});
it('expires logical access at20minutes and clears all reversible secrets on access/bounded cleanup, preserving redacted result facts', async () => {
  const f = await fixture(),
    p = await pending(f);
  await f.pool.query(
    `UPDATE mio_material_auth_sessions SET created_at=created_at-interval '21 minutes',
      expires_at=expires_at-interval '21 minutes',state='verifying',lease_id=$2,
      lease_until=now()-interval '1 minute' WHERE id=$1`,
    [p.row.id, randomUUID()],
  );
  await expect(
    f.authentication.get({ userId: 'other', sessionId: 'other' }, p.row.id),
  ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  expect(
    (await f.pool.query('SELECT state FROM mio_material_auth_sessions WHERE id=$1', [p.row.id]))
      .rows[0]?.state,
  ).toBe('verifying');
  const views = await Promise.all(
    Array.from({ length: 2 }, () => f.authentication.get(f.actor, p.row.id)),
  );
  expect(views).toMatchObject([
    { state: 'expired', errorCode: 'AUTH_EXPIRED' },
    { state: 'expired', errorCode: 'AUTH_EXPIRED' },
  ]);
  expect(views.every((view) => !view.launchUrl)).toBe(true);
  await expect(f.authentication.launch(p.row.id)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  const row = await f.store.authentication.get(p.row.id);
  expect(row).toMatchObject({
    state: 'expired',
    ciphertext: null,
    nonce: null,
    auth_tag: null,
    cipher_format: null,
    master_key_id: null,
  });
  expect(row.token_digest).not.toBeNull();
  await expect(f.authentication.complete(p.row.id, p.token, '10000')).rejects.toMatchObject({
    code: 'AUTH_EXPIRED',
  });
});
it('settles a lost verification lease from an idempotent view without dropping its recovery proof', async () => {
  const f = await fixture();
  const request = randomUUID();
  const p = await f.authentication.create(f.actor, request, 'materials', 'materials');
  await f.pool.query(
    `UPDATE mio_material_auth_sessions SET state='verifying',lease_id=$2,
      lease_until=now()-interval '1 minute' WHERE id=$1`,
    [p.sessionId, randomUUID()],
  );
  await expect(
    f.store.authentication.previous(f.actor.userId, request, 'a'.repeat(64)),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await f.authentication.create(f.actor, request, 'materials', 'materials')).toMatchObject({
    state: 'unknown',
    errorCode: 'UPSTREAM_RESULT_UNKNOWN',
    launchUrl: p.launchUrl,
  });
  expect(await f.store.authentication.get(p.sessionId, f.actor.userId)).toMatchObject({
    lease_id: null,
    lease_until: null,
    ciphertext: expect.any(Buffer),
    token_digest: expect.any(String),
  });
  expect(f.authTransport).toHaveBeenCalledTimes(1);
});
it('retains known creation proof after PG failure for original-session launch/callback recovery and never repeats create across restart', async () => {
  const f = await fixture();
  vi.spyOn(f.store.authentication, 'created').mockRejectedValueOnce(new Error('PG_COMMIT_LOST'));
  const p = await pending(f);
  expect(p.result.state).toBe('unknown');
  expect(p.result.launchUrl).toBe(`${f.origin}/api/v1/materials/auth-sessions/${p.row.id}/launch`);
  expect((await f.authentication.get(f.actor, p.row.id)).launchUrl).toBe(p.result.launchUrl);
  expect(p.row.ciphertext).not.toBeNull();
  expect(p.row.upstream_create_request_id).toEqual(expect.any(String));
  const recovered = createMaterialAuthService(
    f.store.authentication,
    f.provider,
    createMaterialAuthUpstream(f.authTransport),
    f.origin,
  );
  try {
    expect(await recovered.launch(p.row.id)).toBe(f.tokens.get(p.token)!.launchUrl);
    expect(await recovered.complete(p.row.id, p.token, '10000')).toMatchObject({
      state: 'completed',
    });
  } finally {
    await recovered.close();
  }
  expect(
    f.authTransport.mock.calls.filter(([url]) =>
      String(url).includes('Action=CreateVisualValidateSession'),
    ),
  ).toHaveLength(1);
});
it('leaves lost-token create unknown and does not automatically re-create or forge launch authority', async () => {
  const f = await fixture();
  f.authOverride(async (action) => {
    if (action === 'CreateVisualValidateSession') throw new Error('TIMEOUT');
    return;
  });
  const request = randomUUID();
  const view = await f.authentication.create(f.actor, request, 'materials', 'materials');
  expect(view).toMatchObject({ state: 'unknown' });
  expect((await f.store.authentication.get(view.sessionId)).upstream_create_request_id).toBeNull();
  expect(view).not.toHaveProperty('launchUrl');
  expect(await f.authentication.create(f.actor, request, 'materials', 'materials')).toEqual(view);
  await expect(f.authentication.launch(view.sessionId)).rejects.toMatchObject({
    code: 'AUTH_NOT_READY',
  });
  expect(f.authTransport).toHaveBeenCalledTimes(1);
});
it('serializes concurrent callbacks and prevents an expired old verifier from overwriting the new terminal', async () => {
  const f = await fixture(),
    p = await pending(f);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let held = false;
  f.authOverride(async (action) => {
    if (action === 'GetVisualValidateResult' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const first = f.authentication.complete(p.row.id, p.token, '10000');
  await entered.promise;
  await expect(f.authentication.complete(p.row.id, p.token, '10000')).rejects.toMatchObject({
    code: 'AUTH_QUERY_LIMITED',
  });
  await f.pool.query(
    "UPDATE mio_material_auth_sessions SET lease_until=clock_timestamp()-interval '1 second',next_query_at=NULL WHERE id=$1",
    [p.row.id],
  );
  const winner = await f.authentication.complete(p.row.id, p.token, '10000');
  expect(winner.state).toBe('completed');
  release.resolve();
  await expect(first).rejects.toMatchObject({ code: 'MATERIAL_AUTH_SUPERSEDED' });
  expect(await f.authentication.get(f.actor, p.row.id)).toEqual(winner);
  expect(
    (
      await f.pool.query('SELECT count(*) FROM mio_material_groups WHERE source_session_id=$1', [
        p.row.id,
      ])
    ).rows[0].count,
  ).toBe('1');
});
it('retains the upstream creation request ID from a known rejection without saving a token', async () => {
  const f = await fixture();
  f.authOverride(async (action) => envelope(action, {}, 403, 'Forbidden'));
  const requestId = randomUUID();
  const view = await f.authentication.create(f.actor, requestId, 'materials', 'materials');
  expect(view).toMatchObject({ state: 'failed', errorCode: 'PROVIDER_RESOURCE_FORBIDDEN' });
  const stored = await f.store.authentication.get(view.sessionId, f.actor.userId);
  expect(stored).toMatchObject({
    upstream_create_request_id: expect.any(String),
    token_digest: null,
  });
  expect(stored.upstream_create_request_id).not.toBe(requestId);
  expect(JSON.stringify(view)).not.toContain(stored.upstream_create_request_id);
});
it.each([403, 404, 'invalid', 'wrongtype', 'group-rejected', 'missing-request-id'])(
  'fails closed on result/group issue %s and keeps session recoverable',
  async (kind) => {
    const f = await fixture(),
      p = await pending(f);
    f.authOverride(async (action) => {
      if (action === 'GetVisualValidateResult' && (kind === 403 || kind === 404))
        return envelope(action, {}, kind, kind === 404 ? 'ResourceNotFound' : 'Forbidden');
      if (action === 'GetVisualValidateResult' && kind === 'invalid')
        return envelope(action, { State: 'succeeded' });
      if (action === 'GetVisualValidateResult' && kind === 'missing-request-id')
        return Response.json(
          {
            ResponseMetadata: {
              Action: action,
              Service: 'ark',
              Version: '2024-01-01',
              Error: { Code: 'Forbidden' },
            },
          },
          { status: 403 },
        );
      if (action === 'GetAssetGroup' && kind === 'wrongtype')
        return envelope(action, { Id: f.tokens.get(p.token)!.group, GroupType: 'AIGC' });
      if (action === 'GetAssetGroup' && kind === 'group-rejected')
        return envelope(action, {}, 403, 'Forbidden');
      return;
    });
    await expect(f.authentication.complete(p.row.id, p.token, '10000')).rejects.toBeDefined();
    expect(await f.store.authentication.get(p.row.id)).toMatchObject({
      state: 'unknown',
      upstream_result_request_id: ['invalid', 'missing-request-id'].includes(String(kind))
        ? null
        : expect.any(String),
      upstream_group_request_id: kind === 'group-rejected' ? expect.any(String) : null,
    });
    expect((await f.pool.query('SELECT count(*) FROM mio_material_groups')).rows[0].count).toBe(
      '0',
    );
    const before = f.authTransport.mock.calls.length;
    await expect(f.authentication.complete(p.row.id, p.token, '10000')).rejects.toMatchObject({
      code: 'AUTH_QUERY_LIMITED',
    });
    expect(f.authTransport).toHaveBeenCalledTimes(before);
  },
);
it('never rebinds a completed session group ID already owned by another user', async () => {
  const f = await fixture(),
    p = await pending(f);
  const existing = { upstreamId: 'group-20261120000000-othrx' };
  await f.pool.query(
    "INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,upstream_group_id,group_type,name,auth_status,state) VALUES($1,'other-owner','onelink',$2,'onelink-volc-ark',$3,'aigc','Other private','not_applicable','ready')",
    [randomUUID(), randomUUID(), existing.upstreamId],
  );
  f.authOverride(async (action) =>
    action === 'GetVisualValidateResult'
      ? envelope(action, { GroupId: existing.upstreamId })
      : undefined,
  );
  await expect(f.authentication.complete(p.row.id, p.token, '10000')).rejects.toMatchObject({
    code: 'UPSTREAM_RESOURCE_COLLISION',
  });
  expect(await f.store.authentication.get(p.row.id)).toMatchObject({
    state: 'unknown',
    upstream_result_request_id: expect.any(String),
    upstream_group_request_id: expect.any(String),
  });
  expect(
    (
      await f.pool.query(
        'SELECT owner_id,group_type FROM mio_material_groups WHERE upstream_group_id=$1',
        [existing.upstreamId],
      )
    ).rows,
  ).toEqual([{ owner_id: 'other-owner', group_type: 'aigc' }]);
});
it('omits malformed or secret-like request metadata from the durable authentication audit', async () => {
  const f = await fixture(),
    p = await pending(f);
  const { group } = f.tokens.get(p.token)!;
  f.authOverride(async (action) => {
    const isResult = action === 'GetVisualValidateResult';
    const response = envelope(
      action,
      isResult ? { GroupId: group } : { Id: group, GroupType: 'LivenessFace' },
    );
    const payload = (await response.json()) as { ResponseMetadata: { RequestId: string } };
    payload.ResponseMetadata.RequestId = isResult
      ? `upstream-${p.token}-opaque`
      : 'https://example.test/?opaque=secret';
    return Response.json(payload);
  });
  expect(await f.authentication.complete(p.row.id, p.token, '10000')).toMatchObject({
    state: 'completed',
  });
  expect(await f.store.authentication.get(p.row.id)).toMatchObject({
    upstream_result_request_id: null,
    upstream_group_request_id: null,
  });
});
it('persists verification query budget across service restart and leaves budget exhaustion unknown without remote replay', async () => {
  const f = await fixture(),
    p = await pending(f);
  await f.pool.query(
    "UPDATE mio_material_auth_sessions SET query_count=8,state='unknown' WHERE id=$1",
    [p.row.id],
  );
  const recovered = createMaterialAuthService(
    f.store.authentication,
    f.provider,
    createMaterialAuthUpstream(f.authTransport),
    f.origin,
  );
  const before = f.authTransport.mock.calls.length;
  try {
    await expect(recovered.complete(p.row.id, p.token, '10000')).rejects.toMatchObject({
      code: 'AUTH_QUERY_LIMITED',
    });
  } finally {
    await recovered.close();
  }
  expect((await f.store.authentication.get(p.row.id)).state).toBe('unknown');
  expect(f.authTransport).toHaveBeenCalledTimes(before);
});
it.each(['unique', 'expiry', 'owner-fk'])(
  'startup rejects a missing auth-method critical %s constraint/index without repairing',
  async (kind) => {
    const f = await fixture();
    await checkMaterialAuthSchema(f.pool);
    if (kind === 'expiry') await f.pool.query('DROP INDEX mio_material_auth_sessions_expiry');
    else {
      const type = kind === 'unique' ? 'u' : 'f';
      const constraint = (
        await f.pool.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='mio_material_auth_sessions'::regclass AND contype=$1 AND (contype='f' OR pg_get_constraintdef(oid)='UNIQUE (owner_id, request_id)') LIMIT 1",
          [type],
        )
      ).rows[0];
      await f.pool.query(
        `ALTER TABLE mio_material_auth_sessions DROP CONSTRAINT "${constraint.conname}"`,
      );
    }
    await expect(checkMaterialAuthSchema(f.pool)).rejects.toThrow('MATERIAL_AUTH_SCHEMA');
  },
);

it('rejects partial encrypted envelopes at the database boundary and keeps plaintext columns absent', async () => {
  const f = await fixture();
  const row = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  await expect(
    f.pool.query('UPDATE mio_material_auth_sessions SET auth_tag=NULL WHERE id=$1', [
      row.sessionId,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    f.pool.query('SELECT byted_token,h5_link FROM mio_material_auth_sessions'),
  ).rejects.toMatchObject({ code: '42703' });
});
it('cleans at most100 due sessions per pass and preserves completed and not-yet-expired envelopes', async () => {
  const f = await fixture(),
    p = await pending(f);
  const complete = await pending(f);
  await f.authentication.complete(complete.row.id, complete.token, '10000');
  await f.pool.query(
    `INSERT INTO mio_material_auth_sessions(id,owner_id,provider_type,provider_config_id,credential_version,request_id,input_hash,state,protocol_snapshot,return_target,created_at,expires_at,cipher_format,master_key_id,nonce,ciphertext,auth_tag,token_digest)
   SELECT md5('session-'||x)::uuid,owner_id,provider_type,provider_config_id,credential_version,md5('request-'||x)::uuid,input_hash,'pending',protocol_snapshot,return_target,created_at-interval '21 minutes',expires_at-interval '21 minutes',cipher_format,master_key_id,nonce,ciphertext,auth_tag,token_digest FROM mio_material_auth_sessions CROSS JOIN generate_series(1,101) x WHERE id=$1`,
    [p.row.id],
  );
  await f.store.authentication.expire();
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM mio_material_auth_sessions WHERE state='expired' AND ciphertext IS NULL",
      )
    ).rows[0].count,
  ).toBe('100');
  await f.store.authentication.expire();
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM mio_material_auth_sessions WHERE state='expired' AND ciphertext IS NULL",
      )
    ).rows[0].count,
  ).toBe('101');
  expect((await f.store.authentication.get(p.row.id)).ciphertext).not.toBeNull();
  expect((await f.store.authentication.get(complete.row.id)).state).toBe('completed');
});

it('uses the owner current rotated account without changing session/group ownership, and rejected credentials preserve unknown history', async () => {
  const f = await fixture(),
    p = await pending(f);
  const before = await f.provider.get(f.actor);
  await f.provider.save(f.actor, before!.revision, 'rotated-auth-private-key');
  const completed = await f.authentication.complete(p.row.id, p.token, '10000');
  expect(completed.state).toBe('completed');
  const call = f.authTransport.mock.calls.find(([url]) =>
    String(url).includes('Action=GetVisualValidateResult'),
  )!;
  expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer rotated-auth-private-key' });
  const second = await pending(f);
  await f.pool.query(
    "UPDATE mio_provider_configs SET credential_auth_state='rejected' WHERE owner_id=$1",
    [f.actor.userId],
  );
  await expect(
    f.authentication.complete(second.row.id, second.token, '10000'),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect((await f.store.authentication.get(second.row.id)).state).toBe('unknown');
  expect((await f.store.ownedGroup(f.actor.userId, completed.groupId!)).owner_id).toBe(
    f.actor.userId,
  );
});

it('recovers after the phone callback page was closed using only the original owner request and stored session token', async () => {
  const f = await fixture(),
    p = await pending(f);
  let lost = true;
  f.authOverride(async (action) => {
    if (action === 'GetVisualValidateResult' && lost) {
      lost = false;
      throw new Error('CALLBACK_CONNECTION_LOST');
    }
    return;
  });
  await expect(f.authentication.complete(p.row.id, p.token, '10000')).rejects.toBeDefined();
  expect((await f.authentication.get(f.actor, p.row.id)).state).toBe('unknown');
  const opens = vi.spyOn(f.provider, 'openMaterialAuth'),
    calls = f.authTransport.mock.calls.length;
  await expect(
    f.authentication.refresh({ userId: 'other-owner', sessionId: 'other' }, p.row.id),
  ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  expect(opens).not.toHaveBeenCalled();
  expect(f.authTransport).toHaveBeenCalledTimes(calls);
  await expect(f.authentication.refresh(f.actor, p.row.id)).rejects.toMatchObject({
    code: 'AUTH_QUERY_LIMITED',
  });
  await f.pool.query('UPDATE mio_material_auth_sessions SET next_query_at=NULL WHERE id=$1', [
    p.row.id,
  ]);
  await f.authentication.close();
  const restarted = createMaterialAuthService(
    f.store.authentication,
    f.provider,
    createMaterialAuthUpstream(f.authTransport),
    f.origin,
  );
  try {
    const result = await restarted.refresh(f.actor, p.row.id);
    expect(result.state).toBe('completed');
    const count = f.authTransport.mock.calls.length;
    expect(await restarted.refresh(f.actor, p.row.id)).toEqual(result);
    expect(f.authTransport).toHaveBeenCalledTimes(count);
  } finally {
    await restarted.close();
  }
  expect(
    f.authTransport.mock.calls.filter(([url]) =>
      String(url).includes('Action=CreateVisualValidateSession'),
    ),
  ).toHaveLength(1);
});
it('never reconstructs an owner refresh with no original token and does not query past budget or expiry', async () => {
  const f = await fixture();
  f.authOverride(async (action) => {
    if (action === 'CreateVisualValidateSession') throw new Error('LOST_TOKEN');
    return;
  });
  const row = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  const calls = f.authTransport.mock.calls.length;
  await expect(f.authentication.refresh(f.actor, row.sessionId)).rejects.toMatchObject({
    code: 'AUTH_RECOVERY_UNAVAILABLE',
  });
  expect(f.authTransport).toHaveBeenCalledTimes(calls);
});

it('cannot complete or resurrect secrets when a held successful verifier returns after the hard20-minute deadline', async () => {
  const f = await fixture(),
    p = await pending(f),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.authOverride(async (action) => {
    if (action === 'GetVisualValidateResult') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const finishing = f.authentication.complete(p.row.id, p.token, '10000');
  await entered.promise;
  await f.pool.query(
    "UPDATE mio_material_auth_sessions SET created_at=created_at-interval '21 minutes',expires_at=expires_at-interval '21 minutes' WHERE id=$1",
    [p.row.id],
  );
  await f.store.authentication.expire(p.row.id);
  release.resolve();
  await expect(finishing).rejects.toMatchObject({ code: 'MATERIAL_AUTH_SUPERSEDED' });
  const final = await f.store.authentication.get(p.row.id);
  expect(final).toMatchObject({
    state: 'expired',
    group_id: null,
    cipher_format: null,
    master_key_id: null,
    nonce: null,
    ciphertext: null,
    auth_tag: null,
  });
  expect(
    (
      await f.pool.query('SELECT count(*) FROM mio_material_groups WHERE source_session_id=$1', [
        p.row.id,
      ])
    ).rows[0].count,
  ).toBe('0');
});
it('cannot rewrite returned creation secrets or fallback after the same session expired while remote create was held', async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.authOverride(async (action) => {
    if (action === 'CreateVisualValidateSession') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const creating = f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  await entered.promise;
  const id = (
    await f.pool.query('SELECT id FROM mio_material_auth_sessions WHERE owner_id=$1', [
      f.actor.userId,
    ])
  ).rows[0].id;
  await f.pool.query(
    "UPDATE mio_material_auth_sessions SET created_at=created_at-interval '21 minutes',expires_at=expires_at-interval '21 minutes' WHERE id=$1",
    [id],
  );
  await f.store.authentication.expire(id);
  release.resolve();
  expect(await creating).toMatchObject({ state: 'expired', sessionId: id });
  const final = await f.store.authentication.get(id);
  expect(final).toMatchObject({
    state: 'expired',
    group_id: null,
    cipher_format: null,
    master_key_id: null,
    nonce: null,
    ciphertext: null,
    auth_tag: null,
    token_digest: null,
  });
  expect(
    (
      await f.pool.query('SELECT count(*) FROM mio_material_groups WHERE source_session_id=$1', [
        id,
      ])
    ).rows[0].count,
  ).toBe('0');
  expect(
    f.authTransport.mock.calls.filter(([url]) =>
      String(url).includes('Action=CreateVisualValidateSession'),
    ),
  ).toHaveLength(1);
});
