import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readAssetConfig, readAssetDatabaseURL } from '../../src/assets/config.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';

export async function inspectGenerationCutover(
  pool: Pool,
  options: { dataDirectory: string; journal?: string; env: NodeJS.ProcessEnv; probeCos?: boolean },
) {
  const blockers: string[] = [];
  const counts = (
    await pool.query<{
      legacy: number;
      legacyUnfinished: number;
      aUnfinished: number;
      aTasks: number;
    }>(`SELECT
    count(*) FILTER (WHERE e.job_id IS NULL)::int AS legacy,
    count(*) FILTER (WHERE e.job_id IS NULL AND (
      j.state IN ('accepted','submitted','processing','materializing','materialization_failed','unknown')
      OR (j.state='failed' AND j.upstream_task_id IS NOT NULL AND
        j.async_deadline>now() AND j.query_attempt<j.async_max_queries)))::int AS "legacyUnfinished",
    count(*) FILTER (WHERE e.phase<>'done')::int AS "aUnfinished",
    count(*) FILTER (WHERE e.job_id IS NOT NULL)::int AS "aTasks"
    FROM mio_image_jobs j LEFT JOIN mio_image_executions e ON e.job_id=j.id`)
  ).rows[0]!;
  if (counts.legacyUnfinished > 0) blockers.push('LEGACY_IMAGE_TASKS_UNRECONCILED');
  if (counts.aUnfinished > 0) blockers.push('A_GENERATION_TASKS_UNRECONCILED');
  const oldOutbox = (
    await pool.query<{ present: string | null }>(
      "SELECT to_regclass('mio_image_outbox')::text AS present",
    )
  ).rows[0]?.present;
  const outbox = oldOutbox
    ? (
        await pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM mio_image_outbox WHERE sent_at IS NULL',
        )
      ).rows[0]!.count
    : 0;
  if (outbox > 0) blockers.push('LEGACY_IMAGE_OUTBOX_PENDING');
  let journal: 'absent' | 'idle' | 'unreconciled' | 'unreadable' = 'absent';
  if (options.journal) {
    let database: DatabaseSync | undefined;
    try {
      const stat = await lstat(options.journal);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('JOURNAL_PATH');
      database = new DatabaseSync(options.journal, { readOnly: true });
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='image_attempts'")
        .get();
      const unfinished = table
        ? Number(
            database
              .prepare(
                "SELECT count(*) AS count FROM image_attempts WHERE phase IS NULL OR phase NOT IN ('completed','failed','rejected')",
              )
              .get()!.count,
          )
        : 0;
      let uncertainUploads = 0;
      if (table) {
        for (const row of database.prepare('SELECT job_id,payload FROM image_attempts').iterate()) {
          if (typeof row.payload !== 'string') continue;
          const saved = JSON.parse(row.payload) as {
            attemptedFileIds?: Record<string, string[]>;
            invalidIndices?: number[];
            outputs?: { key: string }[];
          };
          for (const [index, attempts] of Object.entries(saved.attemptedFileIds ?? {})) {
            if (saved.invalidIndices?.includes(Number(index))) continue;
            for (const id of attempts) {
              const prefix = `mio/derived/${String(row.job_id)}/images/${index}-${id}.`;
              if (!saved.outputs?.some((output) => output.key.startsWith(prefix)))
                uncertainUploads++;
            }
          }
        }
      }
      if (uncertainUploads) blockers.push('LEGACY_IMAGE_UPLOADS_REQUIRE_RECONCILIATION');
      journal = unfinished || uncertainUploads ? 'unreconciled' : 'idle';
      if (unfinished) blockers.push('LEGACY_IMAGE_JOURNAL_UNRECONCILED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        journal = 'unreadable';
        blockers.push('LEGACY_IMAGE_JOURNAL_UNREADABLE');
      }
    } finally {
      database?.close();
    }
  }
  if (journal === 'absent' && counts.legacyUnfinished > 0)
    blockers.push('LEGACY_IMAGE_RECOVERY_DATA_MISSING');
  const queues: { name: string; messages: number; consumers: number }[] = [];
  const managementPort = options.env.MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT;
  if (managementPort && options.env.MIO_LOCAL_RABBITMQ_PASSWORD && options.env.MIO_ENVIRONMENT) {
    for (const name of ['mio.compute.image.commands.v1', 'mio.compute.image.commands.dlq.v1']) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${managementPort}/api/queues/mio-${options.env.MIO_ENVIRONMENT}/${name}`,
          {
            headers: {
              authorization: `Basic ${Buffer.from(
                `mio-${options.env.MIO_ENVIRONMENT}-admin:${options.env.MIO_LOCAL_RABBITMQ_PASSWORD}`,
              ).toString('base64')}`,
            },
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          },
        );
        if (response.status === 404) continue;
        if (!response.ok) throw new Error('BROKER_INSPECTION');
        const value = (await response.json()) as { messages: number; consumers: number };
        if (!Number.isSafeInteger(value.messages) || !Number.isSafeInteger(value.consumers))
          throw new Error('BROKER_INSPECTION');
        queues.push({ name, messages: value.messages, consumers: value.consumers });
        if (value.messages > 0 || value.consumers > 0)
          blockers.push('LEGACY_IMAGE_BROKER_NOT_DRAINED');
      } catch {
        blockers.push('LEGACY_IMAGE_BROKER_UNVERIFIED');
        break;
      }
    }
  } else if (counts.legacy > 0) blockers.push('LEGACY_IMAGE_BROKER_UNVERIFIED');
  let directory: 'writable' | 'unavailable' = 'unavailable';
  try {
    const stat = await lstat(options.dataDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('DIRECTORY_PATH');
    await access(options.dataDirectory, constants.R_OK | constants.W_OK);
    directory = 'writable';
  } catch {
    blockers.push('A_GENERATION_DIRECTORY_UNAVAILABLE');
  }
  let cos: { status: 'not_checked' | 'verified' | 'unknown'; key?: string } = {
    status: 'not_checked',
  };
  if (options.probeCos) {
    const key = `mio/derived/${randomUUID()}/images/0-${randomUUID()}.png`;
    cos = { status: 'unknown', key };
    try {
      const config = readAssetConfig(options.env);
      if (!config) throw new Error('COS_CONFIG');
      const storage = createCosStorage(config);
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const uploaded = await fetch(storage.uploadUrl(key, bytes.length), {
        method: 'PUT',
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          'content-length': String(bytes.length),
          'content-type': 'image/png',
          'content-md5': createHash('md5').update(bytes).digest('base64'),
          'x-cos-forbid-overwrite': 'true',
          'x-cos-meta-sha256': sha256,
        },
      });
      if (!uploaded.ok) throw new Error('COS_PUT');
      const found = await storage.head(key);
      if (
        found.size !== bytes.length ||
        found.sha256 !== sha256 ||
        found.etag !== uploaded.headers.get('etag') ||
        !storage.readImage
      )
        throw new Error('COS_HEAD');
      const saved = await storage.readImage(
        key,
        found.etag,
        found.size,
        AbortSignal.timeout(60_000),
      );
      if (!Buffer.from(saved).equals(bytes)) throw new Error('COS_BYTES');
      cos = { status: 'verified', key };
    } catch {
      blockers.push('A_COS_ACCESS_UNKNOWN');
    }
  } else blockers.push('A_COS_ACCESS_UNVERIFIED');
  return {
    counts,
    outbox,
    journal,
    queues,
    directory,
    cos,
    blockers: [...new Set(blockers)],
    readyForCutover: blockers.length === 0,
    rollbackRequiresAReconciliation: counts.aTasks > 0,
    retainedProbeObject: cos.key ?? null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--probe-cos'))
    throw new Error('Usage: generations:preflight [--probe-cos]');
  const databaseURL = readAssetDatabaseURL();
  const dataDirectory = process.env.MIO_GENERATIONS_DATA_DIR;
  if (!databaseURL || !dataDirectory) throw new Error('GENERATION_PREFLIGHT_CONFIG_REQUIRED');
  const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000 });
  try {
    const workerDirectory =
      process.env.MIO_LOCAL_COMPUTE_DIRECTORY ?? process.env.MIO_COMPUTE_DIRECTORY;
    const report = await inspectGenerationCutover(pool, {
      dataDirectory: resolve(dataDirectory),
      env: process.env,
      probeCos: args.includes('--probe-cos'),
      ...(workerDirectory ? { journal: resolve(workerDirectory, 'journal.sqlite3') } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.readyForCutover ? 0 : 1;
  } catch {
    console.error(
      'GENERATION_PREFLIGHT_FAILED: preserve the scene and inspect metadata/configuration',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
