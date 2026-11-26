import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { creationLogSchemaSQL } from '../../src/notifications/creation-schema.ts';

it('survives loss of its pinned borrowed transaction, rolls back and retries the original audio event', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.observerURL });
  const applicationName = `mio_creation_disconnect_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(database.url);
  url.searchParams.set('application_name', applicationName);
  const eventId = randomUUID();
  const event = {
    ownerId: 'disconnect-owner',
    mediaType: 'audio',
    jobId: randomUUID(),
    eventKind: 'completed',
    title: 'audio saved',
    summary: 'ready',
    occurredAt: new Date(Date.now() - 3600000).toISOString(),
  };
  await pool.query(creationLogSchemaSQL);
  const identity = (
    await pool.query<{ datname: string; usename: string }>(
      'SELECT current_database() AS datname,current_user AS usename',
    )
  ).rows[0]!;
  expect(identity.datname).toBe(new URL(database.url).pathname.slice(1));
  const child = fork('tests/notifications/creation-disconnect-probe.ts', [], {
    execArgv: [],
    env: {
      PATH: process.env.PATH,
      MIO_TEST_DATABASE_URL: url.toString(),
      MIO_CREATION_PROBE_EVENT_ID: eventId,
      MIO_CREATION_PROBE_EVENT: JSON.stringify(event),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 10000);
  deadline.unref();
  let stdout = '',
    stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const messages: { phase: string; pid?: number; items?: unknown }[] = [];
  const borrowed = Promise.withResolvers<number>(),
    disconnected = Promise.withResolvers<void>();
  child.on('message', (raw: unknown) => {
    const message = raw as { phase: string; pid?: number; items?: unknown };
    messages.push(message);
    if (message.phase === 'borrowed' && message.pid) borrowed.resolve(message.pid);
    if (message.phase === 'disconnected') disconnected.resolve();
  });
  const exited = once(child, 'exit').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as string | null,
  }));
  const failOnExit = exited.then((result) => {
    throw new Error(
      `Probe child exited before expected event: ${JSON.stringify(result)}\n${stderr}`,
    );
  });
  try {
    const pid = await Promise.race([borrowed.promise, failOnExit]);
    const own = await pool.query<{
      pid: number;
      datname: string;
      usename: string;
      application_name: string;
      state: string;
    }>(
      'SELECT pid,datname,usename,application_name,state FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND datname=current_database() AND usename=current_user',
      [pid, applicationName],
    );
    expect(own.rows).toEqual([
      {
        pid,
        datname: identity.datname,
        usename: identity.usename,
        application_name: applicationName,
        state: 'idle in transaction',
      },
    ]);
    expect(
      (await pool.query('SELECT * FROM mio_audio_creation_receipts WHERE event_id=$1', [eventId]))
        .rowCount,
    ).toBe(0);
    const terminated = await pool.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
       WHERE pid=$1 AND application_name=$2 AND datname=$3 AND usename=$4
       AND datname=current_database() AND usename=current_user AND state='idle in transaction'`,
      [pid, applicationName, identity.datname, identity.usename],
    );
    expect(terminated.rows).toEqual([{ terminated: true }]);
    await Promise.race([disconnected.promise, failOnExit]);
    expect(
      (await pool.query('SELECT * FROM mio_audio_creation_receipts WHERE event_id=$1', [eventId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT * FROM mio_creation_logs WHERE job_id=$1', [event.jobId])).rowCount,
    ).toBe(0);
    child.send('resume');
    const exit = await exited;
    expect(exit, JSON.stringify({ stdout, stderr, messages })).toEqual({ code: 0, signal: null });
    expect(messages.map((message) => message.phase)).toEqual([
      'borrowed',
      'disconnected',
      'rejected',
      'retried',
    ]);
    expect(messages.at(-1)?.items).toMatchObject([
      { jobId: event.jobId, occurredAt: event.occurredAt, eventKind: 'completed' },
    ]);
    expect(
      (
        await pool.query('SELECT event_id FROM mio_audio_creation_receipts WHERE event_id=$1', [
          eventId,
        ])
      ).rows,
    ).toEqual([{ event_id: eventId }]);
    expect(
      (await pool.query('SELECT occurred_at FROM mio_creation_logs WHERE job_id=$1', [event.jobId]))
        .rows,
    ).toEqual([{ occurred_at: new Date(event.occurredAt) }]);
    console.log(
      'CREATION_BORROWED_CLIENT_PROBE',
      JSON.stringify({
        applicationName,
        backendPid: pid,
        database: identity.datname,
        user: identity.usename,
        terminated: terminated.rows[0]!.terminated,
        childExit: exit,
        phases: messages.map((message) => message.phase),
        receiptCount: 1,
        logCount: 1,
        occurredAt: event.occurredAt,
      }),
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await pool.end();
    await database.close();
  }
});
