import sharp from 'sharp';
import { expect, it } from 'vitest';
import { decodeMaterialImage, MATERIAL_MAX_PIXELS } from '../../src/materials/decode.ts';
const signal = () => new AbortController().signal;
const image = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
it.each([
  [300, 300],
  [300, 750],
  [750, 300],
  [6000, 6000],
])('accepts inclusive dimensions/ratio and total pixels %s×%s', async (width, height) => {
  const data = await image(width, height);
  expect(await decodeMaterialImage(data, 'image/png', signal())).toMatchObject({
    width,
    height,
    pages: 1,
    totalPixels: width * height,
  });
});
it.each([
  [299, 300],
  [300, 299],
  [6001, 3000],
  [3000, 6001],
  [300, 751],
  [751, 300],
])('rejects dimensions/ratio outside %s×%s', async (width, height) => {
  await expect(
    decodeMaterialImage(await image(width, height), 'image/png', signal()),
  ).rejects.toMatchObject({ code: 'MATERIAL_IMAGE_INVALID' });
});
it('validates actual JPEG/WebP magic and full decode rather than metadata alone', async () => {
  const png = await image(300, 300);
  const jpeg = await sharp(png).jpeg().toBuffer(),
    webp = await sharp(png).webp().toBuffer();
  expect(await decodeMaterialImage(jpeg, 'image/jpeg', signal())).toHaveProperty('width', 300);
  expect(await decodeMaterialImage(webp, 'image/webp', signal())).toHaveProperty('width', 300);
  for (const data of [png.subarray(0, png.length - 50), Buffer.from('not an image')])
    await expect(decodeMaterialImage(data, 'image/png', signal())).rejects.toMatchObject({
      code: 'MATERIAL_IMAGE_INVALID',
    });
  await expect(decodeMaterialImage(png, 'image/jpeg', signal())).rejects.toMatchObject({
    code: 'MATERIAL_IMAGE_INVALID',
  });
});
it('validates all animated WebP frames by frame dimensions and aggregate pixel budget', async () => {
  const webp = await sharp({
    create: { width: 300, height: 600, pageHeight: 300, channels: 3, background: 'red' },
  })
    .composite([
      {
        input: await image(300, 300).then((data) => sharp(data).tint('blue').png().toBuffer()),
        top: 300,
        left: 0,
      },
    ])
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  expect(await decodeMaterialImage(webp, 'image/webp', signal())).toMatchObject({
    width: 300,
    height: 300,
    pages: 2,
    totalPixels: 180000,
  });
  const corrupt = Buffer.from(webp);
  let last = 0;
  for (let i = 0; (i = corrupt.indexOf(Buffer.from('ANMF'), i)) >= 0; i += 4) last = i;
  corrupt.fill(0xff, last + 24, Math.min(last + 40, corrupt.length));
  await expect(decodeMaterialImage(corrupt, 'image/webp', signal())).rejects.toMatchObject({
    code: 'MATERIAL_IMAGE_INVALID',
  });
  const over = await sharp({
    create: { width: 6000, height: 9000, pageHeight: 3000, channels: 3, background: 'red' },
  })
    .composite(
      await Promise.all(
        ['blue', 'green', 'purple', 'white'].map(async (color, index) => ({
          input: await sharp({
            create: { width: 300, height: 300, channels: 3, background: color },
          })
            .png()
            .toBuffer(),
          top: (index + 1) * 3000,
          left: 0,
        })),
      ),
    )
    .webp({ loop: 0, delay: [100, 100, 100, 100, 100] })
    .toBuffer();
  await expect(decodeMaterialImage(over, 'image/webp', signal())).rejects.toMatchObject({
    code: 'MATERIAL_IMAGE_INVALID',
  });
  expect(MATERIAL_MAX_PIXELS).toBe(36_000_000);
}, 20_000);
