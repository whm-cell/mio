const responseByteLimit = 2 * 1024 * 1024;

/** Observe the same response stream the adapter reads. Keep at most the adapter's byte budget. */
export function observeMaterialLiveResponse(
  response: Response,
  observe: (value: unknown) => void,
  signal?: AbortSignal,
): Response {
  if (!response.body) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size <= responseByteLimit) chunks.push(chunk);
      else chunks.length = 0;
      // Forward oversize bytes so the adapter rejects and cancels the original response.
      controller.enqueue(chunk);
    },
    flush() {
      if (size > responseByteLimit || signal?.aborted) return;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      } finally {
        chunks.length = 0;
      }
      observe(value);
    },
  });
  return new Response(response.body.pipeThrough(transform, signal ? { signal } : undefined), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
