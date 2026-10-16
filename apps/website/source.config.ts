/**
 * Fumadocs MDX: the user docs under `content/docs` (ADR website-nextjs-on-vercel
 * D2). Code blocks are left as plain `pre > code`, styled by the site's tokens:
 * no syntax theme brings its own colours (style guide §3).
 */
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: false,
    remarkImageOptions: false,
    remarkNpmOptions: false,
  },
});
