/** FFprobe emits one timestamp and duration per packet. Retain only the earliest start and latest end. */
export function videoPacketEndCapture(frameSeconds: number) {
  let tail = '';
  let first = Infinity;
  let end = -Infinity;
  let packets = 0;
  return {
    write(chunk: Buffer) {
      const lines = (tail + chunk.toString('utf8')).split('\n');
      tail = lines.pop()!;
      if (tail.length > 128) throw new Error('OUTPUT_INVALID');
      for (const line of lines) {
        if (++packets > 3_600_000 || line.length > 128) throw new Error('OUTPUT_INVALID');
        const [timestamp, duration] = line.split(',');
        const start = Number(timestamp);
        const length = Number(duration);
        if (timestamp && Number.isFinite(start)) {
          first = Math.min(first, start);
          end = Math.max(
            end,
            start + (length > 0 && Number.isFinite(length) ? length : frameSeconds),
          );
        }
      }
    },
    finish() {
      if (tail) throw new Error('OUTPUT_INVALID');
      return Number.isFinite(end) ? { first, end } : undefined;
    },
  };
}
