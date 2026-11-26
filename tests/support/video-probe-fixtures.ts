import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type VideoProbeFixture = 'mp4' | 'attached-cover' | 'truncated-mp4' | 'corrupt-mp4' | 'mov' | '3gp';

export function writeVideoProbeFixture(directory: string, kind: VideoProbeFixture): string {
  const format = kind === 'mov' || kind === '3gp' ? kind : 'mp4';
  const path = join(directory, `${kind}.${format}`);
  const attached = kind === 'attached-cover';
  execFileSync('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    attached
      ? 'color=black:size=32x32:rate=1:duration=1'
      : 'color=black:size=320x240:rate=24:duration=1.25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000:duration=1.25',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    attached ? 'mjpeg' : 'libx264',
    '-threads',
    '1',
    ...(attached
      ? ['-frames:v', '1', '-disposition:v', 'attached_pic']
      : ['-pix_fmt', 'yuv420p', '-g', '12']),
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    path,
  ]);

  if (kind === 'truncated-mp4') {
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 128));
  }
  if (kind === 'corrupt-mp4') {
    const { packets } = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts,size,pos',
          '-of',
          'json',
          path,
        ],
        { encoding: 'utf8' },
      ),
    ) as { packets: { pts: number; size: string; pos: string }[] };
    const last = packets.reduce((latest, packet) => (packet.pts > latest.pts ? packet : latest));
    const bytes = readFileSync(path);
    const offset = Number(last.pos);
    // Preserve all MP4 boxes and sample sizes, damage only the last displayed frame.
    bytes.fill(0, offset, offset + Number(last.size));
    writeFileSync(path, bytes);
  }
  return path;
}
