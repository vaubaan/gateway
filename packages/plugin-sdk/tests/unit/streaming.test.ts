import type { McpToolContent } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { appendPart, streamToolResult, textParts } from '../../src/streaming.ts';

const text = (value: string): McpToolContent => ({ type: 'text', text: value });
const image: McpToolContent = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

async function* partsOf(...parts: McpToolContent[]): AsyncGenerator<McpToolContent> {
  for (const part of parts) yield part;
}

function bodyOf(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('appendPart', () => {
  it('merges consecutive text parts and keeps every other boundary', () => {
    const content: McpToolContent[] = [];
    for (const part of [text('a'), text('b'), image, text('c'), text('d')]) {
      appendPart(content, part);
    }
    expect(content).toEqual([text('ab'), image, text('cd')]);
  });
});

describe('streamToolResult', () => {
  it('returns the complete result when the host provides no sink', async () => {
    await expect(streamToolResult({}, partsOf(text('one '), text('two')))).resolves.toEqual({
      content: [text('one two')],
    });
    await expect(streamToolResult({}, partsOf())).resolves.toEqual({ content: [] });
  });

  it('hands each part to the sink, in order, before reading the next one', async () => {
    const order: string[] = [];
    async function* provider(): AsyncGenerator<McpToolContent> {
      order.push('provider: 1');
      yield text('1');
      order.push('provider: 2');
      yield text('2');
    }
    const result = await streamToolResult(
      {
        emitPart: async (part) => {
          await Promise.resolve();
          order.push(`sink: ${part.type === 'text' ? part.text : part.type}`);
        },
      },
      provider(),
    );
    expect(order).toEqual(['provider: 1', 'sink: 1', 'provider: 2', 'sink: 2']);
    expect(result).toEqual({ content: [text('12')] });
  });

  it('propagates a failure of the provider after the parts already sent', async () => {
    const sent: McpToolContent[] = [];
    async function* provider(): AsyncGenerator<McpToolContent> {
      yield text('kept');
      throw new Error('connection reset');
    }
    await expect(
      streamToolResult({ emitPart: async (part) => void sent.push(part) }, provider()),
    ).rejects.toThrow('connection reset');
    expect(sent).toEqual([text('kept')]);
  });

  it('ends the iteration when the sink rejects, so the provider is released', async () => {
    let released = false;
    async function* provider(): AsyncGenerator<McpToolContent> {
      try {
        yield text('1');
        yield text('2');
      } finally {
        released = true;
      }
    }
    await expect(
      streamToolResult(
        {
          emitPart: async () => {
            throw new Error('the caller is gone');
          },
        },
        provider(),
      ),
    ).rejects.toThrow('the caller is gone');
    expect(released).toBe(true);
  });
});

describe('textParts', () => {
  const encoder = new TextEncoder();

  it('yields one text part per chunk', async () => {
    const parts: McpToolContent[] = [];
    for await (const part of textParts(bodyOf([encoder.encode('ab'), encoder.encode('cd')]))) {
      parts.push(part);
    }
    expect(parts).toEqual([text('ab'), text('cd')]);
  });

  it('decodes a character split across two chunks, and emits no empty part', async () => {
    const bytes = encoder.encode('né');
    // 'é' is two bytes: cut between them.
    const chunks = [bytes.slice(0, 2), bytes.slice(2)];
    const parts: McpToolContent[] = [];
    for await (const part of textParts(bodyOf([new Uint8Array(0), ...chunks]))) parts.push(part);
    expect(parts.map((p) => (p.type === 'text' ? p.text : ''))).toEqual(['n', 'é']);
  });

  it('cancels the body when the iteration stops early', async () => {
    let cancelled = false;
    const body = bodyOf([encoder.encode('1'), encoder.encode('2'), encoder.encode('3')], () => {
      cancelled = true;
    });
    for await (const part of textParts(body)) {
      expect(part).toEqual(text('1'));
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('throws when the body errors midway', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode('first'));
        else controller.error(new Error('socket hang up'));
      },
    });
    const parts: McpToolContent[] = [];
    await expect(
      (async () => {
        for await (const part of textParts(body)) parts.push(part);
      })(),
    ).rejects.toThrow('socket hang up');
    expect(parts).toEqual([text('first')]);
  });
});
