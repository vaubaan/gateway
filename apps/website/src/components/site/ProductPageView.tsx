/**
 * A product page (website spec §2.1 bis) and the parts the landing shares
 * with it: the opening (title, defining sentence, one primary action), the
 * project switch, and sections of words, a drawing and one link each.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { twinPathOf } from '../../content/outputs';
import { cn } from '../../lib/utils';
import { PROJECTS } from '../../site/drawings';
import {
  isShared,
  STATUS_WORDS,
  textFor,
  type Link as PageLink,
  type ProductPage,
  type Section,
} from '../../site/product-pages';
import { buttonVariants } from '../ui/button';
import { Drawing, ForProject, ProjectSwitch, VariantText } from './Project';

export function productPageMetadata(page: ProductPage): Metadata {
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.path, types: { 'text/markdown': twinPathOf(page.path) } },
  };
}

function isExternal(href: string): boolean {
  return /^https?:/.test(href);
}

function Anchor({
  href,
  className,
  children,
}: {
  readonly href: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return isExternal(href) ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className} prefetch={false}>
      {children}
    </Link>
  );
}

/** A link whose label or address may differ by project. */
export function PageLinkView({
  link,
  className,
  arrow = false,
}: {
  readonly link: PageLink;
  readonly className?: string;
  readonly arrow?: boolean;
}) {
  const one = (p: (typeof PROJECTS)[number]) => (
    <Anchor href={textFor(link.href, p)} className={className}>
      {textFor(link.label, p)}
      {arrow ? ' →' : ''}
    </Anchor>
  );
  if (isShared(link.label) && isShared(link.href)) return one('dev');
  return (
    <>
      {PROJECTS.map((p) => (
        <ForProject key={p} project={p}>
          {one(p)}
        </ForProject>
      ))}
    </>
  );
}

export function StatusTag({ status }: { readonly status: 'built' | 'planned' }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full border px-2 text-xs font-semibold',
        status === 'planned'
          ? 'border-dashed border-border-strong text-muted-foreground'
          : 'border-border bg-muted text-foreground',
      )}
    >
      {STATUS_WORDS[status]}
    </span>
  );
}

export function SectionView({ section }: { readonly section: Section }) {
  return (
    <section
      id={section.id}
      aria-labelledby={`${section.id}-title`}
      className="border-t border-border py-12"
    >
      <div className="max-w-measure">
        <h2
          id={`${section.id}-title`}
          className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-[-0.02em] text-balance"
        >
          {section.heading}
          {section.status && <StatusTag status={section.status} />}
        </h2>
        <div className="prose mt-4 text-[1.0625rem]">
          <VariantText text={section.body} />
        </div>
        {section.link && (
          <p className="mt-2 font-semibold">
            <PageLinkView link={section.link} arrow />
          </p>
        )}
      </div>
      {section.drawing && <Drawing name={section.drawing} />}
    </section>
  );
}

export function PageOpening({
  heading,
  lede,
  primary,
  secondary,
}: {
  readonly heading: string;
  readonly lede: string;
  readonly primary: PageLink;
  readonly secondary?: PageLink;
}) {
  return (
    <div className="max-w-measure">
      <h1 className="text-4xl font-semibold tracking-[-0.03em] text-balance md:text-5xl">
        {heading}
      </h1>
      <p className="mt-5 text-lg text-muted-foreground">{lede}</p>
      <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
        <PageLinkView link={primary} className={buttonVariants({ size: 'lg' })} />
        {secondary && <PageLinkView link={secondary} className="font-semibold" arrow />}
      </div>
    </div>
  );
}

export function ProductPageView({ page }: { readonly page: ProductPage }) {
  const withDrawings =
    page.sections.some((s) => s.drawing) || page.sections.some((s) => !isShared(s.body));
  return (
    <div className="mx-auto max-w-page px-4 pt-10 md:px-6 md:pt-16">
      <PageOpening
        heading={page.heading}
        lede={page.lede}
        primary={page.primary}
        secondary={page.secondary}
      />
      {withDrawings && (
        <div className="mt-10">
          <ProjectSwitch />
        </div>
      )}
      <div className="mt-10">
        {page.sections.map((s) => (
          <SectionView key={s.id} section={s} />
        ))}
      </div>
      <p className="border-t border-border pt-6 text-sm text-muted-foreground">
        This page as Markdown: <a href={twinPathOf(page.path)}>{twinPathOf(page.path)}</a>
      </p>
    </div>
  );
}
