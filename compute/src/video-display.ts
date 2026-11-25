export interface VideoDisplayStream {
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

export function probeRatio(value: string | undefined, separator: ':' | '/'): number | null {
  const [a, b] = (value ?? '').split(separator).map(Number);
  return a !== undefined && b !== undefined && a > 0 && b > 0 && Number.isFinite(a / b)
    ? a / b
    : null;
}

export function videoDisplayGeometry(stream: VideoDisplayStream) {
  const { width = 0, height = 0, sample_aspect_ratio: aspect = '1:1' } = stream;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    return null;
  const rawRotation =
    stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ??
    Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(rawRotation)) return null;
  const rotation = ((rawRotation % 360) + 360) % 360;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const sar = probeRatio(aspect, ':');
  const pixelWidth = sar ?? 1;
  return {
    width: Math.round(cos * width * pixelWidth + sin * height),
    height: Math.round(sin * width * pixelWidth + cos * height),
    rotation,
    sampleAspectRatio: sar === null ? '1:1' : aspect,
  };
}
