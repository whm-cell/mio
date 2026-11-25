import { matchesImageSignature } from '../../integrations/onelink/shared/index.ts';

function hasText(bytes: Buffer, offset: number, marker: string): boolean {
  return bytes.toString('latin1', offset, offset + marker.length) === marker;
}

function hasMpegAudioHeader(bytes: Buffer): boolean {
  if (hasText(bytes, 0, 'ID3')) {
    return (
      bytes.length >= 10 &&
      bytes[3]! >= 2 &&
      bytes[3]! <= 4 &&
      bytes[4] !== 0xff &&
      bytes.subarray(6, 10).every((byte) => byte < 0x80)
    );
  }
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0 &&
    (bytes[1]! & 0x18) !== 0x08 &&
    (bytes[1]! & 0x06) !== 0 &&
    (bytes[2]! & 0xf0) !== 0xf0 &&
    (bytes[2]! & 0x0c) !== 0x0c
  );
}

function fileBrands(bytes: Buffer): string[] {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    if (size < 8 || offset + size > bytes.length) break;
    if (kind === 'ftyp' && size >= 16 && size % 4 === 0) {
      const brands = [bytes.toString('latin1', offset + 8, offset + 12)];
      for (let index = offset + 16; index < offset + size; index += 4)
        brands.push(bytes.toString('latin1', index, index + 4));
      return brands;
    }
    if (kind !== 'free' && kind !== 'skip' && kind !== 'wide') break;
    offset += size;
  }
  return [];
}

function ebmlNumber(bytes: Buffer, offset: number) {
  const first = bytes[offset] ?? 0;
  const width = Math.clz32(first) - 23;
  if (width > 8 || offset + width > bytes.length) return;
  let value = first & (0xff >> width);
  for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i]!;
  if (Number.isSafeInteger(value)) return { width, value };
}

function ebmlDocType(bytes: Buffer): string | undefined {
  if (bytes.length < 5 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return;
  const header = ebmlNumber(bytes, 4);
  if (!header) return;
  let offset = 4 + header.width;
  const end = offset + header.value;
  if (end > bytes.length) return;
  while (offset < end) {
    const id = ebmlNumber(bytes, offset);
    if (!id) return;
    offset += id.width;
    const size = ebmlNumber(bytes, offset);
    if (!size) return;
    offset += size.width;
    if (size.value > end - offset) return;
    if (id.width === 2 && id.value === 0x282)
      return bytes.toString('latin1', offset, offset + size.value);
    offset += size.value;
  }
}

const heifBrand = /^(mif1|msf1|hei[cxmsv])$/;
const threeGppBrand = /^3g[pers]/;
const mp4Brand = /^(iso[m2-9]|mp4[12]|avc1|dash|M4[AV] |MSNV)$/;

/** Recognize file signatures and container brands without inferring tracks or decoding media. */
export function matchesVideoInputFormat(value: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/jpg')
    return matchesImageSignature(value, contentType === 'image/png' ? 'image/png' : 'image/jpeg');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  switch (contentType) {
    case 'image/webp':
      return hasText(bytes, 0, 'RIFF') && hasText(bytes, 8, 'WEBPVP8');
    case 'image/gif':
      return hasText(bytes, 0, 'GIF87a') || hasText(bytes, 0, 'GIF89a');
    case 'image/bmp':
    case 'image/x-ms-bmp':
      return hasText(bytes, 0, 'BM');
    case 'image/tiff':
      return hasText(bytes, 0, 'II*\0') || hasText(bytes, 0, 'MM\0*');
    case 'image/avif':
      return fileBrands(bytes).some((brand) => brand === 'avif' || brand === 'avis');
    case 'image/heif':
    case 'image/heic':
      return fileBrands(bytes).some((brand) => heifBrand.test(brand));
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/vnd.wave':
      return (hasText(bytes, 0, 'RIFF') || hasText(bytes, 0, 'RF64')) && hasText(bytes, 8, 'WAVE');
    case 'audio/mpeg':
    case 'audio/mp3':
    case 'audio/x-mp3':
      return hasMpegAudioHeader(bytes);
    case 'audio/flac':
    case 'audio/x-flac':
      return hasText(bytes, 0, 'fLaC');
    case 'audio/aac':
    case 'audio/aacp':
      return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
    case 'audio/aiff':
    case 'audio/x-aiff':
      return hasText(bytes, 0, 'FORM') && (hasText(bytes, 8, 'AIFF') || hasText(bytes, 8, 'AIFC'));
    case 'audio/ogg':
    case 'video/ogg':
    case 'audio/opus':
      return hasText(bytes, 0, 'OggS\0');
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'video/mp4':
    case 'video/x-m4v': {
      const brands = fileBrands(bytes);
      const major = brands[0];
      if (!major || major === 'qt  ' || major.startsWith('3g')) return false;
      return (
        !brands.some((brand) => brand === 'avif' || brand === 'avis' || heifBrand.test(brand)) &&
        brands.some((brand) => mp4Brand.test(brand))
      );
    }
    case 'video/quicktime':
      return fileBrands(bytes).includes('qt  ');
    case 'video/3gpp':
    case 'audio/3gpp':
      return fileBrands(bytes).some((brand) => threeGppBrand.test(brand));
    case 'video/webm':
    case 'audio/webm':
      return ebmlDocType(bytes) === 'webm';
    case 'video/matroska':
    case 'video/x-matroska':
    case 'audio/x-matroska':
      return ebmlDocType(bytes) === 'matroska';
    case 'video/avi':
    case 'video/msvideo':
    case 'video/x-msvideo':
      return hasText(bytes, 0, 'RIFF') && hasText(bytes, 8, 'AVI ');
    case 'video/mpeg':
      return hasText(bytes, 0, '\0\0\x01\xba') || hasText(bytes, 0, '\0\0\x01\xb3');
    case 'video/mp2t':
      return bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
    default:
      return false;
  }
}
