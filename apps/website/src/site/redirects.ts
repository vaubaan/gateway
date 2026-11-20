/**
 * The permanent redirects of the site (`next.config.ts` reads them).
 *
 * - A service's connect guide lives on its plugin page, section "Connecting an account"
 *   (website spec §2.3 item 9): the former "Connect <service>" docs pages
 *   `/docs/providers/<id>` answer there, their Markdown twins at the plugin page's twin.
 * - The docs section that was `/docs/providers` is `/docs/services` (ADR
 *   one-word-per-thing-account-service-plugin, rename R2): the old index and its twin
 *   answer at the new one. The old paths keep their word on purpose: they are the
 *   addresses already linked from elsewhere.
 * - "Install with your coding agent" moved from the root of the docs under Install
 *   (`/docs/install/with-your-coding-agent`); its former address and twin answer there.
 */
export interface SiteRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
}

/** The docs section of the services, and the path it had before the rename. */
export const SERVICES_DOCS_PATH = '/docs/services';
const FORMER_SERVICES_DOCS_PATH = '/docs/providers';

/** The page that hands a coding agent the install, under Install, and its former path. */
export const CODING_AGENT_INSTALL_PATH = '/docs/install/with-your-coding-agent';
const FORMER_CODING_AGENT_INSTALL_PATH = '/docs/install-with-your-coding-agent';

export const SITE_REDIRECTS: readonly SiteRedirect[] = [
  {
    source: `${FORMER_SERVICES_DOCS_PATH}/:id([a-z][a-z0-9-]*).md`,
    destination: '/plugins/:id.md',
    permanent: true,
  },
  {
    source: `${FORMER_SERVICES_DOCS_PATH}/:id([a-z][a-z0-9-]*)`,
    destination: '/plugins/:id#connect',
    permanent: true,
  },
  {
    source: `${FORMER_SERVICES_DOCS_PATH}.md`,
    destination: `${SERVICES_DOCS_PATH}.md`,
    permanent: true,
  },
  {
    source: FORMER_SERVICES_DOCS_PATH,
    destination: SERVICES_DOCS_PATH,
    permanent: true,
  },
  // The management door was retired (ADR platform-management-is-a-plugin-on-the-execution-door).
  {
    source: '/docs/missions/management-door',
    destination: '/docs/missions/platform-management',
    permanent: true,
  },
  // Installing with a coding agent is a way to install: it moved under Install (2026-11-20).
  {
    source: `${FORMER_CODING_AGENT_INSTALL_PATH}.md`,
    destination: `${CODING_AGENT_INSTALL_PATH}.md`,
    permanent: true,
  },
  {
    source: FORMER_CODING_AGENT_INSTALL_PATH,
    destination: CODING_AGENT_INSTALL_PATH,
    permanent: true,
  },
];
