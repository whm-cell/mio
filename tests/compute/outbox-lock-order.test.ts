import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { ComputeCommandV1, MediaCommand, MediaControl } from '@mio/compute-contracts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { AccountDomainStore } from '../../src/account-deletion/domain-store.ts';
import { AccountResultClosed } from '../../src/compute/deleted-results.ts';
import { ComputeStore } from '../../src/compute/transcode/store.ts';
import { MediaStore } from '../../src/compute/media/store.ts';
import { authDatabase } from '../support/auth-database.ts';

type Protocol = 'transcode' | 'media';
type Claimed = { command: ComputeCommandV1 | MediaCommand | MediaControl; lease: string };

async function fixture(kind: Protocol) {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.observerURL });
  await pool.query(assetSchemaSQL + computeSchemaSQL);
  const names = ['ack', 'peer'].map((name) => database.applicationName + '_' + name);
  const connections = names.map((name) => {
    const url = new URL(database.url);
    url.searchParams.set('application_name', name);
    return new Pool({ connectionString: url.toString(), max: 1 });
  });
  const [ackPool, peerPool] = connections as [Pool, Pool];
  const endpoints = connections.map((connection) => {
    const transcode = new ComputeStore(connection),
      media = new MediaStore(connection);
    return {
      claim: () => (kind === 'transcode' ? transcode.claim() : media.claim('encode')),
      sent: (item: Claimed) =>
        item.command.type === 'transcode.request'
          ? transcode.sent(item.command, item.lease)
          : media.sent(item.command, item.lease),
      release: (item: Claimed) =>
        kind === 'transcode'
          ? transcode.release(item.command.messageId, item.lease)
          : media.release(item.command.messageId, item.lease),
      rejectResult: (item: Claimed) => {
        const { command } = item;
        if (command.type === 'media.control') throw new Error('EXPECTED_REQUEST');
        const base = {
          version: 1 as const,
          messageId: randomUUID(),
          jobId: command.jobId,
          attemptId: command.attemptId,
          attempt: command.attempt,
          commandId: command.messageId,
          state: 'failed' as const,
          errorCode: 'STORAGE_FAILURE' as const,
        };
        return command.type === 'transcode.request'
          ? transcode.accept({ ...base, type: 'transcode.result' })
          : media.accept({ ...base, type: 'media.result' });
      },
    };
  });
  const [ack, peer] = endpoints as [(typeof endpoints)[number], (typeof endpoints)[number]];
  const owner = 'outbox-' + randomUUID(),
    assetId = randomUUID();
  const key = `mio/raw/${assetId}/${randomUUID()}`;
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'source.mp4','video/mp4',1,$3,$3,'ready',now())",
    [assetId, owner, key],
  );
  if (kind === 'transcode')
    await new ComputeStore(ackPool).create(owner, randomUUID(), assetId, key, 1, 'source');
  else
    await new MediaStore(ackPool).create(
      owner,
      {
        requestId: randomUUID(),
        operation: 'video.trim',
        inputs: [{ assetId }],
        parameters: { startSeconds: 0, endSeconds: 1 },
      },
      [{ assetId, key, sizeBytes: 1, etag: 'source' }],
    );
  const outbox = kind === 'transcode' ? 'mio_compute_outbox' : 'mio_media_outbox';
  return {
    pool,
    owner,
    ack,
    peer,
    ackPool,
    peerPool,
    outbox,
    jobs: kind === 'transcode' ? 'mio_compute_jobs' : 'mio_media_jobs',
    inbox: kind === 'transcode' ? 'mio_compute_inbox' : 'mio_media_inbox',
    async expire() {
      await pool.query(`UPDATE ${outbox} SET lease_until=now()-interval '1 second'`);
    },
    async blockedByAck() {
      await vi.waitFor(
        async () => {
          const rows = (
            await pool.query(
              `SELECT pg_blocking_pids(p.pid) AS blockers,a.pid AS ack_pid
          FROM pg_stat_activity p JOIN pg_stat_activity a ON a.application_name=$1
          WHERE p.application_name=$2`,
              names,
            )
          ).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0].blockers).toContain(rows[0].ack_pid);
        },
        { timeout: 3000, interval: 10 },
      );
    },
    async close() {
      await Promise.all(connections.map((p) => p.end()));
      await pool.end();
      await database.close();
    },
  };
}

/** Pause only the caller; both stores still execute their real SQL/transactions/triggers on separate PG connections. */
async function pauseBefore(pool: Pool, prefix: string) {
  const client = await pool.connect();
  const query = client.query.bind(client);
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let armed = true;
  const spy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
    const sql = args[0];
    if (armed && typeof sql === 'string' && sql.startsWith(prefix)) {
      armed = false;
      reached.resolve();
      return resume.promise.then(() => Reflect.apply(query, client, args));
    }
    return Reflect.apply(query, client, args);
  }) as typeof client.query);
  client.release();
  return {
    reached: reached.promise,
    resume: () => resume.resolve(),
    restore: () => spy.mockRestore(),
  };
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({
      ok: false,
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    }),
  );
}

