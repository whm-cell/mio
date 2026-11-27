import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationError } from '../../src/conversations/contracts.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const actor = { userId: 'transaction-owner', sessionId: 'fixture' };
const model = {
  providerConfigId: 'provider',
  modelKey: 'model',
  modelRef: 'model-ref',
  modelId: 'model',
  protocol: 'openai-chat',
} as const;
let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let store: Awaited<ReturnType<typeof createConversationStore>>;
let releases: (() => void)[];
let pending: Promise<unknown>[];

beforeEach(async () => {
  releases = [];
  pending = [];
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  await observer.query(conversationSchemaSQL);
  store = await createConversationStore(database.url);
});

afterEach(async () => {
  for (const release of releases) release();
  await Promise.allSettled(pending);
  await store?.close();
  await observer?.end();
  await database?.close();
});

function gate() {
  const barrier = Promise.withResolvers<void>();
  releases.push(barrier.resolve);
  return barrier;
}

function track<T>(job: Promise<T>): Promise<T> {
  pending.push(job);
  void job.catch(() => {});
  return job;
}

async function ready(purpose: 'general' | 'audio' = 'general') {
  const id = randomUUID();
  await store.create(actor, id, undefined, purpose);
  await store.setReady(id, true);
  return id;
}

async function detached(id: string) {
  // Keep the callback gated until the observer sees zero transactions. A held callback
  // transaction cannot finish to satisfy this condition; acquiring its row checks the lock too.
  await vi.waitFor(async () => {
    const transactions = await observer.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
     WHERE datname=current_database() AND application_name=$1 AND xact_start IS NOT NULL`,
      [database.applicationName],
    );
    expect(transactions.rows[0]?.count).toBe(0);
  });
  const client = await observer.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='200ms'");
    await client.query('SELECT id FROM mio_conversations WHERE id=$1 FOR UPDATE', [id]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

it.each(['boundary', 'materialize', 'model', 'rename', 'voice', 'fresh', 'audio'] as const)(
  'releases the PG transaction and row lock while %s work is paused',
  async (operation) => {
    let id: string = await ready(
      operation === 'voice' || operation === 'audio' ? 'audio' : 'general',
    );
    const entered = gate();
    const release = gate();
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    let job: Promise<unknown>;
    switch (operation) {
      case 'boundary':
        job = store.reserveFork(actor, id, 'fork', undefined, async () => {
          await pause();
          return 3;
        });
        break;
      case 'materialize': {
        const reservation = await store.reserveFork(actor, id, 'fork', undefined, async () => 3);
        id = reservation.targetId;
        job = store.completeFork(actor, id, pause);
        break;
      }
      case 'model':
        job = store.selectModel(actor, id, model.modelRef, async () => {
          await pause();
          return model;
        });
        break;
      case 'rename':
        job = store.rename(actor, id, async () => {
          await pause();
          return 'Renamed';
        });
        break;
      case 'voice':
        job = store.selectAudioVoice(actor, id, 'voice', 0, async () => {
          await pause();
          return { voiceRef: 'voice', name: 'Voice' };
        });
        break;
      case 'fresh':
        job = store.receive(actor, id, 'turn', 'digest', async () => {
          await pause();
          return undefined;
        });
        break;
      case 'audio':
        job = store.receive(
          actor,
          id,
          'turn',
          'digest',
          async () => undefined,
          async () => {
            await pause();
            return {};
          },
        );
    }
    track(job);
    await entered.promise;
    await detached(id);
    release.resolve();
    await job;
  },
);

it('retains pool headroom while four conversations resolve external contexts', async () => {
  const ids = await Promise.all(Array.from({ length: 5 }, () => ready()));
  const entered = Array.from({ length: 4 }, () => gate());
  const release = gate();
  const jobs = ids.slice(0, 4).map((id, index) =>
    track(
      store.receive(actor, id, 'turn', 'digest', async () => {
        entered[index]!.resolve();
        await release.promise;
        return undefined;
      }),
    ),
  );
  await Promise.all(entered.map((item) => item.promise));
  await detached(ids[0]!);
  await expect(store.owned(actor, ids[4]!)).resolves.toMatchObject({ id: ids[4] });
  release.resolve();
  expect(await Promise.all(jobs)).toHaveLength(4);
});

it('orders same/different request IDs and archive behind preparation without repeating callbacks', async () => {
  const id = await ready();
  const entered = gate();
  const release = gate();
  const original = track(
    store.receive(actor, id, 'same', 'digest', async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    }),
  );
  await entered.promise;
  const fresh = vi.fn(async () => undefined);
  const replay = track(store.receive(actor, id, 'same', 'digest', fresh));
  const mismatch = track(store.receive(actor, id, 'same', 'other-digest', fresh));
  const different = track(store.receive(actor, id, 'different', 'digest', fresh));
  const archive = track(store.archive(actor, id));
  const select = vi.fn(async () => model);
  const selection = track(store.selectModel(actor, id, model.modelRef, select));
  await detached(id);
  release.resolve();
  expect(await original).toMatchObject({ fresh: true });
  expect(await replay).toMatchObject({ fresh: false, receipt: { requestId: 'same' } });
  await expect(mismatch).rejects.toMatchObject({ status: 409, code: 'REQUEST_ID_CONFLICT' });
  await expect(different).rejects.toMatchObject({ status: 409, code: 'CONVERSATION_BUSY' });
  await expect(archive).rejects.toMatchObject({ status: 409, code: 'CONVERSATION_BUSY' });
  await expect(selection).rejects.toMatchObject({ status: 409, code: 'CONVERSATION_BUSY' });
  expect(fresh).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  await expect(
    store.receive({ ...actor, userId: 'outsider' }, id, 'same', 'different', fresh),
  ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' });
});

it('continues queued admission after a failed preparation without leaving an accepted receipt', async () => {
  const id = await ready();
  const entered = gate();
  const release = gate();
  const first = track(
    store.receive(actor, id, 'turn', 'digest', async () => {
      entered.resolve();
      await release.promise;
      throw new ConversationError(503, 'MODEL_UNAVAILABLE');
    }),
  );
  await entered.promise;
  const retry = track(store.receive(actor, id, 'turn', 'digest', async () => undefined));
  release.resolve();
  await expect(first).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  expect(await retry).toMatchObject({ fresh: true, receipt: { status: 'accepted' } });
  expect(
    (await observer.query('SELECT count(*)::int AS count FROM mio_conversation_requests')).rows,
  ).toEqual([{ count: 1 }]);
});

it.each(['uppercase', 'compact', 'braced'] as const)(
  'orders the %s UUID spelling as the same conversation before native writes',
  async (kind) => {
    const id = 'abcdefab-1234-4123-8123-abcdefabcdef';
    await store.create(actor, id);
    await store.setReady(id, true);
    const entered = gate();
    const release = gate();
    const first = track(
      store.rename(actor, id, async () => {
        entered.resolve();
        await release.promise;
        return 'First';
      }),
    );
    await entered.promise;
    const secondNative = vi.fn(async () => 'Second');
    const alternate =
      kind === 'uppercase'
        ? id.toUpperCase()
        : kind === 'compact'
          ? id.replaceAll('-', '')
          : '{' + id + '}';
    const second = track(store.rename(actor, alternate, secondNative));
    // An independent query lets the second preflight finish if its key is incorrectly distinct.
    await observer.query('SELECT pg_sleep(0.02)');
    expect(secondNative).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second]);
    expect((await store.owned(actor, id)).title).toBe('Second');
  },
);

it('keeps native rename, activity projection, settlement and archive in the same order', async () => {
  const id = await ready();
  await store.receive(actor, id, 'turn', 'digest', async () => undefined);
  const entered = gate();
  const release = gate();
  const nativeTitles: string[] = [];
  const first = track(
    store.rename(actor, id, async () => {
      nativeTitles.push('First');
      entered.resolve();
      await release.promise;
      return 'First';
    }),
  );
  await entered.promise;
  const activity = track(
    store.inputAdmitted(id, 'turn', Date.parse('2026-11-28T00:00:00Z'), 'Auto'),
  );
  const finish = track(store.finish(id, 'turn', 'completed'));
  const secondNative = vi.fn(async () => {
    nativeTitles.push('Second');
    return 'Second';
  });
  const second = track(store.rename(actor, id, secondNative));
  const archived = track(store.archive(actor, id));
  await detached(id);
  expect(secondNative).not.toHaveBeenCalled();
  expect((await store.owned(actor, id)).active_request).toBe('turn');
  release.resolve();
  await Promise.all([first, activity, finish, second, archived]);
  expect(nativeTitles).toEqual(['First', 'Second']);
  expect(await store.owned(actor, id)).toMatchObject({
    title: 'Second',
    title_pinned: true,
    active_request: null,
    updated_at: new Date('2026-11-28T00:00:00Z'),
    archived_at: expect.any(Date),
  });
  expect(await store.request(actor, id, 'turn')).toMatchObject({ status: 'completed' });
});

it('admits the completed model and voice selection after their queued updates', async () => {
  const id = await ready('audio');
  const entered = gate();
  const release = gate();
  const selection = track(
    store.selectModel(actor, id, model.modelRef, async () => {
      entered.resolve();
      await release.promise;
      return model;
    }),
  );
  await entered.promise;
  const voice = track(
    store.selectAudioVoice(actor, id, 'voice', 0, async () => ({
      voiceRef: 'voice',
      name: 'Selected',
    })),
  );
  const receive = track(
    store.receive(
      actor,
      id,
      'turn',
      'digest',
      async (row) => {
        expect(row.model_binding).toEqual(model);
        return undefined;
      },
      async (row) => {
        expect(row.audio_selection).toEqual({ voiceRef: 'voice', name: 'Selected', revision: 1 });
        return { voiceRef: row.audio_selection!.voiceRef! };
      },
    ),
  );
  release.resolve();
  await Promise.all([selection, voice, receive]);
  expect(
    (await observer.query('SELECT audio_context FROM mio_conversation_requests')).rows,
  ).toEqual([{ audio_context: { voiceRef: 'voice' } }]);
});

it.each([
  ['model', "model_binding='{}'::jsonb", 'CONVERSATION_BUSY'],
  [
    'voice',
    `audio_selection='{"voiceRef":"new","name":"New","revision":1}'::jsonb`,
    'AUDIO_SELECTION_CONFLICT',
  ],
  ['state', "state='unknown'", 'CONVERSATION_UNKNOWN'],
] as const)('rejects stale %s input at final comparison', async (_kind, assignment, error) => {
  const id = await ready('audio');
  const entered = gate();
  const release = gate();
  const job = track(
    store.receive(actor, id, 'turn', 'digest', async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    }),
  );
  await entered.promise;
  await observer.query(`UPDATE mio_conversations SET ${assignment} WHERE id=$1`, [id]);
  release.resolve();
  await expect(job).rejects.toMatchObject({ status: 409, code: error });
  expect((await observer.query('SELECT request_id FROM mio_conversation_requests')).rows).toEqual(
    [],
  );
  expect((await store.owned(actor, id)).active_request).toBeNull();
});

it('fails native completion and queued writes closed after losing the actual advisory lease', async () => {
  const id = await ready();
  const entered = gate();
  const release = gate();
  const first = track(
    store.rename(actor, id, async () => {
      entered.resolve();
      await release.promise;
      return 'Native completed';
    }),
  );
  await entered.promise;
  const secondNative = vi.fn(async () => 'Must not run');
  const second = track(store.rename(actor, id, secondNative));
  const lease = await observer.query<{ pid: number }>(
    `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
     WHERE l.locktype='advisory' AND a.application_name=$1`,
    [database.applicationName],
  );
  expect(lease.rows).toHaveLength(1);
  await observer.query('SELECT pg_terminate_backend($1)', [lease.rows[0]!.pid]);
  await vi.waitFor(async () => {
    await expect(store.owned(actor, id)).rejects.toMatchObject({
      code: 'CONVERSATION_UNAVAILABLE',
    });
  });
  release.resolve();
  await expect(first).rejects.toMatchObject({ status: 503, code: 'CONVERSATION_UNAVAILABLE' });
  await expect(second).rejects.toMatchObject({ status: 503, code: 'CONVERSATION_UNAVAILABLE' });
  expect(secondNative).not.toHaveBeenCalled();
  expect(
    (await observer.query('SELECT title,title_pinned FROM mio_conversations WHERE id=$1', [id]))
      .rows,
  ).toEqual([{ title: null, title_pinned: false }]);
});

it('does not enter the next external context callback after availability is lost', async () => {
  const id = await ready('audio');
  const audio = vi.fn(async () => ({}));
  const job = track(
    store.receive(
      actor,
      id,
      'turn',
      'digest',
      async () => {
        store.markUnavailable();
        return undefined;
      },
      audio,
    ),
  );
  await expect(job).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
  expect(audio).not.toHaveBeenCalled();
  expect((await observer.query('SELECT request_id FROM mio_conversation_requests')).rows).toEqual(
    [],
  );
});

it.each(['ready', 'activity'] as const)(
  'rolls back a %s write when the lease is lost while waiting on its row',
  async (operation) => {
    const id = await ready();
    await store.receive(actor, id, 'turn', 'digest', async () => undefined);
    const before = (
      await observer.query('SELECT state,title,updated_at FROM mio_conversations WHERE id=$1', [id])
    ).rows;
    const blocker = await observer.connect();
    let job: Promise<void> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM mio_conversations WHERE id=$1 FOR UPDATE', [id]);
      const backend = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!;
      job = track(
        operation === 'ready'
          ? store.setReady(id, false)
          : store.inputAdmitted(id, 'turn', Date.parse('2026-11-28T00:00:00Z'), 'Auto'),
      );
      await vi.waitFor(async () => {
        const waiting = await observer.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT FROM pg_stat_activity
            WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting`,
          [database.applicationName, backend.pid],
        );
        expect(waiting.rows[0]?.waiting).toBe(true);
      });
      store.markUnavailable();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await expect(job).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    expect(
      (
        await observer.query('SELECT state,title,updated_at FROM mio_conversations WHERE id=$1', [
          id,
        ])
      ).rows,
    ).toEqual(before);
  },
);

