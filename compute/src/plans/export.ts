import type { MediaParameters, MediaProbe } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaExecutionResult,
} from '../media-execution.ts';
import { mediaError } from './probe.ts';

export async function exportMedia(
  parameters: MediaParameters['media.export'],
  probe: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  const format = parameters.format;
  if (format === 'mp3' ? !probe.hasAudio : !probe.hasVideo) throw mediaError('INPUT_INVALID');
  const types = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', mp3: 'audio/mpeg' };
  const file: LocalMediaFile = {
    name: `export.${format}`,
    role: 'primary',
    contentType: types[format],
  };
  const args = ['-v', 'error', '-i', '@file:input-0'];
  if (format === 'mp3') args.push('-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k');
  else {
    const filters = [`scale=trunc(iw*sar/2)*2:ih,setsar=1`];
    if (parameters.height) filters.push(`scale=-2:${parameters.height}`);
    if (parameters.fps || format === 'gif') filters.push(`fps=${parameters.fps ?? 12}`);
    if (format === 'gif') {
      // Generate the palette separately so frames do not accumulate waiting for the final palette.
      await context.run({
        id: 'export-gif-palette',
        tool: 'ffmpeg',
        outputs: [{ name: 'palette.png', role: 'data', contentType: 'image/png' }],
        args: [
          '-v',
          'error',
          '-i',
          '@file:input-0',
          '-map',
          '0:V:0',
          '-an',
          '-vf',
          filters.join(',') + ',palettegen',
          '-frames:v',
          '1',
          '-update',
          '1',
          '@file:palette.png',
        ],
      });
      args.push(
        '-i',
        '@file:palette.png',
        '-an',
        '-filter_complex',
        '[0:V:0]' + filters.join(',') + '[frames];[frames][1:v:0]paletteuse[out]',
        '-map',
        '[out]',
        '-loop',
        '0',
      );
    } else {
      filters.push('scale=ceil(iw/2)*2:ceil(ih/2)*2');
      args.push('-vf', filters.join(','), '-map', '0:V:0', '-map', '0:a:0?', '-pix_fmt', 'yuv420p');
      if (format === 'webm')
        args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus');
      else
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
        );
    }
  }
  args.push(`@file:${file.name}`);
  await context.run({
    id: 'export-media',
    tool: 'ffmpeg',
    ...(probe.durationSeconds > 0 ? { durationSeconds: probe.durationSeconds } : {}),
    args,
    outputs: [file],
  });
  return { files: [file], data: {} };
}
