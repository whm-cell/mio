import { createHash } from 'node:crypto';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { constants, lstatSync, realpathSync, statfsSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, lstat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VideoProbeCommandV1, VideoProbeMetadataV1 } from '@mio/compute-contracts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import { waitForObjectHead } from '../../assets/contracts.ts';
import { withPublicHttps } from '../../integrations/onelink/public-https.ts';
import { VideoResultUrlExpired } from './execution.ts';
import type { VideoExecution, VideoMaterializer } from './execution.ts';

const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const VIDEO_CONTENT_TYPE = 'video/mp4';
const VIDEO_IO_TIMEOUT_MS = 180_000;
const READ_CHECKPOINT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const log = createLogger('app', 'video-media');

interface VideoDownload {
  path: string;
  owned: boolean;
}

const activeDownloads = new Map<string, Set<VideoDownload>>();

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

async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publish(
  temporary: string,
  path: string,
  mode: 'create' | 'update',
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let installed = true;
  if (mode === 'create') {
    try {
      // An overlapping claim may already have published this name.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      installed = false;
    }
    await unlink(temporary);
  } else {
    await rename(temporary, path);
  }
  await syncDirectory(dirname(path));
  signal.throwIfAborted();
  return installed;
}

async function save(
  path: string,
  saved: SavedVideo,
  signal: AbortSignal,
  mode: 'create' | 'update' = 'update',
) {
  signal.throwIfAborted();
  const temporary = path + '.' + createId();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(saved));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return publish(temporary, path, mode, signal);
}

async function readReceipt(path: string, jobId: string, index: number, signal: AbortSignal) {
  let saved: SavedVideo;
  try {
    saved = JSON.parse(
      await readFile(path, { encoding: 'utf8', flag: READ_CHECKPOINT_FLAGS, signal }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !saved ||
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
export { readReceipt as readVideoRecoveryReceipt };

async function digestFile(file: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const handle = await open(file, READ_CHECKPOINT_FLAGS).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!handle) return;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_VIDEO_BYTES)
      throw new Error('VIDEO_FILE_INVALID');
    const hash = createHash('sha256');
    const md5 = createHash('md5');
    let sizeBytes = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted();
      sizeBytes += bytes.length;
      if (sizeBytes > info.size) throw new Error('VIDEO_FILE_INVALID');
      hash.update(bytes);
      md5.update(bytes);
    }
    signal.throwIfAborted();
    if (sizeBytes !== info.size) throw new Error('VIDEO_FILE_INVALID');
    return { sizeBytes, sha256: hash.digest('hex'), contentMd5: md5.digest('base64') };
  } finally {
    await handle.close();
  }
}

function reserveVideoDownload(directory: string, pending: VideoDownload) {
  const active = activeDownloads.get(directory) ?? new Set<VideoDownload>();
  let requiredBytes = MIN_FREE_BYTES + MAX_VIDEO_BYTES;
  for (const current of active) {
    requiredBytes += MAX_VIDEO_BYTES;
    if (!current.owned) continue;
    const info = lstatSync(current.path, { throwIfNoEntry: false });
    // Free space already excludes allocated blocks, including from a partial write.
    if (info?.isFile()) requiredBytes -= Math.min(MAX_VIDEO_BYTES, info.size, info.blocks * 512);
  }
  // Sample last and register without yielding to another download in this executor.
  const space = statfsSync(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(requiredBytes)) throw new Error('VIDEO_DISK_FULL');
  active.add(pending);
  activeDownloads.set(directory, active);
  return () => {
    if (active.delete(pending) && !active.size) activeDownloads.delete(directory);
  };
}

async function writeDownloadedVideo(
  url: string,
  handle: FileHandle,
  signal: AbortSignal,
  download: typeof withPublicHttps,
) {
  signal.throwIfAborted();
  const hash = createHash('sha256');
  const md5 = createHash('md5');
  let sizeBytes = 0;
  await download(new URL(url), signal, async (response) => {
    signal.throwIfAborted();
    if ([401, 403, 404, 410].includes(response.status)) throw new VideoResultUrlExpired();
    if (response.status !== 200 || !response.body) throw new Error('VIDEO_DOWNLOAD_FAILED');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_VIDEO_BYTES))
      throw new Error('VIDEO_TOO_LARGE');
    for await (const bytes of response.body) {
      signal.throwIfAborted();
      sizeBytes += bytes.length;
      if (sizeBytes > MAX_VIDEO_BYTES) throw new Error('VIDEO_TOO_LARGE');
      hash.update(bytes);
      md5.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const written = await handle.write(bytes, offset, bytes.length - offset);
        if (!written.bytesWritten) throw new Error('VIDEO_STORAGE_FAILED');
        offset += written.bytesWritten;
      }
    }
    if (sizeBytes < 1 || (declared !== null && sizeBytes !== Number(declared)))
      throw new Error('VIDEO_DOWNLOAD_INCOMPLETE');
  });
  signal.throwIfAborted();
  await handle.sync();
  return { sizeBytes, sha256: hash.digest('hex'), contentMd5: md5.digest('base64') };
}

