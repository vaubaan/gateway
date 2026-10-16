/**
 * A page whose content is generated Markdown (plugins, plugin health, trust
 * center): the HTML is that Markdown rendered, the `.md` twin is the same
 * string, and the metadata comes from the generator's page list.
 */
import type { Metadata } from 'next';

import { twinPathOf } from '@/content/outputs';
import { MarkdownBody } from '@/components/MarkdownBody';
import { markdownOf, pageMeta } from '@/site/data';

export function generatedPageMetadata(path: string): Metadata {
  const meta = pageMeta(path);
  return {
    title: meta?.title,
    description: meta?.description,
    alternates: { canonical: path, types: { 'text/markdown': twinPathOf(path) } },
  };
}

export function GeneratedPage({ path }: { readonly path: string }) {
  const meta = pageMeta(path);
  return (
    <div className="page">
      <article className="prose">
        <MarkdownBody markdown={markdownOf(path)} />
        <p className="meta">
          {meta?.lastModified ? `Last changed ${meta.lastModified}. ` : ''}
          This page as Markdown: <a href={twinPathOf(path)}>{twinPathOf(path)}</a>
        </p>
      </article>
    </div>
  );
}
