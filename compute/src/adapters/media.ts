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
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AUDIO_INSPECTION_LIMITS,
  AUDIO_MIME_TYPES,
  COMPUTE_MAX_MEDIA_BYTES,
} from '@mio/compute-contracts';
import type { AudioInspectCommandV1, AudioInspection } from '@mio/compute-contracts';
import { videoDisplayGeometry } from '../video-display.ts';
import type { VideoDisplayStream } from '../video-display.ts';

const MAX_DIRECTORY_BYTES = 10 * 1024 ** 3;
const MIN_FREE_BYTES = 2 * 1024 ** 3;

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
  return join(resolve(directory), `.video-probe-${messageId}.media`);
}

/** Remove only the regular probe file derived from a UUID in the private worker directory. */
export function removeProbeFile(directory: string, messageId: string): void {
  const path = probePath(directory, messageId);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('VIDEO_PROBE_FILE_INVALID');
    rmSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function directoryBytes(path: string): number {
  let size = 0;
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('WORK_DIRECTORY_SYMLINK');
    size += stat.isDirectory() ? directoryBytes(child) : stat.size;
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
  pendingBytes: number,
): void {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > COMPUTE_MAX_MEDIA_BYTES
  )
    throw new MediaError(
      expectedBytes > COMPUTE_MAX_MEDIA_BYTES ? 'SOURCE_TOO_LARGE' : 'SOURCE_INVALID',
    );
  const fs = statfsSync(directory);
  const incomingBytes = pendingBytes + expectedBytes;
  if (
    directoryBytes(directory) + incomingBytes > MAX_DIRECTORY_BYTES ||
    fs.bavail * fs.bsize < MIN_FREE_BYTES + incomingBytes
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

type ProcessResult = { stdout: string; exitCode: number | null; aborted: boolean };

async function runProcess(
  binary: string,
  args: string[],
  signal: AbortSignal,
  onSpawn?: (pid: number) => void,
): Promise<ProcessResult> {
  if (signal.aborted) throw new MediaError('EXECUTION_TIMEOUT');
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '';
  let stderrBytes = 0;
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString('utf8');
    if (stdout.length > 64 * 1024) child.kill('SIGKILL');
  });
  child.stderr.on('data', (data: Buffer) => {
    stderrBytes += data.length;
    if (stderrBytes > 256 * 1024) child.kill('SIGKILL');
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
    return await new Promise<ProcessResult>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolvePromise({ stdout, exitCode, aborted }));
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

interface ProbeStream extends VideoDisplayStream {
  codec_type?: string;
  codec_name?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface Probe {
  duration: number;
  container: string;
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

async function probe(
  path: string,
  signal: AbortSignal,
  includeSampleAspectRatio = false,
): Promise<Probe> {
  const aspectField = includeSampleAspectRatio ? ',sample_aspect_ratio' : '';
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
      `format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate${aspectField}:stream_side_data=rotation:stream_tags=rotate`,
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
  return { duration, container: value.format.format_name, streams: value.streams };
}

export interface VideoProbeMetadata {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  audioCodec: string | null;
}

/** Probe fixed local media paths with the worker's bounded ffprobe invocation. */
export async function probeVideoFile(
  path: string,
  signal: AbortSignal,
): Promise<VideoProbeMetadata> {
  try {
    const media = await probe(path, signal, true);
    const video = media.streams.find((stream) => stream.codec_type === 'video');
    const size = video ? videoDisplayGeometry(video) : null;
    if (
      !video?.codec_name ||
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
    if (media.container.length === 0 || !/^[A-Za-z0-9_,.+-]+$/.test(media.container))
      throw new MediaError('SOURCE_INVALID');
    return {
      container: media.container,
      videoCodec: video.codec_name,
      width: size.width,
      height: size.height,
      durationSeconds: media.duration,
      hasAudio: Boolean(audio),
      audioCodec,
    };
  } catch (error) {
    if (error instanceof MediaError) {
      if (error.code === 'INPUT_INVALID') throw new MediaError('SOURCE_INVALID');
      if (error.code === 'INPUT_TOO_LONG') throw new MediaError('SOURCE_INVALID');
      throw error;
    }
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
