import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { authDatabase } from './auth-database.ts';
import { packedAuthRuntime } from './auth-runtime.ts';
import { importDeclaration } from './fixtures/provider-declaration.ts';

const diagnostic: {
  phase: string;
  httpStatus?: number;
  serviceCode?: string;
  cancellation?: { requested: boolean; requestId: string };
} = {
  phase: 'credential-input',
};
/** Explicit live process only; Vitest never discovers or imports this entry. No secret is printed. */
async function main() {
  const path = process.argv[2];
  const modelId = process.argv[3] ?? 'deepseek-v4.1-flash';
  const protocol = process.argv[4] ?? 'openai-chat';
  assert(
    path && process.argv.length <= 5 && ['openai-chat', 'anthropic-messages'].includes(protocol),
  );
  const raw = await readFile(path, 'utf8');
  assert(Buffer.byteLength(raw) <= 8192);
  const line = raw.trim();
  assert(line && !/[\r\n]/.test(line));
  const assignment = /^[A-Za-z_][A-Za-z0-9_]{0,47}=(.*)$/.exec(line);
  let apiKey = assignment ? assignment[1]! : line;
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  )
    apiKey = apiKey.slice(1, -1);
  assert(apiKey && apiKey.length <= 4096 && !/[\s'"*•\u0000-\u001f\u007f]/.test(apiKey));
  diagnostic.phase = 'isolated-migration';
  const database = await authDatabase();
  const observer = new Pool({ connectionString: database.observerURL });
  let runtime: Awaited<ReturnType<typeof packedAuthRuntime>> | undefined;
  let streamAbort: AbortController | undefined;
  let reading: Promise<void> | undefined;
  const seen: { requestId: string; text: string }[] = [];
  const terminalFrames = new Map<string, string>();
  let streamState = 'not-opened';
  try {
    const master = randomBytes(32).toString('base64');
    const env = {
      PATH: process.env.PATH ?? '',
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_CONVERSATIONS_DATABASE_URL: database.url,
      MIO_PROVIDERS_DATABASE_URL: database.url,
      MIO_PROVIDERS_MASTER_KEY: master,
      MIO_PROVIDERS_MASTER_KEY_ID: 'live-chat-isolated',
    };
    for (const name of ['auth', 'providers', 'conversations']) {
      const result = spawnSync(
        process.execPath,
        [`scripts/service/migrate-${name}.ts`, '--apply'],
        { env, encoding: 'utf8', timeout: 30000 },
      );
      assert.equal(result.status, 0);
    }
    diagnostic.phase = 'packed-profile';
    runtime = await packedAuthRuntime(database.url, '', 'unused', {
      conversations: true,
      providerMasterKey: master,
      providerKeyId: 'live-chat-isolated',
    });
    await runtime.start('database');
    const origin = runtime.origin;
    let cookie = '';
    const call = async (path: string, method = 'GET', value?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        signal: AbortSignal.timeout(15_000),
        headers: {
          origin,
          cookie,
          ...(value === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      diagnostic.httpStatus = response.status;
      if (!response.ok) {
        const error = (await response
          .clone()
          .json()
          .catch(() => null)) as { error?: { code?: unknown } } | null;
        const code = error?.error?.code;
        if (typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code)) diagnostic.serviceCode = code;
      }
      return response;
    };
    diagnostic.phase = 'signup';
    const signup = await call('/api/auth/sign-up/email', 'POST', {
      name: 'Live text isolated',
      email: 'live-text@example.test',
      password: randomBytes(24).toString('hex'),
    });
    assert.equal(signup.status, 200);
    cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const owner = ((await signup.json()) as { user: { id: string } }).user.id;
    diagnostic.phase = 'save-owned-credential';
    const saved = await call('/api/v1/providers/onelink/credential', 'PUT', {
      apiKey,
      expectedRevision: 0,
    });
    assert.equal(saved.status, 200);
    const provider = (await saved.json()) as {
      id: string;
      revision: number;
      credentialVersion: number;
    };
    diagnostic.phase = 'exact-catalog';
    const discovered = await call('/api/v1/providers/onelink/test', 'POST', {});
    assert.equal(discovered.status, 200);
    const discovery = (await discovered.json()) as { status: string; ids: string[] };
    assert.equal(discovery.status, 'connected');
    assert(discovery.ids.includes(modelId), 'Exact live model is absent from current directory');
    const directory = (await (await call('/api/v1/providers/onelink/models')).json()) as {
      items: { modelId: string; modelRef: string; modelKey: string }[];
    };
    const model = directory.items.find((item) => item.modelId === modelId)!;
    assert(model);
    const current = (await (await call('/api/v1/providers/onelink')).json()) as {
      revision: number;
    };
    const declared = await importDeclaration(
      env,
      owner,
      current.revision,
      model.modelRef,
      protocol as 'openai-chat' | 'anthropic-messages',
      'OneLink text protocol documentation and explicit authorized exact-model protocol probe',
    );
    assert.equal(
      (
        await call('/api/v1/providers/onelink/models', 'PATCH', {
          modelRef: model.modelRef,
          usage: 'chat',
          isDefault: true,
          expectedRevision: declared.revision,
        })
      ).status,
      200,
    );
    diagnostic.phase = 'create-default-conversation';
    const created = await call('/api/v1/conversations', 'POST', {});
    assert.equal(created.status, 201);
    const conversation = (await created.json()) as { id: string; modelRef: string };
    assert.equal(conversation.modelRef, model.modelRef);
    const id = conversation.id;
    const cancelText = Promise.withResolvers<void>();
    streamAbort = new AbortController();
    const stream = await fetch(`${origin}/api/v1/conversations/${id}/events`, {
      headers: { origin, cookie },
      signal: streamAbort.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    streamState = 'reading';
    reading = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) {
            streamState = 'ended';
            break;
          }
          buffer += decoder.decode(part.value, { stream: true });
          let split: number;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6)) as {
              type: string;
              requestId?: string;
              text?: string;
              receipt?: { requestId: string; status: string };
            };
            if (event.type === 'text' && event.requestId && event.text) {
              seen.push({ requestId: event.requestId, text: event.text });
              if (event.requestId === 'live-cancel') cancelText.resolve();
            }
            if (
              event.type === 'state' &&
              event.receipt &&
              ['completed', 'cancelled', 'failed', 'unknown'].includes(event.receipt.status)
            )
              terminalFrames.set(event.receipt.requestId, event.receipt.status);
          }
        }
      } catch {
        streamState = streamAbort?.signal.aborted ? 'aborted' : 'failed';
        if (!streamAbort?.signal.aborted) throw new Error('LIVE_STREAM_FAILED');
      }
    })();
    // Observe early rejection; the original promise is still awaited and must fail the run.
    void reading.catch(() => {});
    const send = (requestId: string, text: string) =>
      call(`/api/v1/conversations/${id}/messages`, 'POST', { requestId, text });
    const terminal = async (requestId: string) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const response = await call(`/api/v1/conversations/${id}/requests/${requestId}`);
        assert.equal(response.status, 200);
        const value = (await response.json()) as { status: string; error?: string };
        if (['completed', 'cancelled', 'failed', 'unknown'].includes(value.status)) {
          if (value.status === 'failed' || value.status === 'unknown') {
            const facts = await observer.query(
              'SELECT request_id,model_binding,model_observations FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
              [id, requestId],
            );
            console.log(
              JSON.stringify({
                result: 'failed-request-observation',
                modelId,
                terminal: value.status,
                serviceCode: value.error,
                requests: facts.rows,
                fees: 'unknown',
              }),
            );
            return value;
          }
          if (terminalFrames.get(requestId) === value.status) return value;
        }
        assert(Date.now() < deadline, 'Receipt and SSE terminal did not agree before deadline');
        await delay(100);
      }
    };
    diagnostic.phase = 'live-first-round';
    assert.equal(
      (await send('live-one', 'Remember the code MIO-ORCHID-27. Reply only MIO-ORCHID-27.')).status,
      202,
    );
    assert.equal((await terminal('live-one')).status, 'completed');
    diagnostic.phase = 'live-second-round';
    assert.equal(
      (await send('live-two', 'What code did I ask you to remember? Reply only with that code.'))
        .status,
      202,
    );
    assert.equal((await terminal('live-two')).status, 'completed');
    assert(
      seen
        .filter((value) => value.requestId === 'live-two')
        .map((value) => value.text)
        .join('')
        .includes('MIO-ORCHID-27'),
    );
    diagnostic.phase = 'live-running-cancel';
    assert.equal(
      (
        await send(
          'live-cancel',
          'Write a numbered list of 10000 distinct short sentences, one sentence per line. Do not summarize.',
        )
      ).status,
      202,
    );
    diagnostic.phase = 'live-cancel-wait-first-text';
    await Promise.race([
      cancelText.promise,
      delay(60_000, undefined, { ref: false }).then(() => {
        throw new Error('LIVE_TEXT_TIMEOUT');
      }),
    ]);
    diagnostic.phase = 'live-cancel-request';
    const cancelled = await call(`/api/v1/conversations/${id}/cancel`, 'POST', {});
    assert.equal(cancelled.status, 202);
    const cancellation = (await cancelled.json()) as { requested: boolean; requestId: string };
    diagnostic.cancellation = cancellation;
    assert(cancellation.requested && cancellation.requestId === 'live-cancel');
    diagnostic.phase = 'live-cancel-terminal';
    const cancelReceipt = await terminal('live-cancel');
    assert.equal(cancelReceipt.status, 'cancelled');
    streamAbort.abort();
    await reading;
    diagnostic.phase = 'history-and-observations';
    const history = await (await call(`/api/v1/conversations/${id}/history`)).json();
    assert(JSON.stringify(history).includes('MIO-ORCHID-27'));
    const observations = (
      await observer.query<{
        request_id: string;
        model_binding: Record<string, unknown>;
        model_observations: Record<string, unknown>[];
      }>(
        'SELECT request_id,model_binding,model_observations FROM mio_conversation_requests WHERE conversation_id=$1 ORDER BY created_at',
        [id],
      )
    ).rows;
    assert.equal(observations.length, 3);
    assert(
      observations.every(
        (row) =>
          row.model_binding.providerConfigId === provider.id &&
          row.model_binding.credentialVersion === 1 &&
          row.model_binding.catalogVersion === 1 &&
          row.model_binding.modelKey === model.modelKey &&
          row.model_binding.adaptationVersion === 1 &&
          row.model_binding.profile === protocol &&
          row.model_observations.length === 1,
      ),
    );
    assert(
      observations
        .slice(0, 2)
        .every(
          (row) =>
            row.model_observations[0]!.finish === 'stop' &&
            row.model_observations[0]!.usageStatus === 'reported',
        ),
    );
    assert(!JSON.stringify(observations).includes(apiKey));
    diagnostic.phase = 'restart-no-replay';
    await runtime.stop();
    await runtime.start('database');
    assert.equal(
      (await send('live-one', 'Remember the code MIO-ORCHID-27. Reply only MIO-ORCHID-27.')).status,
      202,
    );
    assert.equal((await terminal('live-cancel')).status, 'cancelled');
    const after = await observer.query(
      'SELECT model_observations FROM mio_conversation_requests WHERE conversation_id=$1',
      [id],
    );
    assert.equal(after.rows.length, 3);
    assert(
      after.rows.every(
        (row: { model_observations: unknown[] }) => row.model_observations.length === 1,
      ),
    );
    const inspect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else assert(!(await readFile(path, 'utf8')).includes(apiKey));
      }
    };
    await inspect(runtime.nativeLogRoot);
    console.log(
      JSON.stringify({
        result: 'pass',
        modelId,
        protocol,
        catalogDiscovered: discovery.ids.includes(modelId),
        requests: observations,
        sseTextFrames: seen.length,
        sseTerminalStates: Object.fromEntries(terminalFrames),
        cancellation: cancelReceipt.status,
        restart: 'no replay',
        fees: 'unknown',
      }),
    );
  } catch (error) {
    // Keep failure facts before isolated cleanup; never print arbitrary error messages or text.
    try {
      const requests = await observer.query(
        'SELECT request_id,status,error_code,model_binding,model_observations FROM mio_conversation_requests ORDER BY created_at',
      );
      const observation = JSON.stringify({
        result: 'failed-run-observation',
        ...diagnostic,
        requests: requests.rows,
        sseTextFrames: Object.fromEntries(
          [...new Set(seen.map((frame) => frame.requestId))].map((requestId) => [
            requestId,
            seen.filter((frame) => frame.requestId === requestId).length,
          ]),
        ),
        sseTerminalStates: Object.fromEntries(terminalFrames),
        streamState,
        fees: 'unknown',
      });
      assert(!observation.includes(apiKey));
      console.error(observation);
    } catch {
      console.error(JSON.stringify({ result: 'failed-observation-unavailable' }));
    }
    throw error;
  } finally {
    streamAbort?.abort();
    await reading?.catch(() => {});
    try {
      await runtime?.close();
    } finally {
      await observer.end();
      await database.close();
    }
  }
}
try {
  await main();
} catch {
  console.error(JSON.stringify({ result: 'failed', ...diagnostic }));
  process.exitCode = 1;
}
