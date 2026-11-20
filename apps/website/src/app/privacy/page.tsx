import { GeneratedPage, generatedPageMetadata } from '@/components/GeneratedPage';

export const dynamic = 'force-static';

export const metadata = generatedPageMetadata('/privacy');

export default function PrivacyPage() {
  return <GeneratedPage path="/privacy" />;
}
