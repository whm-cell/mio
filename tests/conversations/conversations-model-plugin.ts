import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-host-webserver';

/** Installed only into the test's temporary Profile overlay; never included in @mio/plugin. */
export const inject = ['llm', 'webServer'];
export function apply(ctx: Context) {
  const requests: GenerateOptions[] = [];
  let release: (() => void) | undefined;
  class FixtureModel extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      const input = options.messages.filter((message) => message.role === 'user').at(-1);
      const text = JSON.stringify(input).includes('HOLD')
        ? 'held public text'
        : `reply ${requests.length}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      if (text === 'held public text')
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          const abort = () => reject(options.signal?.reason ?? new Error('aborted'));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        });
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['mio-test-only'], new FixtureModel());
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__test/model',
      handler: (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ count: requests.length, messages: requests.at(-1)?.messages }),
        );
      },
    }),
  );
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__test/release',
      handler: (_request, response) => {
        release?.();
        response.end('released');
      },
    }),
  );
}
