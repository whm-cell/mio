import { sha256Bytes } from '@mio/foundation/hash';
import { MEDIA_MAX_FILES, mediaObjectPrefix } from '@mio/compute-contracts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { AssetError } from '../../assets/contracts.ts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import { MediaError } from './model.ts';

export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const PLAYLIST_LIMIT = 256 * 1024;
const MASTER_NAME = 'master.m3u8';
const EXPIRY_MARGIN_SECONDS = 300;

interface HlsFile {
  asset_id: string;
  name: string;
  role: string;
  content_type: string;
  object_key: string;
  size_bytes: string;
  etag: string;
  sha256: string;
}
export interface MediaHlsPackage {
  attemptId: string;
  files: readonly HlsFile[];
}
interface HlsStore {
  hlsPackage(jobId: string, owner: string): Promise<MediaHlsPackage | undefined>;
}

export function mediaHlsPath(jobId: string, assetId?: string): string {
  return `/api/v1/compute/media/${jobId}/hls${assetId ? '/' + assetId : ''}`;
}
function invalid(): never {
  throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_HLS_INVALID');
}
function missing(): never {
  throw new MediaError(HTTP_STATUS.NOT_FOUND, 'MEDIA_HLS_NOT_FOUND');
}

async function readPlaylist(
  read: NonNullable<AssetObjectStore['readMedia']>,
  file: HlsFile,
  signal: AbortSignal,
): Promise<string[]> {
  const size = Number(file.size_bytes);
  if (!Number.isSafeInteger(size) || size <= 0 || size > PLAYLIST_LIMIT) invalid();
  let bytes: Uint8Array;
  try {
    bytes = await read(file.object_key, file.etag, size, signal);
  } catch (error) {
    if (
      (error instanceof AssetError && error.code === 'ASSET_SIZE_MISMATCH') ||
      (error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        (error.statusCode === 404 || error.statusCode === 412))
    )
      invalid();
    throw error;
  }
  signal.throwIfAborted();
  if (bytes.byteLength !== size || sha256Bytes(bytes) !== file.sha256) invalid();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  // Reject control characters, bare CR and other whitespace outside this closed format.
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines[0] !== '#EXTM3U' || lines.some((line) => !/^[\x21-\x7e]+$/.test(line))) invalid();
  return lines;
}

/** Only the Worker-generated master format is served. URI-bearing extension tags fail closed. */
function masterChildren(lines: string[]): string[] {
  if (lines[1] !== '#EXT-X-VERSION:3' || (lines.length !== 4 && lines.length !== 6)) invalid();
  const names: string[] = [];
  for (let index = 2; index < lines.length; index += 2) {
    const child = lines[index + 1]!;
    if (
      !/^#EXT-X-STREAM-INF:BANDWIDTH=[1-9][0-9]*,RESOLUTION=[1-9][0-9]*x[1-9][0-9]*$/.test(
        lines[index]!,
      ) ||
      !/^sub-(ordinary|720|480)\.m3u8$/.test(child)
    )
      invalid();
    names.push(child);
  }
  if (
    (names[0] !== 'sub-ordinary.m3u8' && names[0] !== 'sub-720.m3u8') ||
    (names.length === 2 && (names[0] !== 'sub-720.m3u8' || names[1] !== 'sub-480.m3u8'))
  )
    invalid();
  return names;
}

