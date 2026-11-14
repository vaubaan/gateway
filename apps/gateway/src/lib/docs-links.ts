/**
 * The address of a doc link (docs/handbook/web-app.md, "doc links"): a target
 * of `DOC_PAGES` or `serviceDoc` (`lib/vocabulary.ts`, the one table) under
 * the docs root the instance is configured with (`docs.url`). Pure and
 * browser-safe.
 */
import type { DocTarget } from './vocabulary';

/** The address of a target under the docs root (`docs.url`; a trailing slash is optional). */
export function docHref(docsRoot: string, target: DocTarget): string {
  return new URL(target.path, `${docsRoot.replace(/\/+$/, '')}/`).href;
}
