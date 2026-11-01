/**
 * The sentence of a JSON refusal of the gateway's API (`{ error, message }`), as the
 * client components show it.
 */

/** The `message` the instance stated, or `null` when the body carries none. */
export function statedMessageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('message' in body)) return null;
  return typeof body.message === 'string' ? body.message : null;
}

/** The stated message, or a sentence naming the HTTP status. */
export function messageOf(body: unknown, status: number): string {
  return statedMessageOf(body) ?? `The gateway answered ${status}.`;
}
