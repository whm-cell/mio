import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { generationFixture } from './fixture.ts';

it.each(['valid', 'length', 'digest', 'etag', 'key'])(
  'adopts COS output only after its mandatory HEAD: %s',
  async (mutation) => {
    const f = await generationFixture();
    const accept = f.store.acceptOutputs.bind(f.store);
    const first = Promise.withResolvers<Parameters<typeof accept>>();
    const release = Promise.withResolvers<void>();
    const checkpoint = vi
      .spyOn(f.store, 'acceptOutputs')
      .mockImplementationOnce(async (...args) => {
        first.resolve(args);
        await release.promise;
        return accept(...args);
      });
    const objects = new Map<string, { bytes: Buffer; sha256: string }>();
    const put = vi.spyOn(COS.prototype, 'putObject').mockImplementation(async (parameters) => {
      const chunks: Buffer[] = [];
      for await (const chunk of parameters.Body as Readable) chunks.push(Buffer.from(chunk));
      objects.set(parameters.Key, {
        bytes: Buffer.concat(chunks),
        sha256: parameters['x-cos-meta-sha256']!,
      });
      return { ETag: '"actual-put-etag"', Location: '' };
    });
    const head = vi.spyOn(COS.prototype, 'headObject').mockImplementation(async ({ Key }) => {
      const object = objects.get(Key)!;
      return {
        ETag: mutation === 'etag' ? '"changed-etag"' : '"actual-put-etag"',
        headers: {
          'content-length': String(object.bytes.length + (mutation === 'length' ? 1 : 0)),
          'x-cos-meta-sha256': mutation === 'digest' ? '0'.repeat(64) : object.sha256,
        },
      };
    });
    const storage = createCosStorage({
      databaseURL: 'postgresql://fixture.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'fixture',
      secretKey: 'fixture',
    });
    f.objects.head = storage.head;
    f.objects.putImage = async (...args) => {
      const output = await storage.putImage!(...args);
      return mutation === 'key' ? { ...output, key: 'unexpected-key' } : output;
    };
    try {
      const service = await f.start();
      const job = await service.createImage(f.actor, randomUUID(), f.modelRef, {
        prompt: 'two originals',
        n: 2,
      });
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce(), { timeout: 6000 });
      const [, outputs, state] = await first.promise;
      expect(state).toBe(mutation === 'valid' ? 'completed' : 'materializing');
      expect(f.transport).toHaveBeenCalledTimes(1);
      if (mutation === 'valid') {
        expect(outputs).toHaveLength(2);
        expect(put).toHaveBeenCalledTimes(2);
        expect(head).toHaveBeenCalledTimes(2);
        expect(head.mock.calls.map(([parameters]) => parameters.Key)).toEqual(
          put.mock.calls.map(([parameters]) => parameters.Key),
        );
      } else {
        expect(outputs).toEqual([]);
        expect(
          (
            await f.pool.query(
              "SELECT count(*) FROM mio_assets WHERE owner_id=$1 AND state='ready'",
              [f.actor.userId],
            )
          ).rows[0].count,
        ).toBe('0');
        if (mutation === 'key') expect(head).not.toHaveBeenCalled();
        else expect(head).toHaveBeenCalled();
      }
      // Stop before a second attempt can legitimately recover by the saved physical key.
      const closing = service.close();
      release.resolve();
      await closing;
      expect(
        (await f.pool.query('SELECT count(*) FROM mio_image_outputs WHERE job_id=$1', [job.jobId]))
          .rows[0].count,
      ).toBe(mutation === 'valid' ? '2' : '0');
    } finally {
      release.resolve();
      await f.close();
      put.mockRestore();
      head.mockRestore();
    }
  },
  15000,
);
