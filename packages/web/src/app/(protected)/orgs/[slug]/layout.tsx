/**
 * Layout for routes scoped to a specific org. Mounts the
 * `<NeedsResealBanner>` so it is rendered above every org-level page
 * (Resources, SecretManagers). Spec §4.5.
 *
 * The slug comes from the URL segment. The banner itself is
 * RLS-gated client-side — a non-member sees a 404 from the
 * `/needs-reseal` endpoint and the banner returns `null`.
 */

import type { ReactNode } from 'react';

import { NeedsResealBanner } from '@/components/needs-reseal/NeedsResealBanner';

interface LayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly slug: string }>;
}

export default async function OrgLayout({ children, params }: LayoutProps) {
  const { slug } = await params;
  return (
    <>
      <NeedsResealBanner orgSlug={slug} />
      {children}
    </>
  );
}
