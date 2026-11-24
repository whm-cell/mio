import { createHash } from 'node:crypto';
import { createId } from '@mio/foundation/identifiers';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, statfs, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoProbeCommandV1, VideoProbeMetadataV1 } from '@mio/compute-contracts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import { withPublicHttps } from '../integrations/onelink/public-https.ts';
import type {
  VideoExecution,
  VideoMaterializer,
  VideoMaterializedOutput,
} from './video-execution.ts';

const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
interface SavedVideo {
  jobId: string;
  index: number;
  assetId: string;
  attemptId: string;
  sha256: string;
  sizeBytes: number;
  etag?: string;
  media?: VideoProbeMetadataV1;
}
export type VideoProbe = (
  command: VideoProbeCommandV1,
  signal: AbortSignal,
) => Promise<VideoProbeMetadataV1>;

async function save(path: string, saved: SavedVideo) {
  const temporary = path + '.' + createId();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(saved));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function digestFile(file: string, signal: AbortSignal) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_VIDEO_BYTES)
      throw new Error('VIDEO_FILE_INVALID');
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(bytes);
    }
    return { sizeBytes: info.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function downloadVideo(
  url: string,
  file: string,
  signal: AbortSignal,
  download: typeof withPublicHttps,
) {
  const temporary = file + '.' + createId();
  const handle = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    await download(new URL(url), signal, async (response) => {
      if (response.status !== 200 || !response.body) throw new Error('VIDEO_DOWNLOAD_FAILED');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_VIDEO_BYTES))
        throw new Error('VIDEO_TOO_LARGE');
      for await (const part of response.body) {
        signal.throwIfAborted();
        const bytes = Buffer.from(part);
        sizeBytes += bytes.length;
        if (sizeBytes > MAX_VIDEO_BYTES) throw new Error('VIDEO_TOO_LARGE');
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const written = await handle.write(bytes, offset, bytes.length - offset);
          if (!written.bytesWritten) throw new Error('VIDEO_STORAGE_FAILED');
          offset += written.bytesWritten;
        }
      }
      if (sizeBytes < 1 || (declared !== null && sizeBytes !== Number(declared)))
        throw new Error('VIDEO_DOWNLOAD_INCOMPLETE');
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  return { sizeBytes, sha256: hash.digest('hex') };
}

