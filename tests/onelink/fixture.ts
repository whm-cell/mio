/** Protocol-only substitute: no Agent, request selection, credentials or persistence implementation. */
export function protocolResponse(request: Request, text: string, hold = false): Response {
  const anthropic = new URL(request.url).pathname === '/v1/messages';
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown, event?: string) =>
        controller.enqueue(
          encoder.encode(
            `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`,
          ),
        );
      const abort = () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* already closed */
        }
      };
      if (request.signal.aborted) return abort();
      if (hold) request.signal.addEventListener('abort', abort, { once: true });
      if (anthropic) {
        send(
          {
            type: 'message_start',
            message: {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model: 'claude-fixture',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          'message_start',
        );
        send(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          'content_block_start',
        );
        send(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          'content_block_delta',
        );
        if (!hold) {
          send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
          send(
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 4 },
            },
            'message_delta',
          );
          send({ type: 'message_stop' }, 'message_stop');
        }
      } else {
        send({
          id: 'chatcmpl_fixture',
          object: 'chat.completion.chunk',
          model: 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        });
        if (!hold) {
          send({
            id: 'chatcmpl_fixture',
            object: 'chat.completion.chunk',
            model: 'deepseek-v4.1-flash',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          });
          send('[DONE]');
        }
      }
      if (!hold) controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request-id' },
  });
}

export function protocolToolResponse(anthropic: boolean): Response {
  const values = anthropic
    ? [
        {
          type: 'message_start',
          message: {
            id: 'msg_tool',
            type: 'message',
            role: 'assistant',
            model: 'claude-fixture',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'call_fixture',
            name: 'counted_fixture',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"value":7}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]
    : [
        {
          id: 'chatcmpl_tool',
          object: 'chat.completion.chunk',
          model: 'deepseek-v4.1-flash',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_fixture',
                    type: 'function',
                    function: { name: 'counted_fixture', arguments: '{"value":7}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl_tool',
          object: 'chat.completion.chunk',
          model: 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        },
      ];
  const body =
    values
      .map(
        (value) =>
          `${anthropic ? `event: ${(value as { type: string }).type}\n` : ''}data: ${JSON.stringify(value)}\n\n`,
      )
      .join('') + (anthropic ? '' : 'data: [DONE]\n\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'tool-fixture-id' },
  });
}
