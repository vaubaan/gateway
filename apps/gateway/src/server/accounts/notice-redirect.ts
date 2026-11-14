/**
 * "Do the act, then send the browser to a page that says what happened."
 *
 * The outcome of a form POST reaches the next page as an opaque one-time
 * notice id (`?notice=<id>`), never as text in the URL, and the target is a
 * path of this instance, validated where it becomes a `Location` (spec §6).
 * One helper for the surfaces that share the accounts' `NoticeStore`
 * (shares, local groups, operator reassignment).
 */
import { resolveReturnTo } from '../http/return-to';
import type { Notice, NoticeStore } from './pending';

const SEE_OTHER = 303;
/** The `?notice=` parameter of the page a redirect lands on. */
export const NOTICE_QUERY_PARAM = 'notice';

export interface NoticeRedirectDeps {
  readonly publicUrl: URL;
  readonly notices: NoticeStore;
}

export type NoticeRedirect = (sessionId: string, path: string, notice: Notice) => Promise<Response>;

/** `fallbackPath` is where a path that leaves the instance is replaced by. */
export function createNoticeRedirect(
  deps: NoticeRedirectDeps,
  fallbackPath: string,
): NoticeRedirect {
  return async (sessionId, path, notice) => {
    const id = await deps.notices.put(sessionId, notice);
    const url = new URL(resolveReturnTo(path, deps.publicUrl) ?? fallbackPath, deps.publicUrl);
    url.searchParams.set(NOTICE_QUERY_PARAM, id);
    return new Response(null, {
      status: SEE_OTHER,
      headers: {
        Location: `${url.pathname}${url.search}${url.hash}`,
        'Cache-Control': 'no-store',
      },
    });
  };
}
