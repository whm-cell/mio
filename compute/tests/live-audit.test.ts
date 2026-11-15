import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';

it('records the first real-provider attempt and blocks a second without forwarding credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    const url = 'https://api.onelinkai.cloud/vidu/ent/v2/reference2image';
    const options = { method: 'POST', headers: { authorization: 'synthetic-secret' } };
    await fetch(url, options);
    expect(() => fetch(url, options)).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
    expect(transport).toHaveBeenCalledOnce();
    const first = readFileSync(join(directory, 'supplier-post-started.json'), 'utf8');
    const allowed = readFileSync(join(directory, 'supplier-post-allowed.json'), 'utf8');
    const blocked = readFileSync(join(directory, 'supplier-post-repeat-blocked.json'), 'utf8');
    expect(first + allowed + blocked).not.toContain('synthetic-secret');
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('records and blocks an unexpected provider endpoint without allowing an outbound request', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() => fetch('https://api.onelinkai.cloud/unexpected', { method: 'POST' })).toThrow(
      'LIVE_IMAGE_UNEXPECTED_PROVIDER_POST',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'supplier-post-started.json'), 'utf8')).toContain('at');
    expect(
      readFileSync(join(directory, 'supplier-post-unexpected-blocked.json'), 'utf8'),
    ).toContain('at');
    expect(() => readFileSync(join(directory, 'supplier-post-allowed.json'), 'utf8')).toThrow();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('holds the first query before network access and allows interrupted-worker cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const module = pathToFileURL(resolve('tests/compute/live-image-audit.ts')).href;
  const source = `
    import { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(process.env.MIO_LIVE_IMAGE_AUDIT_DIRECTORY + '/forwarded', 'unexpected'); return new Response('ok'); };
    await import(${JSON.stringify(module)});
    void fetch('https://api.onelinkai.cloud/vidu/ent/v2/tasks/private-task/creations');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      MIO_LIVE_IMAGE_AUDIT_DIRECTORY: directory,
      MIO_LIVE_IMAGE_HOLD_FIRST_QUERY: 'yes',
    },
    stdio: 'ignore',
  });
  try {
    await vi.waitFor(
      () => expect(existsSync(join(directory, 'supplier-query-held.json'))).toBe(true),
      {
        timeout: 5000,
      },
    );
    expect(existsSync(join(directory, 'forwarded'))).toBe(false);
    expect(existsSync(join(directory, 'supplier-query-1.json'))).toBe(false);
    const exited = once(child, 'exit');
    expect(child.kill('SIGKILL')).toBe(true);
    const [, signal] = await exited;
    expect(signal).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true });
  }
}, 10000);

it('reads the journal only after the worker releases its exclusive lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-journal-'));
  const journal = new Journal(directory, randomUUID(), true);
  let closed = false;
  try {
    const held = new DatabaseSync(join(directory, 'journal.sqlite3'), { readOnly: true });
    try {
      expect(() => held.prepare('SELECT phase,payload FROM image_attempts LIMIT 1').get()).toThrow(
        /locked/,
      );
    } finally {
      held.close();
    }
    journal.close();
    closed = true;
    const released = new DatabaseSync(join(directory, 'journal.sqlite3'), { readOnly: true });
    try {
      expect(
        released.prepare('SELECT phase,payload FROM image_attempts LIMIT 1').get(),
      ).toBeUndefined();
    } finally {
      released.close();
    }
  } finally {
    if (!closed) journal.close();
    rmSync(directory, { recursive: true });
  }
});

it('keeps only a valid failure code when an assertion includes sensitive trailing details', async () => {
  const directory = mkdtempSync(join(resolve('.runtime'), 'mio-live-safe-code-'));
  const infrastructure = join(directory, 'infra');
  mkdirSync(infrastructure, { mode: 0o700 });
  const write = (name: string, content: string) =>
    writeFileSync(join(infrastructure, name), content, { mode: 0o600 });
  write(
    'manifest.json',
    JSON.stringify({
      runDirectory: infrastructure,
      project: 'miow3safe',
      postgresDatabase: 'mio_w3_safe',
      rabbitVhost: 'mio-w3-safe',
      ports: { postgres: 12345, amqp: 12346, management: 12347 },
    }),
  );
  write('postgres.env', 'MIO_TEST_DATABASE_URL=postgres://a:b@127.0.0.1:12345/mio_w3_safe\n');
  write(
    'rabbit-a.env',
    'MIO_COMPUTE_BROKER_USER=a\nMIO_COMPUTE_EXPECTED_RESULT_USER=b\nRABBITMQ_URL=amqp://a:b@127.0.0.1:12346/mio-w3-safe\n',
  );
  write(
    'rabbit-b.env',
    'MIO_COMPUTE_BROKER_USER=b\nMIO_COMPUTE_EXPECTED_COMMAND_USER=a\nRABBITMQ_URL=amqp://b:b@127.0.0.1:12346/mio-w3-safe\n',
  );
  const preload = join(directory, 'preload.mjs');
  writeFileSync(
    preload,
    `import assert from 'node:assert/strict';
import pg from 'pg';
pg.Pool.prototype.query = async () => ({ rows: [{ count: '0' }] });
pg.Pool.prototype.end = async () => {};
const equal = assert.equal;
assert.equal = (...args) => {
  if (args[2] === 'LIVE_DATABASE_NOT_EMPTY') throw new Error(process.env.MIO_TEST_INVALID_CODE
    ? 'private-sensitive-tail\\nLIVE_DATABASE_NOT_EMPTY'
    : 'LIVE_DATABASE_NOT_EMPTY\\nprivate-sensitive-tail');
  return equal(...args);
};`,
    { mode: 0o600 },
  );
  try {
    for (const invalid of [false, true]) {
      const run = join(directory, invalid ? 'invalid' : 'valid');
      const child = spawn(
        process.execPath,
        [
          'tests/compute/live-image-loop.ts',
          'prepare',
          run,
          infrastructure,
          '/unused',
          'a'.repeat(64),
        ],
        {
          env: {
            ...process.env,
            MIO_RUN_LIVE_IMAGE: 'yes',
            MIO_TEST_INVALID_CODE: invalid ? 'yes' : '',
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const [code] = await once(child, 'close');
      expect(code).toBe(1);
      expect(output).toContain(invalid ? 'LIVE_UNEXPECTED_FAILURE' : 'LIVE_DATABASE_NOT_EMPTY');
      expect(output).not.toContain('private-sensitive-tail');
      expect(readFileSync(join(run, 'events.jsonl'), 'utf8')).not.toContain(
        'private-sensitive-tail',
      );
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}, 10000);

it('marks a received response before its diagnostic trace is available', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  writeFileSync(join(directory, 'allowed-task.json'), JSON.stringify({ upstreamTaskId: 'task' }));
  try {
    await import('../../tests/compute/live-image-audit.ts');
    const response = await fetch('https://api.onelinkai.cloud/vidu/ent/v2/tasks/task/creations');
    expect(existsSync(join(directory, 'supplier-query-1-response.json'))).toBe(true);
    expect(existsSync(join(directory, 'supplier-query-1-trace.json'))).toBe(false);
    controller.enqueue(new TextEncoder().encode('{"state":"processing"}'));
    controller.close();
    expect(await response.json()).toEqual({ state: 'processing' });
    await vi.waitFor(() =>
      expect(existsSync(join(directory, 'supplier-query-1-trace.json'))).toBe(true),
    );
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('allows only the saved task and at most eight query attempts without logging credentials', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const states = [
    'created',
    'queueing',
    'processing',
    'success',
    'failed',
    'private-state',
    null,
    undefined,
  ];
  let responseIndex = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      state: states[responseIndex++],
      creations: [{ url: 'https://image01.vidu.zone/private-path?token=private-token' }],
      task_id: 'private-task',
      secret: 'synthetic-secret',
    }),
  );
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  writeFileSync(
    join(directory, 'allowed-task.json'),
    JSON.stringify({ upstreamTaskId: 'private-task' }),
    {
      mode: 0o600,
    },
  );
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() =>
      fetch('https://api.onelinkai.cloud/vidu/ent/v2/tasks/other-task/creations'),
    ).toThrow('LIVE_QUERY_TASK_MISMATCH');
    const url = 'https://api.onelinkai.cloud/vidu/ent/v2/tasks/private-task/creations';
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(url, { headers: { authorization: 'synthetic-secret' } });
      expect(((await response.json()) as { task_id: string }).task_id).toBe('private-task');
    }
    expect(() => fetch(url)).toThrow('LIVE_QUERY_LIMIT_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(8);
    await vi.waitFor(() =>
      expect(
        readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8').trim().split('\n'),
      ).toHaveLength(8),
    );
    await vi.waitFor(() => {
      for (let attempt = 1; attempt <= 8; attempt++) {
        expect(existsSync(join(directory, `supplier-query-${attempt}-response.json`))).toBe(true);
        expect(existsSync(join(directory, `supplier-query-${attempt}-trace.json`))).toBe(true);
      }
    });
    const events = readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8');
    expect(events).not.toContain('synthetic-secret');
    expect(events).not.toContain('private-task');
    expect(events).not.toContain('private-path');
    expect(events).not.toContain('private-token');
    expect(events.trim().split('\n')).toHaveLength(8);
    const facts = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.attempt - b.attempt);
    expect(facts.map((event) => event.state)).toEqual([
      'created',
      'queueing',
      'processing',
      'success',
      'failed',
      'other',
      'unknown',
      'unknown',
    ]);
    expect(facts[0]).toMatchObject({
      status: 200,
      stateType: 'string',
      creationsType: 'array',
      creationsCount: 1,
      firstUrlPresent: true,
      firstUrlSyntaxAllowed: true,
    });
    expect(existsSync(join(directory, 'supplier-query-limit-blocked.json'))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it.each([
  ['vidu-async', 'https://api.onelinkai.cloud/vidu/ent/v2/img2img'],
  ['kling-async', 'https://api.onelinkai.cloud/kling/v1/images/generations'],
  ['seedream-sync', 'https://api.onelinkai.cloud/volc/api/v3/images/generations'],
  ['gpt-sync', 'https://api.onelinkai.cloud/v1/images/generations'],
  ['gpt-edit', 'https://api.onelinkai.cloud/v1/images/edits'],
] as const)(
  'enforces the single-POST interlock for explicit scenario %s (%s)',
  async (scenario, allowedUrl) => {
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
    vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', scenario);
    vi.stubGlobal('fetch', transport);
    try {
      await import('../../tests/compute/live-image-audit.ts');
      const options = { method: 'POST', headers: { authorization: 'synthetic-secret' } };
      await fetch(allowedUrl, options);
      expect(() => fetch(allowedUrl, options)).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
      expect(transport).toHaveBeenCalledOnce();
      expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-allowed.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-repeat-blocked.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-unexpected-blocked.json'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true });
    }
  },
);

it.each([
  ['seedream-sync', 'https://api.onelinkai.cloud/v1/images/generations', 'POST'],
  ['seedream-sync', 'https://api.onelinkai.cloud/vidu/ent/v2/tasks/task/creations', 'GET'],
  ['seedream-sync', 'https://api.onelinkai.cloud/kling/v1/images/generations/task', 'GET'],
  ['seedream-sync', 'https://unexpected.example/volc/api/v3/images/generations', 'POST'],
  ['gpt-sync', 'https://api.onelinkai.cloud/v1/images/edits', 'POST'],
  ['gpt-edit', 'https://api.onelinkai.cloud/v1/images/generations', 'POST'],
  ['vidu-async', 'https://unexpected.example/vidu/ent/v2/reference2image', 'POST'],
  ['vidu-async', 'https://api.onelinkai.cloud/kling/v1/images/generations/task', 'GET'],
  ['kling-async', 'https://api.onelinkai.cloud/vidu/ent/v2/reference2image', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/v1/images/generations', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/volc/api/v3/images/generations', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/kling/v1/images/omni-image', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/vidu/ent/v2/tasks/task/creations', 'GET'],
  ['kling-async', 'https://unexpected.example/kling/v1/images/generations', 'POST'],
] as const)(
  'blocks cross-scenario or unexpected host/path requests in %s (%s %s)',
  async (scenario, rejectedUrl, method) => {
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
    vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', scenario);
    vi.stubGlobal('fetch', transport);
    try {
      await import('../../tests/compute/live-image-audit.ts');
      expect(() => fetch(rejectedUrl, { method })).toThrow('LIVE_IMAGE_UNEXPECTED_PROVIDER_POST');
      expect(transport).not.toHaveBeenCalled();
      expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-unexpected-blocked.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-allowed.json'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true });
    }
  },
);

it('enforces Kling task-ID matching, eight-query cap, and sanitized envelope diagnostics without logging URLs', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const statuses = [
    'NOT_START',
    'queued',
    'IN_PROGRESS',
    'SUBMITTED',
    'SUCCEED',
    'success',
    'FAILURE',
    'UNKNOWN',
  ];
  let responseIndex = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    const currentStatus = statuses[responseIndex++];
    return Response.json({
      code: responseIndex === 6 ? 1001 : 0,
      message: 'private-kling-message',
      data: {
        task_id: 'private-kling-task',
        task_status: currentStatus,
        task_result: {
          images: [{ index: 0, url: 'https://cdn.kling.example/private-image?sig=private-sig' }],
        },
      },
      secret: 'synthetic-kling-secret',
    });
  });
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', 'kling-async');
  vi.stubGlobal('fetch', transport);
  writeFileSync(
    join(directory, 'allowed-task.json'),
    JSON.stringify({ upstreamTaskId: 'private-kling-task' }),
    { mode: 0o600 },
  );
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() =>
      fetch('https://api.onelinkai.cloud/kling/v1/images/generations/other-kling-task'),
    ).toThrow('LIVE_QUERY_TASK_MISMATCH');
    const url = 'https://api.onelinkai.cloud/kling/v1/images/generations/private-kling-task';
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(url, { headers: { authorization: 'synthetic-kling-secret' } });
      expect(((await response.json()) as { data: { task_id: string } }).data.task_id).toBe(
        'private-kling-task',
      );
    }
    expect(() => fetch(url)).toThrow('LIVE_QUERY_LIMIT_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(8);
    await vi.waitFor(() => {
      for (let attempt = 1; attempt <= 8; attempt++) {
        expect(existsSync(join(directory, `supplier-query-${attempt}-response.json`))).toBe(true);
        expect(existsSync(join(directory, `supplier-query-${attempt}-trace.json`))).toBe(true);
      }
    });
    const events = readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8');
    expect(events).not.toContain('synthetic-kling-secret');
    expect(events).not.toContain('private-kling-task');
    expect(events).not.toContain('private-kling-message');
    expect(events).not.toContain('private-image');
    expect(events).not.toContain('private-sig');
    const facts = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.attempt - b.attempt);
    expect(facts.map((event) => event.state)).toEqual([
      'not_start',
      'queued',
      'in_progress',
      'submitted',
      'succeed',
      'success',
      'failure',
      'other',
    ]);
    expect(facts[4]).toMatchObject({
      status: 200,
      codeZero: true,
      state: 'succeed',
      stateType: 'string',
      creationsType: 'array',
      creationsCount: 1,
      firstUrlPresent: true,
      firstUrlSyntaxAllowed: true,
    });
    expect(facts[5]).toMatchObject({
      codeZero: false,
      state: 'success',
    });
    expect(existsSync(join(directory, 'supplier-query-mismatch-blocked.json'))).toBe(true);
    expect(existsSync(join(directory, 'supplier-query-limit-blocked.json'))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('rejects an invalid audit scenario before installing fetch hooks', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', 'unknown-scenario');
  try {
    await expect(import('../../tests/compute/live-image-audit.ts')).rejects.toThrow(
      'LIVE_IMAGE_SCENARIO_INVALID',
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});
