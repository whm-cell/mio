import { appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { protocolResponse } from './fixture.ts';

/** Temporary child-Profile overlay only. Production Mio/PiAi/loop remain the request implementation. */
export function apply(ctx: Context) {
  ctx.on('llm/stream', (options, next) => {
    const input = options.messages.filter((message) => message.role === 'user').at(-1);
    if (!JSON.stringify(input).includes('PAUSE_WIRE')) return next();
    return (async function* () {
      await writeFile(new URL('./paused', import.meta.url), 'prepared');
      while (
        !(await readFile(new URL('./release', import.meta.url), 'utf8').then(
          () => true,
          () => false,
        ))
      ) {
        options.signal?.throwIfAborted();
        await delay(10);
      }
      await unlink(new URL('./release', import.meta.url));
      await unlink(new URL('./paused', import.meta.url));
      yield* next();
    })();
  });
  const original = globalThis.fetch;
  const intercepted: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== 'https://api.onelinkai.cloud') return original(input, init);
    if (new URL(request.url).pathname === '/v1/models') {
      const ids = await readFile(new URL('./catalog.json', import.meta.url), 'utf8').then(
        (raw) => JSON.parse(raw) as string[],
        () => ['deepseek-v4.1-flash', 'claude-sonnet-4.5-20250929'],
      );
      return Response.json({ data: ids.map((id) => ({ id })) });
    }
    const body = (await request.clone().json()) as Record<string, unknown>;
    await appendFile(
      new URL('./requests.jsonl', import.meta.url),
      JSON.stringify({
        authorization: request.headers.get('authorization'),
        path: new URL(request.url).pathname,
        body,
      }) + '\n',
    );
    const messages = body.messages as { role: string; content: unknown }[];
    const text = JSON.stringify(messages.filter((message) => message.role === 'user').at(-1));
    return protocolResponse(
      request,
      text.includes('HOLD') ? 'held fixture text' : 'fixture answer',
      text.includes('HOLD'),
    );
  };
  ctx.effect(() => {
    globalThis.fetch = intercepted;
    return () => {
      if (globalThis.fetch === intercepted) globalThis.fetch = original;
    };
  });
}
