import type { MediaParameters, MediaProbe } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaExecutionResult,
} from '../media-execution.ts';
import { mediaError, primaryVideoEnd } from './probe.ts';

export async function detectScenes(
  parameters: MediaParameters['scenes.detect'],
  probe: MediaProbe,
  context: MediaExecutionContext,
  maximum = 4096,
): Promise<number[]> {
  if (!probe.hasVideo || probe.durationSeconds <= 0) throw mediaError('INPUT_INVALID');
  const threshold = parameters.threshold ?? 0.3,
    minimum = parameters.minSceneSeconds ?? 0.04;
  const { stdout } = await context.run({
    id: 'detect-scenes',
    tool: 'ffmpeg',
    durationSeconds: probe.durationSeconds,
    capture: 'lines',
    args: [
      '-v',
      'error',
      '-i',
      '@file:input-0',
      '-an',
      '-vf',
      `select='gt(scene,${threshold})*if(isnan(prev_selected_t),gte(t,${minimum}),gte(t-prev_selected_t,${minimum}))',metadata=print:file=-`,
      '-frames:v',
      String(maximum),
      '-fps_mode',
      'vfr',
      '-f',
      'null',
      '-',
    ],
  });
  const scenes: number[] = [];
  for (const match of stdout.matchAll(/pts_time:([\d.e+-]+)/g)) {
    const time = Number(match[1]);
    if (!Number.isFinite(time) || time < 0 || time > probe.durationSeconds)
      throw mediaError('OUTPUT_INVALID');
    if (time > (scenes.at(-1) ?? 0) && scenes.length < maximum) scenes.push(time);
  }
  return scenes;
}

export async function extractFrames(
  parameters: MediaParameters['frames.extract'],
  probe: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  if (!probe.hasVideo || probe.durationSeconds <= 0) throw mediaError('INPUT_INVALID');
  const maximum = parameters.maxFrames ?? 256;
  let timestamps: number[];
  if (parameters.mode === 'timestamps') {
    timestamps = parameters.timestamps!;
    if (timestamps.some((t) => t < 0 || t >= probe.durationSeconds))
      throw mediaError('INPUT_INVALID');
  } else if (parameters.mode === 'scene') {
    timestamps = await detectScenes(
      { threshold: parameters.threshold ?? 0.3 },
      probe,
      context,
      maximum,
    );
  } else if (parameters.mode === 'interval') {
    const count = Math.min(maximum, Math.ceil(probe.durationSeconds / parameters.intervalSeconds!));
    timestamps = Array.from({ length: count }, (_, i) => i * parameters.intervalSeconds!);
  } else timestamps = maximum === 1 ? [0] : [0, 0];
  const files: LocalMediaFile[] = [];
  for (const [index, time] of timestamps.entries()) {
    const last = parameters.mode === 'first_last' && index === 1;
    const file: LocalMediaFile = {
      name: `frame-${index}.jpg`,
      role: 'frame',
      contentType: 'image/jpeg',
    };
    const end = last ? await primaryVideoEnd(probe, context) : null;
    const seek = last ? Math.max(0, (end ?? 0) - 1) : time;
    // Keep only one updated image while decoding toward the end of the video stream.
    const width = parameters.width ?? 640;
    const filter = `scale=${width}:round(${width}/dar),setsar=1`;
    const step = {
      id: `extract-frame-${index}`,
      tool: 'ffmpeg' as const,
      outputs: [file],
    };
    const args = [
      '-i',
      '@file:input-0',
      '-map',
      '0:V:0',
      '-an',
      '-vf',
      filter,
      ...(last ? ['-fps_mode', 'passthrough', '-atomic_writing', '1'] : ['-frames:v', '1']),
      '-q:v',
      '2',
      '-update',
      '1',
      `@file:${file.name}`,
    ];
    try {
      await context.run({
        ...step,
        args: ['-v', 'error', ...(seek ? ['-ss', String(seek)] : []), ...args],
      });
    } catch (error) {
      // A sparse video may have no decoded frames in the estimated tail window.
      // Only a known missing output can fall back to a full, constant-memory decode.
      if (!last || !seek || (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      await context.run({ ...step, id: step.id + '-full', args: ['-v', 'error', ...args] });
    }
    files.push(file);
  }
  return { files, data: {} };
}
