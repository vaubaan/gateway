/**
 * The address of a doc link (docs/handbook/web-app.md, "doc links"): a target
 * of `DOC_PAGES` or `serviceDoc` (`lib/vocabulary.ts`, the one table) under
 * the docs root the instance is configured with (`docs.url`). Pure and
 * browser-safe.
 */
import { servicePath } from './services/links';
import type { DocTarget } from './vocabulary';

/** The address of a target under the docs root (`docs.url`; a trailing slash is optional). */
export function docHref(docsRoot: string, target: Pick<DocTarget, 'path'>): string {
  return new URL(target.path, `${docsRoot.replace(/\/+$/, '')}/`).href;
}

/**
 * Where a link of a service's page goes in the gateway (`ServicePage`'s `href`):
 * the page speaks in paths of the documentation site. `/docs/<page>` is that
 * page under the docs root; `/plugins/<id>` is the service's own Reference
 * here; any other path of the site is its sibling, as `serviceDoc`'s
 * `../plugins/<id>`; an address with a scheme is left as it is.
 */
export function docsSiteHref(docsRoot: string, path: string): string {
  if (!path.startsWith('/')) return path;
  const service = /^\/plugins\/([a-z0-9-]+)(#.*)?$/.exec(path);
  if (service) return `${servicePath(service[1]!)}${service[2] ?? ''}`;
  const doc = /^\/docs\/(.*)$/.exec(path);
  return docHref(docsRoot, { path: doc ? doc[1]! : `..${path}` });
}
