import { expect, it, vi } from 'vitest';
import { createMaterialAuthUpstream } from '../../src/integrations/onelink/materials.ts';
import { auditMaterialAuthResponse } from './auth-live-audit.ts';

const limit = 2 * 1024 * 1024;
const key = 'synthetic-audit-credential';
const token = 'synthetic-audit-session-token';
const group = 'group-00000000000001-authx';
const requestId = 'synthetic-audit-request';
const resultAction = 'GetVisualValidateResult';
const groupAction = 'GetAssetGroup';

function fullBody(action: string, fields: Record<string, unknown>) {
  const payload = {
    ResponseMetadata: {
      Action: action,
      Version: '2024-01-01',
      Service: 'ark',
      RequestId: requestId,
    },
    Result: { ...fields, [token]: 'private', padding: '' },
  };
  payload.Result.padding = 'x'.repeat(limit - Buffer.byteLength(JSON.stringify(payload)));
  return Buffer.from(JSON.stringify(payload));
}

it.each([resultAction, groupAction] as const)(
  'records only selected field types through a complete response at the byte limit for %s',
  async (action) => {
    const groupResult = { Id: group, GroupType: 'LivenessFace' };
    const bytes = fullBody(action, action === resultAction ? { GroupId: group } : groupResult);
    expect(bytes.byteLength).toBe(limit);
    const observe = vi.fn();
    const upstream = createMaterialAuthUpstream(async (_url, options) =>
      auditMaterialAuthResponse(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 117));
              controller.enqueue(bytes.subarray(117));
              controller.close();
            },
          }),
        ),
        action,
        observe,
        options.signal ?? undefined,
      ),
    );
    const signal = new AbortController().signal;
    if (action === resultAction) {
      expect(await upstream.result(key, token, signal)).toEqual({ groupId: group, requestId });
      expect(observe.mock.calls).toEqual([[{ GroupId: 'string' }]]);
    } else {
      expect(await upstream.verifiedGroup(key, group, signal)).toBe(requestId);
      expect(observe.mock.calls).toEqual([[{ Id: 'string', GroupType: 'string' }]]);
    }
  },
);

it('keeps the overflow visible to the material adapter and cancels a chunked source promptly', async () => {
  const bytes = fullBody(resultAction, { GroupId: group });
  const chunks = [bytes.subarray(0, limit / 2), bytes.subarray(limit / 2), Uint8Array.of(0x20)];
  const observe = vi.fn();
  const cancel = vi.fn();
  let pulls = 0;
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (pulls === 20) controller.close();
          else controller.enqueue(chunks[pulls++] ?? chunks[2]!);
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
  const upstream = createMaterialAuthUpstream(async (_url, options) =>
    auditMaterialAuthResponse(response, resultAction, observe, options.signal ?? undefined),
  );
  await expect(upstream.result(key, token, new AbortController().signal)).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
  await expect.poll(() => cancel.mock.calls.length).toBe(1);
  expect(pulls).toBeLessThanOrEqual(4);
  expect(observe).not.toHaveBeenCalled();
});

it('propagates consumer cancellation without observing a partial response', async () => {
  const observe = vi.fn();
  const cancel = vi.fn();
  const source = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('{"Result":'));
      },
      cancel,
    }),
  );
  const reader = auditMaterialAuthResponse(source, resultAction, observe).body!.getReader();
  await reader.read();
  await reader.cancel('test cancellation');
  await expect.poll(() => cancel.mock.calls).toEqual([['test cancellation']]);
  expect(observe).not.toHaveBeenCalled();
});

it('cancels an unfinished source when verification aborts during the read', async () => {
  const reading = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  const observe = vi.fn();
  const cancel = vi.fn(() => pending.resolve());
  const stop = new AbortController();
  const source = new Response(
    new ReadableStream(
      {
        start(controller) {
          controller.enqueue(Buffer.from('{"Result":'));
        },
        pull() {
          reading.resolve();
          return pending.promise;
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
  const upstream = createMaterialAuthUpstream(async (_url, options) =>
    auditMaterialAuthResponse(source, resultAction, observe, options.signal ?? undefined),
  );
  const verification = upstream.result(key, token, stop.signal);
  await reading.promise;
  stop.abort();
  await expect(verification).rejects.toMatchObject({ status: 503 });
  await expect.poll(() => cancel.mock.calls.length).toBe(1);
  expect(observe).not.toHaveBeenCalled();
});
