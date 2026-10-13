/**
 * `/admin/provider-apps` — the app the company registered at each provider
 * (spec §4.2 Administration, §4.3, §7.1). One form per provider that needs an
 * app, its fields derived from the plugin's `CredentialSpec`; secrets are
 * sealed in `instance_config` and never echoed. A provider set by the mounted
 * configuration is read-only here (the file wins).
 */
import {
  CredentialFieldInputs,
  credentialKindLabel,
  ExperimentalBadge,
  NoticeBanner,
} from '@/components/connections/parts';
import styles from '@/components/connections/connections.module.css';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Stack } from '@/components/ui';
import { adminDecision } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import { NOTICE_PARAM, PROVIDER_APPS_PAGE } from '@/server/connections';
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
        </span>
      </CardHeader>
      <CardBody>
        <Stack gap="var(--space-4)">
          <p className={styles.muted}>
            {credentialKindLabel(app.credentialKind)}.{' '}
            {app.credentialKind === 'oauth2'
              ? 'Redirect URI to register at the provider:'
              : 'Setup URL (redirect after installation) to register at the provider:'}{' '}
            <code>{callbackUrl}</code>
          </p>
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
