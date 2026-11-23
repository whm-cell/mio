import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { readSessionArtifact } from '../support/session-artifact.ts';
import { importDeclaration } from '../providers/fixtures/provider-declaration.ts';
import {
  authenticateOrCreateRetainedDevOwner,
  createPersistentDevProfileController,
  parseLiveAuthInput,
  preparePersistentDevEnvironment,
} from '../support/local-dev-live.ts';

const diagnostic: {
  phase: string;
  httpStatus?: number;
  serviceCode?: string;
  cancellation?: { requested: boolean; requestId: string };
} = {
  phase: 'credential-input',
};

/** Explicit live process against persistent mio_dev; retains conversation, receipts and DSH session logs. */
async function main() {
  const path = process.argv[2];
  const modelId = process.argv[3] ?? 'deepseek-v4.1-flash';
  const protocol = process.argv[4] ?? 'openai-chat';
  assert(
    path && process.argv.length <= 5 && ['openai-chat', 'anthropic-messages'].includes(protocol),
  );
  const authInput = await parseLiveAuthInput(path);
  const rawSecretForLeakScan = authInput.apiKey ?? null;

  diagnostic.phase = 'dev-environment-migration';
  const dev = await preparePersistentDevEnvironment(['auth', 'providers', 'conversations']);
  const observer = new Pool({
    connectionString: dev.runtimeEnv.MIO_CONVERSATIONS_DATABASE_URL ?? dev.databaseUrl,
  });
  const runtime = await createPersistentDevProfileController(dev.runtimeEnv, dev.origin);
  let streamAbort: AbortController | undefined;
  let reading: Promise<void> | undefined;
  let conversationId: string | undefined;
  const seen: { requestId: string; text: string }[] = [];
  const terminalFrames = new Map<string, string>();
  let streamState = 'not-opened';
  const runSuffix = randomUUID().slice(0, 8);
  const reqOne = `live-one-${runSuffix}`;
  const reqTwo = `live-two-${runSuffix}`;
  const reqCancel = `live-cancel-${runSuffix}`;

  try {
    diagnostic.phase = 'dev-profile';
    await runtime.start();
    const origin = runtime.origin;
    let cookie = '';
    const call = async (targetPath: string, method = 'GET', value?: unknown) => {
      const response = await fetch(`${origin}${targetPath}`, {
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

    diagnostic.phase = 'dev-auth';
    const ownerAccount = await authenticateOrCreateRetainedDevOwner(
      origin,
      authInput,
      'conversations',
    );
    cookie = ownerAccount.cookie;

    const existingProvider = (await (await call('/api/v1/providers/onelink')).json()) as {
      id: string;
      hasKey: boolean;
      revision: number;
      credentialVersion: number;
    };
    let providerId = existingProvider.id;
    if (ownerAccount.apiKey || !existingProvider.hasKey) {
      assert(ownerAccount.apiKey, 'LIVE_PROVIDER_KEY_REQUIRED');
      diagnostic.phase = 'save-owned-credential';
      const saved = await call('/api/v1/providers/onelink/credential', 'PUT', {
        apiKey: ownerAccount.apiKey,
        expectedRevision: existingProvider.revision,
      });
      assert.equal(saved.status, 200);
      providerId = ((await saved.json()) as { id: string }).id;
    }

    diagnostic.phase = 'exact-catalog';
    const discovered = await call('/api/v1/providers/onelink/test', 'POST', {});
    assert.equal(discovered.status, 200);
    const discovery = (await discovered.json()) as { status: string; ids: string[] };
    assert.equal(discovery.status, 'connected');
    assert(discovery.ids.includes(modelId), 'Exact live model is absent from current directory');
    const directory = (await (await call('/api/v1/providers/onelink/models')).json()) as {
      provider: {
        credentialVersion: number;
        catalog: { version: number };
      };
      items: { modelId: string; modelRef: string; modelKey: string }[];
    };
    const model = directory.items.find((item) => item.modelId === modelId)!;
    assert(model);
    const current = (await (await call('/api/v1/providers/onelink')).json()) as {
      revision: number;
    };
    const declared = await importDeclaration(
      dev.runtimeEnv,
      ownerAccount.userId,
      current.revision,
      model.modelRef,
      protocol as 'openai-chat' | 'anthropic-messages',
      'OneLink text protocol documentation and persistent mio_dev protocol probe',
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
    conversationId = id;
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
              if (event.requestId === reqCancel) cancelText.resolve();
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
                environment: 'mio_dev',
                conversationId: id,
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
      (await send(reqOne, 'Remember the code MIO-ORCHID-27. Reply only MIO-ORCHID-27.')).status,
      202,
    );
    assert.equal((await terminal(reqOne)).status, 'completed');
    diagnostic.phase = 'live-second-round';
    assert.equal(
      (await send(reqTwo, 'What code did I ask you to remember? Reply only with that code.'))
        .status,
      202,
    );
    assert.equal((await terminal(reqTwo)).status, 'completed');
    assert(
      seen
        .filter((value) => value.requestId === reqTwo)
        .map((value) => value.text)
        .join('')
        .includes('MIO-ORCHID-27'),
    );

    diagnostic.phase = 'live-running-cancel';
    assert.equal(
      (
        await send(
          reqCancel,
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
    assert(cancellation.requested && cancellation.requestId === reqCancel);
    diagnostic.phase = 'live-cancel-terminal';
    const cancelReceipt = await terminal(reqCancel);
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
          row.model_binding.providerConfigId === providerId &&
          row.model_binding.credentialVersion === directory.provider.credentialVersion &&
          row.model_binding.catalogVersion === directory.provider.catalog.version &&
          row.model_binding.modelKey === model.modelKey &&
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
    if (rawSecretForLeakScan) {
      assert(!JSON.stringify(observations).includes(rawSecretForLeakScan));
    }

    diagnostic.phase = 'restart-no-replay';
    await runtime.stop();
    await runtime.start();
    assert.equal(
      (await send(reqOne, 'Remember the code MIO-ORCHID-27. Reply only MIO-ORCHID-27.')).status,
      202,
    );
    assert.equal((await terminal(reqCancel)).status, 'cancelled');
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
    if (rawSecretForLeakScan) {
      let inspectedSessionLog = false;
      const inspect = async (directoryPath: string): Promise<void> => {
        for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
          const itemPath = join(directoryPath, entry.name);
          if (entry.isDirectory()) await inspect(itemPath);
          else {
            assert(!(await readSessionArtifact(itemPath)).includes(rawSecretForLeakScan));
            if (/^session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?$/.test(entry.name))
              inspectedSessionLog = true;
          }
        }
      };
      await inspect(runtime.nativeLogRoot);
      assert(inspectedSessionLog, 'Live leak scan did not inspect a native Session log');
    }
    console.log(
      JSON.stringify({
        result: 'pass',
        environment: 'mio_dev',
        retainedInDatabase: true,
        conversationId: id,
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
    try {
      const requests = conversationId
        ? await observer.query(
            'SELECT request_id,status,error_code,model_binding,model_observations FROM mio_conversation_requests WHERE conversation_id=$1 ORDER BY created_at',
            [conversationId],
          )
        : { rows: [] };
      const observation = JSON.stringify({
        result: 'failed-run-observation',
        environment: 'mio_dev',
        conversationId: conversationId ?? null,
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
      if (rawSecretForLeakScan) assert(!observation.includes(rawSecretForLeakScan));
      console.error(observation);
    } catch {
      console.error(JSON.stringify({ result: 'failed-observation-unavailable' }));
    }
    throw error;
  } finally {
    streamAbort?.abort();
    await reading?.catch(() => {});
    try {
      await runtime.close();
    } finally {
      await observer.end();
    }
  }
}

try {
  await main();
} catch {
  console.error(JSON.stringify({ result: 'failed', ...diagnostic }));
  process.exitCode = 1;
}