it.each([
  ['transcode', 'claim'],
  ['media', 'claim'],
  ['transcode', 'release'],
  ['media', 'release'],
] as const)(
  'settles %s expired %s overlapping an old ACK without an owner/outbox deadlock',
  async (kind, operation) => {
    const f = await fixture(kind);
    const old = (await f.ack.claim())!;
    await f.expire();
    const gate = await pauseBefore(f.ackPool, `UPDATE ${f.outbox} SET sent_at=`);
    let ack: Promise<unknown> | undefined, peer: Promise<unknown> | undefined;
    try {
      ack = observe(f.ack.sent(old));
      await gate.reached;
      peer = observe<unknown>(operation === 'claim' ? f.peer.claim() : f.peer.release(old));
      // Pre-fix peer holds outbox and waits for ACK's owner lock. Fixed peer waits before taking outbox.
      await f.blockedByAck();
      gate.resume();
      const results = await Promise.all([ack, peer]);
      expect(results).toEqual([
        { ok: true, value: undefined },
        { ok: true, value: undefined },
      ]);
      expect((await f.pool.query(`SELECT sent_at,lease_id FROM ${f.outbox}`)).rows[0]).toEqual({
        sent_at: expect.any(Date),
        lease_id: null,
      });
      expect((await f.pool.query(`SELECT state FROM ${f.jobs}`)).rows[0].state).toBe('queued');
      expect(await f.peer.claim()).toBeUndefined();
    } finally {
      gate.resume();
      await Promise.allSettled([ack, peer]);
      gate.restore();
      await f.close();
    }
  },
);

it.each(['transcode', 'media'] as const)(
  'keeps the reclaimed %s lease authoritative over delayed ACK and releases',
  async (kind) => {
    const f = await fixture(kind);
    const old = (await f.ack.claim())!;
    await f.expire();
    const gate = await pauseBefore(f.ackPool, 'SELECT pg_advisory_xact_lock($1)');
    let ack: Promise<unknown> | undefined;
    try {
      ack = observe(f.ack.sent(old));
      await gate.reached;
      const current = (await f.peer.claim())!;
      expect(current.command).toEqual(old.command);
      expect(current.lease).not.toBe(old.lease);
      gate.resume();
      expect(await ack).toEqual({ ok: true, value: undefined });
      await f.ack.release(old);
      expect((await f.pool.query(`SELECT sent_at,lease_id FROM ${f.outbox}`)).rows[0]).toEqual({
        sent_at: null,
        lease_id: current.lease,
      });
      expect((await f.pool.query(`SELECT state FROM ${f.jobs}`)).rows[0].state).toBe('accepted');
      await f.peer.release(current);
      const replacement = (await f.peer.claim())!;
      expect(replacement.lease).not.toBe(current.lease);
      await f.ack.sent(current);
      await f.ack.release(current);
      expect((await f.pool.query(`SELECT sent_at,lease_id FROM ${f.outbox}`)).rows[0]).toEqual({
        sent_at: null,
        lease_id: replacement.lease,
      });
      await f.peer.sent(replacement);
      expect((await f.pool.query(`SELECT sent_at,lease_id FROM ${f.outbox}`)).rows[0]).toEqual({
        sent_at: expect.any(Date),
        lease_id: null,
      });
    } finally {
      gate.resume();
      await ack;
      gate.restore();
      await f.close();
    }
  },
);

it.each(['transcode', 'media'] as const)(
  'does not reclaim, ACK or retry %s work after the actual domain closes',
  async (kind) => {
    const f = await fixture(kind);
    try {
      const old = (await f.ack.claim())!;
      await f.expire();
      await new AccountDomainStore(f.pool).closeAccount(f.owner, new Date());
      expect(await f.peer.claim()).toBeUndefined();
      await f.ack.sent(old);
      await expect(f.peer.release(old)).rejects.toThrow('ACCOUNT_DELETED');
      await expect(f.ack.rejectResult(old)).rejects.toBeInstanceOf(AccountResultClosed);
      expect((await f.pool.query(`SELECT sent_at,lease_id FROM ${f.outbox}`)).rows[0]).toEqual({
        sent_at: null,
        lease_id: old.lease,
      });
      expect((await f.pool.query(`SELECT state FROM ${f.jobs}`)).rows).toEqual([
        { state: 'accepted' },
      ]);
      expect((await f.pool.query(`SELECT id FROM ${f.inbox}`)).rowCount).toBe(0);
      expect(
        (await f.pool.query("SELECT id FROM mio_assets WHERE asset_kind='derived'")).rowCount,
      ).toBe(0);
    } finally {
      await f.close();
    }
  },
);
