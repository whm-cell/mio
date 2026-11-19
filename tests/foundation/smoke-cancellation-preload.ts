// Loaded only into the smoke parent, never its sanitized official DSH child.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).pathname !== process.env.MIO_SMOKE_PROBE_STAGE)
    return originalFetch(url, init);
  // Readiness cancellation starts only after the real child owns its HTTP port.
  if (process.env.MIO_SMOKE_PROBE_STAGE === '/readyz') {
    const response = await originalFetch(url, init);
    if (!response.ok) return response;
  }
  console.log(`SMOKE_FETCH_PENDING ${url}`);
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error('SMOKE_FETCH_MISSING_SIGNAL');
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};
