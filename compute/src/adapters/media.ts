import { ApplicationError } from '@mio/foundation/errors';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AUDIO_INSPECTION_LIMITS,
  AUDIO_MIME_TYPES,
  COMPUTE_MAX_MEDIA_BYTES,
} from '@mio/compute-contracts';
import type {
  AudioInspectCommandV1,
  AudioInspection,
  VideoProbeMetadataV1,
} from '@mio/compute-contracts';
import { isVideoTrack, videoDisplayGeometry } from '../video-display.ts';
import type { VideoDisplayStream } from '../video-display.ts';

const MAX_DIRECTORY_BYTES = 10 * 1024 ** 3;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const VIDEO_PROBE_PREFIX = '.video-probe-';
const VIDEO_PROBE_SUFFIX = '.media';
const PROCESS_STDOUT_LIMIT = 64 * 1024;
const PROCESS_STDERR_LIMIT = 256 * 1024;
const MP4_PROBE_INPUT = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov',
  '-enable_drefs',
  '0',
];

export class MediaError extends ApplicationError<
  | 'INPUT_INVALID'
  | 'INPUT_TOO_LONG'
  | 'INPUT_CHANGED'
  | 'TRANSCODE_FAILED'
  | 'OUTPUT_INVALID'
  | 'EXECUTION_TIMEOUT'
  | 'DISK_FULL'
  | 'SOURCE_INVALID'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_CHANGED'
  | 'PROBE_FAILED'
> {
  constructor(code: MediaError['code']) {
    super(code);
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Explicit creation is separate from startup; startup never creates a missing journal. */
export function prepareJournalFile(directory: string, initialize: boolean): string {
  const root = resolve(directory);
  if (initialize) mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = lstatSync(root);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (dir.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && dir.uid !== process.getuid())
  )
    throw new Error('JOURNAL_DIRECTORY_INVALID');
  const path = join(root, 'journal.sqlite3');
  const flags =
    constants.O_RDWR |
    constants.O_NOFOLLOW |
    (initialize ? constants.O_CREAT | constants.O_EXCL : 0);
  const fd = openSync(path, flags, 0o600);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (initialize) syncPath(root);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('JOURNAL_FILE_INVALID');
  return path;
}

export function paths(
  directory: string,
  attemptId: string,
): { input: string; temporary: string; output: string } {
  if (!isUuidV4(attemptId)) throw new Error('ATTEMPT_ID_INVALID');
  const root = resolve(directory);
  return {
    input: join(root, `${attemptId}.input`),
    temporary: join(root, `${attemptId}.partial.mp4`),
    output: join(root, `${attemptId}.mp4`),
  };
}

export function probePath(directory: string, messageId: string): string {
  if (!isUuidV4(messageId)) throw new Error('VIDEO_PROBE_ID_INVALID');
  return join(resolve(directory), `${VIDEO_PROBE_PREFIX}${messageId}${VIDEO_PROBE_SUFFIX}`);
}

/** Remove only the regular probe file derived from a UUID in the private worker directory. */
export function removeProbeFile(directory: string, messageId: string): void {
  if (!unlinkRegularProbeFile(probePath(directory, messageId)))
    throw new Error('VIDEO_PROBE_FILE_INVALID');
}

/** Sweep under the instance journal lock before starting any consumers. */
export function removeOrphanProbeFiles(directory: string): void {
  const root = resolve(directory);
  for (const name of readdirSync(root)) {
    if (!name.startsWith(VIDEO_PROBE_PREFIX) || !name.endsWith(VIDEO_PROBE_SUFFIX)) continue;
    const messageId = name.slice(VIDEO_PROBE_PREFIX.length, -VIDEO_PROBE_SUFFIX.length);
    if (isUuidV4(messageId)) unlinkRegularProbeFile(join(root, name));
  }
}

function unlinkRegularProbeFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return true;
}

function directoryBytes(path: string, onFile?: (path: string, stat: Stats) => void): number {
  let size = 0;
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('WORK_DIRECTORY_SYMLINK');
    if (stat.isDirectory()) size += directoryBytes(child, onFile);
    else {
      size += stat.size;
      if (onFile && stat.isFile()) onFile(child, stat);
    }
  }
  return size;
}

export function requireSpace(directory: string, incomingBytes = 0): void {
  const fs = statfsSync(directory);
  if (
    directoryBytes(directory) + incomingBytes >= MAX_DIRECTORY_BYTES ||
    fs.bavail * fs.bsize < MIN_FREE_BYTES + incomingBytes
  ) {
    throw new MediaError('DISK_FULL');
  }
}

