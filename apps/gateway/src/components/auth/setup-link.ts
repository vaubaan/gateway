/**
 * The setup link: `/admin/bootstrap#token=<bootstrap token>` (spec §7.1). Whoever
 * installs a gateway with a script can hand the operator one address instead of a
 * value to paste; the page reads the token from it and fills the field, ready to
 * submit — nothing is submitted without the click.
 *
 * The token travels in the **fragment**, which a browser never sends: it reaches
 * neither the instance's access logs nor a referrer. The query form
 * (`?token=…`) is read too, for a link built the older way, and the page then
 * strips it from the address bar at once (`history.replaceState`).
 */
export const SETUP_LINK_TOKEN_PARAM = 'token';

/** The token a setup link carries: the fragment first, else the query; `null` without one. */
export function tokenFromSetupLink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, '')).get(SETUP_LINK_TOKEN_PARAM);
  const query = url.searchParams.get(SETUP_LINK_TOKEN_PARAM);
  const token = (fragment ?? query ?? '').trim();
  return token.length > 0 ? token : null;
}

/** The same address without the token, for the address bar and the history. */
export function setupLinkWithoutToken(href: string): string {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  fragment.delete(SETUP_LINK_TOKEN_PARAM);
  url.hash = fragment.size > 0 ? `#${fragment.toString()}` : '';
  url.searchParams.delete(SETUP_LINK_TOKEN_PARAM);
  return url.href;
}
