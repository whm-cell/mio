import type { MediaCommand, SubtitleCue, SubtitleStyle } from '@mio/compute-contracts';
import { checkBundledFonts } from '../adapters/fonts.ts';
import { mediaError, probeInput } from './probe.ts';
import {
  displaySize,
  evenDimension,
  h264Video,
  mp4Output,
  verifyRender,
  videoOutput,
} from './render-video.ts';
import type { MediaFileExecutionContext } from '../media-execution.ts';

interface StyledCue extends SubtitleCue {
  style?: SubtitleStyle;
  track?: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function timestamp(centiseconds: number): string {
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function assColor(value: string): { rgb: string; alpha: string } {
  const [, red, green, blue, opacity] = value.match(/^#(..)(..)(..)(..)?$/)!;
  const alpha = (255 - Number.parseInt(opacity ?? 'ff', 16)).toString(16).padStart(2, '0');
  return { rgb: `${blue}${green}${red}`, alpha };
}

function wrap(text: string, width: number, measure: (text: string) => number): string[] {
  const result: string[] = [];
  // Normalize newlines and protect ASS event rows and overrides. User strings
  // are never used as filter arguments, filenames, styles, or drawing commands.
  const literal = text
    .replace(/\r\n?/g, '\n')
    .replaceAll('\\', '＼')
    .replaceAll('{', '｛')
    .replaceAll('}', '｝')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  for (const paragraph of literal.split('\n')) {
    let line = '';
    let used = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      const advance = measure(segment);
      if (line && used + advance > width) {
        result.push(line);
        line = '';
        used = 0;
      }
      line += segment;
      used += advance;
    }
    result.push(line);
  }
  return result;
}

type Fonts = Awaited<ReturnType<typeof checkBundledFonts>>;
type Display = { width: number; height: number };

function layoutCue(cue: StyledCue, canvas: Display, font: Fonts[keyof Fonts]) {
  const style = cue.style ?? {};
  const scale = canvas.height / 1080;
  const size = (style.fontSize ?? 48) * scale;
  const outline = ((style.outline ?? 0) * scale) / 2;
  const ink = assColor(style.color ?? '#ffffff');
  const stroke = assColor(style.outlineColor ?? '#000000');
  const lines = wrap(cue.text, canvas.width * 0.9, (item) => font.width(item, size));
  const width = Math.max(...lines.map((line) => font.width(line, size)));
  const height = lines.length * size * font.heightInEm;
  const margin = style.margin === undefined ? canvas.height * 0.1 : style.margin * scale;
  const centerY =
    style.alignment === 'top'
      ? margin + height / 2
      : style.alignment === 'middle'
        ? canvas.height / 2
        : canvas.height - margin;
  return { lines, width, height, centerY, ink, stroke, outline, size: size * font.heightInEm };
}

function assScript(cues: StyledCue[], canvas: Display, fonts: Fonts): string {
  const { width, height } = canvas;
  const styles = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];
  const events = [
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const [index, cue] of cues.entries()) {
    const font = fonts[cue.style?.font ?? 'sans'];
    const box = layoutCue(cue, canvas, font);
    const name = `Cue${index}`;
    const layer = ((cue.track ?? 0) * cues.length + index) * 3;
    styles.push(
      `Style: ${name},${font.family},${box.size.toFixed(3)},&H${box.ink.alpha}${box.ink.rgb},&H000000FF,&H${box.stroke.alpha}${box.stroke.rgb},&HFF000000,0,0,0,0,100,100,0,0,1,${box.outline.toFixed(3)},0,5,0,0,0,1`,
    );
    const start = timestamp(Math.floor(cue.startSeconds * 100 + 1e-6));
    const end = timestamp(Math.ceil(cue.endSeconds * 100 - 1e-6));
    const prefix = `${start},${end},${name},,0,0,0,,`;
    if (cue.style?.background && box.width > 0) {
      const background = assColor(cue.style.background);
      const x = (width / 2 - box.width / 2).toFixed(3);
      const y = (box.centerY - box.height / 2).toFixed(3);
      const w = box.width.toFixed(3);
      const h = box.height.toFixed(3);
      events.push(
        `Dialogue: ${layer},${prefix}{\\an7\\pos(${x},${y})\\bord0\\shad0\\1c&H${background.rgb}&\\1a&H${background.alpha}&\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`,
      );
    }
    const position = `\\pos(${width / 2},${box.centerY.toFixed(3)})`;
    const text = box.lines.join('\\N');
    if (box.outline > 0)
      events.push(`Dialogue: ${layer + 1},${prefix}{${position}\\1a&HFF&}${text}`);
    events.push(`Dialogue: ${layer + 2},${prefix}{${position}\\bord0}${text}`);
  }
  return `${[...styles, ...events].join('\n')}\n`;
}

export async function subtitleFilter(
  context: MediaFileExecutionContext,
  cues: StyledCue[],
  canvas: Display,
): Promise<string> {
  const fonts = await checkBundledFonts();
  await context.write('subtitles.ass', assScript(cues, canvas, fonts));
  return 'ass=@file:subtitles.ass:fontsdir=@font:bundled';
}

export async function renderSubtitleCommand(
  command: Extract<MediaCommand, { operation: 'subtitle.burn' }>,
  context: MediaFileExecutionContext,
) {
  const probe = await probeInput(0, context);
  const size = displaySize(probe);
  const canvas = { width: evenDimension(size.width), height: evenDimension(size.height) };
  if (!probe.durationSeconds) throw mediaError('INPUT_INVALID');
  const { cues, style } = command.parameters;
  const scale = `scale=${canvas.width}:${canvas.height},setsar=1`;
  const filter = cues.length
    ? `${scale},${await subtitleFilter(
        context,
        cues.map((cue) => ({ ...cue, ...(style ? { style } : {}) })),
        canvas,
      )}`
    : scale;
  const output = videoOutput('subtitled.mp4');
  await context.run({
    id: 'burn-subtitles',
    tool: 'ffmpeg',
    durationSeconds: probe.durationSeconds,
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      '@file:input-0',
      '-vf',
      filter,
      '-map',
      '0:V:0',
      '-map',
      '0:a?',
      ...h264Video,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      ...mp4Output,
      `@file:${output.name}`,
    ],
    outputs: [output],
  });
  await verifyRender(
    output,
    { ...canvas, duration: probe.durationSeconds, audio: probe.hasAudio, tolerance: 0.1 },
    context,
  );
  return { files: [output], data: { subtitles: cues } };
}
