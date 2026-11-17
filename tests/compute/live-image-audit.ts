import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// Acceptance-only safety interlock: no headers, request body, URL token or credential is logged.
const maxUpstreamGeneratePosts = 1;
const SCENARIO_POST_ENDPOINTS = {
  'vidu-async': ['https://api.onelinkai.cloud/vidu/ent/v2/reference2image'],
  'kling-async': ['https://api.onelinkai.cloud/kling/v1/images/generations'],
  'kling-omni-async': ['https://api.onelinkai.cloud/kling/v1/images/omni-image'],
  'seedream-sync': ['https://api.onelinkai.cloud/volc/api/v3/images/generations'],
  'seedream-45-sync': ['https://api.onelinkai.cloud/volc/api/v3/images/generations'],
  'seedream-50-lite-sync': ['https://api.onelinkai.cloud/volc/api/v3/images/generations'],
  'gpt-sync': ['https://api.onelinkai.cloud/v1/images/generations'],
  'gpt-edit': ['https://api.onelinkai.cloud/v1/images/edits'],
} as const;
type AuditScenario = keyof typeof SCENARIO_POST_ENDPOINTS;
const rawScenario = process.env.MIO_LIVE_IMAGE_SCENARIO;
const scenario = (
  rawScenario && rawScenario.length > 0 ? rawScenario : 'vidu-async'
) as AuditScenario;
if (!Object.hasOwn(SCENARIO_POST_ENDPOINTS, scenario))
  throw new Error('LIVE_IMAGE_SCENARIO_INVALID');
const allowedPostEndpoints: readonly string[] = SCENARIO_POST_ENDPOINTS[scenario];
const directory = process.env.MIO_LIVE_IMAGE_AUDIT_DIRECTORY;
if (!directory) throw new Error('LIVE_IMAGE_AUDIT_DIRECTORY_REQUIRED');
const root = resolve(directory);
const stat = lstatSync(root);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
  throw new Error('LIVE_IMAGE_AUDIT_DIRECTORY_INVALID');
