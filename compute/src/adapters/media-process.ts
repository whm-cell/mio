import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { processIdentity } from './media.ts';
import type { MediaProcessResult, MediaStep } from '../media-execution.ts';
import type { MediaAttempt, MediaJournal, MediaStepCheckpoint } from './media-journal.ts';
import { mediaIdentity } from './media-journal.ts';
import type { MediaFiles } from './media-files.ts';
import { mediaName, MEDIA_TEXT_LIMIT } from './media-files.ts';
import { waveformCapture } from './waveform.ts';
import { videoPacketEndCapture } from './video-packet-end.ts';

// Standalone media demuxers. Playlist/concat demuxers can open a second local
// file even when network protocols are disabled.
const inputRestriction = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,h264,hevc,m4v,flv,asf,ivf,ogg,aac,ac3,eac3,mp3,wav,flac,aiff,amr,ape,au,caf,wv,tta,mpc,mpc8,adts,gif,image2,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe',
];

/** Recovery never signals a PID read from disk; only an owned ChildProcess can be killed. */
function mediaProcessIdentity(pid: number): string | null {
  try {
    const boot = processIdentity();
    if (!boot) return null;
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `${boot}:pid:${pid}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8',
        timeout: 5000,
        shell: false,
      });
      return result.status === 0 && result.stdout.trim()
        ? `${boot}:pid:${pid}:${result.stdout.trim()}`
        : null;
    }
  } catch {
    /* Exited before identity capture is still reaped by the owner. */
  }
  return null;
}
export function mediaProcessGone(pid: number | null, identity: string | null): boolean {
  if (!pid || !identity) return false;
  const boot = processIdentity();
  if (!boot || !identity.startsWith(`${boot}:pid:${pid}:`)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function resolveMediaArgs(args: string[], files: MediaFiles): string[] {
  return args.map((arg) => {
    if (arg.includes('\0') || arg.length > 128 * 1024) throw new Error('MEDIA_ARGUMENT_INVALID');
    const replaced = arg.replace(/@file:([^\s'",;:\[\]()=]+)/g, (_token, name: string) => {
      mediaName(name);
      files.path(name, true);
      return name;
    });
    if (replaced.includes('@file:') || /(?:https?|tcp|udp|concat|subfile|crypto):/i.test(replaced))
      throw new Error('MEDIA_PATH_INVALID');
    // Raw absolute paths and file-valued filters must originate from a token.
    if (
      (/(?:^|[='",;])\//.test(arg) ||
        /(?:textfile|filename|fontfile|(?:^|[,;])(?:a?movie|subtitles|ass))\s*=?/.test(arg)) &&
      !arg.includes('@file:')
    )
      throw new Error('MEDIA_PATH_INVALID');
    return replaced;
  });
}

export class MediaProcessAdapter {
  readonly #files: MediaFiles;
  readonly #journal: MediaJournal;
  readonly #attempt: MediaAttempt;
  readonly #signal: AbortSignal;
  readonly #progress: (stage: string, fraction: number) => void;
  #running = false;
  constructor(
    files: MediaFiles,
    journal: MediaJournal,
    attempt: MediaAttempt,
    signal: AbortSignal,
    progress: (stage: string, fraction: number) => void,
  ) {
    this.#files = files;
    this.#journal = journal;
    this.#attempt = attempt;
    this.#signal = signal;
    this.#progress = progress;
  }
  async run(step: MediaStep): Promise<MediaProcessResult> {
    if (this.#running) throw new Error('MEDIA_STEP_CONCURRENT');
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(step.id) ||
      !['ffmpeg', 'ffprobe'].includes(step.tool) ||
      step.args.length > 8192 ||
      (step.durationSeconds !== undefined &&
        (!Number.isFinite(step.durationSeconds) || step.durationSeconds <= 0))
    )
      throw new Error('MEDIA_STEP_INVALID');
    this.#signal.throwIfAborted();
    this.#running = true;
    try {
      this.#progress(step.id, 0);
      return await this.#run(step);
    } finally {
      this.#running = false;
    }
  }
  async #run(step: MediaStep): Promise<MediaProcessResult> {
    const identity = mediaIdentity(step);
    const previous = this.#attempt.steps[step.id];
    if (previous) {
      if (previous.identity !== identity) throw new Error('OUTPUT_MISMATCH');
      if (previous.state !== 'complete' || !previous.result) throw new Error('PROCESS_UNKNOWN');
      for (const [name, digest] of Object.entries(previous.outputs)) {
        const actual = await this.#files.digest(name, this.#signal);
        if (actual.size !== digest.size || actual.sha256 !== digest.sha256)
          throw new Error('OUTPUT_MISMATCH');
      }
      this.#progress(step.id, 1);
      return previous.result;
    }
    this.#files.checkLimits();
    const args = resolveMediaArgs(step.args, this.#files);
    for (const output of step.outputs ?? []) this.#files.path(output.name, true);
    const checkpoint: MediaStepCheckpoint = {
      identity,
      step,
      state: 'intent',
      pid: null,
      processIdentity: null,
      exitCode: null,
      signal: null,
      outputs: {},
      result: null,
    };
    this.#attempt.steps[step.id] = checkpoint;
    this.#journal.save(this.#attempt);
    const result = await this.#spawn(step, args, checkpoint);
    for (const { name } of step.outputs ?? []) {
      const digest = await this.#files.digest(name, this.#signal);
      if (digest.size < 1) throw new Error('OUTPUT_INVALID');
      checkpoint.outputs[name] = digest;
    }
    checkpoint.state = 'complete';
    checkpoint.result = result;
    this.#journal.save(this.#attempt);
    return result;
  }
  async #spawn(
    step: MediaStep,
    args: string[],
    checkpoint: MediaStepCheckpoint,
  ): Promise<MediaProcessResult> {
    const result = await managedProcess(
      step.tool,
      args,
      this.#signal,
      (pid) => {
        checkpoint.pid = pid;
        checkpoint.processIdentity = mediaProcessIdentity(pid);
        checkpoint.state = 'running';
        this.#journal.save(this.#attempt);
      },
      {
        cwd: this.#files.directory,
        capture: Boolean(step.capture),
        ...(step.waveform ? { waveform: step.waveform } : {}),
        ...(step.packetEnd ? { packetEnd: step.packetEnd } : {}),
        ...(step.durationSeconds === undefined ? {} : { durationSeconds: step.durationSeconds }),
        progress: (fraction) => this.#progress(step.id, fraction),
        checkLimits: () => this.#files.checkLimits(),
        exited: (result) => {
          checkpoint.exitCode = result.exitCode;
          checkpoint.signal = result.signal;
          checkpoint.state = 'exited';
          this.#journal.save(this.#attempt);
        },
      },
    );
    if (result.aborted) throw this.#signal.reason ?? new Error('EXECUTION_TIMEOUT');
    if (result.signal) throw new Error('WORKER_INTERRUPTED');
    if (result.exitCode !== 0) throw new Error('EXECUTION_FAILED');
    return {
      stdout: result.stdout,
      diagnostic: result.diagnostic,
      ...(result.waveform ? { waveform: result.waveform } : {}),
      ...(result.packetEndSeconds === undefined
        ? {}
        : { packetEndSeconds: result.packetEndSeconds }),
    };
  }
}

export interface ManagedProcessResult {
  stdout: string;
  diagnostic: string;
  exitCode: number | null;
  signal: string | null;
  aborted: boolean;
  waveform?: number[];
  packetEndSeconds?: number;
}
interface ManagedProcessOptions {
  cwd?: string;
  capture?: boolean;
  waveform?: NonNullable<MediaStep['waveform']>;
  packetEnd?: NonNullable<MediaStep['packetEnd']>;
  progress?: (fraction: number) => void;
  durationSeconds?: number;
  checkLimits?: () => void;
  exited?: (result: ManagedProcessResult) => void;
}

/** Owns a media subprocess and reaps it before exposing the outcome. */
export async function managedProcess(
  binary: string,
  args: string[],
  signal: AbortSignal,
  onSpawn?: (pid: number) => void,
  options: ManagedProcessOptions = {},
): Promise<ManagedProcessResult> {
  signal.throwIfAborted();
  if (binary !== 'ffmpeg' && binary !== 'ffprobe') throw new Error('CAPABILITY_UNAVAILABLE');
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (
      ['-threads', '-filter_threads', '-filter_complex_threads'].includes(arg) &&
      args[index + 1] !== '2'
    )
      throw new Error('MEDIA_THREADS_INVALID');
    if (arg === '-y' || arg === '-n') continue;
    if (arg === '-i') {
      normalized.push('-threads', '2');
      if (args[index - 2] !== '-f' || args[index - 1] !== 'lavfi')
        normalized.push(...inputRestriction);
    }
    normalized.push(arg);
  }
  const prefix =
    binary === 'ffmpeg'
      ? [
          '-nostdin',
          '-hide_banner',
          '-n',
          '-threads',
          '2',
          '-filter_threads',
          '2',
          '-filter_complex_threads',
          '2',
        ]
      : ['-threads', '2'];
  if (binary === 'ffmpeg' && options.progress)
    prefix.push('-progress', 'pipe:3', '-stats_period', '1');
  const informational = normalized.some((arg) =>
    ['-version', '-encoders', '-filters', '-formats', '-h'].includes(arg),
  );
  if (binary === 'ffprobe' && !informational) prefix.push(...inputRestriction);
  if (binary === 'ffmpeg' && normalized.length && !informational)
    normalized.splice(normalized.length - 1, 0, '-threads', '2');
  const waveform = options.waveform ? waveformCapture(options.waveform) : undefined;
  const packets = options.packetEnd
    ? videoPacketEndCapture(options.packetEnd.frameSeconds)
    : undefined;
  const streamCapture = waveform ?? packets;
  const child = spawn(binary, [...prefix, ...normalized], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let stdoutBytes = 0,
    stderr = Buffer.alloc(0),
    progress = '',
    failure: unknown;
  let outputSeconds = 0;
  const result: ManagedProcessResult = {
    stdout: '',
    diagnostic: '',
    exitCode: null,
    signal: null,
    aborted: false,
  };
  const fail = (error: unknown) => {
    failure ??= error;
    child.kill('SIGKILL');
  };
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code, exitSignal) => {
      result.exitCode = code;
      result.signal = exitSignal;
      resolve();
    });
  });
  child.stdout!.on('data', (chunk: Buffer) => {
    if (streamCapture) {
      try {
        streamCapture.write(chunk);
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (options.capture === false) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > MEDIA_TEXT_LIMIT) {
      fail(new Error('OUTPUT_INVALID'));
      return;
    }
    chunks.push(chunk);
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-64 * 1024);
  });
  child.stdio[3]?.on('data', (chunk: Buffer) => {
    const lines = (progress + chunk.toString('utf8')).split('\n');
    progress = lines.pop()!;
    if (progress.length > 16 * 1024) {
      fail(new Error('OUTPUT_INVALID'));
      return;
    }
    try {
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const value = Number(line.slice('out_time_us='.length));
          if (Number.isFinite(value)) outputSeconds = Math.max(outputSeconds, value / 1_000_000);
        } else if (line.startsWith('progress='))
          options.progress?.(
            line.trim() === 'progress=end'
              ? 1
              : options.durationSeconds
                ? Math.min(0.999, outputSeconds / options.durationSeconds)
                : 0,
          );
      }
    } catch (error) {
      fail(error);
    }
  });
  const abort = () => {
    result.aborted = true;
    child.kill('SIGKILL');
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = options.checkLimits
    ? setInterval(() => {
        try {
          options.checkLimits!();
        } catch (error) {
          fail(error);
        }
      }, 1000)
    : undefined;
  try {
    if (signal.aborted) abort();
    if (child.pid && onSpawn)
      try {
        onSpawn(child.pid);
      } catch (error) {
        fail(error);
      }
    await closed;
    result.stdout = Buffer.concat(chunks).toString('utf8');
    result.diagnostic = stderr.toString('utf8');
    options.exited?.(result);
    if (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error('CAPABILITY_UNAVAILABLE');
      throw failure;
    }
    if (waveform && result.exitCode === 0 && !result.aborted) result.waveform = waveform.finish();
    if (packets && result.exitCode === 0 && !result.aborted) {
      const end = packets.finish();
      if (end !== undefined) result.packetEndSeconds = end;
    }
    options.checkLimits?.();
    return result;
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Checks installed FFmpeg/ffprobe, required encoders and filters before queue admission. */
export async function checkMediaCapabilities(
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<void> {
  const encoders = await managedProcess('ffmpeg', ['-encoders'], signal, undefined, {
    capture: true,
  });
  const filters = await managedProcess('ffmpeg', ['-filters'], signal, undefined, {
    capture: true,
  });
  const probe = await managedProcess('ffprobe', ['-version'], signal);
  const has = (text: string, name: string) =>
    text.split('\n').some((line) => line.trim().split(/\s+/)[1] === name);
  if (
    [encoders, filters, probe].some((result) => result.aborted || result.exitCode !== 0) ||
    [
      'libx264',
      'aac',
      'libvpx-vp9',
      'libmp3lame',
      'libopus',
      'pcm_s16le',
      'mjpeg',
      'png',
      'gif',
    ].some((name) => !has(encoders.stdout, name)) ||
    [
      'scale',
      'fps',
      'setsar',
      'select',
      'metadata',
      'asetpts',
      'atrim',
      'concat',
      'asetnsamples',
      'astats',
      'ametadata',
      'palettegen',
      'paletteuse',
    ].some((name) => !has(filters.stdout, name))
  )
    throw new Error('CAPABILITY_UNAVAILABLE');
}