/** Reserve both the worker-directory budget and filesystem safety margin before a probe download. */
export function requireProbeSpace(
  directory: string,
  expectedBytes: number,
  activeDownloads: ReadonlyMap<string, number>,
): void {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > COMPUTE_MAX_MEDIA_BYTES
  )
    throw new MediaError(
      expectedBytes > COMPUTE_MAX_MEDIA_BYTES ? 'SOURCE_TOO_LARGE' : 'SOURCE_INVALID',
    );
  let unwrittenBytes = expectedBytes;
  for (const bytes of activeDownloads.values()) unwrittenBytes += bytes;
  let unallocatedBytes = unwrittenBytes;
  const currentDirectoryBytes = directoryBytes(resolve(directory), (path, stat) => {
    const reserved = activeDownloads.get(path);
    if (reserved === undefined) return;
    const written = Math.min(reserved, stat.size);
    unwrittenBytes -= written;
    // lstat reports allocated blocks in 512-byte units.
    unallocatedBytes -= Math.min(written, stat.blocks * 512);
  });
  // Sample free space last so it reflects writes that raced with the walk.
  const fs = statfsSync(directory);
  if (
    currentDirectoryBytes + unwrittenBytes > MAX_DIRECTORY_BYTES ||
    fs.bavail * fs.bsize < MIN_FREE_BYTES + unallocatedBytes
  )
    throw new MediaError('DISK_FULL');
}

export function processIdentity(): string | null {
  try {
    if (process.platform === 'linux') {
      return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${readlinkSync('/proc/self/ns/pid')}`;
    }
    if (process.platform === 'darwin') {
      const value = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      return value.status === 0 && value.stdout.trim() ? `darwin:${value.stdout.trim()}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function processGone(pid: number | null, identity: string | null): boolean {
  if (!pid || !identity || processIdentity() !== identity) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function createInput(directory: string, attemptId: string) {
  return createWriteStream(paths(directory, attemptId).input, { flags: 'wx', mode: 0o600 });
}

export function readOutput(directory: string, attemptId: string) {
  return createReadStream(paths(directory, attemptId).output);
}

function finishInput(directory: string, attemptId: string): void {
  syncPath(paths(directory, attemptId).input);
  syncPath(resolve(directory));
}

export async function fileDigest(
  path: string,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string; md5: string }> {
  const hash = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
    md5.update(bytes);
  }
  return { size, sha256: hash.digest('hex'), md5: md5.digest('base64') };
}

export async function digestStream(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const abort = () => stream.destroy(new Error('EXECUTION_TIMEOUT'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > maxBytes) throw new Error('OBJECT_TOO_LARGE');
      hash.update(bytes);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
  return { size, sha256: hash.digest('hex') };
}

export async function drainInput(
  source: Readable,
  directory: string,
  attemptId: string,
  size: number,
  signal: AbortSignal,
): Promise<void> {
  let received = 0;
  const { Transform } = await import('node:stream');
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > size || received > COMPUTE_MAX_MEDIA_BYTES)
        callback(new Error('INPUT_TOO_LARGE'));
      else callback(null, chunk);
    },
  });
  await pipeline(source, limit, createInput(directory, attemptId), { signal });
  if (received !== size) throw new Error('INPUT_SIZE_MISMATCH');
  finishInput(directory, attemptId);
}

/** Stream a private staging object to a private temporary file and verify actual bytes/digest. */
export async function drainProbeInput(
  source: Readable,
  directory: string,
  messageId: string,
  expectedSize: number,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<string> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > COMPUTE_MAX_MEDIA_BYTES ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) {
    source.destroy();
    throw new MediaError(
      expectedSize > COMPUTE_MAX_MEDIA_BYTES ? 'SOURCE_TOO_LARGE' : 'SOURCE_INVALID',
    );
  }
  const path = probePath(directory, messageId);
  removeProbeFile(directory, messageId);
  const hash = createHash('sha256');
  let received = 0;
  const { Transform } = await import('node:stream');
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > expectedSize || received > COMPUTE_MAX_MEDIA_BYTES) {
        callback(new MediaError('SOURCE_TOO_LARGE'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, inspect, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
      signal,
    });
    const sha256 = hash.digest('hex');
    if (received !== expectedSize || sha256 !== expectedSha256)
      throw new MediaError('SOURCE_CHANGED');
    return path;
  } catch (error) {
    removeProbeFile(directory, messageId);
    if (signal.aborted) throw new MediaError('EXECUTION_TIMEOUT');
    throw error;
  }
}

type ProcessResult = {
  stdout: string;
  stderrBytes: number;
  exitCode: number | null;
  aborted: boolean;
};

