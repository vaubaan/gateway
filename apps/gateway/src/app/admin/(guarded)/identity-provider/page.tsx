/**
 * `/admin/identity-provider` — Settings → Sign-in: the sign-in providers of the
 * gateway (spec §4.2; ADR sign-in-providers-admission-and-admin-rule). One row
 * each: its name and id, its kind, who it admits, how many people signed in
 * through it. A provider saved here is edited (`/admin/identity-provider/<id>`),
 * tested (the real sign-in, coming back here with what it returned) and removed
 * (asked first, with the people it concerns); one set by the mounted
 * configuration is shown read-only. "Add a sign-in provider" opens the form.
 */
import styles from '@/components/settings/settings.module.css';
import {
  ButtonLink,
  Callout,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Hint,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  Tag,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { CONFIG_WORDS, SETTINGS_ACTIONS, SETTINGS_PAGES } from '@/lib/vocabulary';
import {
  describeAdminRule,
  IDP_PAGE,
  NEW_SIGN_IN_PROVIDER_PAGE,
  signInProviderPage,
  signInStartPath,
  type SignInProviderView,
} from '@/server/auth';
import { isOpenProvider, issuerKey } from '@/server/config';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

const KIND_WORDS = { oidc: 'OpenID Connect', github: 'GitHub', local: 'Local accounts' } as const;

/** Who a provider admits, in words. */
function admits(provider: SignInProviderView): string {
  if (provider.invitationOnly) return 'invited people only';
  if (provider.allowedEmailDomains.length > 0) {
    return `${provider.allowedEmailDomains.join(', ')}, and invited people`;
  }
  return 'everyone the directory signs in';
}

interface Row {
  readonly provider: SignInProviderView;
  readonly people: number;
}

export default async function SignInSettingsPage({ searchParams }: Props) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const problems = ([] as string[]).concat(params.problem ?? []);
  const saved = first(params.saved);
  const removed = first(params.removed);
  const removedPeople = Number(first(params.people) ?? '0');
  const tested = first(params.tested);
  const providers = await root.auth.providers.views();
  const rule = await root.auth.providers.adminRule();
  const users = await root.store.users.list();
  const rows: Row[] = providers.map((provider) => ({
    provider,
    people: users.filter(
      (user) => user.issuer !== null && issuerKey(user.issuer) === issuerKey(provider.issuer),
    ).length,
  }));

  const columns: readonly Column<Row>[] = [
    {
      id: 'provider',
      header: 'Provider',
      cell: ({ provider }) => (
        <span className={styles.namedText}>
          <span>
            <span className={styles.name}>{provider.name}</span> <Mono>{provider.id}</Mono>
          </span>
          <span className={styles.sub}>
            {provider.kind === 'local' ? 'kept by this gateway' : issuerKey(provider.issuer)}
          </span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      nowrap: true,
      cell: ({ provider }) => (
        <span className={styles.inline}>
          {KIND_WORDS[provider.kind]}
          {isOpenProvider(provider) && <Tag>open to anyone</Tag>}
        </span>
      ),
    },
    { id: 'admits', header: 'Admits', cell: ({ provider }) => admits(provider) },
    {
      id: 'people',
      header: 'People',
      align: 'right',
      cell: ({ people }) => <span className={styles.quiet}>{people}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.signIn.title}
        lede={SETTINGS_PAGES.signIn.lede}
        primary={
          <ButtonLink href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=oidc`} variant="primary">
            {SETTINGS_ACTIONS.addSignInProvider}
          </ButtonLink>
        }
        secondary={
          rows.some(({ provider }) => provider.kind === 'local')
            ? [
                <ButtonLink key="github" href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=github`}>
                  Add GitHub
                </ButtonLink>,
              ]
            : [
                <ButtonLink key="github" href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=github`}>
                  Add GitHub
                </ButtonLink>,
                <ButtonLink key="local" href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=local`}>
                  Add local accounts
                </ButtonLink>,
              ]
        }
      />

      {(saved || removed || problems.length > 0 || (tested && principal.kind === 'user')) && (
        <div className={styles.notes}>
          {saved && (
            <Callout tone="ok" title="Saved" testId="idp-saved">
              The client secret is encrypted at rest. Use “{SETTINGS_ACTIONS.testSignIn}” to check
              the settings; the first sign-in of an administrator revokes the install token.
            </Callout>
          )}
          {removed && (
            <Callout tone="ok" title={`Provider ${removed} removed`} testId="idp-removed">
              {removedPeople === 0
                ? 'Nobody had signed in through it.'
                : `${removedPeople} ${removedPeople === 1 ? 'person' : 'people'} signed in through it: their sessions are over and they can no longer sign in. Their missions and connected apps keep running until you deactivate them on People.`}
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
            <Callout tone="info" title="What the provider returned" testId="idp-tested">
              <KeyValue
                items={[
                  { term: 'Provider', value: <Mono>{principal.providerId ?? tested}</Mono> },
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

      <Section first>
        {rows.length === 0 ? (
          <EmptyState
            title="Nobody can sign in yet: no sign-in provider is set up."
            action={
              <ButtonLink href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=oidc`} variant="primary">
                {SETTINGS_ACTIONS.addSignInProvider}
              </ButtonLink>
            }
            testId="no-sign-in-provider"
          >
            Your company’s directory through OpenID Connect (Entra ID, Google Workspace, Okta,
            Keycloak), GitHub for people who sign in with their own account, or local accounts kept
            by this gateway — an email, a password and a second factor — when there is no directory.
          </EmptyState>
        ) : (
          <DataTable
            caption="The providers people sign in through"
            columns={columns}
            rows={rows}
            rowKey={({ provider }) => provider.id}
            actions={({ provider, people }) => (
              <span className={styles.inline}>
                <ButtonLink
                  href={`${signInStartPath(provider.id)}?return_to=${encodeURIComponent(`${IDP_PAGE}?tested=${provider.id}`)}`}
                  size="sm"
                  aria-label={`${SETTINGS_ACTIONS.testSignIn} through ${provider.name}`}
                  // A plain link: a prefetch of /auth/login would start a sign-in.
                  external
                >
                  Test
                </ButtonLink>
                {provider.source === 'file' ? (
                  <Tag>{CONFIG_WORDS.file}</Tag>
                ) : (
                  <>
                    <ButtonLink
                      href={signInProviderPage(provider.id)}
                      size="sm"
                      aria-label={`${SETTINGS_ACTIONS.edit} ${provider.name}`}
                    >
                      {SETTINGS_ACTIONS.edit}
                    </ButtonLink>
                    <ConfirmSubmit
                      action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/remove`}
                      label={SETTINGS_ACTIONS.remove}
                      ariaLabel={`${SETTINGS_ACTIONS.remove} ${provider.name}`}
                      variant="danger"
                      tone="danger"
                      title={`Remove ${provider.name}?`}
                      consequence={
                        people === 0 ? (
                          <>
                            Nobody has signed in through it yet. Nobody can sign in through it
                            after.
                          </>
                        ) : (
                          <>
                            {people} {people === 1 ? 'person has' : 'people have'} signed in through
                            it. At once they can no longer sign in, and their open sessions end.
                            Their missions, keys and connected apps keep running, as for anyone the
                            provider no longer vouches for: deactivate them on People to stop those.
                            Added again later with the same address, the provider gives them back
                            the same accounts.
                          </>
                        )
                      }
                      confirmLabel={SETTINGS_ACTIONS.remove}
                      testId={`remove-provider-${provider.id}`}
                    />
                  </>
                )}
              </span>
            )}
            testId="sign-in-providers"
          />
        )}
        <Hint>
          Administrators: {describeAdminRule(rule) || 'nobody yet'}. A provider where anyone can
          open an account — GitHub, personal Google or Microsoft accounts — admits only allowed
          domains and invited people; the gateway never joins two accounts of one person.
        </Hint>
      </Section>
    </>
  );
}
