/**
 * The pack of a push, read whole and bounded before any byte of it leaves
 * the gateway (ADR git-push-inspected-before-it-leaves): the plugin inspects
 * its objects first, the pipeline decides on what it found, and only then is
 * it stored at the provider (`temporary-refs.ts`).
 *
 * Memory: at most `git.max_pack_mb` per push, and at most
 * `MAX_PUSHES_IN_FLIGHT_PER_MISSION` pushes of a mission at once.
 */
import { concatBytes, type PktLineReader } from '@vaubaan/plugin-sdk';

import { interrupted, PushStop, tooLarge } from './push-stop';

/**
 * The rest of the request — the pack — as bytes, at most `limit` of them.
 * Over the limit the rest of the body is left unread: the server discards it
 * once the answer is sent, so git reads the refusal instead of a broken pipe.
 */
export async function readPack(
  reader: PktLineReader,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const stream = reader.rest().getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await stream.read();
      if (done) break;
      seen += value.length;
      if (seen > limit) throw tooLarge(limit);
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PushStop) throw err;
    throw (
      interrupted(signal) ??
      new PushStop('the push could not be read; push again', 'the push body could not be read')
    );
  } finally {
    stream.releaseLock();
  }
  return concatBytes(chunks);
}
