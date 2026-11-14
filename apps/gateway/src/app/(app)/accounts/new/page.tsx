/**
 * `/accounts/new` — choose the service of the account to connect. The same
 * picker as the last region of `/accounts`, on a page of its own for whoever
 * arrives from elsewhere (the mission being written keeps its `return_to`).
 * The list is the plugin registry's; nothing is enumerated here.
 */
import Link from 'next/link';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { NoticeBanner } from '@/components/accounts/parts';
import { ServicePicker } from '@/components/accounts/ServicePicker';
import { Hint, PageHeader, Section } from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/accounts/session';
import { DOC_PAGES, ACCOUNT_PAGES, PAGES, ROUTES } from '@/lib/vocabulary';
import { PROVIDERS_PATH } from '@/lib/providers/links';

export const dynamic = 'force-dynamic';

export default async function ConnectAccountPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal } = session;
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const providers = await root.accounts.service.providers();

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.connect}
        crumbs={[
          { label: PAGES.accounts.title, href: ROUTES.accounts },
          { label: ACCOUNT_PAGES.connect.title },
        ]}
        title={ACCOUNT_PAGES.connect.title}
        lede={ACCOUNT_PAGES.connect.lede}
      />
      <NoticeBanner notice={notice} />
      <Section first>
        <ServicePicker providers={providers} returnTo={firstParam(params.return_to)} />
        <Hint>
          What an agent can then do on each service, permission by permission, is in the{' '}
          <Link href={PROVIDERS_PATH}>{PAGES.reference.title}</Link>.
        </Hint>
      </Section>
    </>
  );
}
