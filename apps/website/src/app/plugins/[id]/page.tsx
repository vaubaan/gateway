import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';
import { siteData } from '@/site/data';
import { liveSite, pageMarkdown } from '@/site/live';

// HEALTH_REVALIDATE_SECONDS: the collector is read again at most once an hour.
export const revalidate = 3600;
export const dynamicParams = false;

interface Props {
  readonly params: Promise<{ id: string }>;
}

export function generateStaticParams(): { id: string }[] {
  return siteData().plugins.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return generatedPageMetadata(`/plugins/${id}`);
}

export default async function PluginPage({ params }: Props) {
  const { id } = await params;
  const live = await liveSite();
  const markdown = pageMarkdown(`/plugins/${id}`, live);
  if (markdown === null) notFound();
  return <GeneratedPage path={`/plugins/${id}`} markdown={markdown} />;
}
