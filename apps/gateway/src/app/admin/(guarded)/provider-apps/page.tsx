/**
 * `/admin/provider-apps` — the app the company registered at each provider
 * (spec §4.2 Administration, §4.3, §7.1). One form per provider that needs an
 * app, its fields derived from the plugin's `CredentialSpec`; secrets are
 * sealed in `instance_config` and never echoed. A provider set by the mounted
 * configuration is read-only here (the file wins).
 *
 * An app that is installed (`app-install`) shows how its installations are
 * bound to the connecting user: verified by the host, or — for a plugin that
 * cannot prove it — refused until the operator explicitly accepts unverified
 * installations, with a warning.
 */
import {
  CredentialFieldInputs,
  credentialKindLabel,
  ExperimentalBadge,
  NoticeBanner,
} from '@/components/connections/parts';
import styles from '@/components/connections/connections.module.css';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Stack,
} from '@/components/ui';
import { adminDecision } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import {
  ACCEPT_UNVERIFIED_ACTION,
  NOTICE_PARAM,
  PROVIDER_APPS_PAGE,
  REFUSE_UNVERIFIED_ACTION,
} from '@/server/connections';
import type { ProviderAppStatus } from '@/server/provider-apps';

export const dynamic = 'force-dynamic';

export default async function ProviderAppsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const params = await searchParams;
  const { root, decision } = await adminDecision();
  const notice = decision.ok
    ? await root.connections.notices.take(
        decision.principal.sessionId,
        firstParam(params[NOTICE_PARAM]),
      )
    : null;
  const apps = await root.providerApps.list();
  const withApp = apps.filter((a) => a.needsApp);
  const withoutApp = apps.filter((a) => !a.needsApp);

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Provider apps</h1>
        <p className={styles.muted}>
          Register one app per provider at the provider itself, then enter its credentials here.
          Users connect through it; the gateway never ships a shared app. Values set in the mounted
          configuration (<code>providers.&lt;id&gt;.*</code>) take precedence and are read-only
          here.
        </p>
      </div>

      <NoticeBanner notice={notice} />

      {withApp.map((app) => (
        <ProviderAppCard
          key={app.providerId}
          app={app}
          callbackUrl={root.connections.service.callbackUrl(app.providerId).href}
        />
      ))}

      {withoutApp.length > 0 && (
        <p className={styles.muted}>
          Nothing to register for {withoutApp.map((a) => a.displayName).join(', ')}: each user
          connects with a key of their own.
        </p>
      )}
    </Stack>
  );
}

/**
 * Shown only for an installed app whose plugin cannot prove who performed an
 * installation. Its own form, outside the fields' fieldset: the decision is
 * the operator's whatever the source of the fields.
 */
function UnverifiedInstallations({ app, action }: { app: ProviderAppStatus; action: string }) {
  if (app.installVerification === null || app.installVerification === 'verified') return null;
  const accepted = app.installVerification === 'unverified-accepted';
  return (
    <Banner
      tone={accepted ? 'danger' : 'warning'}
      title={
        accepted
          ? 'Unverified installations are accepted'
          : 'This plugin cannot verify installations'
      }
    >
      <Stack gap="var(--space-3)">
        <p>
          The plugin of {app.displayName} does not let the gateway check that the person connecting
          an installation has access to it. If you accept unverified installations, any signed-in
          user who knows the id of an installation of this app — another team&apos;s, another
          organisation&apos;s — can connect it and issue missions on it.
          {accepted ? '' : ' Until you accept, nobody can connect this provider.'}
        </p>
        <form method="post" action={action}>
          <Button
            type="submit"
            name="action"
            value={accepted ? REFUSE_UNVERIFIED_ACTION : ACCEPT_UNVERIFIED_ACTION}
            variant={accepted ? 'primary' : 'ghost'}
          >
            {accepted ? 'Refuse unverified installations' : 'Accept unverified installations'}
          </Button>
        </form>
      </Stack>
    </Banner>
  );
}

function ProviderAppCard({ app, callbackUrl }: { app: ProviderAppStatus; callbackUrl: string }) {
  const readOnly = app.source === 'file';
  const action = `${PROVIDER_APPS_PAGE}/${encodeURIComponent(app.providerId)}`;
  return (
    <Card id={app.providerId}>
      <CardHeader>
        <CardTitle>{app.displayName}</CardTitle>
        <span className={styles.badges}>
          {app.experimental && <ExperimentalBadge />}
          {readOnly && <Badge tone="info">set by the mounted configuration</Badge>}
          {app.configured ? (
            <Badge tone="success">configured</Badge>
          ) : app.source === 'none' ? (
            <Badge>not configured</Badge>
          ) : (
            <Badge tone="warning">incomplete: {app.missing.join(', ')}</Badge>
          )}
          {app.installVerification === 'verified' && (
            <Badge tone="success">installations verified</Badge>
          )}
          {app.installVerification === 'unverified-refused' && (
            <Badge tone="warning">installations refused: unverifiable</Badge>
          )}
          {app.installVerification === 'unverified-accepted' && (
            <Badge tone="danger">unverified installations accepted</Badge>
          )}
        </span>
      </CardHeader>
      <CardBody>
        <Stack gap="var(--space-4)">
          <p className={styles.muted}>
            {credentialKindLabel(app.credentialKind)}.{' '}
            {app.credentialKind === 'oauth2'
              ? 'Redirect URI to register at the provider:'
              : app.installVerification === 'verified'
                ? 'Callback URL to register at the provider, with user authorization requested during installation:'
                : 'Setup URL (redirect after installation) to register at the provider:'}{' '}
            <code>{callbackUrl}</code>
          </p>
          {app.installVerification === 'verified' && (
            <p className={styles.muted}>
              An installation is connected only after the provider confirms that the person who
              authorized the app can reach it. The app must request user authorization during
              installation; without it every connection attempt is refused.
            </p>
          )}
          <UnverifiedInstallations app={app} action={action} />
          <form method="post" action={action}>
            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
              <Stack gap="var(--space-4)">
                <CredentialFieldInputs
                  fields={app.fields}
                  values={app.values}
                  secretsSet={app.secretsSet}
                  disabled={readOnly}
                />
                <div className={styles.actions}>
                  <Button type="submit" variant="primary" disabled={readOnly}>
                    Save
                  </Button>
                  {app.source === 'store' && (
                    <Button
                      type="submit"
                      name="action"
                      value="clear"
                      variant="ghost"
                      formNoValidate
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </Stack>
            </fieldset>
          </form>
        </Stack>
      </CardBody>
    </Card>
  );
}
