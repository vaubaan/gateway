import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';
import { liveSite, pageMarkdown } from '@/site/live';

// HEALTH_REVALIDATE_SECONDS: the collector is read again at most once an hour.
export const revalidate = 3600;

export const metadata = generatedPageMetadata('/plugins');

export default async function PluginsPage() {
  const live = await liveSite();
  return <GeneratedPage path="/plugins" markdown={pageMarkdown('/plugins', live) ?? ''} />;
}
