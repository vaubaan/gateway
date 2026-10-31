/**
 * Read a provider's answer without trusting its size : a declared
 * `content-length` above the bound is refused before a byte is read, and a
 * body without one (chunked, or lying) is cut as soon as it passes the bound.
 * Either way the body is cancelled, so the connection is released.
 */

import { UpstreamAnswerTooLarge } from './errors.ts';

/**
 * The bound of `httpJson` and the MCP client when the plugin names none :
 * 10 MB, well above a page of any shipped provider's API, well below what
 * would hurt the gateway's memory.
 */
export const DEFAULT_MAX_ANSWER_BYTES = 10_000_000;

/**
 * The body of `res`, at most `maxBytes` bytes ; `UpstreamAnswerTooLarge`
 * beyond (`what` names the request in its message). An answer without a
 * body is empty.
 */
export async function readBounded(
  res: Response,
  maxBytes: number,
  what = 'the answer',
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamAnswerTooLarge(what, maxBytes);
  }
  if (!res.body) return new Uint8Array(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamAnswerTooLarge(what, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** `readBounded`, decoded as UTF-8. */
export async function readBoundedText(
  res: Response,
  maxBytes: number,
  what = 'the answer',
): Promise<string> {
  return new TextDecoder().decode(await readBounded(res, maxBytes, what));
}

/**
 * At most the first `maxBytes` bytes of the body, decoded as UTF-8 ; the
 * rest is cancelled unread. For quoting a failed answer, never for reading
 * one : a prefix is not the answer.
 */
export async function readPrefixText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const room = maxBytes - size;
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      size += part.byteLength;
      text += decoder.decode(part, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return text;
  } finally {
    reader.releaseLock();
  }
}
