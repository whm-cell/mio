import { sms } from 'tencentcloud-sdk-nodejs-sms';
import { Agent } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { Duplex } from 'node:stream';

export interface TencentSmsConfig {
  secretId: string;
  secretKey: string;
  appId: string;
  signName: string;
  templateId: string;
  region: string;
}

export type SmsSender = (phoneNumber: string, code: string) => Promise<void>;

/** A redirect must not reuse a connection or open another one for the same send. */
class SingleConnectionAgent extends Agent {
  private opened = false;

  constructor() {
    super({ keepAlive: false, maxSockets: Infinity, maxTotalSockets: Infinity });
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (this.opened) throw new Error('SMS_REDIRECT_BLOCKED');
    this.opened = true;
    return super.createConnection(options, callback);
  }
}

/** A successful response means accepted by Tencent, not delivered to the handset. */
export function createTencentSmsSender(config: TencentSmsConfig): SmsSender {
  return async (phoneNumber, code) => {
    const agent = new SingleConnectionAgent();
    try {
      const started = performance.now();
      const client = new sms.v20210111.Client({
        credential: { secretId: config.secretId, secretKey: config.secretKey },
        region: config.region,
        profile: {
          signMethod: 'TC3-HMAC-SHA256',
          httpProfile: { reqTimeout: 5, agent, headers: { Connection: 'close' } },
        },
      });
      const result = (await client.request(
        'SendSms',
        {
          PhoneNumberSet: [phoneNumber],
          SmsSdkAppId: config.appId,
          SignName: config.signName,
          TemplateId: config.templateId,
          TemplateParamSet: [code, '5'],
        },
        { signal: AbortSignal.timeout(5000) },
      )) as { SendStatusSet?: { Code?: string }[] };
      if (
        performance.now() - started >= 5000 ||
        result.SendStatusSet?.length !== 1 ||
        result.SendStatusSet[0]?.Code !== 'Ok'
      )
        throw new Error('SMS_REJECTED');
    } catch {
      // Provider errors may contain request details. Never relay or log them.
      throw new Error('SMS_UNAVAILABLE');
    } finally {
      agent.destroy();
    }
  };
}
