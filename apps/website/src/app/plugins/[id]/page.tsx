import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';
import { siteData } from '@/site/data';

export const dynamic = 'force-static';
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
  if (!siteData().plugins.some((p) => p.id === id)) notFound();
  return <GeneratedPage path={`/plugins/${id}`} />;
}
