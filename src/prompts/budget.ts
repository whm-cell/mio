/** Deterministic heuristic only; callers own window limits and semantic chunking. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const point of text) {
    if (point.codePointAt(0)! <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}
