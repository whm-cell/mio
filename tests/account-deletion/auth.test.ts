import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createAuthHandler } from '../../src/auth/http.ts';
import { deleteAccount, replayAccountDeletion } from '../../src/auth/deletion.ts';
import {
  reserveAccountDeletionChallenge,
  activatePhoneChallenge,
  consumePhoneLoginChallenge,
  reservePhoneChallenge,
} from '../../src/auth/phone-store.ts';
import { readSmsBudgetSchema } from '../../src/auth/phone-budget-schema.ts';
import { deletionAuthFixture } from './fixture.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import {
  consumePendingPhoneChallenge,
  reserveWechatExistingPhoneChallenge,
} from '../../src/auth/phone-store.ts';

it('DELETE enforces exact Origin/JSON, removes both devices, releases login identity and cannot be revived by admin or a late session', async () => {
  const f = await deletionAuthFixture();
  const server = createServer();
  try {
    const actor = await f.register();
    const login = await f.request('sign-in/email', {
      email: actor.email,
      password: 'strong-test-password-143',
    });
    const second = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    server.on('request', createAuthHandler(f.config, f.auth));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/me`;
    const call = (origin?: string, body = '{}', json = true) =>
      fetch(endpoint, {
        method: 'DELETE',
        headers: {
          cookie: actor.cookie,
          ...(origin ? { origin } : {}),
          ...(json ? { 'content-type': 'application/json' } : {}),
        },
        body,
      });
    expect((await call()).status).toBe(403);
    expect((await call(f.config.baseURL + '/')).status).toBe(403);
    expect((await call(f.config.baseURL, '{}', false)).status).toBe(415);
    const response = await call(f.config.baseURL);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.getSetCookie().join()).toContain('Max-Age=0');
    const value = await response.json();
    expect(value).toMatchObject({ status: true, finalizedAt: expect.any(String) });
    expect(await f.auth.identity(new Headers({ cookie: actor.cookie }))).toBeNull();
    expect(await f.auth.identity(new Headers({ cookie: second }))).toBeNull();
    expect(await f.auth.setUserDisabled(actor.userId, false)).toBeNull();
    await expect(
      f.pool.query('UPDATE "user" SET disabled=false WHERE id=$1', [actor.userId]),
    ).rejects.toThrow('ACCOUNT_DELETED');
    await expect(
      f.pool.query(
        `INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt")
      VALUES($1,$1,$2,now()+interval '1 day',now(),now())`,
        [randomUUID(), actor.userId],
      ),
    ).rejects.toThrow('ACCOUNT_DELETED');
    const fresh = await f.register(actor.email);
    expect(fresh.userId).not.toBe(actor.userId);
    expect(
      (
        await f.pool.query(
          'SELECT user_id,finalized_at,deadline_at FROM mio_account_cleanup_jobs WHERE user_id=$1',
          [actor.userId],
        )
      ).rows[0],
    ).toMatchObject({ user_id: actor.userId, finalized_at: new Date(value.finalizedAt) });
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

it('deletion/job are atomic; OTP proof stays scoped to original session, phone and purpose, including identity reuse', async () => {
  const f = await deletionAuthFixture();
  try {
    const actor = await f.register();
    const phone = '+8613800000000';
    await f.pool.query(
      'UPDATE "user" SET "phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',
      [actor.userId, phone],
    );
    expect((await deleteAccount(f.pool, f.secret, actor, {})).status).toBe('invalid_input');
    const challenge = await reserveAccountDeletionChallenge(
      f.pool,
      undefined,
      f.secret,
      f.config.smsLimits,
      '192.0.2.22',
      actor,
      '123456',
    );
    await activatePhoneChallenge(f.pool, challenge.id);
    expect(
      (
        await deleteAccount(
          f.pool,
          f.secret,
          { ...actor, sessionId: randomUUID() },
          { code: '123456' },
        )
      ).status,
    ).toBe('session_required');
    await f.pool
      .query(`CREATE FUNCTION fail_cleanup_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'JOB_FAILED'; END $$;
      CREATE TRIGGER fail_cleanup_job BEFORE INSERT ON mio_account_cleanup_jobs FOR EACH ROW EXECUTE FUNCTION fail_cleanup_job();`);
    await expect(deleteAccount(f.pool, f.secret, actor, { code: '123456' })).rejects.toThrow(
      'JOB_FAILED',
    );
    expect(await f.auth.identity(new Headers({ cookie: actor.cookie }))).not.toBeNull();
    expect(
      (await f.pool.query('SELECT id FROM "mioPhoneChallenge" WHERE id=$1', [challenge.id]))
        .rowCount,
    ).toBe(1);
    await f.pool.query('DROP TRIGGER fail_cleanup_job ON mio_account_cleanup_jobs');
    const tables = (await readSmsBudgetSchema(f.pool)).tables!;
    const login = await reservePhoneChallenge(
      f.pool,
      tables,
      f.secret,
      f.config.smsLimits,
      'login',
      phone,
      '192.0.2.33',
    );
    await activatePhoneChallenge(f.pool, login.id);
    const proof = await consumePhoneLoginChallenge(f.pool, f.secret, phone, login.code);
    expect(proof).toEqual({ status: 'ok', userId: actor.userId });
    expect((await deleteAccount(f.pool, f.secret, actor, { code: login.code })).status).toBe(
      'invalid_otp',
    );
    expect((await deleteAccount(f.pool, f.secret, actor, { code: '123456' })).status).toBe('ok');
    const fresh = await f.register();
    await f.pool.query(
      'UPDATE "user" SET "phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',
      [fresh.userId, phone],
    );
    expect(await consumePhoneLoginChallenge(f.pool, f.secret, phone, login.code)).toEqual({
      status: 'invalid',
    });
    await replayAccountDeletion(
      f.pool,
      {
        userId: actor.userId,
        finalizedAt: (
          await f.pool.query('SELECT finalized_at FROM mio_account_cleanup_jobs WHERE user_id=$1', [
            actor.userId,
          ])
        ).rows[0].finalized_at.toISOString(),
      },
      ['auth', 'archive'],
    );
    expect(await f.auth.identity(new Headers({ cookie: fresh.cookie }))).not.toBeNull();
    expect(
      (await f.pool.query('SELECT "phoneNumber" FROM "user" WHERE id=$1', [fresh.userId])).rows[0]
        .phoneNumber,
    ).toBe(phone);
  } finally {
    await f.close();
  }
});

it('requires a recent original session and rejects callbacks whose final user write follows deletion', async () => {
  const f = await deletionAuthFixture();
  try {
    const actor = await f.register();
    await f.pool.query(
      'UPDATE "session" SET "createdAt"=now()-interval \'10 minutes\' WHERE id=$1',
      [actor.sessionId],
    );
    expect((await deleteAccount(f.pool, f.secret, actor, {})).status).toBe('session_required');
    await f.pool.query('UPDATE "session" SET "createdAt"=now() WHERE id=$1', [actor.sessionId]);
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [actor.userId]);
    const deleting = deleteAccount(f.pool, f.secret, actor, {});
    await blocker.query('COMMIT');
    blocker.release();
    expect((await deleting).status).toBe('ok');
    await expect(
      f
        .request(
          'phone-binding/confirm',
          { phoneNumber: '13800000001', code: '123456' },
          actor.cookie,
        )
        .then(async (r) => {
          if (r.status < 400) throw new Error('CALLBACK_REVIVED');
        }),
    ).resolves.toBeUndefined();
    await expect(
      f.pool.query(
        `INSERT INTO "verification"(id,identifier,value,"expiresAt","createdAt","updatedAt")
      VALUES($1,$1,$2,now()+interval '1 minute',now(),now())`,
        [randomUUID(), JSON.stringify({ link: { userId: actor.userId, email: actor.email } })],
      ),
    ).rejects.toThrow('ACCOUNT_DELETED');
  } finally {
    await f.close();
  }
});

it('sends only to the current verified phone and charges the existing account-operations SMS subbudget', async () => {
  const f = await deletionAuthFixture();
  let real: Awaited<ReturnType<typeof createAuthentication>> | undefined;
  try {
    const actor = await f.register();
    expect((await f.request('account-deletion/send-otp', {}, actor.cookie)).status).toBe(409);
    const sent: { phone: string; code: string }[] = [];
    await f.pool.query(
      'UPDATE "user" SET "phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',
      [actor.userId, '+8613900000001'],
    );
    real = await createAuthentication(
      f.config,
      undefined,
      async (phone, code) => {
        sent.push({ phone, code });
      },
      () => ({ emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: null }),
    );
    const send = (body: unknown) =>
      real!.handler(
        new Request(f.config.baseURL + '/api/auth/account-deletion/send-otp', {
          method: 'POST',
          headers: {
            origin: f.config.baseURL,
            cookie: actor.cookie,
            'content-type': 'application/json',
            'x-mio-client-ip': '192.0.2.15',
          },
          body: JSON.stringify(body),
        }),
      );
    expect((await send({ phoneNumber: '13900000002' })).status).toBe(400);
    expect(sent).toHaveLength(0);
    expect((await send({})).status).toBe(200);
    expect(sent[0]).toMatchObject({ phone: '+8613900000001' });
    expect(
      (
        await f.pool.query('SELECT count(*) FROM "mioSmsBudgetEvent" WHERE "budgetId"=$1', [
          'global:account_ops',
        ])
      ).rows[0].count,
    ).toBe('1');
    expect(
      (
        await f.pool.query('SELECT count(*) FROM "mioSmsBudgetEvent" WHERE "budgetId"=$1', [
          'global',
        ])
      ).rows[0].count,
    ).toBe('0');
    const code = sent[0]!.code;
    await f.pool.query('UPDATE "user" SET "phoneNumber"=$2 WHERE id=$1', [
      actor.userId,
      '+8613900000003',
    ]);
    expect((await deleteAccount(f.pool, f.secret, actor, { code })).status).toBe('invalid_otp');
    f.setPolicy({ emailPasswordEnabled: true, smsMode: 'disabled', smsBypassCode: null });
    expect((await f.request('account-deletion/send-otp', {}, actor.cookie)).status).toBe(503);
  } finally {
    await real?.close();
    await f.close();
  }
});

it('rejects an old pending-provider phone proof after that phone is reused by a new user, even if its challenge row survives a restored snapshot', async () => {
  const f = await deletionAuthFixture();
  try {
    const old = await f.register(),
      phone = '+8613900000009',
      scope = { pendingId: randomUUID(), candidateToken: randomUUID() };
    await f.pool.query(
      'UPDATE "user" SET "phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',
      [old.userId, phone],
    );
    const pending = await reserveWechatExistingPhoneChallenge(
      f.pool,
      undefined,
      f.secret,
      f.config.smsLimits,
      phone,
      '192.0.2.22',
      scope,
      '654321',
    );
    await activatePhoneChallenge(f.pool, pending.id);
    const row = (await f.pool.query('SELECT * FROM "mioPhoneChallenge" WHERE id=$1', [pending.id]))
      .rows[0];
    expect(row.subjectUserId).toBe(old.userId);
    const challenge = await reserveAccountDeletionChallenge(
      f.pool,
      undefined,
      f.secret,
      f.config.smsLimits,
      '192.0.2.22',
      old,
      '123456',
    );
    await activatePhoneChallenge(f.pool, challenge.id);
    expect((await deleteAccount(f.pool, f.secret, old, { code: '123456' })).status).toBe('ok');
    const fresh = await f.register();
    await f.pool.query(
      'UPDATE "user" SET "phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',
      [fresh.userId, phone],
    );
    const columns = [
      'id',
      'challengeKey',
      'codeHash',
      'purpose',
      'userId',
      'sessionId',
      'status',
      'attempts',
      'expiresAt',
      'originalPhone',
      'phoneDigest',
      'subjectUserId',
    ];
    await f.pool.query(
      `INSERT INTO "mioPhoneChallenge"(${columns.map((column) => '"' + column + '"').join(',')}) VALUES(${columns.map((_, index) => '$' + (index + 1)).join(',')})`,
      columns.map((column) => row[column]),
    );
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [fresh.userId]);
      expect(
        await consumePendingPhoneChallenge(client, f.secret, 'wechat_existing', phone, '654321', {
          ...scope,
          subjectUserId: fresh.userId,
        }),
      ).toBe(false);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await f.auth.identity(new Headers({ cookie: fresh.cookie }))).not.toBeNull();
  } finally {
    await f.close();
  }
});
