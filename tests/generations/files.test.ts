import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { GenerationFiles } from '../../src/generations/files.ts';
import { createImageDecoder } from '../../src/generations/decode.ts';

it('fully decodes valid original bytes and rejects a damaged body with a valid PNG signature', async () => {
  const original = await sharp({
    create: { width: 4, height: 3, channels: 3, background: '#667788' },
  })
    .png()
    .toBuffer();
  const copy = Buffer.from(original);
  const decode = createImageDecoder();
  await expect(decode(original, 'png')).resolves.toBeUndefined();
  const damaged = Buffer.from(original);
  const idat = damaged.indexOf(Buffer.from('IDAT'));
  damaged[idat + 4] = damaged[idat + 4]! ^ 255;
  expect((await sharp(damaged).metadata()).width).toBe(4);
  await expect(decode(damaged, 'png')).rejects.toThrow('IMAGE_OUTPUT_INVALID');
  await expect(decode(original, 'jpeg')).rejects.toThrow('IMAGE_OUTPUT_INVALID');
  expect(original).toEqual(copy);
});

it('verifies stored bytes and retains the previous checkpoint after a damaged recovery file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mio-generation-files-'));
  const files = new GenerationFiles(directory);
  const jobId = randomUUID();
  const commandId = randomUUID();
  try {
    await files.initialize();
    const receipt = await files.receive(
      jobId,
      commandId,
      2,
      [
        { base64: Buffer.from('first original bytes').toString('base64') },
        { base64: Buffer.from('second original bytes').toString('base64') },
      ],
      'png',
    );
    const first = receipt.checkpoint.images[0]!;
    const second = receipt.checkpoint.images[1]!;
    await writeFile(join(directory, second.file), 'corrupt');
    await expect(files.read(jobId, second)).rejects.toThrow('IMAGE_CHECKPOINT_INVALID');
    expect((await files.read(jobId, first)).toString()).toBe('first original bytes');
    expect((await files.load(jobId, commandId, 2, receipt.ref))!.checkpoint.images).toHaveLength(2);
    await writeFile(join(directory, 'blocked'), 'unavailable directory');
    await expect(new GenerationFiles(join(directory, 'blocked')).admit()).rejects.toMatchObject({
      code: 'COMPUTE_STORAGE_UNAVAILABLE',
    });
    expect((await files.read(jobId, first)).toString()).toBe('first original bytes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
