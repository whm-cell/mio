import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { GenerationStore } from '../../src/generations/store.ts';
import { generationFixture } from '../generations/fixture.ts';

it.each(['submitted', 'beginQuery'] as const)(
  'serializes image recovery with %s without losing its durable task identity',
  async (operation) => {
    const f = await generationFixture();
    const name = f.database.applicationName;
    const writerUrl = new URL(f.database.url);
    writerUrl.searchParams.set('application_name', name + '_writer');
    const recoveryUrl = new URL(f.database.url);
    recoveryUrl.searchParams.set('application_name', name + '_recovery');
    const writer = new GenerationStore(
      new Pool({
        connectionString: writerUrl.toString(),
      }),
    );
    const recovery = new GenerationStore(
      new Pool({
        connectionString: recoveryUrl.toString(),
      }),
    );
    const gate = await f.pool.connect();
    const lock = randomInt(1, 2147483647);
    let work: Promise<unknown> | undefined;
    let recover: Promise<unknown> | undefined;
    try {
      const job = await f.admit(undefined, 'lock order fixture', { async: true }, true);
      let row = (await f.store.claim())!;
      expect(row.id).toBe(job.jobId);
      await f.store.submitting(row);
      if (operation === 'beginQuery') {
        await f.store.submitted(row, 'known-upstream-task');
        await f.pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [row.id]);
        row = (await f.store.claim())!;
      }
      await gate.query('SELECT pg_advisory_lock($1)', [lock]);
      await f.pool.query(
        'CREATE FUNCTION pause_image_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(' +
          lock +
          '); RETURN NEW; END $$',
      );
      await f.pool.query(
        operation === 'submitted'
          ? "CREATE TRIGGER pause_image_write AFTER UPDATE ON mio_image_executions FOR EACH ROW WHEN (NEW.phase='waiting') EXECUTE FUNCTION pause_image_write()"
          : 'CREATE TRIGGER pause_image_write AFTER UPDATE ON mio_image_jobs FOR EACH ROW WHEN (NEW.query_attempt > OLD.query_attempt) EXECUTE FUNCTION pause_image_write()',
      );
      work =
        operation === 'submitted'
          ? writer.submitted(row, 'known-upstream-task')
          : writer.beginQuery(row);
      // Attach handlers before creating a possible deadlock; preserve both outcomes below.
      const observedWork = work.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      let writerPid = 0;
      await vi.waitFor(
        async () => {
          const waiting = (
            await f.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=$2',
              [name + '_writer', 'Lock'],
            )
          ).rows;
          expect(waiting).toHaveLength(1);
          writerPid = waiting[0]!.pid;
        },
        { timeout: 3000, interval: 10 },
      );
      recover = recovery.imageRecover(f.actor.userId, row.id);
      const observedRecovery = recover.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      await vi.waitFor(
        async () => {
          const blocked = (
            await f.pool.query(
              'SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1',
              [name + '_recovery'],
            )
          ).rows;
          expect(blocked.some((item) => item.blockers.includes(writerPid))).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );
      await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
      const results = await Promise.all([observedWork, observedRecovery]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(
        (
          await f.pool.query(
            'SELECT j.state,j.upstream_task_id,j.query_attempt,e.phase FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id WHERE j.id=$1',
            [row.id],
          )
        ).rows[0],
      ).toEqual({
        state: 'submitted',
        upstream_task_id: 'known-upstream-task',
        query_attempt: operation === 'beginQuery' ? 1 : 0,
        phase: operation === 'beginQuery' ? 'querying' : 'waiting',
      });
    } finally {
      await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
      await Promise.allSettled([work, recover]);
      gate.release();
      await Promise.all([writer.close(), recovery.close()]);
      await f.close();
    }
  },
  15000,
);
