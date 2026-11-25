import { createHash } from 'node:crypto';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, statfs, lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VideoProbeCommandV1, VideoProbeMetadataV1 } from '@mio/compute-contracts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import { waitForObjectHead } from '../assets/contracts.ts';
import { withPublicHttps } from '../integrations/onelink/public-https.ts';
import type {
  VideoExecution,
  VideoMaterializer,
  VideoMaterializedOutput,
} from './video-execution.ts';

const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const VIDEO_CONTENT_TYPE = 'video/mp4';

interface SavedVideo {
  jobId: string;
  index: number;
  assetId: string;
  attemptId: string;
  sha256: string;
  sizeBytes: number;
  etag?: string;
  media?: VideoProbeMetadataV1;
  rawEtag?: string;
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

async function readReceipt(path: string, jobId: string, index: number) {
  let saved: SavedVideo;
  try {
    saved = JSON.parse(await readFile(path, 'utf8')) as SavedVideo;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    saved.jobId !== jobId ||
    saved.index !== index ||
    !isUuidV4(saved.assetId) ||
    !isUuidV4(saved.attemptId) ||
    !/^[a-f0-9]{64}$/.test(saved.sha256) ||
    !Number.isSafeInteger(saved.sizeBytes) ||
    saved.sizeBytes < 1 ||
    saved.sizeBytes > MAX_VIDEO_BYTES ||
    (saved.media && (typeof saved.etag !== 'string' || !saved.etag))
  )
    throw new Error('VIDEO_CHECKPOINT_INVALID');
  return saved;
}

async function digestFile(file: string, signal: AbortSignal) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_VIDEO_BYTES)
      throw new Error('VIDEO_FILE_INVALID');
    const hash = createHash('sha256');
    const md5 = createHash('md5');
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(bytes);
      md5.update(bytes);
    }
    return { sizeBytes: info.size, sha256: hash.digest('hex'), contentMd5: md5.digest('base64') };
  } finally {
    await handle.close();
  }
}

async function downloadVideo(
  url: string,
  file: string,
  signal: AbortSignal,
  download: typeof withPublicHttps,
  expected?: Pick<SavedVideo, 'sizeBytes' | 'sha256'>,
) {
  const space = await statfs(dirname(file), { bigint: true });
  if (space.bavail * space.bsize < BigInt(MAX_VIDEO_BYTES + 64 * 1024 * 1024))
    throw new Error('VIDEO_DISK_FULL');
  const temporary = file + '.' + createId();
  const handle = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  const md5 = createHash('md5');
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
        md5.update(bytes);
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
  const sha256 = hash.digest('hex');
  if (expected && (sizeBytes !== expected.sizeBytes || sha256 !== expected.sha256)) {
    await unlink(temporary);
    throw new Error('VIDEO_CHECKPOINT_INVALID');
  }
  await rename(temporary, file);
  return { sizeBytes, sha256, contentMd5: md5.digest('base64') };
}

function verifyVideoObject(
  object: Awaited<ReturnType<AssetObjectStore['head']>>,
  saved: SavedVideo,
  expectedEtag?: string,
) {
  if (
    object.size !== saved.sizeBytes ||
    object.sha256 !== saved.sha256 ||
    object.contentType !== VIDEO_CONTENT_TYPE ||
    !object.etag ||
    (expectedEtag !== undefined && object.etag !== expectedEtag)
  )
    throw new Error('VIDEO_OBJECT_MISMATCH');
}

/** Keep the durable media receipt until its asset transaction has committed. */
export function createVideoMaterializer(
  objects: AssetObjectStore,
  dataDirectory: string,
  probe: VideoProbe,
  download: typeof withPublicHttps = withPublicHttps,
): VideoMaterializer {
  const readHead = (key: string, signal: AbortSignal) =>
    waitForObjectHead(() => objects.head(key, signal), signal);
  const existingObject = (key: string, signal: AbortSignal) =>
    readHead(key, signal).catch((error: unknown) => {
      signal.throwIfAborted();
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return;
      throw error;
    });
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
      let saved = await readReceipt(receipt, row.id, index);
      let contentMd5: string | undefined;
      if (saved) {
        const actual = await digestFile(file, signal).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return;
          throw error;
        });
        if (actual && (actual.sha256 !== saved.sha256 || actual.sizeBytes !== saved.sizeBytes))
          throw new Error('VIDEO_CHECKPOINT_INVALID');
        contentMd5 = actual?.contentMd5;
      } else {
        const { contentMd5: md5, ...actual } = await downloadVideo(
          video.url,
          file,
          signal,
          download,
        );
        contentMd5 = md5;
        saved = { jobId: row.id, index, assetId: createId(), attemptId: createId(), ...actual };
        await save(receipt, saved);
      }
      const key = `mio/staging/video/${row.id}/${index}/${saved.attemptId}.media`;
      if (!saved.media) {
        let object = await existingObject(key, signal);
        signal.throwIfAborted();
        let uploadedEtag: string | undefined;
        if (!object) {
          contentMd5 ??= (await downloadVideo(video.url, file, signal, download, saved)).contentMd5;
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stream = handle.createReadStream({ autoClose: false });
          stream.on('error', () => {});
          try {
            const uploaded = await objects.putVideo(
              key,
              stream,
              saved.sizeBytes,
              saved.sha256,
              contentMd5,
              signal,
            );
            uploadedEtag = uploaded.etag;
          } finally {
            stream.destroy();
            await handle.close();
          }
          object = await readHead(key, signal);
        }
        verifyVideoObject(object, saved, uploadedEtag);
        signal.throwIfAborted();
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
        saved.etag = object.etag;
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
      let rawObject = await existingObject(rawKey, signal);
      signal.throwIfAborted();
      if (!rawObject) {
        if (saved.rawEtag || !saved.etag) throw new Error('VIDEO_OBJECT_MISMATCH');
        const copied = await objects.copy(key, rawKey, saved.etag, 'private', {
          contentType: VIDEO_CONTENT_TYPE,
          sha256: saved.sha256,
          signal,
        });
        signal.throwIfAborted();
        if (!copied?.etag) throw new Error('VIDEO_OBJECT_MISMATCH');
        saved.rawEtag = copied.etag;
        await save(receipt, saved);
        rawObject = await readHead(rawKey, signal);
      }
      verifyVideoObject(rawObject, saved, saved.rawEtag);
      signal.throwIfAborted();
      if (!saved.rawEtag) {
        saved.rawEtag = rawObject.etag;
        await save(receipt, saved);
      }
      signal.throwIfAborted();
      outputs.push({
        index,
        assetId: saved.assetId,
        key: rawKey,
        etag: rawObject.etag,
        sha256: saved.sha256,
        sizeBytes: saved.sizeBytes,
        contentType: VIDEO_CONTENT_TYPE,
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
      const saved = await readReceipt(receipt, row.id, index);
      if (!saved) continue;
      const rawKey = `mio/raw/${saved.assetId}/${saved.attemptId}`;
      const raw = await waitForObjectHead(() => objects.head(rawKey, signal), signal);
      signal.throwIfAborted();
      verifyVideoObject(raw, saved, saved.rawEtag);
      const staging = `mio/staging/video/${row.id}/${index}/${saved.attemptId}.media`;
      try {
        const value = await waitForObjectHead(() => objects.head(staging, signal), signal);
        verifyVideoObject(value, saved, saved.etag);
        signal.throwIfAborted();
        await objects.delete(staging);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      signal.throwIfAborted();
      try {
        await unlink(join(directory, String(index) + '.media'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await unlink(receipt);
    }
  };
}
