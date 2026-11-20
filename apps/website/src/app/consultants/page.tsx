/**
 * The landing opened on the consultant's project (website spec §2.1 bis): a
 * reader who comes from a colleague's message sees mail, notes and calendar
 * first. A query string cannot check a radio without script, hence the page.
 */
import { generatedPageMetadata } from '@/components/GeneratedPage';
import { Landing } from '@/components/site/Landing';
import { siteData } from '@/site/data';
import { landingFaq } from '@/site/landing';

export const dynamic = 'force-static';

export const metadata = generatedPageMetadata('/consultants');

export default function Consultants() {
  const { plugins } = siteData();
  return (
    <Landing initial="consultant" services={plugins} faq={landingFaq(plugins.map((p) => p.name))} />
  );
}
