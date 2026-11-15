import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateImage } from '../src/adapters/media.ts';

function image(format: string, size = '16x16'): Buffer {
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=blue:s=${size}`,
      '-frames:v',
      '1',
      '-c:v',
      format,
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
  return encoded.stdout;
}

describe('image content validation using real decoders', () => {
  it.each([
    ['png', 'png'],
    ['mjpeg', 'jpeg'],
    ['libwebp', 'webp'],
  ])('accepts decodable %s and rejects a mismatched declared format', (codec, format) => {
    const bytes = image(codec);
    expect(() => validateImage(bytes, format)).not.toThrow();
    expect(() => validateImage(bytes, format === 'png' ? 'jpeg' : 'png')).toThrow(
      'IMAGE_OUTPUT_INVALID',
    );
  });
  it('rejects missing image data while accepting dimensions outside a W3 storage policy', () => {
    expect(() => validateImage(Buffer.from('89504e470d0a1a0a', 'hex'), 'png')).toThrow(
      'IMAGE_OUTPUT_INVALID',
    );
    expect(() => validateImage(image('png', '4096x16'), 'png')).not.toThrow();
  });
  it('rejects truncated pixel data even when the header retains dimensions', () => {
    const bytes = image('png', '256x256');
    expect(() => validateImage(bytes.subarray(0, Math.floor(bytes.length / 2)), 'png')).toThrow(
      'IMAGE_OUTPUT_INVALID',
    );
  });
});
