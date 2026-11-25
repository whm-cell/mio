import type { MediaStep } from '../media-execution.ts';

const rmsKey = 'lavfi.astats.Overall.RMS_level=';
const samplesKey = 'lavfi.astats.Overall.Number_of_samples=';
const maxFrameSamples = 1024;
const maxAudioSamples = 3600 * 384_000;

/** Keep only one metadata record and one sum per output bucket. */
export function waveformCapture(options: NonNullable<MediaStep['waveform']>) {
  const { points, samples, frameSamples } = options;
  if (
    !Number.isSafeInteger(points) ||
    points < 1 ||
    points > 4096 ||
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    samples > maxAudioSamples ||
    !Number.isSafeInteger(frameSamples) ||
    frameSamples < 1 ||
    frameSamples > maxFrameSamples
  )
    throw new Error('MEDIA_STEP_INVALID');
  const energies = new Float64Array(points);
  const sampleEnd = (bucket: number) => Math.ceil(((bucket + 1) * samples) / points);
  const byteLimit = (Math.ceil(samples / frameSamples) + 1) * 256;
  let tail = '';
  let bytes = 0;
  let power: number | undefined;
  let position = 0;
  let bucket = 0;

  const merge = (count: number) => {
    if (
      power === undefined ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > frameSamples ||
      position + count > samples
    )
      throw new Error('OUTPUT_INVALID');
    const frameEnd = position + count;
    while (position < frameEnd) {
      const end = Math.min(frameEnd, sampleEnd(bucket));
      energies[bucket] = energies[bucket]! + power * (end - position);
      position = end;
      if (position === sampleEnd(bucket)) bucket++;
    }
    power = undefined;
  };

  return {
    write(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > byteLimit) throw new Error('OUTPUT_INVALID');
      const lines = (tail + chunk.toString('utf8')).split('\n');
      tail = lines.pop()!;
      if (tail.length > 256) throw new Error('OUTPUT_INVALID');
      for (const line of lines) {
        if (line.startsWith(rmsKey)) {
          const level = line.slice(rmsKey.length);
          if (power !== undefined || (level !== '-inf' && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(level)))
            throw new Error('OUTPUT_INVALID');
          power = level === '-inf' ? 0 : Math.min(1, 10 ** (Number(level) / 10));
        } else if (line.startsWith(samplesKey)) {
          merge(Number(line.slice(samplesKey.length)));
        }
      }
    },
    finish(): number[] {
      if (tail || power !== undefined || position === 0) throw new Error('OUTPUT_INVALID');
      return Array.from(energies, (energy, index) => {
        const count = sampleEnd(index) - (index ? sampleEnd(index - 1) : 0);
        return count ? Math.sqrt(Math.min(1, energy / count)) : 0;
      });
    },
  };
}
