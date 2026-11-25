import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { downloadResultImage } from '../../src/integrations/onelink/shared/index.ts';
import type { ImageResult, ImageResultMode } from '../../src/integrations/onelink/shared/index.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';
import { GenerationFiles } from '../../src/generations/image/files.ts';

// Explicit synthetic transport/receipt probe; full pixel validation has separate regression coverage.
const [requestedMode = 'deferred', requestedParallel = '4'] = process.argv.slice(2);
if (!['buffer', 'deferred'].includes(requestedMode)) throw new Error('expected buffer or deferred');
const mode = requestedMode as ImageResultMode;
const parallel = Number(requestedParallel);
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 4)
  throw new Error('parallel must be 1..4');
const count = 16,
  bytes = 2 * 1024 * 1024,
  chunkSize = 64 * 1024;
let downloaded = 0;
const download: typeof withPublicHttps = async (_url, _signal, consume) => {
  let sent = 0;
  return consume(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === bytes) return controller.close();
          const chunk = Buffer.alloc(Math.min(chunkSize, bytes - sent), 17);
          if (!sent) Buffer.from('89504e470d0a1a0a', 'hex').copy(chunk);
          sent += chunk.length;
          downloaded += chunk.length;
          controller.enqueue(chunk);
        },
      }),
    ),
  );
};
const root = await mkdtemp(join(tmpdir(), 'mio-result-memory-'));
try {
  await Promise.all(
    Array.from({ length: parallel }, async (_, worker) => {
      const files = new GenerationFiles(join(root, String(worker)));
      await files.initialize();
      const images: (ImageResult | null)[] = [];
      for (let index = 0; index < count; index++)
        images.push(
          await downloadResultImage(
            'https://images.example/a.png',
            download,
            AbortSignal.timeout(180000),
            mode,
          ),
        );
      const stored = await files.receive(randomUUID(), randomUUID(), count, images, 'png');
      if (stored.checkpoint.images.length !== count || !stored.checkpoint.receivedAll)
        throw new Error('OUTPUT_MISMATCH');
    }),
  );
  console.log(
    JSON.stringify({
      mode,
      parallel,
      count,
      bytes,
      downloaded,
      maxRssKiB: process.resourceUsage().maxRSS,
      memory: process.memoryUsage(),
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
