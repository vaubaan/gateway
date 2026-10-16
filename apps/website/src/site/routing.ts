/**
 * The two decisions the proxy takes on every request, as pure functions:
 *
 * - on the collector's host (`COLLECTOR_HOST`, read at request time), only
 *   the collector's routes exist; the site answers 404 there (ADR
 *   website-nextjs-on-vercel D4), and its robots.txt asks crawlers to stay away;
 * - a page of the docs, the plugins or the trust center asked with
 *   `Accept: text/markdown` is answered with its Markdown twin (website spec §2.6).
 */

/** The collector's routes, the only paths that exist on its host. */
export const COLLECTOR_PATH_PREFIX = '/v1/';

/** The host of a request, lower case, without its port. */
export function hostOf(header: string | null): string | null {
  if (header === null) return null;
  const host = header.trim().toLowerCase().replace(/:\d+$/, '');
  return host === '' ? null : host;
}

export type HostDecision = 'site' | 'collector-route' | 'collector-robots' | 'not-found';

/**
 * What a request is on this host. Without `COLLECTOR_HOST` (a preview, a
 * local build) every host is the site's; the collector's routes then refuse
 * by themselves (they need the variable too).
 */
export function hostDecision(
  host: string | null,
  pathname: string,
  collectorHost: string | undefined,
): HostDecision {
  const collector = collectorHost?.trim().toLowerCase();
  if (!collector || host !== collector) return 'site';
  if (pathname.startsWith(COLLECTOR_PATH_PREFIX)) return 'collector-route';
  if (pathname === '/robots.txt') return 'collector-robots';
  return 'not-found';
}

const TWINNED = /^\/(docs|plugins|trust)(\/[a-z0-9][a-z0-9/-]*)?$/;

/** True when the client prefers Markdown: `text/markdown` is named and `text/html` is not ranked above it. */
export function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranked = accept.split(',').map((part) => {
    const [type = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { type: type.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
  });
  const markdown = ranked.find((r) => r.type === 'text/markdown');
  if (!markdown || !(markdown.q > 0)) return false;
  const html = ranked.find((r) => r.type === 'text/html');
  return !html || html.q < markdown.q;
}

/** `/docs/install` → `/docs/install.md`, for the pages that have a twin; null otherwise. */
export function markdownTwinOf(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return TWINNED.test(path) ? `${path}.md` : null;
}
