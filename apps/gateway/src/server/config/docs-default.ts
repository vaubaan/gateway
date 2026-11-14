/**
 * The default of `docs.url` (spec §4.3; handbook web-app.md, "doc links"):
 * where the (i) of a page header leads, the user docs the project's website
 * publishes. A service's page is its sibling `../plugins/<id>`, as on the
 * site. Only a link a person opens: the instance never requests it.
 * The structural test `no-hardcoded-config.test.ts` whitelists this file.
 */
export const DEFAULT_DOCS_URL = 'https://vaubaan.com/docs';
