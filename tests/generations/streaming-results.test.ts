import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerationFiles } from '../../src/generations/files.ts';
import { downloadResultImage } from '../../src/integrations/onelink/shared/index.ts';
import type { ImageResult } from '../../src/integrations/onelink/shared/index.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('original image bytes'),
]);
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mio-streamed-output-'));
  roots.push(root);
  const files = new GenerationFiles(root);
  await files.initialize();
  return { root, files, jobId: randomUUID(), commandId: randomUUID() };
}
function source(bytes: Uint8Array, fail = false): ImageResult {
  return {
    download: async (consume) => {
      let offset = 0;
      await consume(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= bytes.length) {
                if (fail) controller.error(new Error('download lost'));
                else controller.close();
                return;
              }
              const next = bytes.subarray(offset, offset + 3);
              offset += next.length;
              controller.enqueue(next);
            },
          }),
        ),
      );
    },
  };
}
it('defers HTTPS download and durably preserves original bytes and sparse output positions', async () => {
  const f = await setup();
  const downloaded = vi.fn();
  const download: typeof withPublicHttps = async (_url, _signal, consume) => {
    downloaded();
    return consume(new Response(png));
  };
  const deferred = await downloadResultImage(
    'https://result.example/output.png',
    download,
    new AbortController().signal,
    'deferred',
  );
  expect(downloaded).not.toHaveBeenCalled();
  const result = await f.files.receive(
    f.jobId,
    f.commandId,
    3,
    [null, deferred, source(png)],
    'jpeg',
  );
  expect(downloaded).toHaveBeenCalledOnce();
  expect(result.checkpoint.receivedAll).toBe(true);
  expect(result.checkpoint.images.map((image) => image.index)).toEqual([1, 2]);
  expect(result.checkpoint.invalidIndices).toEqual([0]);
  for (const image of result.checkpoint.images) {
    expect(image.format).toBe('png');
    expect(image.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(await f.files.read(f.jobId, image)).toEqual(png);
  }
  expect(
    (await new GenerationFiles(f.root).load(f.jobId, f.commandId, 3, result.ref))!.checkpoint
      .images,
  ).toEqual(result.checkpoint.images);
});
it('retains the durable prefix after a download fails and resumes without reading that output again', async () => {
  const f = await setup();
  const first = await f.files.receive(
    f.jobId,
    f.commandId,
    2,
    [source(png), source(png, true)],
    'png',
  );
  expect(first.checkpoint.receivedAll).toBe(false);
  expect(first.checkpoint.images.map((image) => image.index)).toEqual([0]);
  expect(f.files.storageFailed).toBe(false);
  expect(
    (await readdir(join(f.root, f.jobId))).filter((name) => name.endsWith('.download')),
  ).toHaveLength(1);
  const readFirst = vi.fn(async () => {
    throw new Error('must retain first result');
  });
  const restarted = new GenerationFiles(f.root);
  const completed = await restarted.receive(
    f.jobId,
    f.commandId,
    2,
    [{ download: readFirst }, source(png)],
    'png',
  );
  expect(readFirst).not.toHaveBeenCalled();
  expect(completed.checkpoint.receivedAll).toBe(true);
  expect(completed.checkpoint.images[0]).toEqual(first.checkpoint.images[0]);
  expect(await restarted.read(f.jobId, completed.checkpoint.images[1]!)).toEqual(png);
});
it('cancels an over-limit body and removes its unconfirmed file', async () => {
  const f = await setup();
  let sent = 0,
    cancelled = false;
  const output: ImageResult = {
    download: async (consume) =>
      consume(
        new Response(
          new ReadableStream({
            pull(controller) {
              const chunk = Buffer.alloc(1024 * 1024);
              if (!sent) png.copy(chunk);
              sent += chunk.length;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
  };
  const result = await f.files.receive(f.jobId, f.commandId, 1, [output], 'png');
  expect(cancelled).toBe(true);
  expect(result.checkpoint.images).toEqual([]);
  expect(result.checkpoint.invalidIndices).toEqual([0]);
  expect(f.files.storageFailed).toBe(false);
  expect(await readdir(join(f.root, f.jobId))).toEqual(['receipt.json']);
}, 30000);

it('keeps complete durable bytes if transport teardown fails after the body was consumed', async () => {
  const f = await setup();
  const output: ImageResult = {
    download: async (consume) => {
      await consume(new Response(png));
      throw new Error('dispatcher teardown lost');
    },
  };
  const result = await f.files.receive(f.jobId, f.commandId, 1, [output], 'png');
  expect(result.checkpoint.receivedAll).toBe(true);
  expect(result.checkpoint.images).toHaveLength(1);
  expect(await f.files.read(f.jobId, result.checkpoint.images[0]!)).toEqual(png);
  expect(f.files.storageFailed).toBe(false);
});
