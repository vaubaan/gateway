/**
 * The landing (website spec §2.1), on the developer's project; the switch
 * shows the consultant's. `/consultants` is the same page opened on the
 * consultant's project.
 */
import type { Metadata } from 'next';

import { Landing } from '@/components/site/Landing';
import { siteData } from '@/site/data';
import { LANDING_LEDE, landingFaq, PROMISE } from '@/site/landing';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: { absolute: `Vaubaan — ${PROMISE}` },
  description: LANDING_LEDE,
  alternates: { canonical: '/', types: { 'text/markdown': '/index.md' } },
};

export default function Home() {
  const { plugins } = siteData();
  return <Landing initial="dev" services={plugins} faq={landingFaq(plugins.map((p) => p.name))} />;
}