it('retries a durable fork target after metadata failure using the same reserved cutoff', async () => {
  const source = await ready();
  const reservation = await store.reserveFork(actor, source, 'fork', undefined, async () => 7);
  let nativeSeed: { nativeId: string; cutoff: number } | undefined;
  const materialize = vi.fn(async (nativeId: string, cutoff: number) => {
    if (nativeSeed) expect(nativeSeed).toEqual({ nativeId, cutoff });
    nativeSeed = { nativeId, cutoff };
    store.markUnavailable();
  });
  await expect(store.completeFork(actor, reservation.targetId, materialize)).rejects.toMatchObject({
    code: 'CONVERSATION_UNAVAILABLE',
  });
  await store.close();
  store = await createConversationStore(database.url);
  const replay = await store.reserveFork(actor, source, 'fork', undefined, async () => {
    throw new Error('Reserved cutoff must not be recomputed');
  });
  expect(replay).toEqual(reservation);
  const completed = await store.completeFork(actor, replay.targetId, async (nativeId, cutoff) => {
    expect({ nativeId, cutoff }).toEqual(nativeSeed);
  });
  expect(completed).toMatchObject({
    created: true,
    conversation: { state: 'ready', forkedUntilSeq: 7 },
  });
  const never = vi.fn(async () => {});
  expect(await store.completeFork(actor, replay.targetId, never)).toMatchObject({ created: false });
  expect(never).not.toHaveBeenCalled();
});
