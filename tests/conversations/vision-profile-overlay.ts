import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import COS from 'cos-nodejs-sdk-v5';
import type {} from '../../src/dsh/kernel.ts';

/** Network-only substitutes for the packed production Profile. */
export function apply(ctx: Context) {
  const origin = process.env.MIO_TEST_COS_ORIGIN!;
  const originalFetch = globalThis.fetch;
  const originalHead = COS.prototype.headObject;
  const originalGet = COS.prototype.getObject;
  const intercepted: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.onelinkai.cloud') {
      if (url.hostname !== '127.0.0.1') throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
      return originalFetch(input, init);
    }
    if (url.pathname === '/v1/models')
      return Response.json({ data: [{ id: 'deepseek-v4.1-flash' }] });
    const body = (await request.clone().json()) as Record<string, unknown>;
    await appendFile(
      new URL('./requests.jsonl', import.meta.url),
      JSON.stringify({
        authorization: request.headers.get('authorization'),
        path: url.pathname,
        body,
      }) + '\n',
    );
    const hold = JSON.stringify(body.messages).includes('VISION_HOLD');
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const event = (value: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          event({
            id: 'fixture',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'fixture reply' },
                finish_reason: null,
              },
            ],
          });
          if (hold) {
            request.signal.addEventListener('abort', () => controller.error(new Error('aborted')), {
              once: true,
            });
          } else {
            event({
              id: 'fixture',
              object: 'chat.completion.chunk',
              model: 'fixture',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  ctx.effect(() => {
    globalThis.fetch = intercepted;
    COS.prototype.headObject = function (this: COS, ...args: unknown[]) {
      const client = this as unknown as { options: { Domain: string; Protocol: string } };
      client.options.Domain = origin;
      client.options.Protocol = 'http:';
      return Reflect.apply(originalHead, this, args);
    } as typeof COS.prototype.headObject;
    COS.prototype.getObject = function (this: COS, ...args: unknown[]) {
      const client = this as unknown as { options: { Domain: string; Protocol: string } };
      client.options.Domain = origin;
      client.options.Protocol = 'http:';
      return Reflect.apply(originalGet, this, args);
    } as typeof COS.prototype.getObject;
    return () => {
      if (globalThis.fetch === intercepted) globalThis.fetch = originalFetch;
      COS.prototype.headObject = originalHead;
      COS.prototype.getObject = originalGet;
    };
  });
  ctx.inject(['mioKernel'], (subCtx) => {
    const kernel = subCtx.mioKernel;
    const original = kernel.history;
    kernel.history = async function (id: string, signal?: AbortSignal) {
      const blocked = await readFile(new URL('./block-history', import.meta.url)).then(
        () => true,
        () => false,
      );
      const state = () =>
        [...subCtx.registry.values()].flatMap((runtime) =>
          [...runtime.fibers]
            .filter((fiber) => /mio|offload/.test(fiber.name))
            .map((fiber) => ({
              name: fiber.name,
              parent: fiber.parent.fiber.name,
              uid: fiber.uid,
              inject: Object.keys(fiber.inject),
              state: fiber.state,
              effects: fiber.getEffects(),
            })),
        );
      if (blocked) {
        await writeFile(
          new URL('./history-state-before', import.meta.url),
          JSON.stringify(state()),
        );
        await writeFile(new URL('./history-entered', import.meta.url), 'entered');
        while (
          !(await readFile(new URL('./release-history', import.meta.url)).then(
            () => true,
            () => false,
          ))
        )
          await delay(10);
        await writeFile(new URL('./history-state', import.meta.url), JSON.stringify(state()));
      }
      try {
        const result = await original.call(this, id, signal);
        if (blocked) await writeFile(new URL('./history-completed', import.meta.url), 'completed');
        return result;
      } catch (error) {
        if (blocked) await writeFile(new URL('./history-error', import.meta.url), String(error));
        throw error;
      }
    };
    subCtx.effect(() => () => {
      kernel.history = original;
    });
  });
}