async function runProcess(
  binary: string,
  args: string[],
  signal: AbortSignal,
  onSpawn?: (pid: number) => void,
  captureStdout?: (data: Buffer) => void,
): Promise<ProcessResult> {
  if (signal.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '';
  let captureError: unknown;
  let stderrBytes = 0;
  child.stdout.on('data', (data: Buffer) => {
    if (captureStdout) {
      if (captureError !== undefined) return;
      try {
        captureStdout(data);
      } catch (error) {
        captureError = error;
        child.kill('SIGKILL');
      }
      return;
    }
    stdout += data.toString('utf8');
    if (stdout.length > PROCESS_STDOUT_LIMIT) child.kill('SIGKILL');
  });
  child.stderr.on('data', (data: Buffer) => {
    stderrBytes += data.length;
    if (stderrBytes > PROCESS_STDERR_LIMIT) child.kill('SIGKILL');
  });
  let aborted = false;
  const abort = () => {
    aborted = true;
    child.kill('SIGKILL');
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    if (child.pid && onSpawn) onSpawn(child.pid);
    const result = await new Promise<ProcessResult>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolvePromise({ stdout, stderrBytes, exitCode, aborted }));
    });
    if (captureError !== undefined) throw captureError;
    return result;
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

interface ProbeStream extends VideoDisplayStream {
  codec_name?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface Probe {
  duration: number;
  streams: ProbeStream[];
}

/** The transcode envelope compares rotated encoded dimensions with conservative rounding. */
function transcodeDisplaySize(stream: ProbeStream | undefined) {
  if (
    !stream?.width ||
    !stream.height ||
    !Number.isSafeInteger(stream.width) ||
    !Number.isSafeInteger(stream.height) ||
    stream.width < 1 ||
    stream.height < 1
  )
    return null;
  const rotation =
    stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ??
    Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(rotation)) return null;
  const angle = ((rotation % 360) * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(angle));
  const sine = Math.abs(Math.sin(angle));
  return {
    width: Math.ceil(stream.width * cosine + stream.height * sine - 1e-8),
    height: Math.ceil(stream.width * sine + stream.height * cosine - 1e-8),
  };
}

async function probe(path: string, signal: AbortSignal): Promise<Probe> {
  const result = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,matroska,webm,avi,mpegts',
      '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:stream_tags=rotate',
      '-of',
      'json',
      path,
    ],
    signal,
  );
  if (result.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  if (result.exitCode !== 0) throw new MediaError('INPUT_INVALID');
  const value = JSON.parse(result.stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Probe['streams'];
  };
  const duration = Number(value.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    typeof value.format?.format_name !== 'string' ||
    value.format.format_name.length > 128 ||
    !Array.isArray(value.streams)
  )
    throw new MediaError('INPUT_INVALID');
  if (duration > 1800) throw new MediaError('INPUT_TOO_LONG');
  if (!value.streams.some((stream) => stream.codec_type === 'video'))
    throw new MediaError('INPUT_INVALID');
  return { duration, streams: value.streams };
}

async function hasMp4Brand(file: FileHandle, offset: number, length: number): Promise<boolean> {
  if (length < 8 || length > PROCESS_STDOUT_LIMIT || length % 4 !== 0) return false;
  const brands = Buffer.alloc(length);
  if ((await file.read(brands, 0, length, offset)).bytesRead !== length) return false;
  const major = brands.toString('latin1', 0, 4);
  if (major === 'qt  ' || major.startsWith('3g')) return false;
  if (/^(?:iso[m2-9abc]|mp4[12]|avc1|av01|dash|cmfc|M4V )$/.test(major)) return true;
  for (let position = 8; position < length; position += 4) {
    const compatible = brands.toString('latin1', position, position + 4);
    if (compatible === 'mp41' || compatible === 'mp42') return true;
  }
  return false;
}

async function* mp4Boxes(file: FileHandle, start: number, end: number, signal: AbortSignal) {
  const header = Buffer.alloc(8);
  for (let offset = start; offset < end;) {
    signal.throwIfAborted();
    if (end - offset < 8 || (await file.read(header, 0, 8, offset)).bytesRead !== 8)
      throw new MediaError('SOURCE_INVALID');
    const type = header.toString('latin1', 4);
    const declared = header.readUInt32BE(0);
    const headerSize = declared === 1 ? 16 : 8;
    let size = declared === 0 ? end - offset : declared;
    if (declared === 1) {
      if (end - offset < 16 || (await file.read(header, 0, 8, offset + 8)).bytesRead !== 8)
        throw new MediaError('SOURCE_INVALID');
      size = Number(header.readBigUInt64BE());
    }
    if (size < headerSize || size > end - offset) throw new MediaError('SOURCE_INVALID');
    yield { type, offset, payload: offset + headerSize, end: offset + size, toEnd: declared === 0 };
    offset += size;
  }
}

