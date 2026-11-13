import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { generatedPageMetadata } from '@/components/GeneratedPage';
import { PluginPageView } from '@/components/plugin/PluginPage';
import { pageMeta, siteData } from '@/site/data';
import { liveSite } from '@/site/live';

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

/** The plugin page in the Atlas layout; its Markdown twin is `pluginPageMarkdown`, same order. */
export default async function PluginPage({ params }: Props) {
  const { id } = await params;
  const live = await liveSite();
  const plugin = live.plugins.find((p) => p.id === id);
  if (plugin === undefined) notFound();
  return (
    <PluginPageView
      plugin={plugin}
      thresholds={live.thresholds}
      lastModified={pageMeta(`/plugins/${id}`)?.lastModified ?? null}
    />
  );
}