/** Keep the durable media receipt until its asset transaction has committed. */
export function createVideoMaterializer(
  objects: AssetObjectStore,
  dataDirectory: string,
  probe: VideoProbe,
  download: typeof withPublicHttps = withPublicHttps,
): VideoMaterializer {
  return async (row, videos, signal) => {
    if (!objects.putVideo) throw new Error('VIDEO_STORAGE_UNAVAILABLE');
    const directory = join(dataDirectory, 'video', row.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('VIDEO_DIRECTORY_INVALID');
    const outputs: VideoMaterializedOutput[] = [];
    for (const [index, video] of videos.entries()) {
      signal.throwIfAborted();
      const file = join(directory, String(index) + '.media');
      const receipt = join(directory, String(index) + '.json');
      let saved: SavedVideo;
      try {
        saved = JSON.parse(await readFile(receipt, 'utf8')) as SavedVideo;
        if (
          saved.jobId !== row.id ||
          saved.index !== index ||
          !/^[a-f0-9-]{36}$/.test(saved.assetId) ||
          !/^[a-f0-9-]{36}$/.test(saved.attemptId)
        )
          throw new Error('VIDEO_CHECKPOINT_INVALID');
        const actual = await digestFile(file, signal);
        if (actual.sha256 !== saved.sha256 || actual.sizeBytes !== saved.sizeBytes)
          throw new Error('VIDEO_CHECKPOINT_INVALID');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const space = await statfs(directory, { bigint: true });
        if (space.bavail * space.bsize < BigInt(MAX_VIDEO_BYTES + 64 * 1024 * 1024))
          throw new Error('VIDEO_DISK_FULL');
        const actual = await downloadVideo(video.url, file, signal, download);
        saved = { jobId: row.id, index, assetId: createId(), attemptId: createId(), ...actual };
        await save(receipt, saved);
      }
      const key = `mio/staging/video/${row.id}/${index}/${saved.attemptId}.media`;
      let object: Awaited<ReturnType<AssetObjectStore['head']>> | undefined;
      try {
        object = await objects.head(key);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      if (!object) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stream = handle.createReadStream({ autoClose: false });
        stream.on('error', () => {});
        try {
          await objects.putVideo(key, stream, saved.sizeBytes, saved.sha256, signal);
        } finally {
          stream.destroy();
          await handle.close();
        }
        object = await objects.head(key);
      }
      if (object.size !== saved.sizeBytes || object.sha256 !== saved.sha256 || !object.etag)
        throw new Error('VIDEO_OBJECT_MISMATCH');
      saved.etag = object.etag;
      if (!saved.media) {
        saved.media = await probe(
          {
            version: 1,
            type: 'video.probe',
            messageId: createId(),
            jobId: row.id,
            outputIndex: index,
            attemptId: saved.attemptId,
            attempt: 1,
            source: {
              stagingKey: key,
              sizeBytes: saved.sizeBytes,
              sha256: saved.sha256,
              etag: object.etag,
            },
          },
          signal,
        );
        await save(receipt, saved);
      }
      const media = saved.media;
      if (
        !media.container.split(',').some((container) => ['mov', 'mp4'].includes(container)) ||
        !Number.isFinite(media.durationSeconds) ||
        media.durationSeconds <= 0
      )
        throw new Error('VIDEO_MEDIA_INVALID');
      const rawKey = `mio/raw/${saved.assetId}/${saved.attemptId}`;
      let rawObject: Awaited<ReturnType<AssetObjectStore['head']>> | undefined;
      try {
        rawObject = await objects.head(rawKey);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      if (!rawObject) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stream = handle.createReadStream({ autoClose: false });
        stream.on('error', () => {});
        try {
          await objects.putVideo(rawKey, stream, saved.sizeBytes, saved.sha256, signal);
        } finally {
          stream.destroy();
          await handle.close();
        }
        rawObject = await objects.head(rawKey);
      }
      if (
        rawObject.size !== saved.sizeBytes ||
        rawObject.sha256 !== saved.sha256 ||
        !rawObject.etag
      )
        throw new Error('VIDEO_OBJECT_MISMATCH');
      outputs.push({
        index,
        assetId: saved.assetId,
        key: rawKey,
        etag: rawObject.etag,
        sha256: saved.sha256,
        sizeBytes: saved.sizeBytes,
        contentType: 'video/mp4',
        width: media.width,
        height: media.height,
        durationMs: Math.round(media.durationSeconds * 1000),
        hasAudio: media.hasAudio,
      });
    }
    return outputs;
  };
}

/** Only committed rows reach cleanup; failed and unknown checkpoints stay intact. */
export function createVideoCleanup(objects: AssetObjectStore, dataDirectory: string) {
  return async (row: VideoExecution, signal: AbortSignal) => {
    const directory = join(dataDirectory, 'video', row.id);
    for (let index = 0; index < (row.checkpoint?.videos.length ?? 0); index++) {
      signal.throwIfAborted();
      const receipt = join(directory, String(index) + '.json');
      let saved: SavedVideo;
      try {
        saved = JSON.parse(await readFile(receipt, 'utf8')) as SavedVideo;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (
        saved.jobId !== row.id ||
        saved.index !== index ||
        !/^[a-f0-9-]{36}$/.test(saved.assetId) ||
        !/^[a-f0-9-]{36}$/.test(saved.attemptId)
      )
        throw new Error('VIDEO_CHECKPOINT_INVALID');
      const raw = await objects.head(`mio/raw/${saved.assetId}/${saved.attemptId}`);
      if (raw.size !== saved.sizeBytes || raw.sha256 !== saved.sha256)
        throw new Error('VIDEO_OBJECT_MISMATCH');
      const staging = `mio/staging/video/${row.id}/${index}/${saved.attemptId}.media`;
      try {
        const value = await objects.head(staging);
        if (value.size !== saved.sizeBytes || value.sha256 !== saved.sha256)
          throw new Error('VIDEO_OBJECT_MISMATCH');
        await objects.delete(staging);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      try {
        await unlink(join(directory, String(index) + '.media'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await unlink(receipt);
    }
  };
}
