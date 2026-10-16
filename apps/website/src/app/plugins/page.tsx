import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';

export const dynamic = 'force-static';

export const metadata = generatedPageMetadata('/plugins');

export default function PluginsPage() {
  return <GeneratedPage path="/plugins" />;
}
