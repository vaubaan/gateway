/**
 * A page of the user docs (website spec §2.2), compiled by Fumadocs from
 * `content/docs`. Static HTML, a navigation, a table of contents, the
 * previous and next pages, the TechArticle JSON-LD and the `.md` twin's link.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findNeighbour, type Folder, type Node } from 'fumadocs-core/page-tree';

import { DocsNav, Toc } from '@/components/DocsNav';
import { JsonLd } from '@/components/JsonLd';
import { MARKDOWN_COMPONENTS } from '@/components/MarkdownBody';
import { twinPathOf } from '@/content/outputs';
import { SITE_ORIGIN } from '@/site/constants';
import { pageMeta } from '@/site/data';
import { source } from '@/site/source';

export const dynamic = 'force-static';
export const dynamicParams = false;

interface Props {
  readonly params: Promise<{ slug?: string[] }>;
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url, types: { 'text/markdown': twinPathOf(page.url) } },
  };
}

function folderOf(nodes: readonly Node[], url: string): Folder | null {
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    if (node.index?.url === url) return node;
    const inner = folderOf(node.children, url);
    if (inner) return inner;
  }
  return null;
}

/** The pages under a folder's index page, listed at its end (the `.md` twin lists the same). */
function Section({ folder }: { readonly folder: Folder }) {
  const links = folder.children.flatMap((child) => {
    if (child.type === 'page') return [{ url: child.url, name: child.name }];
    if (child.type === 'folder' && child.index) return [{ url: child.index.url, name: child.name }];
    return [];
  });
  if (links.length === 0) return null;
  return (
    <>
      <h2 id="in-this-section">In this section</h2>
      <ul>
        {links.map((link) => (
          <li key={link.url}>
            <Link href={link.url} prefetch={false}>
              {link.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function DocsPage({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const tree = source.pageTree;
  const folder = page.url === '/docs' ? null : folderOf(tree.children, page.url);
  const neighbours = findNeighbour(tree, page.url);
  const lastModified = pageMeta(page.url)?.lastModified ?? null;

  return (
    <div className="mx-auto grid max-w-page grid-cols-1 items-start gap-4 px-4 pt-6 md:grid-cols-[var(--spacing-side)_minmax(0,1fr)] md:gap-10 md:px-6 md:pt-10 xl:grid-cols-[var(--spacing-side)_minmax(0,1fr)_var(--spacing-toc)]">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: page.data.title,
          description: page.data.description,
          url: `${SITE_ORIGIN}${page.url}`,
          ...(lastModified ? { dateModified: lastModified } : {}),
          inLanguage: 'en',
          isPartOf: { '@type': 'WebSite', name: 'Vaubaan Gateway', url: SITE_ORIGIN },
          about: { '@type': 'SoftwareApplication', name: 'Vaubaan Gateway' },
        }}
      />
      <DocsNav tree={tree} current={page.url} />
      <article className="prose">
        <h1>{page.data.title}</h1>
        <MDX components={MARKDOWN_COMPONENTS} />
        {folder ? <Section folder={folder} /> : null}
        <p className="mt-8 text-sm text-muted-foreground">
          {lastModified ? `Last changed ${lastModified}. ` : ''}
          This page as Markdown: <a href={twinPathOf(page.url)}>{twinPathOf(page.url)}</a>
        </p>
        <nav
          className="mt-12 flex justify-between gap-4 border-t border-border pt-4 text-sm"
          aria-label="Previous and next"
        >
          {neighbours.previous ? (
            <Link href={neighbours.previous.url} prefetch={false}>
              ← {neighbours.previous.name}
            </Link>
          ) : (
            <span />
          )}
          {neighbours.next ? (
            <Link href={neighbours.next.url} prefetch={false}>
              {neighbours.next.name} →
            </Link>
          ) : null}
        </nav>
      </article>
      <Toc items={page.data.toc} />
    </div>
  );
}