/** A segment index can declare more whole fragments even when the file ends on a box boundary. */
async function requireSegmentIndexExtent(
  file: FileHandle,
  payload: number,
  end: number,
  fileEnd: number,
  signal: AbortSignal,
): Promise<void> {
  const header = Buffer.alloc(32);
  const headerBytes = Math.min(header.length, end - payload);
  if (
    headerBytes < 24 ||
    (await file.read(header, 0, headerBytes, payload)).bytesRead !== headerBytes
  )
    throw new MediaError('SOURCE_INVALID');
  const version = header.readUInt8();
  const headerSize = version === 0 ? 24 : 32;
  if (version > 1 || headerBytes < headerSize) throw new MediaError('SOURCE_INVALID');
  const rowSize = 12;
  const tableSize = header.readUInt16BE(headerSize - 2) * rowSize;
  if (tableSize === 0) return;
  const tableStart = payload + headerSize;
  const firstOffset = version === 0 ? BigInt(header.readUInt32BE(16)) : header.readBigUInt64BE(20);
  if (tableSize > end - tableStart || firstOffset > BigInt(fileEnd - end))
    throw new MediaError('SOURCE_INVALID');
  signal.throwIfAborted();
  const references = Buffer.alloc(tableSize);
  if ((await file.read(references, 0, tableSize, tableStart)).bytesRead !== tableSize)
    throw new MediaError('SOURCE_INVALID');
  let referencedEnd = end + Number(firstOffset);
  for (let row = 0; row < tableSize; row += rowSize) {
    referencedEnd += references.readUInt32BE(row) & 0x7fffffff;
  }
  if (referencedEnd > fileEnd) throw new MediaError('SOURCE_INVALID');
}

interface OpenMp4Media {
  end: number;
  firstFragment: number;
  hasInitialMedia: boolean;
}

/** Check physical box extents before relying on metadata from the shared MOV demuxer. */
async function requireMp4File(path: string, signal: AbortSignal): Promise<OpenMp4Media | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new MediaError('SOURCE_INVALID');
    let identified = false;
    let movie = false;
    let media = false;
    let openMedia = false;
    let fragmentAwaitingMedia = false;
    let hasInitialMedia = false;
    let firstFragment = stat.size;
    for await (const { type, offset, payload, end, toEnd } of mp4Boxes(
      file,
      0,
      stat.size,
      signal,
    )) {
      if (type === 'ftyp') {
        if (identified || !(await hasMp4Brand(file, payload, end - payload)))
          throw new MediaError('SOURCE_INVALID');
        identified = true;
      }
      if (type === 'moov' && end > payload) movie = true;
      if (type === 'sidx') await requireSegmentIndexExtent(file, payload, end, stat.size, signal);
      if (type === 'moof') {
        if (firstFragment === stat.size) firstFragment = offset;
        fragmentAwaitingMedia = true;
      }
      if (type === 'mdat') {
        openMedia ||= toEnd;
        if (end > payload) {
          media = true;
          fragmentAwaitingMedia = false;
          hasInitialMedia ||= firstFragment === stat.size;
        }
      }
    }
    if (!identified || !movie || !media) throw new MediaError('SOURCE_INVALID');
    return openMedia || fragmentAwaitingMedia
      ? { end: stat.size, firstFragment, hasInitialMedia }
      : null;
  } finally {
    await file.close();
  }
}

async function fragmentTrackSamples(
  file: FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  const body = Buffer.alloc(8);
  let id = 0;
  let count = 0;
  for await (const box of mp4Boxes(file, start, end, signal)) {
    if (box.type !== 'tfhd' && box.type !== 'trun') continue;
    if (box.end - box.payload < 8 || (await file.read(body, 0, 8, box.payload)).bytesRead !== 8)
      throw new MediaError('SOURCE_INVALID');
    const value = body.readUInt32BE(4);
    if (box.type === 'tfhd') {
      if (id !== 0 || value === 0) throw new MediaError('SOURCE_INVALID');
      id = value;
    } else {
      count += value;
    }
  }
  if (id === 0 || !Number.isSafeInteger(count)) throw new MediaError('SOURCE_INVALID');
  return { id, count };
}

