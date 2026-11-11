import { createHash, randomUUID } from 'node:crypto';
import type { BetterAuthOptions } from 'better-auth';
import type { RedisResource } from '../integrations/redis.ts';

export type AuthRateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions['rateLimit']>['customStorage']
>;

// One key and one write: count and last admission move together with their expiry.
// Redis TIME is the authority for both the logical window and the PX expiry.
export const AUTH_RATE_LIMIT_SCRIPT = `#!lua
local window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
if not window or window < 1 or window % 1 ~= 0 or not maximum or maximum < 1 or maximum % 1 ~= 0 then
  return redis.error_reply('MIO_RATE_LIMIT_RULE')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local value = redis.call('GET', KEYS[1])
local count = 0
local last = now
if value then
  local storedCount, storedLast = string.match(value, '^(%d+):(%d+)$')
  count = tonumber(storedCount)
  last = tonumber(storedLast)
  if not count or count < 1 or count > 9007199254740991 or not last or last > now or redis.call('PTTL', KEYS[1]) < 0 then
    return redis.error_reply('MIO_RATE_LIMIT_STATE')
  end
  if now - last >= window then count = 0 end
end
if count >= maximum then
  return {0, math.ceil((last + window - now) / 1000)}
end
redis.call('SET', KEYS[1], string.format('%.0f:%.0f', count + 1, now), 'PX', window)
return {1, 0}
`;

/** Startup consumes a private probe, verifies expiry, then removes only that key. */
export async function createRedisRateLimit(
  redis: RedisResource,
  namespace: string,
  startupDeadline = performance.now() + 5000,
): Promise<AuthRateLimitStorage> {
  const prefix = `mio:${namespace}:auth:rate-limit:v1:`;
  const probe = `${prefix}probe:${randomUUID()}`;
  try {
    const reply = await redis.evaluate(
      AUTH_RATE_LIMIT_SCRIPT,
      probe,
      ['1000', '1'],
      startupDeadline - performance.now(),
    );
    const ttl = await redis.ttl(probe, startupDeadline - performance.now());
    const deleted = await redis.delete(probe, startupDeadline - performance.now());
    if (
      !Array.isArray(reply) ||
      reply[0] !== 1 ||
      typeof ttl !== 'number' ||
      ttl <= 0 ||
      ttl > 1000 ||
      deleted !== 1
    )
      throw new Error('probe');
  } catch {
    redis.stop();
    throw new Error('AUTH_RATE_LIMIT_STARTUP: Redis consumption probe failed');
  }
  return {
    async consume(key, rule) {
      const deadline = performance.now() + 1000;
      const storedKey = prefix + createHash('sha256').update(key).digest('hex');
      const reply = await redis.evaluate(
        AUTH_RATE_LIMIT_SCRIPT,
        storedKey,
        [String(rule.window * 1000), String(rule.max)],
        deadline - performance.now(),
      );
      if (
        !Array.isArray(reply) ||
        reply.length !== 2 ||
        ![0, 1].includes(reply[0] as number) ||
        !Number.isInteger(reply[1]) ||
        (reply[1] as number) < 0
      ) {
        redis.stop();
        throw new Error('AUTH_RATE_LIMIT_UNAVAILABLE');
      }
      return { allowed: reply[0] === 1, retryAfter: reply[0] === 1 ? null : (reply[1] as number) };
    },
  };
}
