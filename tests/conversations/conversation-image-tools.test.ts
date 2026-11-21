import { createImageDecoder } from '../../src/generations/decode.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launcher, prepareProfile } from '../../scripts/service/profile.ts';
import {
  ONELINK_FIXTURE_ROUTES,
  findFixtureRoute,
  importRoutesViaCli,
} from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';
import { unpackPluginPackage } from '../support/auth-runtime.ts';

interface CosEntry {
  bytes: Buffer;
  contentType: string;
  etag: string;
  sha256: string;
}

interface RecordedChatRequest {
  authorization: string | null;
  tools: { type?: string; function?: { name?: string; parameters?: Record<string, unknown> } }[];
  messages: Record<string, unknown>[];
}

interface RecordedImageUpstream {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  json?: Record<string, unknown>;
  multipart?: {
    fields: Record<string, string>;
    images: { field: string; type: string; sha256: string }[];
    hasMask: boolean;
    maskType: string | null;
  };
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

async function generateValidImage(format: 'png' | 'jpeg', color: string): Promise<Buffer> {
  const codec = format === 'png' ? 'png' : 'mjpeg';
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=16x16:d=1`,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      codec,
      'pipe:1',
    ],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr?.toString('utf8'));
  const bytes = Buffer.from(result.stdout);
  await createImageDecoder()(bytes, format);
  return bytes;
}

async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'server_error' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : JSON.stringify(part),
      )
      .join('');
  }
  return JSON.stringify(content ?? '');
}

function currentTurnToolOutputs(
  messages: Record<string, unknown>[],
): { toolCallId: string; text: string }[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  const slice = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages;
  return slice
    .filter((msg) => msg.role === 'tool')
    .map((msg) => ({
      toolCallId: String(msg.tool_call_id ?? ''),
      text: extractMessageText(msg.content),
    }));
}

function streamOpenAiText(res: ServerResponse, text: string, requestId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-request-id': requestId,
  });
  const chunk1 = {
    id: `chatcmpl_${requestId}`,
    object: 'chat.completion.chunk',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const chunk2 = {
    id: `chatcmpl_${requestId}`,
    object: 'chat.completion.chunk',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  };
  res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
  res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamOpenAiToolCalls(
  res: ServerResponse,
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  requestId: string,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-request-id': requestId,
  });
  const chunk1 = {
    id: `chatcmpl_${requestId}`,
    object: 'chat.completion.chunk',
    model: 'deepseek-v4.1-flash',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: null,
      },
    ],
  };
  const chunk2 = {
    id: `chatcmpl_${requestId}`,
    object: 'chat.completion.chunk',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 },
  };
  res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
  res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function collectSseFrames(
  response: Response,
  expectedRequestId: string,
): Promise<SseFrame[]> {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = rawFrame.split('\n').filter(Boolean);
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice('event: '.length).trim();
      const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      frames.push({ event, data });
      if (event === 'error') {
        await reader.cancel().catch(() => {});
        return frames;
      }
      if (event === 'state') {
        const receipt = data.receipt as { requestId?: string; status?: string } | undefined;
        if (
          receipt?.requestId === expectedRequestId &&
          ['completed', 'failed', 'cancelled', 'unknown'].includes(receipt.status ?? '')
        ) {
          await reader.cancel().catch(() => {});
          return frames;
        }
      }
    }
  }
  return frames;
}

describe('conversation controlled intent-level image tools end-to-end', () => {
  let database: Awaited<ReturnType<typeof authDatabase>>;
  let observer: Pool;
  let cosObjects: Map<string, CosEntry>;
  let cosServer: Awaited<ReturnType<typeof listenLoopback>>;
  let onelinkServer: Awaited<ReturnType<typeof listenLoopback>>;
  let pngSample: Buffer;
  let jpegSample: Buffer;
  let chatRequests: RecordedChatRequest[];
  let imageUpstreamRequests: RecordedImageUpstream[];
  let pauseSignal: { paused: boolean; release: (() => void) | null };
  let heldKlingTaskIds: Set<string>;
  let heldKlingWaiters: (() => void)[];
  let profileControl: {
    origin: string;
    apiToken: string;
    start: (backend: 'database' | 'redis') => Promise<void>;
    stop: () => Promise<void>;
    close: () => Promise<void>;
  };

  const cookies: string[] = [];
  const owners: string[] = [];
  const chatModelRef = 'onelink:chat:deepseek-v4.1-flash';

  const call = (path: string, method = 'GET', value?: unknown, owner = 0) =>
    fetch(`${profileControl.origin}${path}`, {
      method,
      headers: {
        origin: profileControl.origin,
        ...(cookies[owner] ? { cookie: cookies[owner]! } : {}),
        ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });

  async function providerRevision(owner = 0): Promise<number> {
    const res = await call('/api/v1/providers/onelink', 'GET', undefined, owner);
    expect(res.status).toBe(200);
    return ((await res.json()) as { revision: number }).revision;
  }

  async function setProviderEnabled(enabled: boolean) {
    const response = await call('/api/v1/providers/onelink', 'PATCH', {
      enabled,
      expectedRevision: await providerRevision(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function createConversation(owner = 0, modelRef?: string): Promise<string> {
    const res = await call('/api/v1/conversations', 'POST', modelRef ? { modelRef } : {}, owner);
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function waitReceiptStatus(
    conversationId: string,
    requestId: string,
    owner = 0,
    timeout = 15_000,
  ): Promise<{ status: string; error?: string }> {
    let latest: { status: string; error?: string } = { status: '' };
    await expect
      .poll(
        async () => {
          const res = await call(
            `/api/v1/conversations/${conversationId}/requests/${requestId}`,
            'GET',
            undefined,
            owner,
          );
          if (res.status !== 200) return false;
          latest = (await res.json()) as { status: string; error?: string };
          return ['completed', 'failed', 'cancelled', 'unknown'].includes(latest.status);
        },
        { timeout, interval: 80 },
      )
      .toBe(true);
    return latest;
  }

  async function waitImageJobCompleted(
    jobId: string,
    owner = 0,
    timeout = 15_000,
  ): Promise<{
    jobId: string;
    status: string;
    assetIds: string[];
    outputs: { index: number; assetId: string }[];
  }> {
    let latest = {
      jobId,
      status: '',
      assetIds: [] as string[],
      outputs: [] as { index: number; assetId: string }[],
    };
    await expect
      .poll(
        async () => {
          const res = await call(`/api/v1/compute/images/${jobId}`, 'GET', undefined, owner);
          if (res.status !== 200) return { status: 'http-' + res.status };
          latest = (await res.json()) as typeof latest;
          return latest;
        },
        { timeout, interval: 100 },
      )
      .toMatchObject({ status: 'completed', errorCode: null });
    return latest;
  }

  async function uploadOwnerPngMask(owner = 0): Promise<string> {
    const initRes = await call(
      '/api/v1/assets/uploads',
      'POST',
      { filename: 'mask.png', contentType: 'image/png', size: pngSample.length },
      owner,
    );
    expect(initRes.status, await initRes.clone().text()).toBe(201);
    const { assetId, uploadUrl } = (await initRes.json()) as { assetId: string; uploadUrl: string };
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(pngSample),
    });
    expect(putRes.status).toBe(200);
    const completeRes = await call(`/api/v1/assets/${assetId}/complete`, 'POST', {}, owner);
    expect(completeRes.status, await completeRes.clone().text()).toBe(200);
    return assetId;
  }

  beforeAll(async () => {
    pngSample = await generateValidImage('png', 'navy');
    jpegSample = await generateValidImage('jpeg', 'coral');
    cosObjects = new Map();
    chatRequests = [];
    imageUpstreamRequests = [];
    pauseSignal = { paused: false, release: null };
    heldKlingTaskIds = new Set();
    heldKlingWaiters = [];

    cosServer = await listenLoopback(async (req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (parsed.pathname === '/copy' && req.method === 'POST') {
        const payload = JSON.parse((await readBodyBuffer(req)).toString('utf8')) as {
          source: string;
          target: string;
          ifMatch: string | null;
        };
        const sourceObj = cosObjects.get(payload.source);
        if (!sourceObj) {
          res.writeHead(404).end();
          return;
        }
        if (payload.ifMatch && sourceObj.etag !== payload.ifMatch) {
          res.writeHead(412).end();
          return;
        }
        const sha256 = createHash('sha256').update(sourceObj.bytes).digest('hex');
        const etag = `"raw-${sha256.slice(0, 24)}"`;
        cosObjects.set(payload.target, {
          bytes: Buffer.from(sourceObj.bytes),
          contentType: sourceObj.contentType,
          etag,
          sha256,
        });
        res.writeHead(200, { etag }).end();
        return;
      }
      if (parsed.pathname.startsWith('/object/')) {
        const key = decodeURIComponent(parsed.pathname.slice('/object/'.length));
        if (req.method === 'PUT') {
          if (req.headers['x-cos-forbid-overwrite'] === 'true' && cosObjects.has(key)) {
            res.writeHead(409).end();
            return;
          }
          const bytes = await readBodyBuffer(req);
          const md5 = req.headers['content-md5'];
          if (md5 && md5 !== createHash('md5').update(bytes).digest('base64')) {
            res.writeHead(400).end();
            return;
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const etag = `"stg-${sha256.slice(0, 24)}"`;
          cosObjects.set(key, {
            bytes,
            contentType: req.headers['content-type'] ?? 'application/octet-stream',
            etag,
            sha256,
          });
          res.writeHead(200, { etag }).end();
          return;
        }
        const found = cosObjects.get(key);
        if (!found) {
          res.writeHead(404).end();
          return;
        }
        if (req.headers['if-match'] && req.headers['if-match'] !== found.etag) {
          res.writeHead(412).end();
          return;
        }
        if (req.method === 'DELETE') {
          cosObjects.delete(key);
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'HEAD') {
          res
            .writeHead(200, {
              'content-length': String(found.bytes.length),
              etag: found.etag,
              'x-cos-meta-sha256': found.sha256,
            })
            .end();
          return;
        }
        if (req.method === 'GET') {
          res
            .writeHead(200, {
              'content-type': found.contentType,
              'content-length': String(found.bytes.length),
              etag: found.etag,
            })
            .end(found.bytes);
          return;
        }
      }
      res.writeHead(404).end();
    });

    let asyncTaskSeq = 0;
    onelinkServer = await listenLoopback(async (req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authorization = req.headers.authorization ?? null;

      if (parsed.pathname === '/v1/models' && req.method === 'GET') {
        const baseCatalog = [
          'deepseek-v4.1-flash',
          'doubao-seedream-4.0',
          'doubao-seedream-4.5',
          'image-vidu-q2',
          'image-kling-v3',
          'image-kling-v3-omni',
          'gpt-image-2',
          'unadapted-raw-img',
          'disabled-route-img',
        ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: baseCatalog.map((id) => ({ id })) }));
        return;
      }

      if (parsed.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = JSON.parse((await readBodyBuffer(req)).toString('utf8')) as {
          messages?: Record<string, unknown>[];
          tools?: RecordedChatRequest['tools'];
        };
        const messages = body.messages ?? [];
        chatRequests.push({
          authorization,
          tools: body.tools ?? [],
          messages,
        });
        const reqSeq = `obs-${chatRequests.length}`;
        const lastUser = messages.filter((m) => m.role === 'user').at(-1);
        const prompt = extractMessageText(lastUser?.content);
        const toolOutputs = currentTurnToolOutputs(messages);

        if (prompt === 'WORKFLOW_TURN_1') {
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [{ id: 'call_list_1', name: 'list_image_models', args: {} }],
              reqSeq,
            );
            return;
          }
          if (toolOutputs.length === 1) {
            const discovered = JSON.parse(toolOutputs[0]!.text) as {
              models: { modelId: string; modelRef: string }[];
            };
            const seedRef =
              discovered.models.find((item) => item.modelId === 'doubao-seedream-4.0')?.modelRef ??
              'onelink:image:doubao-seedream-4.0';
            const klingRef =
              discovered.models.find((item) => item.modelId === 'image-kling-v3')?.modelRef ??
              'onelink:image:image-kling-v3';
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'call_sub_seed',
                  name: 'submit_image_job',
                  args: {
                    modelRef: seedRef,
                    prompt: 'sunrise mountain',
                    clientOperationKey: 'seed-sync-1',
                  },
                },
                {
                  id: 'call_sub_kling',
                  name: 'submit_image_job',
                  args: {
                    modelRef: klingRef,
                    prompt: 'misty lake',
                    aspect_ratio: '16:9',
                    clientOperationKey: 'kling-async-1',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Submitted Seedream and Kling image jobs.', reqSeq);
          return;
        }

        if (prompt.startsWith('WORKFLOW_TURN_2:')) {
          const [, seedJobId, klingJobId, maskAssetId] = prompt.split(':');
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                { id: 'call_get_seed', name: 'get_image_job', args: { jobId: seedJobId } },
                { id: 'call_get_kling', name: 'get_image_job', args: { jobId: klingJobId } },
              ],
              reqSeq,
            );
            return;
          }
          if (toolOutputs.length === 2) {
            const seedParsed = JSON.parse(toolOutputs[0]!.text) as { assetIds: string[] };
            const klingParsed = JSON.parse(toolOutputs[1]!.text) as { assetIds: string[] };
            const seedAssetId = seedParsed.assetIds[0]!;
            const klingAssetId = klingParsed.assetIds[0]!;
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'call_edit_gpt',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:gpt-image-2',
                    prompt: 'blend mountain and lake with mask',
                    imageAssetIds: [seedAssetId, klingAssetId],
                    maskAssetId,
                    size: '1024x1024',
                    clientOperationKey: 'turn2-gpt-edit',
                  },
                },
                {
                  id: 'call_ref_seed45',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.5',
                    prompt: 'stylize dual references',
                    imageAssetIds: [seedAssetId, klingAssetId],
                    clientOperationKey: 'turn2-seed45-ref',
                  },
                },
                {
                  id: 'call_ref_kling_std',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:image-kling-v3',
                    prompt: 'kling single reference',
                    imageAssetIds: [klingAssetId],
                    clientOperationKey: 'turn2-kling-std',
                  },
                },
                {
                  id: 'call_ref_kling_omni',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:image-kling-v3-omni',
                    prompt: 'kling omni reference',
                    imageAssetIds: [klingAssetId],
                    aspect_ratio: 'auto',
                    clientOperationKey: 'turn2-kling-omni',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Submitted multi-vendor reference and mask edits.', reqSeq);
          return;
        }

        if (prompt.startsWith('VIDU_REF_TURN:')) {
          const [, firstAssetId, secondAssetId] = prompt.split(':');
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'call_ref_vidu',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:image-vidu-q2',
                    prompt: 'vidu multi reference',
                    imageAssetIds: [firstAssetId, secondAssetId],
                    size: '1080p',
                    clientOperationKey: 'turn-vidu-ref',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Submitted Vidu reference job.', reqSeq);
          return;
        }

        if (prompt.startsWith('ISOLATION_AND_INJECTION_TURN:')) {
          const [, foreignJobId, foreignAssetId] = prompt.split(':');
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'neg_bad_uuid',
                  name: 'get_image_job',
                  args: { jobId: 'not-a-valid-uuid' },
                },
                {
                  id: 'neg_foreign_job',
                  name: 'get_image_job',
                  args: { jobId: foreignJobId },
                },
                {
                  id: 'neg_foreign_asset',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:gpt-image-2',
                    prompt: 'cross owner asset attempt',
                    imageAssetIds: [foreignAssetId],
                  },
                },
                {
                  id: 'neg_missing_model',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:undiscovered-model',
                    prompt: 'missing model',
                  },
                },
                {
                  id: 'neg_disabled_route',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:disabled-route-img',
                    prompt: 'disabled route',
                  },
                },
                {
                  id: 'neg_unadapted_model',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:unadapted-raw-img',
                    prompt: 'adapter pending',
                  },
                },
                {
                  id: 'neg_injected_tool',
                  name: 'counted_fixture',
                  args: { value: 42 },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'All unauthorized and injected calls were rejected.', reqSeq);
          return;
        }

        if (prompt.startsWith('IMAGE_ARGUMENT_POLICY_TURN:')) {
          const [, ownerAssetId] = prompt.split(':');
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'neg_forbidden_arg',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.0',
                    prompt: 'forbidden arg',
                    apiKey: 'sk-injected-secret-value',
                    url: 'https://evil.invalid/payload.png',
                  },
                },
                {
                  id: 'neg_outpaint',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:gpt-image-2',
                    prompt: 'outpaint is outside the tool operation schema',
                    operation: 'outpaint',
                    imageAssetIds: [ownerAssetId],
                  },
                },
                {
                  id: 'neg_geometry',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:gpt-image-2',
                    prompt: 'geometry is outside the tool argument schema',
                    operation: 'edit',
                    imageAssetIds: [ownerAssetId],
                    geometry: { left: 16, top: 0, right: 0, bottom: 0 },
                  },
                },
                {
                  id: 'neg_seed45_output_format',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.5',
                    prompt: 'unsupported output format',
                    output_format: 'png',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'The image tool rejected the supplied arguments.', reqSeq);
          return;
        }

        if (prompt === 'SAME_TURN_POLL_GUARD_TURN') {
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'poll_guard_submit_1',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:image-kling-v3',
                    prompt: 'pending-kling-poll-guard',
                    clientOperationKey: 'poll-guard-1',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          if (toolOutputs.length === 1) {
            const submitted = JSON.parse(toolOutputs[0]!.text) as { jobId: string };
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'poll_guard_immediate_get',
                  name: 'get_image_job',
                  args: { jobId: submitted.jobId },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Submitted image job and deferred same-turn polling.', reqSeq);
          return;
        }

        if (prompt.startsWith('CROSS_TURN_REPEAT_POLL_TURN:')) {
          const [, pendingJobId] = prompt.split(':');
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [{ id: 'cross_get_1', name: 'get_image_job', args: { jobId: pendingJobId } }],
              reqSeq,
            );
            return;
          }
          if (toolOutputs.length === 1) {
            streamOpenAiToolCalls(
              res,
              [{ id: 'cross_get_2', name: 'get_image_job', args: { jobId: pendingJobId } }],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(
            res,
            'Job is still in progress; stopped repeated polling for this turn.',
            reqSeq,
          );
          return;
        }

        if (prompt.startsWith('PARALLEL_POLL_GUARD_TURN:')) {
          const [, pendingJobId] = prompt.split(':');
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                { id: 'par_get_1', name: 'get_image_job', args: { jobId: pendingJobId } },
                { id: 'par_get_2', name: 'get_image_job', args: { jobId: pendingJobId } },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Parallel duplicate poll blocked.', reqSeq);
          return;
        }

        if (prompt === 'IDEMPOTENT_RETRY_TURN') {
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'idem_1',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.0',
                    prompt: 'idempotent castle',
                    clientOperationKey: 'idem-op-01',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          if (toolOutputs.length === 1) {
            await setProviderEnabled(false);
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'idem_2',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.0',
                    prompt: 'idempotent castle',
                    clientOperationKey: 'idem-op-01',
                  },
                },
                {
                  id: 'idem_conflict',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.0',
                    prompt: 'mutated castle prompt',
                    clientOperationKey: 'idem-op-01',
                  },
                },
                {
                  id: 'idem_fresh',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.0',
                    prompt: 'new castle prompt',
                    clientOperationKey: 'new-op-01',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Idempotent retry verified.', reqSeq);
          return;
        }

        if (prompt === 'SUBMIT_BUDGET_TURN') {
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [1, 2, 3, 4, 5].map((index) => ({
                id: `sub_budget_${index}`,
                name: 'submit_image_job',
                args: {
                  modelRef: 'onelink:image:doubao-seedream-4.0',
                  prompt: `budget scene ${index}`,
                  clientOperationKey: `budget-key-${index}`,
                },
              })),
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Submit budget enforced at 4.', reqSeq);
          return;
        }

        if (prompt === 'CALL_BUDGET_TURN') {
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              Array.from({ length: 13 }, (_, idx) => ({
                id: `call_budget_${idx + 1}`,
                name: 'list_image_models',
                args: {},
              })),
              reqSeq,
            );
            return;
          }
          streamOpenAiText(res, 'Call budget enforced at 12.', reqSeq);
          return;
        }

        if (prompt === 'STEP_BUDGET_TURN') {
          streamOpenAiToolCalls(
            res,
            [
              {
                id: `step_loop_${toolOutputs.length + 1}`,
                name: 'list_image_models',
                args: {},
              },
            ],
            reqSeq,
          );
          return;
        }

        if (prompt === 'PAUSE_AFTER_TOOL_TURN') {
          if (toolOutputs.length === 0) {
            streamOpenAiToolCalls(
              res,
              [
                {
                  id: 'pause_sub_1',
                  name: 'submit_image_job',
                  args: {
                    modelRef: 'onelink:image:doubao-seedream-4.0',
                    prompt: 'before cancel',
                    clientOperationKey: 'cancel-turn-op',
                  },
                },
              ],
              reqSeq,
            );
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-request-id': reqSeq,
          });
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl_${reqSeq}`,
              object: 'chat.completion.chunk',
              model: 'deepseek-v4.1-flash',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'holding...' },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          pauseSignal.paused = true;
          await new Promise<void>((resolveHold) => {
            pauseSignal.release = resolveHold;
            req.on('close', () => resolveHold());
          });
          pauseSignal.paused = false;
          if (!res.writableEnded) res.end();
          return;
        }

        streamOpenAiText(res, 'plain conversation reply', reqSeq);
        return;
      }

      // Image upstream endpoints invoked by A's generation executor
      const contentType = req.headers['content-type'] ?? null;
      if (req.method === 'POST') {
        const raw = await readBodyBuffer(req);
        if (contentType?.startsWith('multipart/form-data')) {
          const form = await new Response(new Uint8Array(raw), {
            headers: { 'content-type': contentType },
          }).formData();
          const fields: Record<string, string> = {};
          const images: NonNullable<RecordedImageUpstream['multipart']>['images'] = [];
          let hasMask = false;
          let maskType: string | null = null;
          for (const [key, value] of form.entries()) {
            if (typeof value === 'string') {
              fields[key] = value;
            } else if (key === 'image' || key === 'image[]') {
              images.push({
                field: key,
                type: value.type,
                sha256: createHash('sha256')
                  .update(Buffer.from(await value.arrayBuffer()))
                  .digest('hex'),
              });
            } else if (key === 'mask') {
              hasMask = true;
              maskType = value.type;
            }
          }
          imageUpstreamRequests.push({
            method: 'POST',
            path: parsed.pathname,
            authorization,
            contentType,
            multipart: {
              fields,
              images,
              hasMask,
              maskType,
            },
          });
        } else {
          imageUpstreamRequests.push({
            method: 'POST',
            path: parsed.pathname,
            authorization,
            contentType,
            json: JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>,
          });
        }

        if (parsed.pathname === '/volc/api/v3/images/generations') {
          const last = imageUpstreamRequests.at(-1)?.json;
          const wantedFormat = last?.output_format === 'png' ? pngSample : jpegSample;
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': `volc_${++asyncTaskSeq}`,
          });
          res.end(
            JSON.stringify({
              data: [{ b64_json: wantedFormat.toString('base64') }],
              usage: { generated_images: 1 },
            }),
          );
          return;
        }

        if (
          parsed.pathname === '/kling/v1/images/generations' ||
          parsed.pathname === '/kling/v1/images/omni-image'
        ) {
          const taskId = `kling_task_${++asyncTaskSeq}`;
          const lastReq = imageUpstreamRequests.at(-1)?.json;
          if (lastReq?.prompt === 'pending-kling-poll-guard') {
            heldKlingTaskIds.add(taskId);
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 0,
              request_id: `req_${taskId}`,
              data: { task_id: taskId, task_status: 'submitted' },
            }),
          );
          return;
        }

        if (parsed.pathname === '/vidu/ent/v2/reference2image') {
          const taskId = `vidu_task_${++asyncTaskSeq}`;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ task_id: taskId, state: 'created' }));
          return;
        }

        if (
          parsed.pathname === '/v1/images/edits' ||
          parsed.pathname === '/v1/images/generations'
        ) {
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': `oai_${++asyncTaskSeq}`,
          });
          res.end(
            JSON.stringify({
              data: [{ b64_json: pngSample.toString('base64') }],
              usage: { input_tokens: 20 },
            }),
          );
          return;
        }
      }

      if (req.method === 'GET') {
        imageUpstreamRequests.push({
          method: 'GET',
          path: parsed.pathname,
          authorization,
          contentType,
        });
        if (
          parsed.pathname.startsWith('/kling/v1/images/generations/') ||
          parsed.pathname.startsWith('/kling/v1/images/omni-image/')
        ) {
          const taskId = parsed.pathname.split('/').at(-1)!;
          if (heldKlingTaskIds.has(taskId)) {
            await new Promise<void>((resolveHold) => {
              heldKlingWaiters.push(resolveHold);
              req.on('close', releaseHoldOnce);
              function releaseHoldOnce() {
                resolveHold();
              }
            });
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 0,
              data: {
                task_id: taskId,
                task_status: 'succeed',
                task_result: {
                  images: [{ index: 0, url: 'https://cdn.onelink-fixture.invalid/kling.png' }],
                },
              },
            }),
          );
          return;
        }
        if (
          parsed.pathname.startsWith('/vidu/ent/v2/tasks/') &&
          parsed.pathname.endsWith('/creations')
        ) {
          const parts = parsed.pathname.split('/');
          const taskId = parts[parts.length - 2]!;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: taskId,
              state: 'success',
              creations: [{ id: 'c1', url: 'https://cdn.onelink-fixture.invalid/vidu.png' }],
            }),
          );
          return;
        }
      }

      res.writeHead(404).end();
    });

    database = await authDatabase();
    observer = new Pool({ connectionString: database.observerURL });
    const masterKey = randomBytes(32).toString('base64');
    const masterKeyId = 'conv-img-master-1';
    const migrateEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_ASSETS_DATABASE_URL: database.url,
      MIO_COS_BUCKET: 'mio-test-1234567890',
      MIO_COS_REGION: 'ap-shanghai',
      MIO_COS_SECRET_ID: 'synthetic-cos-id',
      MIO_COS_SECRET_KEY: 'synthetic-cos-secret',
      MIO_PROVIDERS_DATABASE_URL: database.url,
      MIO_PROVIDERS_MASTER_KEY: masterKey,
      MIO_PROVIDERS_MASTER_KEY_ID: masterKeyId,
      MIO_CONVERSATIONS_DATABASE_URL: database.url,
    };

    for (const domain of ['auth', 'assets', 'providers', 'conversations', 'generations']) {
      const args = [`scripts/service/migrate-${domain}.ts`, '--apply'];
      const result = spawnSync(process.execPath, args, {
        env: migrateEnv,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, `${domain}: ${result.stdout}${result.stderr}`).toBe(0);
    }

    const disabledRoute = {
      ...findFixtureRoute('doubao-seedream-4.0', 'image.generate'),
      rawModelId: 'disabled-route-img',
      enabled: false,
    };
    const imageRoutes = ONELINK_FIXTURE_ROUTES.map((route) =>
      route.rawModelId === 'gpt-image-2'
        ? {
            ...route,
            paramSpec: {
              ...route.paramSpec,
              supportedOperations: ['edit', 'outpaint', 'generate'] as const,
              allowOutpaintGeometry: true,
            },
            source: 'Synthetic outpaint capability for isolated Profile regression',
          }
        : route,
    );
    await importRoutesViaCli(migrateEnv, [...imageRoutes, disabledRoute]);

    // Build and pack official Profile with temporary child-Profile overlay
    const profileDir = await mkdtemp(join(tmpdir(), 'mio-conv-img-profile-'));
    const packedDir = await unpackPluginPackage(profileDir);
    const dshHome = join(profileDir, 'home');
    await prepareProfile(dshHome, packedDir);

    const overlayDir = join(profileDir, 'overlay');
    await mkdir(overlayDir);
    await cp(
      resolve('tests/conversations/conversation-image-overlay.ts'),
      join(overlayDir, 'base.ts'),
    );
    await writeFile(
      join(overlayDir, 'index.ts'),
      `
import type { Context } from '@deepseek-ai/cordis';
import COS from 'cos-nodejs-sdk-v5';
import { PassThrough } from 'node:stream';
import { Agent, MockAgent } from 'undici';
import { apply as baseApply } from './base.ts';

export function apply(ctx: Context) {
  baseApply(ctx);
  const realFetch = globalThis.fetch;
  const cosOrigin = process.env.MIO_TEST_COS_ORIGIN!;
  const originalPut = COS.prototype.putObject;
  const originalGet = COS.prototype.getObject;
  const originalDispatch = Agent.prototype.dispatch;
  const fixtureAgent = new Agent();
  fixtureAgent.dispatch = originalDispatch.bind(fixtureAgent);
  const cdn = new MockAgent({ agent: fixtureAgent });
  cdn.disableNetConnect();
  cdn.get('https://cdn.onelink-fixture.invalid')
    .intercept({ method: 'GET', path: /.*/ })
    .reply(200, Buffer.from(process.env.MIO_TEST_RESULT_BASE64!, 'base64'), {
      headers: { 'content-type': 'image/png' },
    }).persist();

  ctx.effect(() => {
    Agent.prototype.dispatch = function (options, handler) {
      if (String(options.origin) === 'https://cdn.onelink-fixture.invalid') {
        return cdn.dispatch(options, handler);
      }
      throw new Error('UNEXPECTED_IMAGE_DOWNLOAD');
    };
    COS.prototype.putObject = (async function (params) {
      const chunks: Buffer[] = [];
      const body = Buffer.isBuffer(params.Body) ? [params.Body] : params.Body;
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const response = await realFetch(cosOrigin + '/object/' + encodeURIComponent(params.Key), {
        method: 'PUT',
        headers: {
          'content-type': params.ContentType,
          'content-md5': params.Headers?.['Content-MD5'] ?? '',
          'x-cos-forbid-overwrite': params.Headers?.['x-cos-forbid-overwrite'] ?? '',
        },
        body: Buffer.concat(chunks),
      });
      if (!response.ok) throw Object.assign(new Error('COS_PUT_FAILED'), { statusCode: response.status });
      return { statusCode: 200, ETag: response.headers.get('etag'), headers: {} };
    }) as typeof COS.prototype.putObject;
    COS.prototype.getObject = (function (params, callback) {
      const sender = new PassThrough();
      sender.on('error', () => {});
      sender.pipe(params.Output);
      void realFetch(cosOrigin + '/object/' + encodeURIComponent(params.Key), {
        headers: { 'if-match': params.IfMatch ?? '' },
      }).then(async response => {
        sender.emit('response', { statusCode: response.status });
        if (!response.ok || !response.body) {
          callback({ statusCode: response.status }, undefined);
          sender.end();
          return;
        }
        for await (const chunk of response.body) sender.write(Buffer.from(chunk));
        sender.end();
        callback(null, { statusCode: 200, headers: {} });
      }).catch(error => {
        sender.destroy(error);
        callback(error, undefined);
      });
    }) as typeof COS.prototype.getObject;
    return async () => {
      COS.prototype.putObject = originalPut;
      COS.prototype.getObject = originalGet;
      Agent.prototype.dispatch = originalDispatch;
      await cdn.close();
    };
  });
}
`,
    );
    await writeFile(
      join(overlayDir, 'package.json'),
      JSON.stringify({ name: '@mio/test-provider', type: 'module', exports: './index.ts' }),
    );
    await symlink(resolve('node_modules'), join(overlayDir, 'node_modules'), 'dir');
    await symlink(overlayDir, join(dshHome, 'profiles/mio/node_modules/@mio/test-provider'), 'dir');
    await writeFile(
      join(dshHome, 'profiles/mio/cordis.patch.yml'),
      JSON.stringify([{ insert: [{ id: 'test-provider', name: '@mio/test-provider' }] }]),
    );

    const portProbe = await listenLoopback((_req, res) => {
      res.end();
    });
    const appPort = new URL(portProbe.origin).port;
    await portProbe.close();
    const appOrigin = `http://127.0.0.1:${appPort}`;
    const apiToken = randomBytes(40).toString('hex');
    const runCwd = join(profileDir, 'run');
    await mkdir(runCwd);

    let child: ChildProcess | undefined;
    let childLogs = '';
    const stopChild = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const graceful = await Promise.race([
        exited.then(() => true),
        delay(6000, false, { ref: false }),
      ]);
      if (!graceful) {
        child.kill('SIGKILL');
        await exited;
      }
      assert(graceful, `Packed Profile failed graceful stop: ${childLogs}`);
    };

    profileControl = {
      origin: appOrigin,
      apiToken,
      async start(backend) {
        assert(!child || child.exitCode !== null || child.signalCode !== null);
        childLogs = '';
        child = spawn(process.execPath, [launcher(), '--profile', 'mio'], {
          cwd: runCwd,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: profileDir,
            DSH_HOME: dshHome,
            DSH_AGENTS_HOME: join(profileDir, 'agents'),
            DSH_TELEMETRY_DISABLED: '1',
            MIO_API_TOKEN: apiToken,
            MIO_HOST: '127.0.0.1',
            MIO_PORT: appPort,
            MIO_AUTH_BASE_URL: appOrigin,
            MIO_AUTH_SECRET: apiToken,
            MIO_AUTH_DATABASE_URL: database.url,
            MIO_AUTH_RATE_LIMIT_BACKEND: backend,
            MIO_ASSETS_DATABASE_URL: database.url,
            MIO_COS_BUCKET: 'mio-test-1234567890',
            MIO_COS_REGION: 'ap-shanghai',
            MIO_COS_SECRET_ID: 'synthetic-cos-id',
            MIO_COS_SECRET_KEY: 'synthetic-cos-secret',
            MIO_GENERATIONS_ENABLED: 'true',
            MIO_GENERATIONS_DATA_DIR: join(profileDir, 'generations'),
            MIO_TEST_RESULT_BASE64: pngSample.toString('base64'),
            MIO_PROVIDERS_DATABASE_URL: database.url,
            MIO_PROVIDERS_MASTER_KEY: masterKey,
            MIO_PROVIDERS_MASTER_KEY_ID: masterKeyId,
            MIO_CONVERSATIONS_DATABASE_URL: database.url,
            MIO_TEST_ONELINK_ORIGIN: onelinkServer.origin,
            MIO_TEST_COS_ORIGIN: cosServer.origin,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout!.on('data', (chunk: Buffer) => {
          childLogs = (childLogs + chunk.toString('utf8')).slice(-16_000);
        });
        child.stderr!.on('data', (chunk: Buffer) => {
          childLogs = (childLogs + chunk.toString('utf8')).slice(-16_000);
        });
        for (let attempt = 0; attempt < 120; attempt += 1) {
          assert(
            child.exitCode === null && child.signalCode === null,
            `Packed Profile exited early: ${childLogs}`,
          );
          try {
            const ready = await fetch(`${appOrigin}/readyz`, {
              signal: AbortSignal.timeout(250),
            });
            if (ready.status === 200) return;
          } catch {
            /* waiting for listener */
          }
          await delay(100);
        }
        throw new Error(`Packed Profile not ready: ${childLogs}`);
      },
      stop: stopChild,
      async close() {
        try {
          await stopChild();
        } finally {
          await rm(profileDir, { recursive: true, force: true });
        }
      },
    };

    await profileControl.start('database');
    const {
      rows: [schema],
    } = await observer.query(`
      SELECT to_regclass('mio_image_jobs') IS NOT NULL AS image_jobs,
             to_regclass('mio_compute_jobs') IS NULL AND
             to_regclass('mio_compute_outbox') IS NULL AND
             to_regclass('mio_compute_inbox') IS NULL AS no_video_tables
    `);
    expect(schema).toEqual({ image_jobs: true, no_video_tables: true });

    for (const [idx, label] of ['owner-zero', 'owner-one'].entries()) {
      const signup = await call(
        '/api/auth/sign-up/email',
        'POST',
        {
          name: label,
          email: `${label}@conv-img.test`,
          password: 'conv-img-strong-password-9821',
        },
        idx,
      );
      expect(signup.status).toBe(200);
      cookies.push(
        signup.headers
          .getSetCookie()
          .map((item) => item.split(';')[0])
          .join('; '),
      );
      owners.push(((await signup.json()) as { user: { id: string } }).user.id);

      expect(
        (
          await call(
            '/api/v1/providers/onelink/credential',
            'PUT',
            { apiKey: `synthetic-conv-img-${idx}`, expectedRevision: 0 },
            idx,
          )
        ).status,
      ).toBe(200);
      const testConn = await call('/api/v1/providers/onelink/test', 'POST', {}, idx);
      expect(testConn.status).toBe(200);
      const testConnBody = (await testConn.json()) as Record<string, unknown>;
      expect(testConnBody, JSON.stringify(testConnBody)).toMatchObject({ status: 'connected' });
      expect(
        (
          await call(
            '/api/v1/providers/onelink/models',
            'PATCH',
            {
              modelRef: chatModelRef,
              isDefault: true,
              expectedRevision: await providerRevision(idx),
            },
            idx,
          )
        ).status,
      ).toBe(200);
    }
  }, 90_000);

  afterAll(async () => {
    heldKlingTaskIds?.clear();
    while (heldKlingWaiters?.length) {
      heldKlingWaiters.shift()?.();
    }
    try {
      await profileControl?.close();
    } finally {
      await onelinkServer?.close().catch(() => {});
      await cosServer?.close().catch(() => {});
      await observer?.end().catch(() => {});
      await database?.close().catch(() => {});
    }
  }, 45_000);

  it('keeps foundation capabilities empty, denies root tool execution, and preserves chat-only model preferences', async () => {
    const capRes = await fetch(`${profileControl.origin}/api/v1/capabilities`, {
      headers: { authorization: `Bearer ${profileControl.apiToken}` },
    });
    expect(capRes.status).toBe(200);
    expect(await capRes.json()).toEqual({
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: true,
    });

    const inspectTools = await (await fetch(`${profileControl.origin}/__test/tools`)).json();
    expect(inspectTools).toEqual({
      countedFixtureExecutions: 0,
      rootToolNames: ['counted_fixture'],
      negativeToolErrors: [],
    });

    for (const name of ['counted_fixture', 'list_image_models', 'submit_image_job']) {
      const rootExec = await (
        await fetch(`${profileControl.origin}/__test/root-execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, args: {} }),
        })
      ).json();
      expect(rootExec.isError).toBe(true);
      expect(rootExec.output).toContain('MIO_TOOL_DENIED');
      expect(rootExec.countedFixtureExecutions).toBe(0);
    }

    // Chat-only preference invariant (MODEL_USAGE_UNSUPPORTED) remains untouched
    const prefRes = await call('/api/v1/providers/onelink/models', 'PATCH', {
      modelRef: 'onelink:image:doubao-seedream-4.0',
      isDefault: true,
      expectedRevision: await providerRevision(0),
    });
    expect(prefRes.status).toBe(409);
    expect(await prefRes.json()).toMatchObject({ error: { code: 'MODEL_USAGE_UNSUPPORTED' } });
  });

  it('drives multi-turn cross-vendor image generation, async auto-fill, derived asset editing, and verification persistence', async () => {
    const workflowConversationId = await createConversation(0);
    const chatCountBeforeTurn1 = chatRequests.length;

    const sseTurn1Res = await fetch(
      `${profileControl.origin}/api/v1/conversations/${workflowConversationId}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[0]! } },
    );
    const sseTurn1Promise = collectSseFrames(sseTurn1Res, 'turn-1');

    const sendTurn1 = await call(
      `/api/v1/conversations/${workflowConversationId}/messages`,
      'POST',
      { requestId: 'turn-1', text: 'WORKFLOW_TURN_1' },
      0,
    );
    expect(sendTurn1.status).toBe(202);

    const [turn1Frames, turn1Receipt] = await Promise.all([
      sseTurn1Promise,
      waitReceiptStatus(workflowConversationId, 'turn-1', 0),
    ]);
    expect(turn1Receipt.status).toBe('completed');

    // Verify 3 LLM steps in Turn 1: list_image_models -> 2x submit_image_job -> final text
    const turn1Chats = chatRequests.slice(chatCountBeforeTurn1);
    expect(turn1Chats).toHaveLength(3);
    const exposedToolNames = turn1Chats[0]!.tools.map((tool) => tool.function?.name).sort();
    expect(exposedToolNames).toEqual([
      'counted_fixture',
      'get_image_job',
      'list_image_models',
      'submit_image_job',
    ]);
    // Verify submit_image_job schema enforces additionalProperties: false
    const submitSchema = turn1Chats[0]!.tools.find(
      (tool) => tool.function?.name === 'submit_image_job',
    )?.function?.parameters;
    expect(submitSchema).toMatchObject({
      additionalProperties: false,
      properties: { operation: { enum: ['generate', 'edit'] } },
    });
    expect(submitSchema?.properties).not.toHaveProperty('geometry');

    // Inspect list_image_models output seen by the model on step 2
    const listOutput = JSON.parse(currentTurnToolOutputs(turn1Chats[1]!.messages)[0]!.text) as {
      models: Record<string, unknown>[];
    };
    const listedIds = listOutput.models.map((item) => item.modelId).sort();
    expect(listedIds).toEqual([
      'doubao-seedream-4.0',
      'doubao-seedream-4.5',
      'gpt-image-2',
      'image-kling-v3',
      'image-kling-v3-omni',
      'image-vidu-q2',
    ]);
    expect(
      listOutput.models.every(
        (item) => typeof item.modelRef === 'string' && item.modelRef.startsWith('onelink:model:'),
      ),
    ).toBe(true);
    const klingSummary = listOutput.models.find((item) => item.modelId === 'image-kling-v3')!;
    expect(Object.keys(klingSummary).sort()).toEqual(
      [
        'modelRef',
        'modelId',
        'name',
        'vendor',
        'driver',
        'supportedOperations',
        'requiresAsync',
        'maxN',
        'allowExplicitN',
        'allowedSizes',
        'defaultSize',
        'allowCustomDimensions',
        'allowedAspectRatios',
        'maxReferenceImages',
        'allowGenerateReferences',
        'allowMaskPng',
        'allowedQualities',
        'allowedBackgrounds',
        'allowedOutputFormats',
      ].sort(),
    );
    expect(klingSummary.requiresAsync).toBe(true);
    const seed45Summary = listOutput.models.find((item) => item.modelId === 'doubao-seedream-4.5')!;
    expect(seed45Summary.allowedOutputFormats).toEqual([]);
    const gptSummary = listOutput.models.find((item) => item.modelId === 'gpt-image-2');
    expect(gptSummary?.supportedOperations).toEqual(['edit', 'generate']);

    // Live SSE whitelist: only submit_image_job cards projected, zero list_image_models or raw tool/call
    const turn1ToolFrames = turn1Frames.filter((frame) => frame.event === 'tool');
    expect(turn1ToolFrames).toHaveLength(2);
    expect(turn1ToolFrames.map((frame) => frame.data.tool)).toEqual([
      'submit_image_job',
      'submit_image_job',
    ]);
    const turn1SeedJobId = String((turn1ToolFrames[0]!.data.job as { jobId: string }).jobId);
    const turn1KlingJobId = String((turn1ToolFrames[1]!.data.job as { jobId: string }).jobId);

    // Wait for A to finish both jobs (sync Seedream + omitted-async Kling)
    const [seedCompleted, klingCompleted] = await Promise.all([
      waitImageJobCompleted(turn1SeedJobId, 0),
      waitImageJobCompleted(turn1KlingJobId, 0),
    ]);
    const turn1SeedAssetId = seedCompleted.assetIds[0]!;
    const turn1KlingAssetId = klingCompleted.assetIds[0]!;
    expect(turn1SeedAssetId).toBeTruthy();
    expect(turn1KlingAssetId).toBeTruthy();

    // Upload owner PNG mask and execute Turn 2: get_image_job -> 4x multi-vendor reference/mask edits
    const maskAssetId = await uploadOwnerPngMask(0);
    const upstreamBeforeTurn2 = imageUpstreamRequests.length;

    const sseTurn2Res = await fetch(
      `${profileControl.origin}/api/v1/conversations/${workflowConversationId}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[0]! } },
    );
    const sseTurn2Promise = collectSseFrames(sseTurn2Res, 'turn-2');

    const sendTurn2 = await call(
      `/api/v1/conversations/${workflowConversationId}/messages`,
      'POST',
      {
        requestId: 'turn-2',
        text: `WORKFLOW_TURN_2:${turn1SeedJobId}:${turn1KlingJobId}:${maskAssetId}`,
      },
      0,
    );
    expect(sendTurn2.status).toBe(202);

    const [turn2Frames, turn2Receipt] = await Promise.all([
      sseTurn2Promise,
      waitReceiptStatus(workflowConversationId, 'turn-2', 0),
    ]);
    expect(turn2Receipt.status).toBe('completed');

    const turn2ToolFrames = turn2Frames.filter((frame) => frame.event === 'tool');
    expect(turn2ToolFrames).toHaveLength(6);
    expect(turn2ToolFrames.slice(0, 2).map((f) => f.data.tool)).toEqual([
      'get_image_job',
      'get_image_job',
    ]);
    expect(turn2ToolFrames.slice(2).map((f) => f.data.tool)).toEqual([
      'submit_image_job',
      'submit_image_job',
      'submit_image_job',
      'submit_image_job',
    ]);

    const turn2SubmitJobIds = turn2ToolFrames
      .slice(2)
      .map((f) => (f.data.job as { jobId: string }).jobId);
    const settledTurn2Jobs = await Promise.all(
      turn2SubmitJobIds.map((jobId) => waitImageJobCompleted(jobId, 0)),
    );
    expect(
      settledTurn2Jobs.every((job) => job.status === 'completed' && job.assetIds.length === 1),
    ).toBe(true);

    // Also verify Vidu multi-reference generation in Turn 3
    const sendTurn3 = await call(
      `/api/v1/conversations/${workflowConversationId}/messages`,
      'POST',
      {
        requestId: 'turn-3-vidu',
        text: `VIDU_REF_TURN:${turn1SeedAssetId}:${turn1KlingAssetId}`,
      },
      0,
    );
    expect(sendTurn3.status).toBe(202);
    expect((await waitReceiptStatus(workflowConversationId, 'turn-3-vidu', 0)).status).toBe(
      'completed',
    );

    const historyRes = await call(
      `/api/v1/conversations/${workflowConversationId}/history`,
      'GET',
      undefined,
      0,
    );
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as {
      items: { seq: number; role: string; tool?: string; job?: { jobId: string } }[];
    };
    const viduJobId = historyBody.items.filter((item) => item.role === 'tool').at(-1)!.job!.jobId;
    await waitImageJobCompleted(viduJobId, 0);

    // Verify the A executor encoded ordered references with the vendor's field names.
    const recentUpstream = imageUpstreamRequests.slice(upstreamBeforeTurn2);
    const gptEditReq = recentUpstream.find((r) => r.path === '/v1/images/edits');
    expect(gptEditReq?.multipart).toMatchObject({
      fields: {
        model: 'gpt-image-2',
        prompt: 'blend mountain and lake with mask',
        size: '1024x1024',
      },
      images: [
        {
          field: 'image[]',
          type: 'image/jpeg',
          sha256: createHash('sha256').update(jpegSample).digest('hex'),
        },
        {
          field: 'image[]',
          type: 'image/png',
          sha256: createHash('sha256').update(pngSample).digest('hex'),
        },
      ],
      hasMask: true,
      maskType: 'image/png',
    });

    const seed45Req = recentUpstream.find(
      (r) =>
        r.path === '/volc/api/v3/images/generations' && r.json?.model === 'doubao-seedream-4.5',
    );
    expect(seed45Req?.json?.output_format).toBeUndefined();
    expect(Array.isArray(seed45Req?.json?.image)).toBe(true);
    expect((seed45Req?.json?.image as string[])[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect((seed45Req?.json?.image as string[])[1]).toMatch(/^data:image\/png;base64,/);

    const klingStdReq = recentUpstream.find(
      (r) =>
        r.path === '/kling/v1/images/generations' &&
        r.method === 'POST' &&
        typeof r.json?.image === 'string',
    );
    expect(klingStdReq?.json?.model_name).toBe('image-kling-v3');
    expect(klingStdReq?.json?.image_list).toBeUndefined();

    const klingOmniReq = recentUpstream.find(
      (r) => r.path === '/kling/v1/images/omni-image' && r.method === 'POST',
    );
    expect(klingOmniReq?.json?.model_name).toBe('image-kling-v3-omni');
    expect(Array.isArray(klingOmniReq?.json?.image_list)).toBe(true);
    expect(klingOmniReq?.json?.image_list as { image: string }[]).toHaveLength(1);

    const viduReq = recentUpstream.find(
      (r) => r.path === '/vidu/ent/v2/reference2image' && r.method === 'POST',
    );
    expect(viduReq?.json?.model).toBe('image-vidu-q2');
    expect(Array.isArray(viduReq?.json?.images)).toBe(true);
    expect(viduReq?.json?.images as string[]).toHaveLength(2);

    // Verify multi-step model_observations and chat + image model verifications in PostgreSQL
    const obsRow = (
      await observer.query<{ model_observations: unknown[] }>(
        'SELECT model_observations FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
        [workflowConversationId, 'turn-2'],
      )
    ).rows[0]!;
    expect(Array.isArray(obsRow.model_observations)).toBe(true);
    expect(obsRow.model_observations).toHaveLength(3);

    const verifications = (
      await observer.query<{
        raw_model_id: string;
        operation: string;
        verification_status: string;
      }>(
        `SELECT m.raw_model_id, v.operation, v.verification_status
         FROM mio_provider_model_verifications v
         JOIN mio_provider_configs c ON c.id = v.provider_id
         JOIN mio_provider_models m ON m.provider_id = v.provider_id AND m.model_key = v.model_key
         WHERE c.owner_id = $1`,
        [owners[0]!],
      )
    ).rows;
    expect(verifications).toEqual(
      expect.arrayContaining([
        {
          raw_model_id: 'deepseek-v4.1-flash',
          operation: 'chat',
          verification_status: 'verified',
        },
        {
          raw_model_id: 'doubao-seedream-4.0',
          operation: 'image.generate',
          verification_status: 'verified',
        },
        {
          raw_model_id: 'image-kling-v3',
          operation: 'image.generate',
          verification_status: 'verified',
        },
        {
          raw_model_id: 'gpt-image-2',
          operation: 'image.generate',
          verification_status: 'verified',
        },
      ]),
    );

    // Derived edited asset is downloadable by Owner 0 and 404 for Owner 1
    const editedAssetId = settledTurn2Jobs[0]!.assetIds[0]!;
    const ownerAssetRes = await call(`/api/v1/assets/${editedAssetId}`, 'GET', undefined, 0);
    expect(ownerAssetRes.status).toBe(200);
    const ownerAssetBody = (await ownerAssetRes.json()) as { downloadUrl: string };
    expect((await fetch(ownerAssetBody.downloadUrl)).status).toBe(200);
    expect((await call(`/api/v1/assets/${editedAssetId}`, 'GET', undefined, 1)).status).toBe(404);
  }, 45_000);

  it('enforces cross-owner isolation, invalid UUID rejection, forbidden arg sanitization, and prompt-injection denial', async () => {
    const ownerAssetId = await uploadOwnerPngMask(0);
    const geometry = { left: 16, top: 0, right: 0, bottom: 0 };
    const upstreamBeforeOutpaint = imageUpstreamRequests.length;
    const ownerAdmission = await call('/api/v1/compute/images', 'POST', {
      requestId: randomUUID(),
      modelRef: 'onelink:image:gpt-image-2',
      parameters: {
        prompt: 'expand the owner fixture',
        operation: 'outpaint',
        imageAssetId: ownerAssetId,
        geometry,
      },
    });
    expect(ownerAdmission.status, await ownerAdmission.clone().text()).toBe(202);
    const { jobId } = (await ownerAdmission.json()) as { jobId: string };
    const foreignJob = await waitImageJobCompleted(jobId, 0);
    expect(foreignJob.assetIds).toHaveLength(1);
    const foreignAssetId = foreignJob.assetIds[0]!;
    const outpaintRequests = imageUpstreamRequests.slice(upstreamBeforeOutpaint);
    expect(outpaintRequests).toHaveLength(1);
    expect(outpaintRequests[0]).toMatchObject({
      path: '/v1/images/edits',
      multipart: { images: [{ field: 'image' }] },
    });
    expect(JSON.parse(outpaintRequests[0]!.multipart!.fields.geometry!)).toEqual(geometry);

    const owner1Conv = await createConversation(1);
    const jobsBefore = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    const chatBefore = chatRequests.length;
    const upstreamBeforeNeg = imageUpstreamRequests.length;

    const sseRes = await fetch(
      `${profileControl.origin}/api/v1/conversations/${owner1Conv}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[1]! } },
    );
    const ssePromise = collectSseFrames(sseRes, 'neg-1');

    const sendNeg = await call(
      `/api/v1/conversations/${owner1Conv}/messages`,
      'POST',
      {
        requestId: 'neg-1',
        text: `ISOLATION_AND_INJECTION_TURN:${foreignJob.jobId}:${foreignAssetId}`,
      },
      1,
    );
    expect(sendNeg.status).toBe(202);

    const [frames, receipt] = await Promise.all([
      ssePromise,
      waitReceiptStatus(owner1Conv, 'neg-1', 1),
    ]);
    expect(receipt.status).toBe('completed');

    // Zero jobs created by any negative/cross-owner/injected call
    const jobsAfter = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    expect(jobsAfter).toBe(jobsBefore);

    // Verify tool errors seen by LLM on step 2 are sanitized and counted_fixture never ran
    const step2Messages = chatRequests[chatBefore + 1]!.messages;
    const negOutputs = currentTurnToolOutputs(step2Messages);
    expect(negOutputs.map((output) => output.toolCallId).sort()).toEqual([
      'neg_bad_uuid',
      'neg_disabled_route',
      'neg_foreign_asset',
      'neg_foreign_job',
      'neg_injected_tool',
      'neg_missing_model',
      'neg_unadapted_model',
    ]);
    expect(negOutputs.find((o) => o.toolCallId === 'neg_bad_uuid')?.text).toContain(
      'IMAGE_JOB_ID_INVALID',
    );
    expect(negOutputs.find((o) => o.toolCallId === 'neg_foreign_job')?.text).toContain(
      'JOB_NOT_FOUND',
    );
    expect(negOutputs.find((o) => o.toolCallId === 'neg_foreign_asset')?.text).toContain(
      'ASSET_NOT_FOUND',
    );
    expect(negOutputs.find((o) => o.toolCallId === 'neg_injected_tool')?.text).toContain(
      'MIO_TOOL_DENIED',
    );

    const inspectTools = await (await fetch(`${profileControl.origin}/__test/tools`)).json();
    expect(inspectTools.countedFixtureExecutions).toBe(0);

    // Denied/failed tools never leak into SSE event: tool or conversation history
    expect(frames.filter((frame) => frame.event === 'tool')).toHaveLength(0);
    const history = (await (
      await call(`/api/v1/conversations/${owner1Conv}/history`, 'GET', undefined, 1)
    ).json()) as { items: { role: string }[] };
    expect(history.items.map((item) => item.role)).toEqual(['user', 'assistant', 'status']);

    const argumentConv = await createConversation(0);
    const chatBeforeArguments = chatRequests.length;
    const argumentSse = await fetch(
      `${profileControl.origin}/api/v1/conversations/${argumentConv}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[0]! } },
    );
    const argumentFrames = collectSseFrames(argumentSse, 'neg-arguments');
    expect(
      (
        await call(
          `/api/v1/conversations/${argumentConv}/messages`,
          'POST',
          { requestId: 'neg-arguments', text: `IMAGE_ARGUMENT_POLICY_TURN:${ownerAssetId}` },
          0,
        )
      ).status,
    ).toBe(202);
    expect((await waitReceiptStatus(argumentConv, 'neg-arguments', 0)).status).toBe('completed');
    const argumentOutputs = currentTurnToolOutputs(chatRequests[chatBeforeArguments + 1]!.messages);
    const expectedErrors = {
      neg_bad_uuid: 'IMAGE_JOB_ID_INVALID',
      neg_foreign_asset: 'ASSET_NOT_FOUND',
      neg_foreign_job: 'JOB_NOT_FOUND',
      neg_forbidden_arg: 'INVALID_ARGS',
      neg_geometry: 'INVALID_ARGS',
      neg_outpaint: 'INVALID_ARGS',
      neg_seed45_output_format: 'IMAGE_INPUT_INVALID',
    };
    expect(argumentOutputs.map((output) => output.toolCallId).sort()).toEqual([
      'neg_forbidden_arg',
      'neg_geometry',
      'neg_outpaint',
      'neg_seed45_output_format',
    ]);
    const inspected = (await (await fetch(`${profileControl.origin}/__test/tools`)).json()) as {
      negativeToolErrors: { toolCallId: string; code: string | null }[];
    };
    for (const [toolCallId, code] of Object.entries(expectedErrors)) {
      expect(
        inspected.negativeToolErrors.filter((result) => result.toolCallId === toolCallId),
      ).toEqual([{ toolCallId, code }]);
    }
    const forbidden = argumentOutputs.find((output) => output.toolCallId === 'neg_forbidden_arg')!;
    expect(forbidden.text).toContain('invalid arguments: unexpected parameter');
    expect(forbidden.text).not.toContain('sk-injected-secret-value');
    expect(forbidden.text).not.toContain('https://evil.invalid/payload.png');
    expect((await argumentFrames).filter((frame) => frame.event === 'tool')).toHaveLength(0);
    const argumentHistory = (await (
      await call(`/api/v1/conversations/${argumentConv}/history`)
    ).json()) as {
      items: { role: string }[];
    };
    expect(argumentHistory.items.map((item) => item.role)).toEqual(['user', 'assistant', 'status']);
    const jobsAfterArguments = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    expect(jobsAfterArguments).toBe(jobsBefore);
    expect(
      imageUpstreamRequests.slice(upstreamBeforeNeg).filter((r) => r.method === 'POST'),
    ).toHaveLength(0);
  }, 30_000);

  it('enforces clientOperationKey idempotency, per-turn submit/call budgets, 8-step circuit breaker, cancel, and cold restart history', async () => {
    const budgetConv = await createConversation(0);

    // 1. Idempotent clientOperationKey retry reuses exact jobId (0 duplicate jobs) and rejects conflicting input
    const jobsBeforeIdem = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    const chatBeforeIdem = chatRequests.length;
    const upstreamBeforeIdem = imageUpstreamRequests.length;
    try {
      expect(
        (
          await call(
            `/api/v1/conversations/${budgetConv}/messages`,
            'POST',
            { requestId: 'idem-turn', text: 'IDEMPOTENT_RETRY_TURN' },
            0,
          )
        ).status,
      ).toBe(202);
      expect((await waitReceiptStatus(budgetConv, 'idem-turn', 0)).status).toBe('completed');
    } finally {
      await setProviderEnabled(true);
    }

    const jobsAfterIdem = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    expect(jobsAfterIdem).toBe(jobsBeforeIdem + 1);
    const idemFinalOutputs = currentTurnToolOutputs(chatRequests[chatBeforeIdem + 2]!.messages);
    expect(idemFinalOutputs).toHaveLength(4);
    const firstIdemJob = JSON.parse(idemFinalOutputs[0]!.text) as { jobId: string };
    expect(idemFinalOutputs[1]!.text).not.toContain('PROVIDER_DISABLED');
    const secondIdemJob = JSON.parse(idemFinalOutputs[1]!.text) as { jobId: string };
    expect(secondIdemJob.jobId).toBe(firstIdemJob.jobId);
    const submittedIds = [firstIdemJob.jobId, secondIdemJob.jobId];
    expect(idemFinalOutputs[2]!.text).toContain('REQUEST_CONFLICT');
    expect(idemFinalOutputs[3]!.text).toContain('PROVIDER_DISABLED');
    await waitImageJobCompleted(firstIdemJob.jobId, 0);
    expect(
      imageUpstreamRequests
        .slice(upstreamBeforeIdem)
        .filter((request) => request.method === 'POST')
        .map((request) => request.json?.prompt),
    ).toEqual(['idempotent castle']);

    // 2. maxImageSubmitsPerTurn = 4 blocks the 5th submit_image_job with 0 5th job created
    const jobsBeforeSubmitBudget = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    const chatBeforeSubmitBudget = chatRequests.length;
    expect(
      (
        await call(
          `/api/v1/conversations/${budgetConv}/messages`,
          'POST',
          { requestId: 'submit-budget', text: 'SUBMIT_BUDGET_TURN' },
          0,
        )
      ).status,
    ).toBe(202);
    expect((await waitReceiptStatus(budgetConv, 'submit-budget', 0)).status).toBe('completed');
    const jobsAfterSubmitBudget = Number(
      (await observer.query<{ count: string }>('SELECT count(*) FROM mio_image_jobs')).rows[0]!
        .count,
    );
    expect(jobsAfterSubmitBudget).toBe(jobsBeforeSubmitBudget + 4);
    const submitBudgetOutputs = currentTurnToolOutputs(
      chatRequests[chatBeforeSubmitBudget + 1]!.messages,
    );
    expect(submitBudgetOutputs).toHaveLength(5);
    expect(submitBudgetOutputs[4]!.text).toContain(
      'MIO_TOOL_BUDGET_EXCEEDED: max 4 image submissions per turn',
    );
    for (let idx = 0; idx < 4; idx += 1) {
      const createdJob = JSON.parse(submitBudgetOutputs[idx]!.text) as { jobId: string };
      submittedIds.push(createdJob.jobId);
      await waitImageJobCompleted(createdJob.jobId, 0);
    }

    // 3. maxToolCallsPerTurn = 12 blocks the 13th tool call
    const chatBeforeCallBudget = chatRequests.length;
    expect(
      (
        await call(
          `/api/v1/conversations/${budgetConv}/messages`,
          'POST',
          { requestId: 'call-budget', text: 'CALL_BUDGET_TURN' },
          0,
        )
      ).status,
    ).toBe(202);
    expect((await waitReceiptStatus(budgetConv, 'call-budget', 0)).status).toBe('completed');
    const callBudgetOutputs = currentTurnToolOutputs(
      chatRequests[chatBeforeCallBudget + 1]!.messages,
    );
    expect(callBudgetOutputs).toHaveLength(13);
    expect(callBudgetOutputs[12]!.text).toContain(
      'MIO_TOOL_BUDGET_EXCEEDED: max 12 tool calls per turn',
    );

    // 4. MAX_TURN_STEPS = 8 circuit breaker halts runaway step loops at step 9
    const chatBeforeStepBudget = chatRequests.length;
    expect(
      (
        await call(
          `/api/v1/conversations/${budgetConv}/messages`,
          'POST',
          { requestId: 'step-budget', text: 'STEP_BUDGET_TURN' },
          0,
        )
      ).status,
    ).toBe(202);
    const stepReceipt = await waitReceiptStatus(budgetConv, 'step-budget', 0);
    expect(stepReceipt.status).toBe('failed');
    expect(stepReceipt.error).toBe('MODEL_FAILED');
    expect(chatRequests.length - chatBeforeStepBudget).toBe(8);

    // 5. Mid-turn cancel revokes active grant cleanly and allows subsequent turns
    expect(
      (
        await call(
          `/api/v1/conversations/${budgetConv}/messages`,
          'POST',
          { requestId: 'cancel-mid', text: 'PAUSE_AFTER_TOOL_TURN' },
          0,
        )
      ).status,
    ).toBe(202);
    await expect.poll(() => pauseSignal.paused, { timeout: 10_000 }).toBe(true);
    const cancelRes = await call(`/api/v1/conversations/${budgetConv}/cancel`, 'POST', {}, 0);
    expect(cancelRes.status).toBe(202);
    pauseSignal.release?.();
    expect((await waitReceiptStatus(budgetConv, 'cancel-mid', 0)).status).toBe('cancelled');

    // Drain any accepted image job from cancel-mid before graceful stop
    const activeJobs = (
      await observer.query<{ id: string }>(
        "SELECT id FROM mio_image_jobs WHERE state IN ('accepted','submitted','processing','materializing')",
      )
    ).rows;
    for (const row of activeJobs) {
      await waitImageJobCompleted(row.id, 0);
    }

    // 6. Compare this conversation's public tool history before and after reopening its JSONL.
    const historyPath = `/api/v1/conversations/${budgetConv}/history?limit=100`;
    const warmHistoryRes = await call(historyPath);
    expect(warmHistoryRes.status).toBe(200);
    const warmHistory = (await warmHistoryRes.json()) as {
      items: {
        seq: number;
        role: string;
        tool?: string;
        job?: { jobId: string; status: string };
      }[];
    };
    const warmToolItems = warmHistory.items.filter((item) => item.role === 'tool');
    expect(
      warmToolItems.slice(0, submittedIds.length).map((item) => [item.tool, item.job?.jobId]),
    ).toEqual(submittedIds.map((id) => ['submit_image_job', id]));
    const chatBeforeColdHistory = chatRequests.length;
    const upstreamBeforeColdHistory = imageUpstreamRequests.length;

    await profileControl.stop();
    await profileControl.start('database');
    const coldHistoryRes = await call(historyPath);
    expect(coldHistoryRes.status).toBe(200);
    const coldHistory = (await coldHistoryRes.json()) as typeof warmHistory;
    expect(chatRequests.length).toBe(chatBeforeColdHistory);
    expect(imageUpstreamRequests.length).toBe(upstreamBeforeColdHistory);

    const coldToolItems = coldHistory.items.filter((item) => item.role === 'tool');
    expect(coldToolItems).toEqual(warmToolItems);
    const seqs = coldHistory.items.map((item) => item.seq);
    expect(seqs.every((seq, idx) => idx === 0 || seq > seqs[idx - 1]!)).toBe(true);
  }, 60_000);

  it('defers same-turn get_image_job polling after submit and repeated non-terminal polls without exceeding step budget', async () => {
    const pollGuardConv = await createConversation(0);
    const chatBeforeTurnA = chatRequests.length;

    const sseTurnARes = await fetch(
      `${profileControl.origin}/api/v1/conversations/${pollGuardConv}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[0]! } },
    );
    const sseTurnAPromise = collectSseFrames(sseTurnARes, 'poll-guard-turn-a');

    expect(
      (
        await call(
          `/api/v1/conversations/${pollGuardConv}/messages`,
          'POST',
          { requestId: 'poll-guard-turn-a', text: 'SAME_TURN_POLL_GUARD_TURN' },
          0,
        )
      ).status,
    ).toBe(202);

    const [turnAFrames, turnAReceipt] = await Promise.all([
      sseTurnAPromise,
      waitReceiptStatus(pollGuardConv, 'poll-guard-turn-a', 0),
    ]);
    expect(turnAReceipt.status).toBe('completed');
    expect(chatRequests.length - chatBeforeTurnA).toBe(3);

    const turnAToolOutputs = currentTurnToolOutputs(chatRequests[chatBeforeTurnA + 2]!.messages);
    expect(turnAToolOutputs).toHaveLength(2);
    const submittedJob = JSON.parse(turnAToolOutputs[0]!.text) as {
      jobId: string;
      status: string;
    };
    const pendingJobId = submittedJob.jobId;
    expect(turnAToolOutputs[1]!.text).toContain('IMAGE_JOB_POLL_DEFERRED');

    const turnAToolFrames = turnAFrames.filter((frame) => frame.event === 'tool');
    expect(turnAToolFrames).toHaveLength(1);
    expect(turnAToolFrames[0]!.data.tool).toBe('submit_image_job');

    const historyAfterTurnA = (await (
      await call(`/api/v1/conversations/${pollGuardConv}/history`, 'GET', undefined, 0)
    ).json()) as {
      items: { seq: number; role: string; tool?: string; job?: { jobId: string } }[];
    };
    const toolItemsAfterTurnA = historyAfterTurnA.items.filter((item) => item.role === 'tool');
    expect(toolItemsAfterTurnA).toHaveLength(1);
    expect(toolItemsAfterTurnA[0]!.tool).toBe('submit_image_job');

    // Cross-turn first query succeeds for the still-non-terminal job; 2nd poll in the same turn is deferred.
    const chatBeforeTurnB = chatRequests.length;
    const sseTurnBRes = await fetch(
      `${profileControl.origin}/api/v1/conversations/${pollGuardConv}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[0]! } },
    );
    const sseTurnBPromise = collectSseFrames(sseTurnBRes, 'poll-guard-turn-b');

    expect(
      (
        await call(
          `/api/v1/conversations/${pollGuardConv}/messages`,
          'POST',
          {
            requestId: 'poll-guard-turn-b',
            text: `CROSS_TURN_REPEAT_POLL_TURN:${pendingJobId}`,
          },
          0,
        )
      ).status,
    ).toBe(202);

    const [turnBFrames, turnBReceipt] = await Promise.all([
      sseTurnBPromise,
      waitReceiptStatus(pollGuardConv, 'poll-guard-turn-b', 0),
    ]);
    expect(turnBReceipt.status).toBe('completed');
    expect(chatRequests.length - chatBeforeTurnB).toBe(3);

    const turnBToolOutputs = currentTurnToolOutputs(chatRequests[chatBeforeTurnB + 2]!.messages);
    expect(turnBToolOutputs).toHaveLength(2);
    const firstCrossPoll = JSON.parse(turnBToolOutputs[0]!.text) as {
      jobId: string;
      status: string;
    };
    expect(firstCrossPoll.jobId).toBe(pendingJobId);
    expect(['accepted', 'submitted', 'processing', 'materializing']).toContain(
      firstCrossPoll.status,
    );
    expect(turnBToolOutputs[1]!.text).toContain('IMAGE_JOB_POLL_DEFERRED');

    const turnBToolFrames = turnBFrames.filter((frame) => frame.event === 'tool');
    expect(turnBToolFrames).toHaveLength(1);
    expect(turnBToolFrames[0]!.data.tool).toBe('get_image_job');

    // Same-step parallel duplicate get_image_job for the same non-terminal jobId emits 1 card and defers the duplicate.
    const chatBeforeTurnC = chatRequests.length;
    const sseTurnCRes = await fetch(
      `${profileControl.origin}/api/v1/conversations/${pollGuardConv}/events`,
      { headers: { origin: profileControl.origin, cookie: cookies[0]! } },
    );
    const sseTurnCPromise = collectSseFrames(sseTurnCRes, 'poll-guard-turn-c');

    expect(
      (
        await call(
          `/api/v1/conversations/${pollGuardConv}/messages`,
          'POST',
          {
            requestId: 'poll-guard-turn-c',
            text: `PARALLEL_POLL_GUARD_TURN:${pendingJobId}`,
          },
          0,
        )
      ).status,
    ).toBe(202);

    const [turnCFrames, turnCReceipt] = await Promise.all([
      sseTurnCPromise,
      waitReceiptStatus(pollGuardConv, 'poll-guard-turn-c', 0),
    ]);
    expect(turnCReceipt.status).toBe('completed');
    const turnCToolOutputs = currentTurnToolOutputs(chatRequests[chatBeforeTurnC + 1]!.messages);
    expect(turnCToolOutputs).toHaveLength(2);
    expect(JSON.parse(turnCToolOutputs[0]!.text)).toMatchObject({ jobId: pendingJobId });
    expect(turnCToolOutputs[1]!.text).toContain('IMAGE_JOB_POLL_DEFERRED');
    expect(turnCFrames.filter((frame) => frame.event === 'tool')).toHaveLength(1);

    const historyAfterTurnC = (await (
      await call(`/api/v1/conversations/${pollGuardConv}/history`, 'GET', undefined, 0)
    ).json()) as {
      items: { seq: number; role: string; tool?: string; job?: { jobId: string } }[];
    };
    const toolItemsAfterTurnC = historyAfterTurnC.items.filter((item) => item.role === 'tool');
    expect(toolItemsAfterTurnC.map((item) => item.tool)).toEqual([
      'submit_image_job',
      'get_image_job',
      'get_image_job',
    ]);

    heldKlingTaskIds.clear();
    while (heldKlingWaiters.length) {
      heldKlingWaiters.shift()?.();
    }
    await waitImageJobCompleted(pendingJobId, 0);
  }, 45_000);
});
