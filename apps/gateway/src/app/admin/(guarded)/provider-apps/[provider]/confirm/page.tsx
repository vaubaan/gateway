/**
 * `/admin/provider-apps/<provider>/confirm?state=…` — the step between the
 * administrator's choice and the service: what will be created, and the one
 * button that posts the manifest to the service (ADR
 * company-app-created-from-a-manifest). The form's action is the service's
 * registration address carrying the single-use state; its one field is the
 * manifest the server built. Read back by the session that started the flow
 * only; nothing is consumed here — the service's redirect does that.
 */
import { permissionSummary } from '@/components/settings/AppRegistration';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  ButtonLink,
  EmptyState,
  KeyValue,
  Mono,
  PageHeader,
  Section,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import { ACTIONS } from '@/lib/vocabulary';
import { providerAppPath } from '@/server/connections';

export const dynamic = 'force-dynamic';

export default async function ConfirmAppCreationPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: PageSearchParams;
}) {
  const { root, principal } = await requireOperator();
  const { provider } = await params;
  const state = firstParam((await searchParams).state) ?? null;
  const registration = root.connections.registration;
  const manifest = registration.manifestOf(provider);
  const view = manifest ? await registration.pending(principal.sessionId, provider, state) : null;
  const back = providerAppPath(provider);

  if (!manifest || !view) {
    return (
      <>
        <PageHeader title="Create the app" />
        <EmptyState
          testId="app-create-expired"
          title="This creation is no longer waiting"
          action={
            <ButtonLink href={back} variant="primary">
              Back to Company apps
            </ButtonLink>
          }
        >
          It was started in another session, or more than a quarter of an hour ago. Nothing was
          sent; start again from Company apps.
        </EmptyState>
      </>
    );
  }

  const { plugin } = root.registry.require(provider);
  const service = plugin.displayName;
  return (
    <>
      <PageHeader
        title={`Create the ${service} App`}
        lede={`${service} shows you the app and asks you to confirm; then it sends you back here.`}
      />
      <Section first>
        <div className={styles.detail} data-testid="app-create-confirm">
          <KeyValue
            items={[
              {
                term: 'Owner',
                value:
                  view.owner.kind === 'organization' ? (
                    <>
                      <Mono>{view.owner.login}</Mono> · an organisation
                    </>
                  ) : (
                    'Your own account'
                  ),
              },
              { term: 'Name', value: view.name },
              {
                term: 'Permissions',
                value: permissionSummary(manifest.permissions, view.permissions),
              },
            ]}
          />
          <p className={styles.prose}>
            The app’s private key and secret come back to this gateway only, encrypted, and are
            never shown. You can change its permissions later at {service}.
          </p>
          <form method="post" action={view.action} className={styles.formActions}>
            <input type="hidden" name={view.manifestField} value={view.manifest} />
            <Button type="submit" variant="primary">
              Continue to {service}
            </Button>
            <ButtonLink href={back} variant="ghost">
              {ACTIONS.cancel}
            </ButtonLink>
          </form>
        </div>
      </Section>
    </>
  );
}