async function downloadVideo(
  url: string,
  file: string,
  signal: AbortSignal,
  download: typeof withPublicHttps,
  expected?: Pick<SavedVideo, 'sizeBytes' | 'sha256'>,
) {
  signal.throwIfAborted();
  const directory = realpathSync(dirname(dirname(file)));
  const temporary = file + '.' + createId();
  const pending: VideoDownload = { path: temporary, owned: false };
  const release = reserveVideoDownload(directory, pending);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    pending.owned = true;
    const actual = await writeDownloadedVideo(url, handle, signal, download).finally(() =>
      handle.close(),
    );
    if (expected && (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256))
      throw new Error('VIDEO_CHECKPOINT_INVALID');
    // From here publication only links and unlinks already allocated bytes.
    release();
    if (!(await publish(temporary, file, 'create', signal))) return;
    return actual;
  } catch (error) {
    // Preserve the original error and any canonical name already installed.
    if (pending.owned)
      await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== 'ENOENT') log.error('VIDEO_DOWNLOAD_CLEANUP_FAILED');
      });
    throw error;
  } finally {
    release();
  }
}

async function putStagingVideo(
  objects: AssetObjectStore,
  key: string,
  file: string,
  saved: SavedVideo,
  contentMd5: string,
  signal: AbortSignal,
) {
  if (!objects.putVideo) throw new Error('VIDEO_STORAGE_UNAVAILABLE');
  signal.throwIfAborted();
  const handle = await open(file, READ_CHECKPOINT_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== saved.sizeBytes) throw new Error('VIDEO_FILE_INVALID');
    const stream = handle.createReadStream({ autoClose: false, end: info.size - 1 });
    stream.on('error', () => {});
    try {
      signal.throwIfAborted();
      return (
        await objects.putVideo(key, stream, saved.sizeBytes, saved.sha256, contentMd5, signal)
      ).etag;
    } finally {
      stream.destroy();
    }
  } finally {
    await handle.close();
  }
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

