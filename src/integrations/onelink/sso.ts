const ENV_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
const ENC_KEY_PATTERN = /^[\x21-\x7e]{32}$/;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ROUTER_CLIENT_ID = 'routerClientId';
const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;
const MAX_REGISTER_RESPONSE_BYTES = 32 * 1024;
const MIN_PG_INT32 = -2_147_483_648;
const MAX_PG_INT32 = 2_147_483_647;

export interface OneLinkSsoConfig {
  readonly environment: string;
  readonly encryptionKey: string;
  readonly authorizeUrl: string;
  readonly registerUrl: string;
  readonly clientName: string;
  readonly appName: string;
}

export type OneLinkSsoRegisterTransport = (url: string, options: RequestInit) => Promise<Response>;

export interface OneLinkSsoRegisterOptions {
  readonly transport?: OneLinkSsoRegisterTransport;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type OneLinkSsoRegisterResult =
  | {
      readonly kind: 'registered';
      readonly code: 200;
      readonly clientId: string;
      readonly clientName: string;
      readonly traceId: string | null;
    }
  | {
      readonly kind: 'already_exists';
      readonly code: 362;
      readonly traceId: string | null;
    }
  | {
      readonly kind: 'rejected';
      readonly code: 363 | 364;
      readonly errorCode: 'ONELINK_CLIENT_NAME_INVALID' | 'ONELINK_CLIENT_TEMPLATE_MISSING';
      readonly traceId: string | null;
    }
  | {
      readonly kind: 'failed';
      readonly code: number | null;
      readonly errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED';
      readonly traceId: string | null;
    };

function parseOneLinkEndpointUrl(raw: string | undefined, name: string): string {
  if (!raw || WHITESPACE_OR_CONTROL.test(raw)) {
    throw new Error(`ONELINK_SSO_CONFIG: invalid ${name}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ONELINK_SSO_CONFIG: invalid ${name}`);
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      `ONELINK_SSO_CONFIG: ${name} must use HTTPS without credentials (HTTP allowed on loopback only)`,
    );
  }
  return parsed.toString();
}

export function readOneLinkSsoConfig(
  env: NodeJS.ProcessEnv = process.env,
): OneLinkSsoConfig | undefined {
  const requiredKeys = [
    'MIO_ONELINK_SSO_ENC_KEY',
    'MIO_ONELINK_SSO_AUTHORIZE_URL',
    'MIO_ONELINK_SSO_REGISTER_URL',
  ] as const;
  if (requiredKeys.every((key) => env[key] === undefined)) {
    return undefined;
  }

  const encryptionKey = env.MIO_ONELINK_SSO_ENC_KEY;
  if (!encryptionKey || !ENC_KEY_PATTERN.test(encryptionKey)) {
    throw new Error('ONELINK_SSO_CONFIG: invalid MIO_ONELINK_SSO_ENC_KEY');
  }

  const authorizeUrl = parseOneLinkEndpointUrl(
    env.MIO_ONELINK_SSO_AUTHORIZE_URL,
    'MIO_ONELINK_SSO_AUTHORIZE_URL',
  );
  const registerUrl = parseOneLinkEndpointUrl(
    env.MIO_ONELINK_SSO_REGISTER_URL,
    'MIO_ONELINK_SSO_REGISTER_URL',
  );

  const clientName =
    env.MIO_ONELINK_SSO_CLIENT_NAME === undefined ? 'miioo' : env.MIO_ONELINK_SSO_CLIENT_NAME;
  if (
    !clientName ||
    clientName.length > 50 ||
    WHITESPACE_OR_CONTROL.test(clientName) ||
    clientName === ROUTER_CLIENT_ID
  ) {
    throw new Error('ONELINK_SSO_CONFIG: invalid MIO_ONELINK_SSO_CLIENT_NAME');
  }

  const appName =
    env.MIO_ONELINK_SSO_APP_NAME === undefined ? 'Miioo' : env.MIO_ONELINK_SSO_APP_NAME;
  if (!appName.trim() || appName.length > 50 || CONTROL_CHARS.test(appName)) {
    throw new Error('ONELINK_SSO_CONFIG: invalid MIO_ONELINK_SSO_APP_NAME');
  }

  const environment =
    env.MIO_ONELINK_SSO_ENV === undefined
      ? env.MIO_ENVIRONMENT?.trim() || 'dev'
      : env.MIO_ONELINK_SSO_ENV;
  if (!ENV_PATTERN.test(environment)) {
    throw new Error('ONELINK_SSO_CONFIG: invalid MIO_ONELINK_SSO_ENV');
  }

  return {
    environment,
    encryptionKey,
    authorizeUrl,
    registerUrl,
    clientName,
    appName,
  };
}

function sanitizeTraceId(value: unknown, encryptionKey: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 128 ||
    CONTROL_CHARS.test(trimmed) ||
    trimmed.includes(encryptionKey)
  ) {
    return null;
  }
  return trimmed;
}

function parseUpstreamCode(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_PG_INT32 ||
    value > MAX_PG_INT32
  ) {
    return null;
  }
  return value;
}

function isValidClientId(value: unknown, encryptionKey: string): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    !WHITESPACE_OR_CONTROL.test(value) &&
    value !== ROUTER_CLIENT_ID &&
    !value.includes(encryptionKey)
  );
}

async function readBoundedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REGISTER_RESPONSE_BYTES) return null;
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function registerOneLinkSsoClient(
  config: OneLinkSsoConfig,
  options?: OneLinkSsoRegisterOptions,
): Promise<OneLinkSsoRegisterResult> {
  const transport = options?.transport ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const failed = (code: number | null = null, traceId: string | null = null) =>
    ({
      kind: 'failed',
      code,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId,
    }) as const;

  let response: Response;
  try {
    response = await transport(config.registerUrl, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ clientName: config.clientName }),
    });
  } catch {
    return failed();
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return failed();
  }

  let raw: string | null;
  try {
    raw = await readBoundedText(response);
  } catch {
    return failed();
  }
  if (raw === null) return failed();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failed();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failed();
  }

  const envelope = parsed as Record<string, unknown>;
  const traceId = sanitizeTraceId(envelope.traceId, config.encryptionKey);
  const code = parseUpstreamCode(envelope.code);

  if (code === 362) {
    return { kind: 'already_exists', code: 362, traceId };
  }
  if (code === 363) {
    return {
      kind: 'rejected',
      code: 363,
      errorCode: 'ONELINK_CLIENT_NAME_INVALID',
      traceId,
    };
  }
  if (code === 364) {
    return {
      kind: 'rejected',
      code: 364,
      errorCode: 'ONELINK_CLIENT_TEMPLATE_MISSING',
      traceId,
    };
  }
  if (response.ok && code === 200) {
    const data = envelope.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return failed(code, traceId);
    }
    const payload = data as Record<string, unknown>;
    if (!isValidClientId(payload.clientId, config.encryptionKey)) {
      return failed(code, traceId);
    }
    if (
      payload.clientName !== undefined &&
      payload.clientName !== null &&
      payload.clientName !== config.clientName
    ) {
      return failed(code, traceId);
    }
    return {
      kind: 'registered',
      code: 200,
      clientId: payload.clientId,
      clientName: config.clientName,
      traceId,
    };
  }
  return failed(code, traceId);
}