/** Count declared samples from the visible fragment headers. */
async function readFragmentSampleCounts(
  path: string,
  layout: OpenMp4Media,
  trackIds: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<ReadonlyMap<number, number>> {
  const counts = new Map<number, number>();
  if (layout.firstFragment === layout.end) return counts;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const fragment of mp4Boxes(file, layout.firstFragment, layout.end, signal)) {
      if (fragment.type !== 'moof') continue;
      for await (const track of mp4Boxes(file, fragment.payload, fragment.end, signal)) {
        if (track.type !== 'traf') continue;
        const { id, count } = await fragmentTrackSamples(file, track.payload, track.end, signal);
        if (!trackIds.has(id)) continue;
        const total = (counts.get(id) ?? 0) + count;
        if (!Number.isSafeInteger(total)) throw new MediaError('SOURCE_INVALID');
        counts.set(id, total);
      }
    }
    return counts;
  } finally {
    await file.close();
  }
}

function requireCleanProbe(result: ProcessResult): void {
  if (result.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  if (result.stderrBytes > PROCESS_STDERR_LIMIT || result.stdout.length > PROCESS_STDOUT_LIMIT)
    throw new MediaError('SOURCE_INVALID');
  // A process killed outside the local time and output limits did not finish validating the source.
  if (result.exitCode === null) throw new MediaError('PROBE_FAILED');
  if (result.exitCode !== 0 || result.stderrBytes !== 0) throw new MediaError('SOURCE_INVALID');
}

interface VideoPacketTime {
  pts: number;
  seconds: number;
}

async function scanMp4Packets(
  path: string,
  signal: AbortSignal,
  entries: string,
  readRecord: (line: string) => void,
  raw = false,
): Promise<void> {
  let remainder = '';
  const result = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      ...MP4_PROBE_INPUT,
      ...(raw ? ['-ignore_editlist', '1'] : []),
      '-fflags',
      raw ? '+noparse+nofillin+discardcorrupt' : '+noparse+nofillin',
      '-show_entries',
      entries,
      '-of',
      'compact',
      path,
    ],
    signal,
    undefined,
    (chunk) => {
      const lines = (remainder + chunk.toString('utf8')).split('\n');
      remainder = lines.pop()!;
      if (remainder.length > 128) throw new MediaError('SOURCE_INVALID');
      for (const line of lines) readRecord(line);
    },
  );
  requireCleanProbe(result);
  if (remainder) throw new MediaError('SOURCE_INVALID');
}

/** Demux every packet for short reads and retain only the last presentation timestamp. */
async function lastVideoPacket(
  path: string,
  streamIndex: number,
  signal: AbortSignal,
): Promise<VideoPacketTime> {
  let last: VideoPacketTime | undefined;
  await scanMp4Packets(
    path,
    signal,
    'packet=stream_index,pts,pts_time,flags:packet_side_data=',
    (line) => {
      const packet =
        /^packet\|stream_index=(\d+)\|pts=(-?\d+|N\/A)\|pts_time=([^|]+)\|flags=([A-Z_]+)\|*$/.exec(
          line,
        );
      if (!packet || packet[4]!.includes('C')) throw new MediaError('SOURCE_INVALID');
      if (Number(packet[1]) !== streamIndex || packet[4]!.includes('D')) return;
      const pts = Number(packet[2]);
      const seconds = Number(packet[3]);
      if (!Number.isSafeInteger(pts) || !Number.isFinite(seconds))
        throw new MediaError('SOURCE_INVALID');
      if (!last || pts > last.pts) last = { pts, seconds };
    },
  );
  if (!last) throw new MediaError('SOURCE_INVALID');
  return last;
}

