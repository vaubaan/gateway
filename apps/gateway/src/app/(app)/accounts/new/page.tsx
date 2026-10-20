/**
 * `/accounts/new` — choose the service of the account to connect. The same
 * picker as the last region of `/accounts`, on a page of its own for whoever
 * arrives from elsewhere (the mission being written keeps its `return_to`).
 * The list is the plugin registry's; nothing is enumerated here.
 */
import Link from 'next/link';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { NoticeBanner } from '@/components/connections/parts';
import { ServicePicker } from '@/components/connections/ServicePicker';
import { Callout, Hint, PageHeader, Section } from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import { ACCOUNT_PAGES, PAGES, ROUTES } from '@/lib/vocabulary';
import { PROVIDERS_PATH } from '@/server/providers/links';

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
  const providers = await root.connections.service.providers();
  const none = providers.every((provider) => !provider.configured);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: PAGES.accounts.title, href: ROUTES.accounts },
          { label: ACCOUNT_PAGES.connect.title },
        ]}
        title={ACCOUNT_PAGES.connect.title}
        lede={ACCOUNT_PAGES.connect.lede}
      />
      <NoticeBanner notice={notice} />
      <Section first>
        {none && (
          <Callout tone="warn" title="No service can be connected yet" testId="no-service">
            Each of them signs people in through an OAuth client an administrator declares once, on
            the service’s page
            {principal.isOperator ? ' — open a service below to declare it.' : '.'}
          </Callout>
        )}
        <ServicePicker
          providers={providers}
          administrator={principal.isOperator}
          returnTo={firstParam(params.return_to)}
        />
        <Hint>
          What an agent can then do on each service, permission by permission, is in the{' '}
          <Link href={PROVIDERS_PATH}>{PAGES.reference.title}</Link>.
        </Hint>
      </Section>
    </>
  );
}
