/**
 * The permanent redirects of the site (`next.config.ts` reads them). A service's
 * connect guide lives on its plugin page, section "Connecting an account" (website
 * spec §2.3 item 7): the former "Connect <service>" docs pages `/docs/providers/<id>`
 * answer there, their Markdown twins at the plugin page's twin. The index
 * `/docs/providers` stays a page.
 */
export interface SiteRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
}

export const SITE_REDIRECTS: readonly SiteRedirect[] = [
  {
    source: '/docs/providers/:id([a-z][a-z0-9-]*).md',
    destination: '/plugins/:id.md',
    permanent: true,
  },
  {
    source: '/docs/providers/:id([a-z][a-z0-9-]*)',
    destination: '/plugins/:id#connect',
    permanent: true,
  },
];