/** Child playlists can name only their own sequential TS pieces. */
function childPieces(lines: string[], childName: string) {
  if (lines.at(-1) !== '#EXT-X-ENDLIST') invalid();
  const headers = new Set<string>();
  let index = 1;
  while (index < lines.length - 1) {
    const tag =
      /^#EXT-X-(VERSION:[1-9][0-9]*|TARGETDURATION:[1-9][0-9]*|MEDIA-SEQUENCE:0|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS)$/.exec(
        lines[index]!,
      )?.[1];
    if (!tag) break;
    const name = tag.split(':')[0]!;
    if (headers.has(name)) invalid();
    headers.add(name);
    index++;
  }
  if (
    ['VERSION', 'TARGETDURATION', 'MEDIA-SEQUENCE', 'PLAYLIST-TYPE'].some(
      (tag) => !headers.has(tag),
    )
  )
    invalid();
  const rendition = childName.slice(4, -'.m3u8'.length);
  const ordinary = rendition === 'ordinary';
  const maxSegments = ordinary ? MEDIA_MAX_FILES - 4 : 120;
  const maxSeconds = ordinary ? 3600 : 720;
  const segments: { line: number; name: string; expiresIn: number }[] = [];
  let start = 0;
  for (; index < lines.length - 1; index += 2) {
    const duration = Number(/^#EXTINF:([0-9]+(?:\.[0-9]+)?),$/.exec(lines[index]!)?.[1]);
    const name = ordinary
      ? `sub-ordinary${segments.length}.ts`
      : `seg-${rendition}-${String(segments.length).padStart(3, '0')}.ts`;
    if (
      lines[index + 1] !== name ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      start + duration > maxSeconds + 0.35 ||
      (!ordinary && duration > 6.35) ||
      segments.length >= maxSegments
    )
      invalid();
    // VOD players can keep an ENDLIST playlist for the whole playback. Give
    // each piece enough lifetime to be fetched at its normal 1x start time.
    const expiresIn = Math.min(maxSeconds, Math.ceil(start)) + EXPIRY_MARGIN_SECONDS;
    segments.push({ line: index + 1, name, expiresIn });
    start += duration;
  }
  if (!segments.length) invalid();
  return segments;
}

export async function mediaHls(
  store: HlsStore,
  objects: Pick<AssetObjectStore, 'readMedia'>,
  signSegment: (key: string, expiresIn: number) => string,
  owner: string,
  jobId: string,
  assetId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const bundle = await store.hlsPackage(jobId, owner);
  if (!bundle) missing();
  const prefix = mediaObjectPrefix(jobId, bundle.attemptId);
  const files = new Map(bundle.files.map((file) => [file.name, file]));
  const master = files.get(MASTER_NAME);
  if (!master) missing();
  if (files.size !== bundle.files.length) invalid();
  const lookup = (name: string, role: 'hls' | 'segment') => {
    const file = files.get(name);
    const type = role === 'hls' ? HLS_PLAYLIST_CONTENT_TYPE : 'video/mp2t';
    if (
      !file ||
      file.role !== role ||
      file.content_type !== type ||
      file.object_key !== prefix + name
    )
      invalid();
    return file;
  };
  // Unknown or foreign child IDs never trigger storage reads.
  if (
    assetId &&
    !bundle.files.some(
      (file) => file.asset_id === assetId && file.name !== MASTER_NAME && file.role === 'hls',
    )
  )
    missing();
  const read = objects.readMedia;
  if (!read) throw new MediaError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
  const masterLines = await readPlaylist(read, lookup(MASTER_NAME, 'hls'), signal);
  const children = masterChildren(masterLines).map((name) => lookup(name, 'hls'));
  if (!assetId) {
    for (const [index, file] of children.entries())
      masterLines[3 + index * 2] = mediaHlsPath(jobId, file.asset_id);
    return masterLines.join('\n') + '\n';
  }
  const child = children.find((file) => file.asset_id === assetId);
  if (!child) missing();
  const childLines = await readPlaylist(read, child, signal);
  // Validate every reference against the same owner, job and attempt before signing.
  const pieces = childPieces(childLines, child.name).map((piece) => ({
    ...piece,
    key: lookup(piece.name, 'segment').object_key,
  }));
  signal.throwIfAborted();
  for (const { line, key, expiresIn } of pieces) childLines[line] = signSegment(key, expiresIn);
  return childLines.join('\n') + '\n';
}
