import sharp from 'sharp';

/** Decode the original fully, one image at a time; preview transformations are not used. */
export function createImageDecoder() {
  let tail: Promise<void> = Promise.resolve();
  return (bytes: Uint8Array, format: string): Promise<void> => {
    const action = tail.then(async () => {
      const input = Buffer.from(bytes);
      const signature =
        format === 'png'
          ? input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          : format === 'jpeg'
            ? input[0] === 255 && input[1] === 216 && input[2] === 255
            : format === 'webp' &&
              input.toString('ascii', 0, 4) === 'RIFF' &&
              input.toString('ascii', 8, 12) === 'WEBP';
      if (!signature) throw new Error('IMAGE_OUTPUT_INVALID');
      try {
        await sharp(input, { failOn: 'warning', limitInputPixels: false }).stats();
      } catch {
        throw new Error('IMAGE_OUTPUT_INVALID');
      }
    });
    tail = action.catch(() => {});
    return action;
  };
}
