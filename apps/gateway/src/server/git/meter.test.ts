/**
 * The git door's bytes (`gitMeter`, `counted`): a relayed fetch counts what
 * went through the relay; a push, the pack the door read.
 */
import { jsonBytes, type CallRequest } from '@vaubaan/gateway-core';
import { describe, expect, it } from 'vitest';

import { counted, gitMeter } from './upstream';

const call: CallRequest = {
  tool: 'github__git_fetch',
  args: { repository: 'acme/app', step: 'pack' },
  channel: 'git',
  agent_label: null,
  client: { ip: null, user_agent: null },
};

describe('gitMeter', () => {
  it('a relayed fetch: the request git sent up, the pack relayed down', () => {
    expect(
      gitMeter.measure(call, { result: { sent_bytes: 812, relayed_bytes: 4_096_000 } }),
    ).toEqual({ request_bytes: 812, response_bytes: 4_096_000 });
  });

  it('a push: the pack the door read up, the tool’s result down', () => {
    const push: CallRequest = { ...call, tool: 'github__git_push', payload_bytes: 70_000 };
    const result = { content: [{ type: 'text', text: 'pushed' }] };
    expect(gitMeter.measure(push, { result })).toEqual({
      request_bytes: 70_000,
      response_bytes: jsonBytes(result),
    });
  });

  it('a call that failed: what went up, nothing down', () => {
    expect(gitMeter.measure({ ...call, payload_bytes: 9 }, { failed: true })).toEqual({
      request_bytes: 9,
      response_bytes: null,
    });
  });
});

describe('counted', () => {
  it('hands the body on unchanged and counts its bytes', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const { stream, bytes } = counted(source);
    const read = new Uint8Array(await new Response(stream).arrayBuffer());
    expect([...read]).toEqual([1, 2, 3, 4, 5]);
    expect(bytes()).toBe(5);
  });
});
