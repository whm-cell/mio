import { AudioError, AUDIO_OUTPUT_BYTES } from '../../audio/contracts.ts';
import type { AudioAdmission, AudioParameters } from '../../audio/contracts.ts';
import { ONELINK_ORIGIN } from './models.ts';
import { withPublicHttps } from './public-https.ts';

export interface AudioSupplierResult {
  bytes?: Uint8Array;
  url?: string;
  voiceId?: string;
}
async function bounded(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new AudioError(503, 'AUDIO_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new AudioError(503, 'AUDIO_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function output(value: Record<string, unknown>): AudioSupplierResult {
  const data = object(value.data) ? value.data : value;
  const audio = data.audio;
  if (
    typeof audio === 'string' &&
    audio.length > 0 &&
    audio.length <= AUDIO_OUTPUT_BYTES * 2 &&
    audio.length % 2 === 0 &&
    /^[a-f0-9]+$/i.test(audio)
  )
    return { bytes: Buffer.from(audio, 'hex') };
  const candidate =
    data.audio_url ??
    value.audio_url ??
    data.demo_audio ??
    value.demo_audio ??
    value.demo_audio_url;
  if (typeof candidate === 'string' && candidate.length <= 8192) {
    const url = new URL(candidate);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port)
      return { url: url.href };
  }
  throw new AudioError(503, 'AUDIO_RESPONSE_INVALID');
}
/** Exactly one gateway POST. Callers persist intent before invoking this function. */
export async function submitAudio(
  admission: AudioAdmission,
  apiKey: string,
  input: {
    text: string;
    parameters?: AudioParameters;
    upstreamVoiceId?: string;
    voiceId?: string;
    sample?: { bytes: Uint8Array; filename: string; contentType: string };
  },
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<AudioSupplierResult> {
  let body: BodyInit,
    headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    };
  if (admission.operation === 'tts') {
    const p = input.parameters!;
    headers = { ...headers, 'content-type': 'application/json' };
    body = JSON.stringify({
      model: admission.modelId,
      text: input.text,
      stream: false,
      output_format: 'hex',
      voice_setting: {
        voice_id: input.upstreamVoiceId,
        speed: p.speed,
        vol: p.volume,
        pitch: p.pitch,
      },
      audio_setting: { format: p.format, sample_rate: 32000, bitrate: 128000, channel: 1 },
    });
  } else {
    if (!input.sample || !input.voiceId) throw new AudioError(400, 'AUDIO_SAMPLE_INVALID');
    const form = new FormData();
    form.set('voice_id', input.voiceId);
    form.set('audition_text', input.text);
    form.set(
      'file',
      new Blob([new Uint8Array(input.sample.bytes)], { type: input.sample.contentType }),
      input.sample.filename,
    );
    body = form;
  }
  const response = await transport(ONELINK_ORIGIN + admission.submitPath, {
    method: 'POST',
    redirect: 'error',
    headers,
    body,
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AudioError(
      503,
      [400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)
        ? 'AUDIO_UPSTREAM_REJECTED'
        : 'AUDIO_SUBMIT_UNKNOWN',
    );
  }
  const bytes = await bounded(response, AUDIO_OUTPUT_BYTES * 2 + 65536, signal);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (raw.includes(apiKey)) throw new AudioError(503, 'AUDIO_RESPONSE_INVALID');
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    !object(value.base_resp) ||
    !Number.isSafeInteger(value.base_resp.status_code)
  )
    throw new AudioError(503, 'AUDIO_RESPONSE_INVALID');
  if (value.base_resp.status_code !== 0) throw new AudioError(503, 'AUDIO_UPSTREAM_REJECTED');
  if (admission.operation === 'clone') {
    // status_code=0 confirms creation even if the audition is absent or malformed.
    // Keep that resource identity durable; materialization must never repeat the clone POST.
    try {
      return { ...output(value), voiceId: input.voiceId! };
    } catch {
      return { voiceId: input.voiceId! };
    }
  }
  // A successful gateway acknowledgement without a valid output is a known
  // failed deliverable. It is safe to preserve that outcome without retrying.
  try {
    return output(value);
  } catch {
    return {};
  }
}
export async function downloadAudio(
  url: string,
  signal: AbortSignal,
  download: typeof withPublicHttps = withPublicHttps,
): Promise<Uint8Array> {
  return download(new URL(url), signal, async (response) => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new AudioError(503, 'AUDIO_OUTPUT_UNAVAILABLE');
    }
    return bounded(response, AUDIO_OUTPUT_BYTES, signal);
  });
}