/** A missing sample at EOF can leave the demuxer with a clean exit. */
async function requireDeclaredMp4Samples(
  path: string,
  layout: OpenMp4Media,
  trackIds: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<void> {
  const fragments = await readFragmentSampleCounts(path, layout, trackIds, signal);
  const reads = new Map<
    number,
    { packets: number; initialPackets: number; initialDuration: number }
  >();
  await scanMp4Packets(
    path,
    signal,
    'packet=stream_index,duration,pos,flags:packet_side_data=:stream=index,codec_name,codec_type,id,duration_ts,nb_frames',
    (line) => {
      const packet =
        /^packet\|stream_index=(\d+)\|duration=(\d+|N\/A)\|pos=(\d+|N\/A)\|flags=([A-Z_]+)\|*$/.exec(
          line,
        );
      if (packet) {
        if (packet[4]!.includes('C')) throw new MediaError('SOURCE_INVALID');
        const index = Number(packet[1]);
        const read = reads.get(index) ?? { packets: 0, initialPackets: 0, initialDuration: 0 };
        read.packets++;
        if (Number(packet[3]) < layout.firstFragment) {
          read.initialPackets++;
          read.initialDuration += Number(packet[2]) || 0;
        }
        reads.set(index, read);
        return;
      }
      // FFprobe emits the stream summaries after the packet records.
      const track =
        /^stream\|index=(\d+)\|codec_name=([^|]+)\|codec_type=(\w+)\|id=(0x[\da-f]+|N\/A)\|duration_ts=(-?\d+|N\/A)\|nb_frames=(\d+|N\/A)$/.exec(
          line,
        );
      if (!track) throw new MediaError('SOURCE_INVALID');
      if (track[3] !== 'video' && track[3] !== 'audio') return;
      // With no initial media box, fragment headers account for all samples.
      const initial = layout.hasInitialMedia ? Number(track[6]) || 0 : 0;
      const fragmented = fragments.get(Number(track[4])) ?? 0;
      const read = reads.get(Number(track[1]));
      const packets = read?.packets ?? 0;
      // MOV groups initial PCM-style samples. Fragment runs describe their own packets.
      const groupedAudio =
        initial > 0 &&
        track[3] === 'audio' &&
        (track[2]?.startsWith('pcm_') || Number(track[5]) <= initial);
      const initialPackets = read?.initialPackets ?? 0;
      const enough = groupedAudio
        ? Math.max(initialPackets, read?.initialDuration ?? 0) >= initial &&
          packets - initialPackets >= fragmented
        : packets >= initial + fragmented;
      if (!enough) throw new MediaError('SOURCE_INVALID');
    },
    true,
  );
}

async function decodeVideoProbe(
  path: string,
  streamIndex: number,
  timeBase: string,
  signal: AbortSignal,
  tail?: VideoPacketTime,
): Promise<void> {
  const seek = Math.max(0, (tail?.seconds ?? 0) - 0.5);
  const result = await runProcess(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-xerror',
      '-abort_on',
      'empty_output',
      '-copyts',
      '-filter_threads',
      '1',
      ...(seek > 0 ? ['-noaccurate_seek', '-seek_timestamp', '1', '-ss', seek.toFixed(6)] : []),
      '-noautorotate',
      '-err_detect',
      'explode',
      '-threads',
      '1',
      ...MP4_PROBE_INPUT,
      '-i',
      path,
      '-map',
      `0:${streamIndex}`,
      // An earlier frame after the seek cannot satisfy the tail check.
      ...(tail ? ['-vf', `trim=start_pts=${tail.pts}`] : ['-frames:v', '1']),
      '-fps_mode',
      'passthrough',
      '-enc_time_base',
      timeBase,
      '-c:v',
      'wrapped_avframe',
      '-f',
      'null',
      '-',
    ],
    signal,
  );
  requireCleanProbe(result);
}

/** Inspect the staged MP4 using one signal for box reads, demux and frame checks. */
export async function probeVideoFile(
  path: string,
  signal: AbortSignal,
): Promise<VideoProbeMetadataV1> {
  try {
    signal.throwIfAborted();
    const openMedia = await requireMp4File(path, signal);
    const metadata = await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        ...MP4_PROBE_INPUT,
        '-show_entries',
        'format=duration:stream=index,id,codec_type,codec_name,width,height,time_base,sample_aspect_ratio:stream_side_data=rotation:stream_tags=rotate:stream_disposition=attached_pic',
        '-of',
        'json',
        path,
      ],
      signal,
    );
    requireCleanProbe(metadata);
    const media = JSON.parse(metadata.stdout) as {
      streams?: (ProbeStream & { index?: number; id?: string; time_base?: string })[];
      format?: { duration?: string };
    };
    const duration = Number(media.format?.duration);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 1800 ||
      !Array.isArray(media.streams)
    )
      throw new MediaError('SOURCE_INVALID');
    const video = media.streams.find(isVideoTrack);
    const size = video ? videoDisplayGeometry(video) : null;
    if (
      !video?.codec_name ||
      typeof video.index !== 'number' ||
      !Number.isSafeInteger(video.index) ||
      video.index < 0 ||
      !video.time_base ||
      !/^[1-9]\d{0,9}\/[1-9]\d{0,9}$/.test(video.time_base) ||
      video.codec_name.length > 128 ||
      !/^[A-Za-z0-9_,.+-]+$/.test(video.codec_name) ||
      !size ||
      !Number.isSafeInteger(size.width) ||
      !Number.isSafeInteger(size.height) ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > 65536 ||
      size.height > 65536
    )
      throw new MediaError('SOURCE_INVALID');
    const audio = media.streams.find((stream) => stream.codec_type === 'audio');
    const audioCodec = audio?.codec_name ?? null;
    if (audioCodec !== null && (audioCodec.length > 128 || !/^[A-Za-z0-9_,.+-]+$/.test(audioCodec)))
      throw new MediaError('SOURCE_INVALID');
    const timeBase = video.time_base.replace('/', ':');
    await decodeVideoProbe(path, video.index, timeBase, signal);
    const tail = await lastVideoPacket(path, video.index, signal);
    if (openMedia) {
      const trackIds = new Set(
        media.streams.map((stream) => Number(stream.id)).filter(Number.isSafeInteger),
      );
      await requireDeclaredMp4Samples(path, openMedia, trackIds, signal);
    }
    await decodeVideoProbe(path, video.index, timeBase, signal, tail);
    return {
      container: 'mp4',
      videoCodec: video.codec_name,
      width: size.width,
      height: size.height,
      durationSeconds: duration,
      hasAudio: Boolean(audio),
      audioCodec,
    };
  } catch (error) {
    if (signal.aborted) throw new MediaError('EXECUTION_TIMEOUT');
    if (error instanceof MediaError) throw error;
    throw new MediaError('PROBE_FAILED');
  }
}

