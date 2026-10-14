/**
 * Byte streams of the git transport (spec vaubaan-gateway §4.1 ter; ADR
 * gateway-as-git-remote): the one "head, then the rest" helper every part of
 * the door uses when it has read the start of a body and hands the whole of
 * it on — the command list of a push before its pack, the head of a v2
 * request before its arguments, what a reader buffered before the stream.
 * Nothing here holds more than one chunk.
 */

/** A stream of the chunks a reader still has, cancelled with it. */
export function streamOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * `head`, then every chunk of `rest`, as one stream. An error of `rest`
 * reaches the consumer; cancelling the result cancels `rest`.
 */
export function prependChunk(
  head: Uint8Array,
  rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let headSent = head.length === 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(head);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
