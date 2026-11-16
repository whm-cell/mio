import { sha256Utf8 } from '@mio/foundation/hash';
import { epochMs, monotonicMs } from '@mio/foundation/time';

export interface WechatConfig {
  appId: string;
  appSecret: string;
}

interface WechatTokens {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: Date;
  scopes: string[];
  openid: string;
}

const RESPONSE_LIMIT = 32 * 1024;
const REQUEST_TIMEOUT = 5000;

/** Both requests have a fixed destination, a real abort deadline and bounded response body. */
async function wechatJSON(path: string, parameters: Record<string, string>) {
  const started = monotonicMs();
  try {
    const url = new URL(path, 'https://api.weixin.qq.com');
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('invalid response');
    }
    if (!response.body) throw new Error('invalid response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > RESPONSE_LIMIT) {
          await reader.cancel();
          throw new Error('response too large');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      ('errcode' in data && data.errcode !== 0) ||
      monotonicMs() - started >= REQUEST_TIMEOUT
    )
      throw new Error('invalid response');
    return data as Record<string, unknown>;
  } catch {
    // Request URLs contain credentials and tokens; neither errors nor URLs leave this boundary.
    throw new Error('WECHAT_UNAVAILABLE');
  }
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function wechatAccountId(appId: string, openid: string) {
  return JSON.stringify([appId, openid]);
}

/** Reuses the provider's authorization URL and account/session flow, replacing only its I/O. */
export function createWechatClient(config: WechatConfig, placeholderDomain: string) {
  return {
    async exchangeCode(code: string): Promise<WechatTokens> {
      if (!present(code)) throw new Error('WECHAT_UNAVAILABLE');
      const data = await wechatJSON('/sns/oauth2/access_token', {
        appid: config.appId,
        secret: config.appSecret,
        code,
        grant_type: 'authorization_code',
      });
      if (
        !present(data.openid) ||
        !present(data.access_token) ||
        typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0 ||
        typeof data.scope !== 'string'
      )
        throw new Error('WECHAT_UNAVAILABLE');
      return {
        accessToken: data.access_token,
        ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
        accessTokenExpiresAt: new Date(epochMs() + data.expires_in * 1000),
        scopes: data.scope.split(',').filter(Boolean),
        openid: data.openid,
      };
    },
    async getUserInfo(tokens: { accessToken?: string | undefined; openid?: string | undefined }) {
      if (!present(tokens.accessToken) || !present(tokens.openid))
        throw new Error('WECHAT_UNAVAILABLE');
      const data = await wechatJSON('/sns/userinfo', {
        access_token: tokens.accessToken,
        openid: tokens.openid,
        lang: 'zh_CN',
      });
      if (data.openid !== tokens.openid) throw new Error('WECHAT_UNAVAILABLE');
      const id = wechatAccountId(config.appId, tokens.openid);
      const hash = sha256Utf8(id).slice(0, 56);
      return {
        user: {
          name: typeof data.nickname === 'string' ? data.nickname : '微信用户',
          email: `wechat-${hash}@${placeholderDomain}`,
          emailVerified: false,
          ...(typeof data.headimgurl === 'string' ? { image: data.headimgurl } : {}),
        },
        data,
      };
    },
  };
}
