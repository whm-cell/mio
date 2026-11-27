import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createAuthentication } from '../../src/auth/service.ts';
import { deleteAccount, replayAccountDeletion } from '../../src/auth/deletion.ts';
import { parseAccountDeletionTombstone } from '../../src/account-deletion/tombstone.ts';
import { deletionAuthFixture } from './fixture.ts';

it('previews without writing, applies idempotently with populated users/sessions, and never repairs schema on startup', async () => {
  const f = await deletionAuthFixture();
  try {
    const actor = await f.register();
    await f.pool.query('DROP TRIGGER mio_auth_session_owner ON "session"');
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['scripts/service/migrate-account-deletion.ts', ...args], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH ?? '',
          MIO_AUTH_BASE_URL: f.config.baseURL,
          MIO_AUTH_SECRET: f.secret,
          MIO_AUTH_DATABASE_URL: f.database.url,
        },
      });
    const preview = run([]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('mio_account_cleanup_jobs');
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM pg_trigger WHERE tgname='mio_auth_session_owner' AND tgrelid='\"session\"'::regclass",
        )
      ).rowCount,
    ).toBe(0);
    await expect(createAuthentication(f.config)).rejects.toThrow('AUTH_SCHEMA');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(['--apply']);
      expect(result.status, result.stderr).toBe(0);
    }
    const current = await createAuthentication(f.config);
    try {
      expect(await current.identity(new Headers({ cookie: actor.cookie }))).toMatchObject({
        userId: actor.userId,
        sessionId: actor.sessionId,
      });
    } finally {
      await current.close();
    }
    const before = (
      await f.pool.query('SELECT "createdAt",email,name FROM "user" WHERE id=$1', [actor.userId])
    ).rows[0];
    expect(before).toMatchObject({ email: actor.email, name: 'private owner' });
    expect(preview.stdout).not.toContain(actor.email);
    expect(preview.stdout).not.toContain(f.secret);
  } finally {
    await f.close();
  }
});

it('external minimal tombstones replay an absent old account and a pre-deletion restored account without touching reused identities', async () => {
  const f = await deletionAuthFixture();
  try {
    const old = await f.register(),
      at = new Date(Date.now() - 1000).toISOString();
    const external = JSON.stringify({ userId: old.userId, finalizedAt: at });
    const tombstone = parseAccountDeletionTombstone(external);
    await replayAccountDeletion(f.pool, tombstone, ['auth', 'archive']);
    expect(await f.auth.identity(new Headers({ cookie: old.cookie }))).toBeNull();
    const fresh = await f.register(old.email);
    expect(fresh.userId).not.toBe(old.userId);
    await replayAccountDeletion(f.pool, tombstone, ['auth', 'archive']);
    expect(await f.auth.identity(new Headers({ cookie: fresh.cookie }))).not.toBeNull();
    const absent = {
      userId: 'immutable-absent-id',
      finalizedAt: new Date(Date.now() - 2000).toISOString(),
    };
    await replayAccountDeletion(f.pool, absent, ['auth', 'archive']);
    expect(
      (await f.pool.query('SELECT disabled,"deletedAt" FROM "user" WHERE id=$1', [absent.userId]))
        .rows[0],
    ).toEqual({ disabled: true, deletedAt: new Date(absent.finalizedAt) });
    const another = await f.register();
    const result = await deleteAccount(f.pool, f.secret, another, {});
    expect(result.status).toBe('ok');
    const jobs = JSON.stringify(
      (await f.pool.query('SELECT * FROM mio_account_cleanup_jobs')).rows,
    );
    expect(jobs).not.toContain(old.email);
    expect(jobs).not.toContain('private owner');
    expect(jobs).not.toContain(fresh.cookie);
    for (const value of [
      { ...absent, email: 'pii' },
      '{not json}',
      { userId: 'old', finalizedAt: 'bad' },
    ])
      expect(() => parseAccountDeletionTombstone(value)).toThrow('ACCOUNT_TOMBSTONE_INVALID');
  } finally {
    await f.close();
  }
});
