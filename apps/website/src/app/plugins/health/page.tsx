import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';
import { liveSite, pageMarkdown } from '@/site/live';

// HEALTH_REVALIDATE_SECONDS: the collector is read again at most once an hour.
export const revalidate = 3600;

export const metadata = generatedPageMetadata('/plugins/health');

export default async function PluginHealthPage() {
  const live = await liveSite();
  return (
    <GeneratedPage path="/plugins/health" markdown={pageMarkdown('/plugins/health', live) ?? ''} />
  );
}
