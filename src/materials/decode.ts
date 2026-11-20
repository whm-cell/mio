import sharp from 'sharp';
import { MAX_MATERIAL_SOURCE_BYTES } from '../assets/contracts.ts';
import { MaterialError } from './contracts.ts';

export const MATERIAL_MAX_BYTES = MAX_MATERIAL_SOURCE_BYTES;
export const MATERIAL_MAX_PIXELS = 36_000_000;

/** Caller owns the single registration slot before retaining bytes; this adds no waiting queue. */
export async function decodeMaterialImage(
  bytes: Uint8Array,
  contentType: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number; pages: number; totalPixels: number }> {
  const invalid = () => new MaterialError(400, 'MATERIAL_IMAGE_INVALID');
  if (bytes.byteLength < 1 || bytes.byteLength > MATERIAL_MAX_BYTES) throw invalid();
  const input = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format =
    contentType === 'image/png'
      ? 'png'
      : contentType === 'image/jpeg'
        ? 'jpeg'
        : contentType === 'image/webp'
          ? 'webp'
          : undefined;
  const signature =
    format === 'png'
      ? input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : format === 'jpeg'
        ? input[0] === 255 && input[1] === 216 && input[2] === 255
        : format === 'webp' &&
          input.toString('ascii', 0, 4) === 'RIFF' &&
          input.toString('ascii', 8, 12) === 'WEBP';
  if (!signature) throw invalid();
  signal.throwIfAborted();
  try {
    const image = sharp(input, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MATERIAL_MAX_PIXELS,
    }).timeout({ seconds: 15 });
    const meta = await image.metadata();
    const pages = meta.pages ?? 1,
      width = meta.width ?? 0,
      height = meta.pageHeight ?? meta.height ?? 0;
    const totalPixels = width * height * pages;
    if (
      meta.format !== format ||
      !Number.isSafeInteger(pages) ||
      pages < 1 ||
      !Number.isSafeInteger(totalPixels) ||
      width < 300 ||
      width > 6000 ||
      height < 300 ||
      height > 6000 ||
      width / height < 0.4 ||
      width / height > 2.5 ||
      totalPixels > MATERIAL_MAX_PIXELS
    )
      throw invalid();
    signal.throwIfAborted();
    // The output pipeline installs libvips' timeout hook; stats() does not.
    await image.raw().toBuffer();
    signal.throwIfAborted();
    return { width, height, pages, totalPixels };
  } catch (error) {
    if (signal.aborted) throw error;
    throw invalid();
  }
}