function requireVerifiedMp4(media: VideoProbeMetadataV1 | undefined) {
  if (
    media?.container !== 'mp4' ||
    !Number.isFinite(media.durationSeconds) ||
    media.durationSeconds <= 0
  )
    throw new Error('VIDEO_MEDIA_INVALID');
  return media;
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
  const existingRaw = async (key: string, saved: SavedVideo, signal: AbortSignal) => {
    const object = await existingObject(key, signal);
    if (object) verifyVideoObject(object, saved, saved.rawEtag);
    else if (saved.rawEtag) throw new Error('VIDEO_OBJECT_MISMATCH');
    return object;
  };
  const copyVideo = async (
    source: string,
    target: string,
    etag: string,
    sha256: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const copied = await objects.copy(source, target, etag, 'private', {
      contentType: VIDEO_CONTENT_TYPE,
      sha256,
      signal,
    });
    signal.throwIfAborted();
    if (!copied?.etag) throw new Error('VIDEO_OBJECT_MISMATCH');
    return copied.etag;
  };
  return async (row, video, index, stop, freshResult?: boolean) => {
    const stagingSignal = AbortSignal.any([stop, AbortSignal.timeout(VIDEO_IO_TIMEOUT_MS)]);
    stagingSignal.throwIfAborted();
    const videoDirectory = join(dataDirectory, 'video');
    const directory = join(videoDirectory, row.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('VIDEO_DIRECTORY_INVALID');
    const file = join(directory, `${index}.media`);
    const receipt = join(directory, `${index}.json`);
    let saved = await readReceipt(receipt, row.id, index, stagingSignal);
    let contentMd5: string | undefined;
    let publishedMedia = false;
    if (!saved) {
      // Persist new directory entries before storing output identity or bytes in them.
      await syncDirectory(dataDirectory);
      await syncDirectory(videoDirectory);
      let actual = await digestFile(file, stagingSignal);
      if (!actual) {
        actual = await downloadVideo(video.url, file, stagingSignal, download);
        publishedMedia = actual !== undefined;
      }
      if (!actual) {
        // Another claim published the bytes. Prefer its receipt when it is already visible.
        saved = await readReceipt(receipt, row.id, index, stagingSignal);
        if (!saved) actual = await digestFile(file, stagingSignal);
      }
      if (actual) {
        const { contentMd5: md5, ...identity } = actual;
        const proposed = {
          jobId: row.id,
          index,
          assetId: createId(),
          attemptId: createId(),
          ...identity,
        };
        if (await save(receipt, proposed, stagingSignal, 'create')) {
          contentMd5 = md5;
          saved = proposed;
        } else {
          saved = await readReceipt(receipt, row.id, index, stagingSignal);
        }
      }
    }
    if (!saved) throw new Error('VIDEO_CHECKPOINT_INVALID');
    const createdReceipt = contentMd5 !== undefined;
    let skipPrewriteHead = freshResult === true && publishedMedia && createdReceipt;
    const reconcileTargetCollision = (error: unknown) => {
      const failure = error as { statusCode?: number; code?: string } | null;
      if (!skipPrewriteHead || failure?.statusCode !== 409 || failure.code !== 'FileAlreadyExists')
        throw error;
      // Verify the competing object with HEAD and check any later target before writing.
      skipPrewriteHead = false;
      return undefined;
    };
    // The name may be visible before its publisher finishes syncing the directory.
    if (!createdReceipt) await syncDirectory(directory);
    const key = `mio/staging/video/${row.id}/${index}/${saved.attemptId}.media`;
    const rawKey = `mio/raw/${saved.assetId}/${saved.attemptId}`;
    let rawObject = createdReceipt ? undefined : await existingRaw(rawKey, saved, stagingSignal);
    let finalizingSignal = stagingSignal;
    const needsProbe = saved.media?.container !== 'mp4';
    let object =
      !skipPrewriteHead && (needsProbe || !rawObject)
        ? await existingObject(key, stagingSignal)
        : undefined;
    if (object) verifyVideoObject(object, saved, saved.etag);
    const rebuildStage = !!saved.media && !rawObject && !object;
    let media: VideoProbeMetadataV1;
    if (needsProbe || rebuildStage) {
      if (!object) {
        if (!rawObject && contentMd5 === undefined) {
          const actual =
            (await digestFile(file, stagingSignal)) ??
            (await downloadVideo(video.url, file, stagingSignal, download, saved)) ??
            (await digestFile(file, stagingSignal));
          if (!actual || actual.sha256 !== saved.sha256 || actual.sizeBytes !== saved.sizeBytes)
            throw new Error('VIDEO_CHECKPOINT_INVALID');
          contentMd5 = actual.contentMd5;
        }
        if (saved.media) {
          // Persist the pending probe before restoring the missing key, even if the write reply is lost.
          if (rawObject) saved.rawEtag = rawObject.etag;
          delete saved.media;
          delete saved.etag;
          await save(receipt, saved, stagingSignal);
        }
        let stagedEtag: string | undefined;
        if (rawObject && saved.rawEtag) {
          stagedEtag = await copyVideo(rawKey, key, saved.rawEtag, saved.sha256, stagingSignal);
        } else {
          if (contentMd5 === undefined) throw new Error('VIDEO_CHECKPOINT_INVALID');
          stagedEtag = await putStagingVideo(
            objects,
            key,
            file,
            saved,
            contentMd5,
            stagingSignal,
          ).catch(reconcileTargetCollision);
        }
        object = await readHead(key, stagingSignal);
        verifyVideoObject(object, saved, stagedEtag);
      }
      stagingSignal.throwIfAborted();
      // Compute owns its queue, execution, and reply deadlines.
      const result = await probe(
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
        stop,
      );
      media = requireVerifiedMp4(result);
      finalizingSignal = AbortSignal.any([stop, AbortSignal.timeout(VIDEO_IO_TIMEOUT_MS)]);
      saved.media = media;
      saved.etag = object.etag;
      await save(receipt, saved, finalizingSignal);
    } else {
      media = requireVerifiedMp4(saved.media);
    }
    if (!skipPrewriteHead && (createdReceipt || rebuildStage))
      rawObject = await existingRaw(rawKey, saved, finalizingSignal);
    if (!rawObject) {
      if (!saved.etag) throw new Error('VIDEO_OBJECT_MISMATCH');
      const copiedEtag = await copyVideo(
        key,
        rawKey,
        saved.etag,
        saved.sha256,
        finalizingSignal,
      ).catch(reconcileTargetCollision);
      if (copiedEtag !== undefined) {
        saved.rawEtag = copiedEtag;
        await save(receipt, saved, finalizingSignal);
      }
      rawObject = await readHead(rawKey, finalizingSignal);
      verifyVideoObject(rawObject, saved, saved.rawEtag);
    }
    if (!saved.rawEtag) {
      saved.rawEtag = rawObject.etag;
      await save(receipt, saved, finalizingSignal);
    }
    finalizingSignal.throwIfAborted();
    return {
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
    };
  };
}

/** Only committed rows reach cleanup; failed and unknown checkpoints stay intact. */
export function createVideoCleanup(objects: AssetObjectStore, dataDirectory: string) {
  return async (row: VideoExecution, signal: AbortSignal) => {
    const directory = join(dataDirectory, 'video', row.id);
    for (let index = 0; index < (row.checkpoint?.videos.length ?? 0); index++) {
      signal.throwIfAborted();
      const receipt = join(directory, String(index) + '.json');
      const saved = await readReceipt(receipt, row.id, index, signal);
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
        await objects.delete(staging, signal);
      } catch (error) {
        signal.throwIfAborted();
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      signal.throwIfAborted();
      try {
        await unlink(join(directory, String(index) + '.media'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      signal.throwIfAborted();
      await unlink(receipt);
    }
  };
}
