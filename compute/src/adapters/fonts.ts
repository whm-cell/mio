import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = new URL('../../fonts/', import.meta.url);
const filenames = {
  sans: ['NotoSansCJKsc-Regular.otf', 'Noto Sans CJK SC'],
  serif: ['NotoSerifCJKsc-Regular.otf', 'Noto Serif CJK SC'],
} as const;

interface FontFace {
  familyName: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  hasGlyphForCodePoint(code: number): boolean;
  layout(text: string): { positions: { xAdvance: number }[] };
}

interface SubtitleFont {
  family: string;
  heightInEm: number;
  width(text: string, size: number): number;
}

let bundled: Promise<Record<keyof typeof filenames, SubtitleFont>> | undefined;

/** The same path applies to src/adapters and dist/adapters in the Worker package. */
export function bundledFontsDirectory(): string {
  return fileURLToPath(directory);
}

async function loadFonts(): Promise<Record<keyof typeof filenames, SubtitleFont>> {
  try {
    // @ts-expect-error fontkit 2.0.4 has no published declarations. Check the loaded face at this boundary.
    const { openSync }: { openSync(filename: string): unknown } = await import('fontkit');
    const license = statSync(new URL('OFL.txt', directory));
    if (!license.isFile() || !license.size) throw new Error();
    const read = (family: keyof typeof filenames): SubtitleFont => {
      const [filename, name] = filenames[family];
      const font = openSync(fileURLToPath(new URL(filename, directory))) as FontFace | null;
      if (
        !font ||
        font.familyName !== name ||
        !Number.isFinite(font.unitsPerEm) ||
        font.unitsPerEm <= 0 ||
        !Number.isFinite(font.ascent - font.descent) ||
        font.ascent <= font.descent ||
        !font.hasGlyphForCodePoint(0x4e2d) ||
        font.layout('中文').positions.length !== 2
      )
        throw new Error();
      return {
        family: name,
        heightInEm: (font.ascent - font.descent) / font.unitsPerEm,
        width: (text, size) =>
          (font.layout(text).positions.reduce((sum, position) => sum + position.xAdvance, 0) *
            size) /
          font.unitsPerEm,
      };
    };
    return { sans: read('sans'), serif: read('serif') };
  } catch (cause) {
    throw new Error('CAPABILITY_UNAVAILABLE', { cause });
  }
}

export function checkBundledFonts(): Promise<Record<keyof typeof filenames, SubtitleFont>> {
  bundled ??= loadFonts();
  return bundled;
}
