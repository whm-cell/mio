import type { VideoRequestParameters } from '../../../generations/video/contracts.ts';

export function happyhorsePrompt(input: VideoRequestParameters): string {
  if (input.mode !== 'reference_subjects') return input.prompt;

  let image = 0;
  const labels: string[] = [];
  for (const subject of input.subjects ?? []) {
    const slots = subject.images.map(() => '[Image ' + ++image + ']').join('、');
    // Brackets in a quoted name must not introduce upstream image references.
    const name = JSON.stringify(subject.name)
      .replaceAll('[', '\\u005b')
      .replaceAll(']', '\\u005d')
      .replaceAll('\u0085', '\\u0085')
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    labels.push(slots + ' 为 ' + name);
  }
  return labels.join('；') + '。\n' + input.prompt;
}