export async function transcode(
  directory: string,
  attemptId: string,
  signal: AbortSignal,
  onSpawn: (pid: number) => void,
): Promise<{ size: number; sha256: string }> {
  const files = paths(directory, attemptId);
  const input = await probe(files.input, signal);
  requireSpace(directory);
  const hasAudio = input.streams.some((stream) => stream.codec_type === 'audio');
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-n',
    '-threads',
    '2',
    '-filter_threads',
    '2',
    '-filter_complex_threads',
    '2',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    'mov,matroska,webm,avi,mpegts',
    '-i',
    files.input,
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
    '-map',
    '0:v:0',
    '-map',
    hasAudio ? '0:a:0' : '1:a:0',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-sn',
    '-dn',
    '-vf',
    'scale=w=trunc(iw*min(1\\,720/ih)/2)*2:h=trunc(ih*min(1\\,720/ih)/2)*2,fps=24',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-b:v',
    '1500k',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-t',
    String(input.duration),
    '-movflags',
    '+faststart',
    files.temporary,
  ];
  const spaceController = new AbortController();
  let outputTooLarge = false;
  const timer = setInterval(() => {
    try {
      requireSpace(directory);
      if (
        existsSync(files.temporary) &&
        lstatSync(files.temporary).size > COMPUTE_MAX_MEDIA_BYTES
      ) {
        outputTooLarge = true;
        spaceController.abort();
      }
    } catch {
      spaceController.abort();
    }
  }, 5000);
  const combined = AbortSignal.any([signal, spaceController.signal]);
  let result: ProcessResult;
  try {
    result = await runProcess('ffmpeg', args, combined, onSpawn);
  } finally {
    clearInterval(timer);
  }
  if (outputTooLarge) throw new MediaError('OUTPUT_INVALID');
  if (spaceController.signal.aborted) throw new MediaError('DISK_FULL');
  if (result.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  if (result.exitCode !== 0) throw new MediaError('TRANSCODE_FAILED');
  let output: Probe;
  try {
    output = await probe(files.temporary, signal);
  } catch (error) {
    if (error instanceof MediaError && error.code === 'EXECUTION_TIMEOUT') throw error;
    throw new MediaError('OUTPUT_INVALID');
  }
  const video = output.streams.find((stream) => stream.codec_type === 'video');
  const inputVideo = input.streams.find((stream) => stream.codec_type === 'video');
  const inputDisplay = transcodeDisplaySize(inputVideo);
  const outputDisplay = transcodeDisplaySize(video);
  const audio = output.streams.find((stream) => stream.codec_type === 'audio');
  if (
    video?.codec_name !== 'h264' ||
    !inputDisplay ||
    !outputDisplay ||
    outputDisplay.height > Math.min(720, inputDisplay.height) ||
    outputDisplay.width > inputDisplay.width ||
    video.r_frame_rate !== '24/1' ||
    video.avg_frame_rate !== '24/1' ||
    audio?.codec_name !== 'aac' ||
    output.duration < input.duration - 0.2 ||
    output.duration > input.duration + 0.3
  )
    throw new MediaError('OUTPUT_INVALID');
  syncPath(files.temporary);
  renameSync(files.temporary, files.output);
  syncPath(resolve(directory));
  let digest: Awaited<ReturnType<typeof fileDigest>>;
  try {
    digest = await fileDigest(files.output, signal);
  } catch (error) {
    if (signal.aborted) throw new MediaError('EXECUTION_TIMEOUT');
    throw error;
  }
  if (digest.size <= 0 || digest.size > COMPUTE_MAX_MEDIA_BYTES)
    throw new MediaError('OUTPUT_INVALID');
  return digest;
}

