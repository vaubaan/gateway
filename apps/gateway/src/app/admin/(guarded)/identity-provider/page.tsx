/**
 * `/admin/identity-provider` — issuer, client id, client secret (sealed in
 * `instance_config`, never echoed), claim mapping, allowed email domains, and
 * a "test login" that runs the real sign-in and comes back here with the
 * claims the IdP returned. Read-only when the mounted configuration sets the
 * IdP (file wins).
 */
import styles from '@/components/auth/auth.module.css';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Stack,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { DEFAULT_CLAIM_MAPPING } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const RETURN_AFTER_TEST = '/admin/identity-provider?tested=1';

export default async function IdentityProviderPage({ searchParams }: Props) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const problems = ([] as string[]).concat(params.problem ?? []);
  const saved = params.saved === '1';
  const tested = params.tested === '1';
  const idp = root.auth.idp;
  const current = await idp.current();
  const stored = await idp.stored();
  const redirectUri = root.auth.relyingParties.redirectUri.href;
  const values = current?.settings ?? null;
  const claims = values?.claims ?? DEFAULT_CLAIM_MAPPING;

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Identity provider</h1>
        <p className={styles.muted}>
          Any OpenID Connect provider (Entra ID, Google, Keycloak, Okta…). Register this redirect
          URI at the provider: <code>{redirectUri}</code>
        </p>
      </div>

      {saved && (
        <Banner tone="success" title="Saved">
          The settings are stored; the client secret is encrypted at rest. Use &quot;Test
          login&quot; to verify them — the first operator sign-in revokes the bootstrap token.
        </Banner>
      )}
      {problems.length > 0 && (
        <Banner tone="danger" title="Not saved">
          <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Banner>
      )}
      {tested && principal.kind === 'user' && (
        <Banner tone="info" title="Test login result">
          <dl className={styles.dl}>
            <dt>Email</dt>
            <dd>{principal.login.email}</dd>
            <dt>Groups claim</dt>
            <dd>
              {principal.login.groups.length === 0 ? (
                <span className={styles.muted}>none returned</span>
              ) : (
                <span className={styles.groupList}>
                  {principal.login.groups.map((g) => (
                    <Badge key={g} mono>
                      {g}
                    </Badge>
                  ))}
                </span>
              )}
            </dd>
            <dt>Operator</dt>
            <dd>{principal.isOperator ? 'yes (matches the admin rule)' : 'no'}</dd>
          </dl>
        </Banner>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          {current?.source === 'file' && (
            <Badge tone="info">set by the mounted configuration</Badge>
          )}
          {current?.source === 'store' && <Badge tone="success">configured</Badge>}
          {!current && <Badge tone="warning">not configured</Badge>}
        </CardHeader>
        <CardBody>
          <form method="post" action="/api/admin/identity-provider">
            <fieldset disabled={idp.readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
              <Stack gap="var(--space-4)">
                <Field
                  label="Issuer URL"
                  htmlFor="idp-issuer"
                  hint="The OpenID issuer identifier; discovery runs against <issuer>/.well-known/openid-configuration"
                >
                  <Input
                    id="idp-issuer"
                    name="issuer"
                    type="url"
                    required
                    defaultValue={values?.issuer.href ?? ''}
                    placeholder="https://login.example.com/realms/acme"
                  />
                </Field>
                <Field label="Client ID" htmlFor="idp-client-id">
                  <Input
                    id="idp-client-id"
                    name="client_id"
                    required
                    defaultValue={values?.clientId ?? ''}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Client secret"
                  htmlFor="idp-client-secret"
                  hint={
                    stored?.hasClientSecret
                      ? 'A secret is stored; leave blank to keep it. It is asked again when the issuer changes.'
                      : 'Stored encrypted with the master key.'
                  }
                >
                  <Input
                    id="idp-client-secret"
                    name="client_secret"
                    type="password"
                    autoComplete="new-password"
                    required={!stored?.hasClientSecret}
                  />
                </Field>
                <Field
                  label="Claim mapping"
                  hint="Claim names in the ID token / userinfo. Entra ID: groups are object ids unless the app is configured for names."
                >
                  <div className={styles.actions}>
                    <Input
                      name="claim_sub"
                      required
                      defaultValue={claims.sub}
                      aria-label="Subject claim"
                      style={{ maxWidth: 160 }}
                    />
                    <Input
                      name="claim_email"
                      required
                      defaultValue={claims.email}
                      aria-label="Email claim"
                      style={{ maxWidth: 160 }}
                    />
                    <Input
                      name="claim_groups"
                      required
                      defaultValue={claims.groups}
                      aria-label="Groups claim"
                      style={{ maxWidth: 160 }}
                    />
                  </div>
                </Field>
                <Field
                  label="Allowed email domains"
                  htmlFor="idp-allowed-email-domains"
                  hint="Optional, space or comma separated. Empty: any domain the IdP authenticates."
                >
                  <Input
                    id="idp-allowed-email-domains"
                    name="allowed_email_domains"
                    defaultValue={values?.allowedEmailDomains.join(' ') ?? ''}
                    placeholder="example.com"
                  />
                </Field>
                <div className={styles.actions}>
                  <Button type="submit" variant="primary" disabled={idp.readOnly}>
                    Save
                  </Button>
                </div>
              </Stack>
            </fieldset>
          </form>
        </CardBody>
      </Card>

      {current && (
        <Card>
          <CardHeader>
            <CardTitle>Test login</CardTitle>
          </CardHeader>
          <CardBody>
            <p className={styles.muted}>
              Runs the real sign-in through <code>{current.settings.issuer.hostname}</code> and
              comes back here with the claims received. Your current session is replaced by the one
              the IdP grants.
            </p>
            <form method="get" action="/auth/login">
              <input type="hidden" name="return_to" value={RETURN_AFTER_TEST} />
              <Button type="submit" variant="secondary">
                Test login
              </Button>
            </form>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}
