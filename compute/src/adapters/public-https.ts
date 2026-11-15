import dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';

type ResolveAll = (
  hostname: string,
  done: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

// ipaddr.js recognizes the IANA special-purpose ranges; mapped IPv4 must be classified as IPv4.
function publicAddress(value: string): boolean {
  if (!isIP(value)) return false;
  const address = ipaddr.process(value);
  if (address instanceof ipaddr.IPv4) {
    const canonical = address.toString();
    return (
      ['unicast', 'as112', 'amt'].includes(address.range()) ||
      canonical === '192.0.0.9' ||
      canonical === '192.0.0.10'
    );
  }
  // The globally reachable NAT64 prefix embeds an IPv4 destination; reject private translations.
  if (address.match(ipaddr.IPv6.parse('64:ff9b::'), 96)) {
    const a = address.parts[6]!;
    const b = address.parts[7]!;
    return publicAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (!address.match(ipaddr.IPv6.parse('2000::'), 3)) return false;
  return (
    ['unicast', 'amt', 'as112v6', 'orchid2', 'droneRemoteIdProtocolEntityTags'].includes(
      address.range(),
    ) || ['2001:1::1', '2001:1::2', '2001:1::3'].includes(address.toRFC5952String())
  );
}

/** Consume one public HTTPS response while its private dispatcher is alive. */
export async function withPublicHttps<T>(
  url: URL,
  signal: AbortSignal,
  consume: (response: Response) => Promise<T>,
  dependencies: {
    resolveAll?: ResolveAll;
    createAgent?: (lookup: LookupFunction) => Dispatcher;
    fetch?: typeof undiciFetch;
  } = {},
): Promise<T> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || signal.aborted)
    throw new Error('IMAGE_RESULT_UNSAFE');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error('IMAGE_RESULT_UNSAFE');
  const resolveAll: ResolveAll =
    dependencies.resolveAll ??
    ((name, done) => dns.lookup(name, { all: true, verbatim: true }, done));
  const lookup: LookupFunction = (name, options, done) => {
    let completed = false;
    try {
      resolveAll(name, (error, addresses) => {
        completed = true;
        if (error) return done(error, '', 0);
        const publicAddresses = addresses.filter(
          (item) =>
            isIP(item.address) === item.family &&
            (!options.family || options.family === item.family) &&
            publicAddress(item.address),
        );
        const first = publicAddresses[0];
        if (!first)
          return done(
            Object.assign(new Error('IMAGE_RESULT_UNSAFE'), { code: 'ENOTFOUND' }),
            '',
            0,
          );
        if (options.all) return done(null, publicAddresses);
        return done(null, first.address, first.family);
      });
    } catch (error) {
      if (completed) throw error;
      done(Object.assign(new Error('IMAGE_RESULT_UNSAFE'), { code: 'ENOTFOUND' }), '', 0);
    }
  };
  const agent = dependencies.createAgent?.(lookup) ?? new Agent({ connect: { lookup } });
  let response: Awaited<ReturnType<typeof undiciFetch>> | undefined;
  let completed = false;
  try {
    response = await (dependencies.fetch ?? undiciFetch)(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      dispatcher: agent,
    });
    const result = await consume(response as unknown as Response);
    completed = true;
    return result;
  } finally {
    if (!completed || response?.body?.locked) await agent.destroy();
    else {
      try {
        await response?.body?.cancel();
        await agent.close();
      } catch {
        await agent.destroy();
      }
    }
  }
}