const marker = join(root, 'supplier-post-started.json');
const allowed = join(root, 'supplier-post-allowed.json');
const blocked = join(root, 'supplier-post-repeat-blocked.json');
const unexpected = join(root, 'supplier-post-unexpected-blocked.json');
const held = join(root, 'supplier-query-held.json');
const queryLimit = join(root, 'supplier-query-limit-blocked.json');
const queryMismatch = join(root, 'supplier-query-mismatch-blocked.json');
const queryDeadline = join(root, 'supplier-query-deadline-blocked.json');
const events = join(root, 'supplier-http-events.jsonl');
function mark(path: string) {
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: new Date().toISOString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
function observe(event: string, data: Record<string, unknown> = {}) {
  appendFileSync(events, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`, {
    mode: 0o600,
  });
}
async function observeQuery(response: Response, attempt: number) {
  const facts: Record<string, unknown> = {
    attempt,
    status: response.status,
    requestIdPresent: response.headers.has('x-request-id'),
    state: 'unknown',
    stateType: 'absent',
    creationsType: 'absent',
    creationsCount: null,
    firstUrlPresent: false,
    firstUrlSyntaxAllowed: null,
  };
  const reader = response.body?.getReader();
  try {
    if (reader) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 64 * 1024) {
          void reader.cancel().catch(() => {});
          observe('query-response', facts);
          return;
        }
        chunks.push(part.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const payload = value as Record<string, unknown>;
        let creations: unknown;
        if (scenario === 'kling-async' || scenario === 'kling-omni-async') {
          facts.codeZero = payload.code === 0;
          const data =
            payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
              ? (payload.data as Record<string, unknown>)
              : null;
          const status = data?.task_status;
          facts.stateType = status === undefined ? 'absent' : typeof status;
          const normalizedStatus =
            typeof status === 'string' &&
            /^[A-Za-z_]+$/.test(status) &&
            (status === status.toLowerCase() || status === status.toUpperCase())
              ? status.toLowerCase()
              : '';
          facts.state =
            typeof status !== 'string'
              ? 'unknown'
              : [
                    'not_start',
                    'submitted',
                    'queued',
                    'queueing',
                    'in_progress',
                    'processing',
                    'succeed',
                    'success',
                    'failed',
                    'failure',
                  ].includes(normalizedStatus)
                ? normalizedStatus
                : 'other';
          const taskResult =
            data?.task_result &&
            typeof data.task_result === 'object' &&
            !Array.isArray(data.task_result)
              ? (data.task_result as Record<string, unknown>)
              : null;
          creations = taskResult?.images;
        } else {
          facts.stateType = payload.state === undefined ? 'absent' : typeof payload.state;
          facts.state =
            typeof payload.state !== 'string'
              ? 'unknown'
              : ['created', 'queueing', 'processing', 'success', 'failed'].includes(payload.state)
                ? payload.state
                : 'other';
          creations = payload.creations;
        }
        facts.creationsType =
          creations === undefined
            ? 'absent'
            : Array.isArray(creations)
              ? 'array'
              : typeof creations;
        if (Array.isArray(creations)) {
          facts.creationsCount = creations.length;
          const first = creations[0];
          const url =
            first && typeof first === 'object' && !Array.isArray(first)
              ? (first as Record<string, unknown>).url
              : undefined;
          facts.firstUrlPresent = typeof url === 'string' && url.length > 0;
          if (typeof url === 'string') {
            try {
              const parsed = new URL(url);
              facts.firstUrlSyntaxAllowed =
                url.length <= 2048 &&
                parsed.protocol === 'https:' &&
                !parsed.username &&
                !parsed.password &&
                !parsed.port;
            } catch {
              facts.firstUrlSyntaxAllowed = false;
            }
          }
        }
      }
    }
  } catch {
    // Missing or malformed diagnostics do not affect the application response.
  }
  observe('query-response', facts);
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const target = new URL(url);
  if (
    target.origin !== 'https://api.onelinkai.cloud' ||
    (method === 'GET' && target.pathname === '/v1/models' && !target.search && !target.hash)
  )
    return originalFetch(input, init);
  const query =
    method === 'GET' &&
    target.origin === 'https://api.onelinkai.cloud' &&
    !target.username &&
    !target.password &&
    !target.search &&
    !target.hash &&
    ((scenario === 'vidu-async' &&
      /^\/vidu\/ent\/v2\/tasks\/[^/]+\/creations$/.test(target.pathname)) ||
      (scenario === 'kling-async' &&
        /^\/kling\/v1\/images\/generations\/[^/]+$/.test(target.pathname)) ||
      (scenario === 'kling-omni-async' &&
        /^\/kling\/v1\/images\/omni-image\/[^/]+$/.test(target.pathname)));
  const providerPost = !query;
  let queryAttempt = 0;
  let queryExpiresAt = 0;
  if (query && process.env.MIO_LIVE_IMAGE_HOLD_FIRST_QUERY === 'yes') {
    mark(held);
    return new Promise<Response>(() => {});
  }
  if (
    query &&
    process.env.MIO_LIVE_IMAGE_AWAIT_TASK === 'yes' &&
    !existsSync(join(root, 'allowed-task.json'))
  ) {
    mark(held);
    return (async () => {
      const deadline = Date.now() + 30_000;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      while (!existsSync(join(root, 'allowed-task.json'))) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('LIVE_QUERY_TASK_NOT_READY');
        await new Promise((done) => setTimeout(done, 100));
      }
      signal?.throwIfAborted();
      return globalThis.fetch(input, init);
    })();
  }
  if (query) {
    const expected = JSON.parse(readFileSync(join(root, 'allowed-task.json'), 'utf8')) as {
      upstreamTaskId?: string;
      deadline?: number;
    };
    if (decodeURIComponent(target.pathname.split('/')[5]!) !== expected.upstreamTaskId) {
      mark(queryMismatch);
      throw new Error('LIVE_QUERY_TASK_MISMATCH');
    }
    if (!Number.isSafeInteger(expected.deadline) || Date.now() >= expected.deadline!) {
      mark(queryDeadline);
      throw new Error('LIVE_QUERY_DEADLINE_EXCEEDED');
    }
    queryExpiresAt = expected.deadline!;
    let allowedQuery = false;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const fd = openSync(join(root, `supplier-query-${attempt}.json`), 'wx', 0o600);
        try {
          writeSync(fd, JSON.stringify({ at: new Date().toISOString(), attempt }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        allowedQuery = true;
        queryAttempt = attempt;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!allowedQuery) {
      mark(queryLimit);
      throw new Error('LIVE_QUERY_LIMIT_BLOCKED');
    }
  }
  if (providerPost) {
    const expected =
      method === 'POST' &&
      target.origin === 'https://api.onelinkai.cloud' &&
      allowedPostEndpoints.includes(url) &&
      maxUpstreamGeneratePosts === 1;
    if (!expected) mark(unexpected);
    let fd: number;
    try {
      fd = openSync(marker, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        mark(blocked);
        throw new Error('LIVE_IMAGE_REPEAT_POST_BLOCKED');
      }
      throw error;
    }
    try {
      writeSync(fd, JSON.stringify({ at: new Date().toISOString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!expected) throw new Error('LIVE_IMAGE_UNEXPECTED_PROVIDER_POST');
    mark(allowed);
  }
  // Redirects must not bypass the endpoint allowlist or the durable POST lock.
  if (query && Date.now() >= queryExpiresAt) {
    mark(queryDeadline);
    throw new Error('LIVE_QUERY_DEADLINE_EXCEEDED');
  }
  const result = originalFetch(input, { ...init, redirect: 'error' });
  return result.then(
    (response) => {
      if (query) {
        try {
          mark(join(root, `supplier-query-${queryAttempt}-response.json`));
          void observeQuery(response.clone(), queryAttempt)
            .then(() => mark(join(root, `supplier-query-${queryAttempt}-trace.json`)))
            .catch(() => {});
        } catch {
          // Audit failures must not change the response consumed by the worker.
        }
      } else
        observe('submit-response', {
          status: response.status,
          requestIdPresent: Boolean(response.headers.get('x-request-id')),
        });
      return response;
    },
    (error: unknown) => {
      observe(
        query ? 'query-transport-error' : 'submit-transport-error',
        query ? { attempt: queryAttempt, state: 'unknown' } : {},
      );
      throw error;
    },
  );
};
