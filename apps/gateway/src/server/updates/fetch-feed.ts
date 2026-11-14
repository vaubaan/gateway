/**
 * One read of the versions feed (ADR plugins-bundled-or-pinned-by-the-operator): a GET
 * that carries nothing about the instance — a generic `User-Agent` without the version,
 * no cookie, no query added, no body — bounded in time and size, its answer checked by
 * `isVersionsFeed` before anything reads it. Never throws: a failure is a result.
 */
import { isVersionsFeed, type VersionsFeed } from '@vaubaan/shared';

/** The `User-Agent` of the request: the product, never its version or the instance. */
export const FEED_USER_AGENT = 'vaubaan-gateway';
/** How long the read may take, account and body together. */
export const FEED_TIMEOUT_MS = 10_000;
/** The largest feed read; the published one is a few kilobytes. */
export const FEED_MAX_BYTES = 512 * 1024;

export type FeedReadFailure =
  'unreachable' | 'timeout' | 'http-status' | 'too-large' | 'not-json' | 'not-a-feed';

export type FeedRead =
  | { readonly ok: true; readonly feed: VersionsFeed }
  | { readonly ok: false; readonly failure: FeedReadFailure; readonly status?: number };

export interface FeedReadOptions {
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** The body as text, or `null` past `maxBytes` (the rest is not read). */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Reads the feed at `url`. */
export async function readVersionsFeed(url: URL, options: FeedReadOptions): Promise<FeedRead> {
  const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FEED_TIMEOUT_MS);
  let text: string | null;
  try {
    const response = await options.fetch(url, {
      method: 'GET',
      headers: { 'user-agent': FEED_USER_AGENT, accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, failure: 'http-status', status: response.status };
    }
    text = await readBoundedText(response, maxBytes);
  } catch (err) {
    return { ok: false, failure: isTimeout(err) || signal.aborted ? 'timeout' : 'unreachable' };
  }
  if (text === null) return { ok: false, failure: 'too-large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: 'not-json' };
  }
  return isVersionsFeed(parsed) ? { ok: true, feed: parsed } : { ok: false, failure: 'not-a-feed' };
}
