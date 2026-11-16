import { vi } from 'vitest';

export function message(content: unknown[], stop_reason = 'end_turn') {
  return {
    id: 'msg_gateway',
    type: 'message',
    role: 'assistant',
    model: 'openai/gpt-5.4',
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  };
}

export const textReply = (text = 'done') => message([{ type: 'text', text }]);
export const toolReply = (name: string, input: unknown) =>
  message([{ type: 'tool_use', id: 'tu_gateway', name, input }], 'tool_use');

/** Exercise the real SDK serialization/tool loop; no request can reach the network. */
export function mockGateway(...replies: Array<unknown | Response>) {
  const requests: Array<{ url: string; headers: Headers; body: any; signal: unknown }> = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('Unexpected Gateway request');
    return reply instanceof Response
      ? reply
      : new Response(JSON.stringify(reply), {
          status: 200,
          headers: { 'content-type': 'application/json', 'request-id': 'req_gateway' },
        });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}