export function removeFiles(directory: string, attemptId: string): void {
  const files = paths(directory, attemptId);
  for (const path of Object.values(files)) if (existsSync(path)) rmSync(path);
  syncPath(resolve(directory));
}

/** Called under the instance journal lock, before the dedicated consumer starts. */
export function prepareAudioDirectory(directory: string): string {
  const path = join(resolve(directory), 'audio-inspection');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('AUDIO_DIRECTORY_INVALID');
  for (const filename of readdirSync(path)) {
    if (filename.endsWith('.input') && isUuidV4(filename.slice(0, -6)))
      rmSync(join(path, filename));
  }
  return path;
}

type AudioProbe = {
  format?: { format_name?: string };
  streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }[];
};

const audioDemuxers = ['-protocol_whitelist', 'file', '-format_whitelist', 'mp3,wav,mov,flac'];

async function probeAudio(
  input: string,
  purpose: AudioInspectCommandV1['purpose'],
  signal: AbortSignal,
): Promise<Pick<AudioInspection, 'format' | 'mimeType' | 'codec' | 'sampleRate' | 'channels'>> {
  const result = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      ...audioDemuxers,
      '-show_entries',
      'format=format_name:stream=codec_type,codec_name,sample_rate,channels',
      '-of',
      'json',
      input,
    ],
    signal,
  );
  if (result.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  if (result.exitCode !== 0) throw new MediaError('INPUT_INVALID');
  const parsed = JSON.parse(result.stdout) as AudioProbe;
  const stream = parsed.streams?.[0];
  const container = parsed.format?.format_name?.split(',')[0];
  const format = container === 'mov' ? 'm4a' : container;
  const sampleRate = Number(stream?.sample_rate);
  if (
    !stream ||
    parsed.streams?.length !== 1 ||
    stream.codec_type !== 'audio' ||
    (format !== 'mp3' && format !== 'wav' && format !== 'm4a' && format !== 'flac') ||
    (purpose === 'sample' && format === 'flac') ||
    (purpose === 'output' && format === 'm4a') ||
    !stream.codec_name ||
    !/^[a-z0-9_]{1,40}$/.test(stream.codec_name) ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    (stream.channels !== 1 && stream.channels !== 2)
  )
    throw new MediaError('INPUT_INVALID');
  return {
    format,
    mimeType: AUDIO_MIME_TYPES[format],
    codec: stream.codec_name,
    sampleRate,
    channels: stream.channels,
  };
}

/** Count decoded samples through EOF. Stop early only when the duration is already invalid. */
export async function inspectAudio(
  directory: string,
  command: AudioInspectCommandV1,
  objectSha256: string | null,
  signal: AbortSignal,
): Promise<AudioInspection> {
  const input = paths(directory, command.inspectionId).input;
  const digest = await fileDigest(input, signal);
  if (
    digest.size !== command.input.sizeBytes ||
    (objectSha256 !== null && digest.sha256 !== objectSha256) ||
    (command.input.sha256 !== undefined && digest.sha256 !== command.input.sha256)
  )
    throw new MediaError('INPUT_CHANGED');
  const media = await probeAudio(input, command.purpose, signal);
  const { minDurationMs, maxDurationMs } = AUDIO_INSPECTION_LIMITS[command.purpose];
  const decoded = await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-err_detect',
      'explode',
      ...audioDemuxers,
      '-threads',
      '2',
      '-i',
      input,
      '-map',
      '0:a:0',
      // Produce a duration from PCM samples, including files with unusual input timestamps.
      '-af',
      'asetpts=N/SR/TB',
      '-filter_threads',
      '2',
      '-t',
      String(maxDurationMs / 1000 + 1),
      '-stats_period',
      '3601',
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    signal,
  );
  if (decoded.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  if (decoded.exitCode !== 0 || !/^progress=end$/m.test(decoded.stdout))
    throw new MediaError('INPUT_INVALID');
  const clocks = [...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)];
  const durationMs = Number(clocks.at(-1)?.[1]) / 1000;
  if (!Number.isFinite(durationMs) || durationMs < minDurationMs || durationMs > maxDurationMs)
    throw new MediaError('INPUT_TOO_LONG');
  return {
    ...media,
    durationMs: Math.round(durationMs),
    sizeBytes: digest.size,
    sha256: digest.sha256,
  };
}
