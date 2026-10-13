/**
 * `/admin/identity-provider` — Sign-in: the company's identity provider
 * (issuer, client id, client secret — sealed in `instance_config`, never
 * echoed —, claim mapping, allowed email domains), and a test that runs the
 * real sign-in and comes back here with the claims the provider returned.
 * Read-only when the mounted configuration sets it (the file wins).
 */
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  CodeBlock,
  Field,
  Hint,
  Input,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  StatusMark,
  Tag,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { CONFIG_WORDS, SETTINGS_ACTIONS, SETTINGS_PAGES } from '@/lib/vocabulary';
import { DEFAULT_CLAIM_MAPPING } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const RETURN_AFTER_TEST = '/admin/identity-provider?tested=1';

export default async function SignInSettingsPage({ searchParams }: Props) {
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
    <>
      <PageHeader
        title={SETTINGS_PAGES.signIn.title}
        lede={SETTINGS_PAGES.signIn.lede}
        status={
          !current ? (
            <StatusMark tone="warn">Not set up</StatusMark>
          ) : current.source === 'file' ? (
            <Tag>{CONFIG_WORDS.file}</Tag>
          ) : undefined
        }
      />

      {(saved || problems.length > 0 || (tested && principal.kind === 'user')) && (
        <div className={styles.notes}>
          {saved && (
            <Callout tone="ok" title="Saved" testId="idp-saved">
              The client secret is encrypted at rest. Use “{SETTINGS_ACTIONS.testSignIn}” to check
              the settings; the first sign-in of an administrator revokes the install token.
            </Callout>
          )}
          {problems.length > 0 && (
            <Callout tone="bad" title="Not saved" testId="idp-problems">
              <ul className={styles.list}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Callout>
          )}
          {tested && principal.kind === 'user' && (
            <Callout tone="info" title="What the identity provider returned" testId="idp-tested">
              <KeyValue
                items={[
                  { term: 'Email', value: principal.login.email },
                  {
                    term: 'Teams',
                    value:
                      principal.login.groups.length === 0 ? (
                        <span className={styles.quiet}>none returned</span>
                      ) : (
                        <span className={styles.inline}>
                          {principal.login.groups.map((group) => (
                            <Tag key={group} mono>
                              {group}
                            </Tag>
                          ))}
                        </span>
                      ),
                  },
                  {
                    term: 'Administrator',
                    value: principal.isOperator ? 'yes: you match the rule' : 'no',
                  },
                ]}
              />
            </Callout>
          )}
        </div>
      )}

      <Section
        title="Identity provider"
        note="Any OpenID Connect provider: Entra ID, Google, Keycloak, Okta…"
        first
      >
        <form method="post" action="/api/admin/identity-provider" className={styles.form}>
          <fieldset disabled={idp.readOnly} className={styles.fieldset}>
            <Field
              label="Issuer URL"
              shape="https, as the provider prints it"
              htmlFor="idp-issuer"
              hint="Discovery runs against <issuer>/.well-known/openid-configuration."
            >
              <Input
                id="idp-issuer"
                name="issuer"
                type="url"
                required
                defaultValue={values?.issuer.href ?? ''}
                placeholder="https://login.example.com/realms/acme"
                mono
              />
            </Field>
            <Field label="Client ID" htmlFor="idp-client-id">
              <Input
                id="idp-client-id"
                name="client_id"
                required
                defaultValue={values?.clientId ?? ''}
                autoComplete="off"
                mono
              />
            </Field>
            <Field
              label="Client secret"
              htmlFor="idp-client-secret"
              hint={
                stored?.hasClientSecret
                  ? 'A secret is stored; leave blank to keep it. It is asked again when the issuer changes.'
                  : 'Stored encrypted with the master key; never shown again.'
              }
            >
              <Input
                id="idp-client-secret"
                name="client_secret"
                type="password"
                autoComplete="new-password"
                required={!stored?.hasClientSecret}
                mono
              />
            </Field>
            <Field
              label="Claim names"
              shape="subject, email, teams"
              hint="As they appear in the ID token or userinfo. Entra ID sends team ids, not names, unless the app is configured for names."
            >
              <div className={styles.claims}>
                <Input
                  name="claim_sub"
                  required
                  defaultValue={claims.sub}
                  aria-label="Subject claim"
                  mono
                />
                <Input
                  name="claim_email"
                  required
                  defaultValue={claims.email}
                  aria-label="Email claim"
                  mono
                />
                <Input
                  name="claim_groups"
                  required
                  defaultValue={claims.groups}
                  aria-label="Groups claim"
                  mono
                />
              </div>
            </Field>
            <Field
              label="Allowed email domains"
              shape="separated by spaces or commas"
              optional
              htmlFor="idp-allowed-email-domains"
              hint="Empty: anyone the identity provider authenticates."
            >
              <Input
                id="idp-allowed-email-domains"
                name="allowed_email_domains"
                defaultValue={values?.allowedEmailDomains.join(' ') ?? ''}
                placeholder="example.com"
              />
            </Field>
            <div className={styles.formActions}>
              <Button type="submit" variant="primary" disabled={idp.readOnly}>
                {SETTINGS_ACTIONS.save}
              </Button>
              {idp.readOnly && <span className={styles.formHint}>{CONFIG_WORDS.fileReadOnly}</span>}
            </div>
          </fieldset>
        </form>
      </Section>

      <Section title="Redirect address to register at the provider">
        <div className={styles.block}>
          <CodeBlock label="Redirect URI">{redirectUri}</CodeBlock>
        </div>
      </Section>

      {current && (
        <Section title={SETTINGS_ACTIONS.testSignIn}>
          <Hint>
            Runs the real sign-in through <Mono>{current.settings.issuer.hostname}</Mono> and comes
            back here with what it returned. Your session is replaced by the one it grants.
          </Hint>
          <form method="get" action="/auth/login" className={styles.formActions}>
            <input type="hidden" name="return_to" value={RETURN_AFTER_TEST} />
            <Button type="submit">{SETTINGS_ACTIONS.testSignIn}</Button>
          </form>
        </Section>
      )}
    </>
  );
}
