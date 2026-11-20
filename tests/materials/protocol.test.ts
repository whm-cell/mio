import { expect, it, vi } from 'vitest';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';
import { envelope } from './fixture.ts';
const key = 'synthetic-protocol-private-key';
const group = 'group-20261120000000-abcde';
const asset = 'asset-20261120000000-abcde';
const signal = () => new AbortController().signal;

it('uses the exact fixed endpoint, plural nonempty group filter, one-based page and bounded page size', async () => {
  const transport = vi.fn(async () =>
    envelope('ListAssets', { Items: [], PageNumber: 2, PageSize: 100, TotalCount: 100 }),
  );
  const upstream = createMaterialUpstream(transport);
  expect(await upstream.listMaterials(key, group, 2, signal())).toEqual({
    items: [],
    hasMore: false,
  });
  expect(transport.mock.calls[0]).toEqual([
    expect.stringMatching(
      /^https:\/\/api\.onelinkai\.cloud\/volc\/openapi\?Action=ListAssets&Version=2024-01-01$/,
    ),
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ Filter: { GroupIds: [group] }, PageNumber: 2, PageSize: 100 }),
    }),
  ]);
  await expect(upstream.listMaterials(key, '', 1, signal())).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
  await expect(upstream.listMaterials(key, group, 0, signal())).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([
  [403, 'ResourceNotFound', 'PROVIDER_RESOURCE_FORBIDDEN'],
  [404, 'ResourceNotFound', 'UPSTREAM_RESOURCE_NOT_FOUND'],
  [404, 'Other', 'UPSTREAM_REJECTED'],
  [401, 'AuthRejected', 'PROVIDER_UNAVAILABLE'],
  [429, 'RateLimit', 'UPSTREAM_RATE_LIMITED'],
])('keeps exact resource error classification for %s/%s', async (status, code, expected) => {
  const upstream = createMaterialUpstream(async () =>
    envelope('GetAsset', {}, Number(status), String(code)),
  );
  await expect(upstream.getMaterial(key, asset, group, signal())).rejects.toMatchObject({
    code: expected,
  });
});
it.each([
  'wrong-group',
  'duplicate',
  'oversize-page',
  'missing-metadata',
  'key-echo',
  'unknown-action',
])('rejects malformed or unsafe upstream snapshot: %s', async (kind) => {
  const item = {
    Id: asset,
    GroupId: kind === 'wrong-group' ? 'group-20261120000001-abcde' : group,
    AssetType: 'Image',
    Name: kind === 'key-echo' ? key : 'Name',
    Status: 'Active',
  };
  const result = {
    Items: kind === 'duplicate' ? [item, item] : [item],
    PageNumber: 1,
    PageSize: kind === 'oversize-page' ? 101 : 100,
    TotalCount: 1,
  };
  const upstream = createMaterialUpstream(async () =>
    kind === 'missing-metadata'
      ? Response.json({ Result: result })
      : envelope(kind === 'unknown-action' ? 'ListAssetGroups' : 'ListAssets', result),
  );
  await expect(upstream.listMaterials(key, group, 1, signal())).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
});
it('bounds response bytes and cancels a stalled stream when the request is aborted', async () => {
  const large = createMaterialUpstream(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await expect(large.getGroup(key, group, signal())).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
  const cancelled = vi.fn();
  const stop = new AbortController();
  const waiting = createMaterialUpstream(
    async () => new Response(new ReadableStream({ cancel: cancelled })),
  );
  const operation = waiting.getGroup(key, group, stop.signal);
  await Promise.resolve();
  stop.abort();
  await expect(operation).rejects.toMatchObject({ uncertain: true });
});
it('enforces a twenty-second timeout even if the transport ignores cancellation, without retry', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  try {
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    const upstream = createMaterialUpstream(transport);
    const result = upstream.createGroup(key, 'Timeout', signal());
    const rejection = expect(result).rejects.toMatchObject({
      code: 'UPSTREAM_RESULT_UNKNOWN',
      uncertain: true,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});
