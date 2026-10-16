/**
 * The Fumadocs source of the user docs: the MDX collection compiled by
 * fumadocs-mdx (`source.config.ts`), its page tree and its pages.
 */
import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
