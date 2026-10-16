import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';

export const dynamic = 'force-static';

export const metadata = generatedPageMetadata('/plugins/health');

export default function PluginHealthPage() {
  return <GeneratedPage path="/plugins/health" />;
}
